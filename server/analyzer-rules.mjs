/**
 * Super Kanban — zero-dependency rules analyzer.
 *
 * Converts a parsed DSH session into one or more task drafts (the same shape the
 * LLM analyzer returns) so the merge pipeline can treat both engines uniformly.
 * Rules are intentionally conservative: they must produce a useful board even
 * when the model is disabled, over quota, or offline.
 */
import { clip, extractArtifacts, extractSubtasks } from "./sessions.mjs";

export const STATUSES = ["backlog", "in_progress", "blocked", "done"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const SEVERITIES = ["high", "medium", "low"];
export const EVIDENCE_KINDS = ["user", "assistant", "todo", "tool", "artifact", "error", "deliverable"];

const DAY = 86_400_000;

/** Chinese negative/blocking phrases used to surface issues from human feedback. */
const NEGATIVE_PATTERNS = [
  /还是不行/,
  /不对/,
  /报错/,
  /失败/,
  /错误/,
  /有问题/,
  /没生效/,
  /不生效/,
  /无法/,
  /不能用/,
  /坏了/,
  /崩了/,
  /回滚/,
  /重做/,
  /重新做/,
  /没反应/,
  /没有效果/,
  /缺/,
  /漏/,
  /不一致/,
  /不对齐/,
];
const STRONG_NEGATIVE = [/还是不行/, /报错/, /失败/, /不对/, /坏了/, /崩了/, /无法/, /回滚/];

const TAG_RULES = [
  { tag: "开发", keywords: [/代码/, /开发/, /插件/, /修复/, /bug/i, /重构/, /脚本/, /python/i, /node/i, /typescript/i, /api/i, /前端/, /后端/, /测试/, /部署/i, /database/i] },
  { tag: "文档整理", keywords: [/文档/, /readme/i, /索引/, /整理/, /链接/, /路径/, /目录/, /归档/, /规范/, /说明/, /markdown/i] },
  { tag: "视觉设计", keywords: [/svg/i, /动画/, /截图/, /视觉/, /设计/, /图片/, /海报/, /封面/, /配色/, /ui/i, /样式/, /长图/, /排版/] },
  { tag: "内容创作", keywords: [/文案/, /文章/, /公众号/, /推文/, /写作/, /标题/, /故事/, /脚本创作/, /书评/, /创作/] },
  { tag: "调研", keywords: [/调研/, /研究/, /收集/, /搜索/, /论文/, /对比/, /分析/, /选型/] },
  { tag: "数据处理", keywords: [/数据/, /表格/, /csv/i, /excel/i, /统计/, /压缩/, /爬取/] },
];

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function dedupeStrings(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/** Character-bigram Jaccard similarity — works for Chinese without tokenizers. */
export function titleSimilarity(left, right) {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.length > 6 && b.includes(a)) || (b.length > 6 && a.includes(b))) return 0.9;
  const bigrams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let overlap = 0;
  for (const gram of setA) if (setB.has(gram)) overlap += 1;
  const union = setA.size + setB.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

/** Pick the first substantial instruction message as the goal source. */
function pickGoal(parsed) {
  const candidates = parsed.users
    .slice(0, 4)
    .map((message) => String(message.text || ""))
    .filter(Boolean);
  const substantial = candidates.find((text) => text.replace(/\s+/g, " ").trim().length >= 24);
  return normalizeGoal(substantial || candidates[0] || parsed.title, 80);
}

/**
 * Rule-mode goals are deliberately terse: the first sentence (or first 80
 * chars) of the initial instruction, single line, without raw prompt dumps.
 */
function normalizeGoal(text, max = 80) {
  const flat = String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutPath = flat.replace(/^@?["']?(?:\/|~\/)[^\s，,。;；:：]+["']?\s*[，,。;；:：\-—]?\s*/, "");
  const sentence = withoutPath.split(/(?<=[。！？!?；;])\s*/)[0] || withoutPath;
  return clip(sentence.trim() || flat, max);
}

function deriveTags(parsed, workspaceTitle) {
  const corpus = [parsed.title, ...parsed.users.slice(0, 3).map((message) => message.text)].join("\n");
  const tags = [];
  if (workspaceTitle && workspaceTitle.length <= 12) tags.push(workspaceTitle);
  for (const rule of TAG_RULES) {
    if (tags.length >= 4) break;
    if (rule.keywords.some((keyword) => keyword.test(corpus))) tags.push(rule.tag);
  }
  return dedupeStrings(tags, 4);
}

function inferProgress(parsed, decision) {
  const { status, todoCounts, todoFresh } = decision;
  if (status === "done") return 100;
  return todoFresh && todoCounts.total > 0 ? Math.round((todoCounts.completed / todoCounts.total) * 100) : null;
}

/**
 * Decide status + progress from turn/todo/error signals.
 * Todo snapshots written before the latest turn started are stale by design:
 * long sessions often plan once in turn 1 and then work for hours.
 */
function inferStatus(parsed) {
  const lastTodo = parsed.todoSnapshots[parsed.todoSnapshots.length - 1] || null;
  const lastTurnStartSeq = parsed.turnStarts[parsed.turnStarts.length - 1]?.seq ?? 0;
  const todoFresh = Boolean(lastTodo && lastTodo.seq > lastTurnStartSeq);
  const todoCounts = lastTodo
    ? lastTodo.todos.reduce(
        (counts, todo) => {
          counts.total += 1;
          if (todo.status === "completed") counts.completed += 1;
          else if (todo.status === "in_progress") counts.inProgress += 1;
          else counts.pending += 1;
          return counts;
        },
        { total: 0, completed: 0, pending: 0, inProgress: 0 },
      )
    : { total: 0, completed: 0, pending: 0, inProgress: 0 };
  const pendingTodos = todoCounts.pending + todoCounts.inProgress;
  const daysIdle = parsed.lastActivityAt > 0 ? (Date.now() - parsed.lastActivityAt) / DAY : 999;
  const lastTurnEnd = parsed.lastTurnEnd;

  let status;
  let reason;
  let attention = null;
  let completionBasis = null;
  const latestReply = parsed.assistants.at(-1)?.text || "";
  const requestsDecision = /(?:请(?:先)?(?:确认|选择|提供|告知|决定)|等待(?:你|用户)(?:确认|选择|回复)|(?:please|could you) (?:confirm|choose|provide|clarify))/i.test(latestReply.slice(-600));
  if (parsed.isLive) {
    status = "in_progress";
    reason = "会话仍在进行中（最后一轮尚未结束）";
  } else if (!lastTurnEnd) {
    status = daysIdle > 14 ? "backlog" : "in_progress";
    reason = daysIdle > 14 ? "会话没有结束标记且已多日无活动" : "会话没有完整的轮次结束标记";
  } else if (lastTurnEnd.kind === "error") {
    status = "blocked";
    reason = "最后一轮以错误结束";
  } else if (lastTurnEnd.kind === "aborted" || lastTurnEnd.kind === "interrupted") {
    status = daysIdle > 7 ? "backlog" : "in_progress";
    reason = daysIdle > 7 ? "最后一轮被中止且已多日无活动" : "最后一轮被中止";
    attention = "interrupted";
  } else if (requestsDecision) {
    status = "in_progress";
    attention = "waiting_user";
    reason = "最近回复请求用户确认或提供信息";
  } else if (todoFresh && pendingTodos > 0) {
    status = "in_progress";
    reason = `最新待办仍有 ${pendingTodos} 项未完成`;
  } else if (lastTurnEnd.kind === "completed" && parsed.goal?.status === "done") {
    status = "done";
    completionBasis = "session_goal";
    reason = "DSH 会话目标已标记完成";
  } else if (lastTurnEnd.kind === "completed" && todoFresh && todoCounts.total > 0 && pendingTodos === 0) {
    status = "done";
    completionBasis = "session_todos";
    reason = "最新待办全部完成且本轮正常结束";
  } else {
    status = "in_progress";
    attention = "review";
    reason = parsed.deliverables.length ? "已有交付物，等待验收" : "本轮已结束，任务完成情况待确认";
  }
  return {
    status,
    reason,
    attention,
    completionBasis,
    todoCounts,
    todoFresh,
    lastTurnStartSeq,
    daysIdle,
    pendingTodos,
    lastTodo,
  };
}

function inferPriority(parsed, status) {
  const daysIdle = parsed.lastActivityAt > 0 ? (Date.now() - parsed.lastActivityAt) / DAY : 999;
  const live = parsed.isLive;
  if (status === "blocked") return daysIdle > 14 ? "P2" : "P1";
  if (status === "in_progress") {
    if (live && daysIdle < 0.5) return "P1";
    if (daysIdle < 1) return "P1";
    if (daysIdle < 7) return "P2";
    return "P3";
  }
  if (status === "done") return daysIdle < 3 ? "P2" : "P3";
  return daysIdle > 21 ? "P3" : "P2";
}

/**
 * Only short, follow-up negative feedback counts as an issue. The initial
 * requirement message (often hundreds of chars of product context) must never
 * be reported as a problem just because it contains words like 缺失/不对.
 */
function negativeFeedbackIssues(parsed, decision, limit = 3) {
  const issues = [];
  if (decision.status === "done") return issues;
  const firstSeq = parsed.users[0]?.seq;
  const recentUsers = parsed.users.slice(-8).filter((message) => message.seq !== firstSeq);
  const lastSeq = recentUsers[recentUsers.length - 1]?.seq ?? 0;
  for (const message of recentUsers) {
    const text = String(message.text || "").replace(/\s+/g, " ").trim();
    if (text.length > 200) continue; // long text = requirement/context, not feedback
    if (!NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) continue;
    const strong = STRONG_NEGATIVE.some((pattern) => pattern.test(text));
    if (!strong && text.length > 120) continue;
    issues.push({
      text: clip(`用户反馈：${text}`, 140),
      severity: strong ? "high" : message.seq === lastSeq ? "medium" : "low",
      seq: message.seq,
    });
    if (issues.length >= limit) break;
  }
  return issues;
}

function errorIssues(parsed, decision, limit = 4) {
  if (decision.status === "done") {
    const turnError = parsed.errors.find((error) => error.source === "turn" && error.seq === parsed.lastTurnEnd?.seq);
    if (!turnError) return [];
  }
  const issues = [];
  const seen = new Set();
  for (const error of [...parsed.errors].reverse()) {
    const text = String(error.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      text: clip(`执行错误：${text}`, 140),
      severity: error.source === "turn" ? "high" : "medium",
      seq: error.seq,
    });
    if (issues.length >= limit) break;
  }
  return issues;
}

function buildNextSteps(parsed, decision) {
  const steps = [];
  if (decision.lastTodo && decision.status !== "done") {
    for (const todo of decision.lastTodo.todos) {
      if (todo.status !== "completed") steps.push(todo.content);
      if (steps.length >= 5) break;
    }
  }
  if (steps.length === 0 && decision.status === "blocked") {
    const error = [...parsed.errors].reverse().find((item) => item.source === "turn") || parsed.errors.at(-1);
    if (error) steps.push(`排查并修复错误：${clip(String(error.text).replace(/\s+/g, " "), 100)}`);
  }
  if (steps.length === 0 && decision.status === "in_progress") {
    steps.push(parsed.isLive ? "完成当前轮次并向用户同步进展" : "继续推进当前工作并向用户同步进展");
  }
  return dedupeStrings(steps, 5);
}

function buildMilestones(decision) {
  if (!decision.lastTodo || !decision.todoFresh) return [];
  return decision.lastTodo.todos.slice(0, 20).map((todo, index) => ({
    text: clip(todo.content, 120),
    done: todo.status === "completed",
    seq: decision.lastTodo.seq,
    index,
  }));
}

function buildReason(parsed, decision) {
  const parts = [decision.reason];
  if (decision.todoCounts.total > 0) {
    parts.push(
      `待办 ${decision.todoCounts.completed}/${decision.todoCounts.total} 完成${decision.todoFresh ? "" : "（快照较早，仅供参考）"}`,
    );
  }
  if (parsed.deliverables.length > 0) parts.push(`${parsed.deliverables.length} 次交付展示`);
  if (parsed.errors.length > 0) parts.push(`${parsed.errors.length} 处错误记录`);
  if (parsed.isLive) parts.push("会话活跃");
  return clip(parts.join("；"), 300);
}

function buildConfidence(parsed, decision) {
  let confidence = 0.42;
  if (decision.todoCounts.total > 0) confidence += 0.12;
  if (decision.todoFresh) confidence += 0.08;
  if (parsed.lastTurnEnd) confidence += 0.12;
  if (parsed.deliverables.length > 0) confidence += 0.1;
  if (parsed.users.length >= 3) confidence += 0.05;
  if (parsed.assistants.length === 0) confidence -= 0.08;
  return Math.round(clamp(confidence * 100, 35, 88)) / 100;
}


/** Deterministic fallback key facts (≤5, ≤60 chars each). */
function buildKeyFacts(parsed, { goalText, subtasks, issues, artifacts, decision }) {
  const facts = [];
  const push = (kind, text, seq) => {
    const value = clip(String(text || "").replace(/\s+/g, " ").trim(), 60);
    if (!value) return;
    if (facts.some((fact) => fact.text === value)) return;
    facts.push({
      id: `k_${parsed.id.slice(-6)}_${facts.length}`,
      text: value,
      kind,
      sessionId: parsed.id,
      seq: Number(seq) || 0,
    });
  };
  if (goalText) push("goal", goalText, parsed.users[0]?.seq || 0);
  const done = subtasks.filter((subtask) => subtask.done).length;
  if (subtasks.length > 0) push("progress", `子任务完成 ${done}/${subtasks.length}`, subtasks[0]?.seq || 0);
  for (const issue of issues.slice(0, 2)) push("issue", issue.text, issue.seq);
  if (artifacts.length > 0) {
    push("artifact", `产出产物 ${artifacts.length} 个：${artifacts.map((item) => item.name).slice(0, 3).join("、")}`, artifacts[0].seq);
  }
  if (decision.lastTodo && subtasks.length === 0) {
    const todos = decision.lastTodo.todos;
    const completed = todos.filter((todo) => todo.status === "completed").length;
    push("progress", `待办完成 ${completed}/${todos.length}`, decision.lastTodo.seq);
  }
  const lastUser = parsed.users[parsed.users.length - 1];
  if (lastUser && parsed.users.length > 1) push("decision", `用户最新要求：${lastUser.text}`, lastUser.seq);
  if (parsed.lastAssistantText) push("status", parsed.lastAssistantText.text, parsed.lastAssistantText.seq);
  return facts.slice(0, 5);
}

/**
 * Rules analysis for one parsed session.
 *
 * @param {object} parsed result of createSessionSource().loadParsed
 * @param {{workspaceTitle?:string|null, workspacePath?:string|null, maxTasks?:number}} options
 * @returns {{engine:"rules", sessionSummary:string, tasks:Array<object>}}
 */
export function analyzeSessionRules(parsed, { workspaceTitle = null, workspacePath = null, maxTasks = 3 } = {}) {
  if (!parsed.users.length) {
    return { engine: "rules", sessionSummary: "无用户消息，跳过", tasks: [] };
  }
  const decision = inferStatus(parsed);
  const status = decision.status;
  const priority = inferPriority(parsed, status);
  const issues = [...errorIssues(parsed, decision), ...negativeFeedbackIssues(parsed, decision)].slice(0, 3);
  const nextSteps = buildNextSteps(parsed, decision).slice(0, 3);
  const milestones = buildMilestones(decision);
  const title = parsed.title;
  const goal = pickGoal(parsed);
  const tags = deriveTags(parsed, workspaceTitle);
  const confidence = buildConfidence(parsed, decision);
  const reason = buildReason(parsed, decision);
  const subtasks = extractSubtasks(parsed);
  const artifacts = extractArtifacts(parsed, { workspacePath: workspacePath || parsed.session?.cwd });
  const progress =
    subtasks.length > 0
      ? clamp(Math.round((subtasks.filter((subtask) => subtask.done).length / subtasks.length) * 100), 0, 100)
      : inferProgress(parsed, decision);
  const keyFacts = buildKeyFacts(parsed, { goalText: goal, subtasks, issues, artifacts, decision });

  const evidenceSource = parsed.evidence;
  const evidence = (evidenceSource || []).map((item) => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    quote: item.quote,
    seq: item.seq,
    time: item.time,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
  }));

  const tasks = [
    {
      title: clip(title, 40),
      goalText: clip(goal, 100),
      status,
      progress,
      priority,
      tags,
      issues: issues.map((issue, index) => ({
        id: `i_${parsed.id.slice(-6)}_${issue.seq}_${index}`,
        text: issue.text,
        severity: issue.severity,
        sessionId: parsed.id,
        seq: issue.seq,
      })),
      nextSteps,
      milestones: milestones.map((milestone) => ({
        id: `m_${parsed.id.slice(-6)}_${milestone.index}`,
        text: milestone.text,
        done: milestone.done,
        sessionId: parsed.id,
        seq: milestone.seq,
      })),
      keyFacts,
      subtasks,
      evidence,
      confidence,
      reason,
      attention: decision.attention,
      completionBasis: decision.completionBasis,
      mergeWith: null,
    },
  ].slice(0, Math.max(1, maxTasks));
  return {
    engine: "rules",
    sessionSummary: `${parsed.title}（${status}，${parsed.users.length} 条用户消息）`,
    tasks,
  };
}

/* ------------------------------------------------------------------ */
/* Shared normalization for LLM output and user payload validation     */
/* ------------------------------------------------------------------ */

function asText(value, limit) {
  return typeof value === "string" ? clip(value.trim(), limit) : "";
}

/**
 * Timeline text candidates for quote→seq recovery, cached per parsed session
 * (WeakMap keeps it GC-friendly; a scan reuses the same parsed object).
 * @type {WeakMap<object, Array<{seq:number, text:string}>>}
 */
const TIMELINE_CACHE = new WeakMap();
const EMPTY_TIMELINE = Object.freeze([]);

function timelineOf(parsed) {
  if (!parsed || typeof parsed !== "object") return EMPTY_TIMELINE;
  const cached = TIMELINE_CACHE.get(parsed);
  if (cached) return cached;
  const items = [];
  const push = (seq, text) => {
    const number = Number(seq);
    const value = typeof text === "string" ? text.trim() : "";
    if (!Number.isFinite(number) || number <= 0 || !value) return;
    items.push({ seq: Math.floor(number), text: value });
  };
  for (const message of parsed.users || []) push(message?.seq, message?.text);
  for (const message of parsed.assistants || []) push(message?.seq, message?.text);
  for (const result of parsed.toolResults || []) push(result?.seq, result?.text);
  for (const snapshot of parsed.todoSnapshots || []) {
    push(snapshot?.seq, (snapshot?.todos || []).map((todo) => todo?.content || "").join("\n"));
  }
  for (const deliverable of parsed.deliverables || []) {
    push(
      deliverable?.seq,
      (deliverable?.files || []).map((file) => `${file?.path || ""}${file?.description ? ` —— ${file.description}` : ""}`).join("\n"),
    );
  }
  for (const error of parsed.errors || []) push(error?.seq, error?.text);
  for (const signal of parsed.signals || []) push(signal?.seq, signal?.text);
  for (const notice of parsed.systemNotices || []) push(notice?.seq, notice?.text);
  items.sort((left, right) => left.seq - right.seq || left.text.localeCompare(right.text));
  TIMELINE_CACHE.set(parsed, items);
  return items;
}

/**
 * Resolve a model-provided seq against the real session timeline.
 *
 * Accept a seq only when it is a positive integer known to `parsed.timeBySeq`;
 * otherwise recover it from an exact quote match (then the tightest containing
 * event). Unresolved seqs become `null`, never 0 — the UI renders 0 as a
 * misleading `#0` citation.
 *
 * @param {unknown} rawSeq
 * @param {unknown} quote evidence quote / issue text / fact text
 * @param {object} [parsed]
 * @returns {number|null}
 */
export function resolveAnalysisSeq(rawSeq, quote, parsed) {
  const timeBySeq = parsed?.timeBySeq instanceof Map ? parsed.timeBySeq : null;
  const numeric = Number(rawSeq);
  if (Number.isFinite(numeric) && numeric > 0) {
    const seq = Math.floor(numeric);
    if (!timeBySeq || timeBySeq.has(seq)) return seq;
  }
  const needle = typeof quote === "string" ? quote.trim() : "";
  if (!needle) return null;
  const timeline = timelineOf(parsed);
  if (timeline.length === 0) return null;
  const exact = timeline.find((event) => event.text === needle);
  if (exact) return exact.seq;
  let best = null;
  for (const event of timeline) {
    if (!event.text.includes(needle)) continue;
    if (!best || event.text.length < best.text.length || (event.text.length === best.text.length && event.seq < best.seq)) {
      best = event;
    }
  }
  return best ? best.seq : null;
}

/** Resolve seq + wall-clock time for one normalized analysis item. */
function resolveSeqTime(rawSeq, quote, parsed) {
  const seq = resolveAnalysisSeq(rawSeq, quote, parsed);
  const timeBySeq = parsed?.timeBySeq instanceof Map ? parsed.timeBySeq : null;
  const time = seq !== null && timeBySeq ? Number(timeBySeq.get(seq)) || 0 : 0;
  return { seq, time };
}

/**
 * Validate/normalize one analysis task coming from the LLM (or a manual payload).
 * Returns null when the object has no usable title.
 */
export function normalizeAnalysis(raw, parsed, { engine = "llm", model = null } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const title = asText(raw.title, 40) || parsed?.title || "";
  if (!title) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : "in_progress";
  const priority = PRIORITIES.includes(raw.priority) ? raw.priority : "P2";
  const progress =
    raw.progress === null || raw.progress === undefined
      ? null
      : Number.isFinite(Number(raw.progress))
        ? clamp(raw.progress, 0, 100)
        : null;
  const sessionId = parsed?.id || parsed?.sessionId || null;
  const sessionTitle = parsed?.title || parsed?.sessionTitle || null;
  const issues = (Array.isArray(raw.issues) ? raw.issues : [])
    .slice(0, 3)
    .map((issue, index) => {
      const text = asText(issue?.text, 60);
      const seq = resolveAnalysisSeq(issue?.seq, text, parsed);
      return {
        id: `i_${(sessionId || "x").slice(-6)}_${seq ?? "na"}_${index}`,
        text,
        severity: SEVERITIES.includes(issue?.severity) ? issue.severity : "medium",
        sessionId,
        seq,
      };
    })
    .filter((issue) => issue.text);

  const milestones = (Array.isArray(raw.milestones) ? raw.milestones : [])
    .slice(0, 20)
    .map((milestone, index) => ({
      id: `m_${(sessionId || "x").slice(-6)}_${index}`,
      text: asText(milestone?.text, 120),
      done: milestone?.done === true,
      sessionId,
      seq: resolveAnalysisSeq(milestone?.seq, asText(milestone?.text, 240), parsed),
    }))
    .filter((milestone) => milestone.text);

  const keyFacts = (Array.isArray(raw.keyFacts) ? raw.keyFacts : [])
    .slice(0, 5)
    .map((fact, index) => {
      const text = asText(fact?.text, 60);
      const kind = ["status", "progress", "issue", "decision", "artifact", "goal"].includes(fact?.kind) ? fact.kind : "status";
      return {
        id: `k_${(sessionId || "x").slice(-6)}_${index}`,
        text,
        kind,
        sessionId,
        seq: resolveAnalysisSeq(fact?.seq, text, parsed),
      };
    })
    .filter((fact) => fact.text);

  const subtasks = (Array.isArray(raw.subtasks) ? raw.subtasks : [])
    .slice(0, 6)
    .map((subtask, index) => ({
      id: `s_${(sessionId || "x").slice(-6)}_ai_${index}`,
      text: asText(subtask?.text, 40),
      done: subtask?.done === true,
      source: "ai",
      seq: resolveAnalysisSeq(subtask?.seq, asText(subtask?.text, 240), parsed),
    }))
    .filter((subtask) => subtask.text);

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((item) => EVIDENCE_KINDS.includes(item?.kind))
    .slice(0, 5)
    .map((item, index) => {
      const quote = asText(item.quote, 160) || asText(item.text, 160);
      // Accept the model seq only when it exists in the real timeline; otherwise
      // recover it from the quote. Unresolved seqs are null (never a fake #0).
      const { seq, time } = resolveSeqTime(item.seq, quote || asText(item.text, 240), parsed);
      return {
        id: `e_${(sessionId || "x").slice(-6)}_${item.kind}_${seq ?? "na"}_${index}`,
        kind: item.kind,
        text: asText(item.text, 200) || asText(item.quote, 200),
        quote: asText(item.quote, 80) || asText(item.text, 80),
        seq,
        time,
        sessionId,
        sessionTitle,
      };
    })
    .filter((item) => item.text);

  return {
    title,
    goalText: asText(raw.goal, 100),
    status,
    progress,
    priority,
    tags: dedupeStrings(Array.isArray(raw.tags) ? raw.tags.map((tag) => asText(tag, 12)) : [], 4),
    issues,
    nextSteps: dedupeStrings(Array.isArray(raw.nextSteps) ? raw.nextSteps.map((step) => asText(step, 60)) : [], 3),
    keyFacts,
    subtasks,
    milestones,
    evidence,
    confidence: Number.isFinite(Number(raw.confidence)) ? Math.round(clamp(Number(raw.confidence) * 100, 0, 100)) / 100 : 0.6,
    reason: asText(raw.reason, 120),
    engine,
    model,
    mergeWith: typeof raw.mergeWith === "string" && raw.mergeWith.trim() ? raw.mergeWith.trim() : null,
  };
}
