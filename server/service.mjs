/**
 * Super Kanban — host service.
 *
 * Orchestrates the whole host half:
 *   - session discovery + rules/LLM analysis on an automatic scan schedule
 *   - merge policy (stable session↔task binding, locked fields, history)
 *   - persistence (state.json / sessions-cache.json)
 *   - the HTTP surface consumed by plugin/client.js (see docs/DEV-CONTRACT.md)
 *
 * Public surface (also the contract with plugin/index.mjs):
 *   createKanbanService({ ctx }) -> { handle(req,res,{route,url,method}), start(), stop() }
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { createSessionSource } from "./sessions.mjs";
import { analyzeSessionRules, normalizeAnalysis, titleSimilarity } from "./analyzer-rules.mjs";
import { createLlmAnalyzer } from "./analyzer-llm.mjs";
import {
  ARTIFACT_LIMIT,
  createStore,
  DEFAULT_SETTINGS,
  EVIDENCE_LIMIT,
  emptyScanState,
  KEYFACT_LIMIT,
  newManualTaskId,
  normalizeSettingsPatch,
  pushHistory,
  rolloverUsage,
  shortId,
  stableTaskId,
  SUBTASK_LIMIT,
  truncateTask,
} from "./store.mjs";

const API_PREFIX = "/super-kanban/api";
const DAY = 86_400_000;
const MAX_AI_CONCURRENCY = 2;
const MAX_SESSIONS_PER_TASK = 12;
const MIN_AI_INTERVAL_MS = 180_000; // v2: same-session re-analysis cooldown
const FIELD_NAMES = ["title", "goal", "status", "progress", "priority", "tags", "issues", "nextSteps", "milestones"];
const LOCKABLE_FIELDS = [...FIELD_NAMES, "keyFacts", "subtasks", "artifacts", "goalObject"];
const STATUSES = ["backlog", "in_progress", "blocked", "done"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const SSE_HEARTBEAT_MS = 15_000;

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request-too-large"), { code: "invalid-input" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("invalid-json"), { code: "invalid-input" }));
      }
    });
    req.on("error", (error) => reject(Object.assign(error, { code: "invalid-input" })));
  });
}

function badRequest(message) {
  return Object.assign(new Error(message), { code: "invalid-input" });
}

function notFound(message) {
  return Object.assign(new Error(message), { code: "not-found" });
}

function clipText(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createKanbanService({ ctx } = {}) {
  const logger = ctx?.logger;
  const dshHome = process.env.DSH_HOME || path.join(homedir(), ".dsh");
  const source = createSessionSource({ dshHome, logger });
  const analyzer = createLlmAnalyzer({ dshHome, logger });
  const store = createStore({ dshHome, logger });

  const loaded = store.load();
  let state = loaded.state;
  let cache = loaded.cache;
  let stopped = false;
  state.usage = rolloverUsage(state.usage);

  /** id -> SessionMeta (compact, includes workspace + last todo counts). */
  let sessionsById = new Map();
  /** parent session id -> child (subagent) session ids. */
  let parentToChildren = new Map();

  let scanPromise = null;
  let scanCancel = false;
  let scanAbort = null;
  let startupTimer = null;
  let autoTimer = null;
  let saveTimer = null;
  const sseClients = new Set();
  let lastScanBroadcast = 0;
  let scanBroadcastTimer = null;
  let suppressPersist = false;
  let scanDigestBytes = []; // digest byte sizes of the current scan (usage.lastScan.digestBytesAvg)

  for (const diagnostic of loaded.diagnostics) {
    logger?.warn?.(`[super-kanban] store: ${diagnostic.kind}: ${diagnostic.message}`);
  }
  logger?.info?.(
    `[super-kanban] host ready · home=${dshHome} · tasks=${state.tasks.length} · sessions cached=${Object.keys(cache.sessions).length}`,
  );

  /* ------------------------------ broadcast ------------------------ */

  function broadcast(event, data) {
    if (sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...sseClients]) {
      try {
        client.res.write(payload);
      } catch {
        removeSseClient(client);
      }
    }
  }

  function removeSseClient(client) {
    if (!sseClients.has(client)) return;
    sseClients.delete(client);
    clearInterval(client.heartbeat);
    try {
      client.res.end();
    } catch {
      /* response already closed */
    }
  }

  function emitChanged(reason, tasksChanged = 0) {
    broadcast("changed", { reason, tasksChanged });
  }

  function broadcastScan(force = false) {
    if (sseClients.size === 0) return;
    const now = Date.now();
    const send = () => {
      lastScanBroadcast = Date.now();
      broadcast("scan", state.scan);
    };
    if (force || now - lastScanBroadcast > 450) {
      if (scanBroadcastTimer) {
        clearTimeout(scanBroadcastTimer);
        scanBroadcastTimer = null;
      }
      send();
      return;
    }
    if (!scanBroadcastTimer) {
      scanBroadcastTimer = setTimeout(() => {
        scanBroadcastTimer = null;
        send();
      }, Math.max(50, 450 - (now - lastScanBroadcast)));
    }
  }

  /* ------------------------------ persistence ---------------------- */

  function persistState() {
    if (suppressPersist) return;
    try {
      store.saveState(state);
    } catch (error) {
      logger?.warn?.(`[super-kanban] failed to save state: ${String(error?.message || error)}`);
    }
  }

  function persistCache() {
    try {
      store.saveCache(cache);
    } catch (error) {
      logger?.warn?.(`[super-kanban] failed to save session cache: ${String(error?.message || error)}`);
    }
  }

  /** Persist state at most every few seconds during a long scan. */
  function schedulePersist() {
    if (saveTimer || suppressPersist) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistState();
      persistCache();
    }, 2000);
  }

  /* ------------------------------ derived state -------------------- */

  function workspaceById(id) {
    return state.workspaces.find((workspace) => workspace.id === id) || null;
  }

  function computeStats() {
    const active = state.tasks.filter((task) => !task.archived);
    const byStatus = { backlog: 0, in_progress: 0, blocked: 0, done: 0 };
    let progressSum = 0;
    let progressCount = 0;
    let issues = 0;
    let aiAnalyzed = 0;
    for (const task of active) {
      if (byStatus[task.status] !== undefined) byStatus[task.status] += 1;
      if (Number.isFinite(task.progress)) {
        progressSum += task.progress;
        progressCount += 1;
      }
      issues += Array.isArray(task.issues) ? task.issues.length : 0;
      if (task.ai && task.ai.analyzedAt) aiAnalyzed += 1;
    }
    const total = state.tasks.length;
    const archived = total - active.length;
    const now = Date.now();
    let activeSessions = 0;
    for (const entry of Object.values(cache.sessions)) {
      if (entry?.meta?.lastActivityAt && now - entry.meta.lastActivityAt < DAY) activeSessions += 1;
    }
    if (activeSessions === 0) {
      activeSessions = active.filter((task) => now - (task.lastActivityAt || 0) < DAY).length;
    }
    return {
      total,
      archived,
      byStatus,
      doneRate: active.length > 0 ? Math.round((byStatus.done / active.length) * 100) / 100 : 0,
      activeSessions,
      avgProgress: progressCount > 0 ? Math.round(progressSum / progressCount) : 0,
      aiAnalyzed,
      issues,
    };
  }

  function computeActivity(days = 14) {
    const counts = new Map();
    const now = Date.now();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      counts.set(new Date(now - offset * DAY).toISOString().slice(0, 10), 0);
    }
    for (const entry of Object.values(cache.sessions)) {
      const activity = entry?.meta?.activity;
      if (!activity) continue;
      for (const [day, count] of Object.entries(activity)) {
        if (counts.has(day)) counts.set(day, counts.get(day) + count);
      }
    }
    return [...counts.entries()].map(([day, count]) => ({ day, count }));
  }

  function computeWorkspaces(discoveryWorkspaces = null, sessions = null) {
    const metas = sessions || [...sessionsById.values()];
    const lastActivity = new Map();
    for (const meta of metas) {
      if (!meta.workspaceId) continue;
      const previous = lastActivity.get(meta.workspaceId) || 0;
      lastActivity.set(meta.workspaceId, Math.max(previous, meta.lastActivityAt || 0));
    }
    const base = discoveryWorkspaces || state.workspaces;
    const excluded = new Set(state.settings.excludeWorkspaces || []);
    return base.map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount:
        discoveryWorkspaces && sessions
          ? sessions.filter((meta) => meta.workspaceId === workspace.id && meta.origin === "main").length
          : workspace.sessionCount || 0,
      included: !excluded.has(workspace.id),
      lastActivityAt: lastActivity.get(workspace.id) || workspace.lastActivityAt || 0,
      source: workspace.source || "registry",
    }));
  }

  function buildStatePayload() {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      tasks: state.tasks,
      stats: computeStats(),
      activity: state.activity,
      workspaces: state.workspaces,
      scan: state.scan,
      settings: state.settings,
      usage: state.usage,
    };
  }

  /* --------------------------- v2 helpers -------------------------- */

  function mapTurnEndKind(kind) {
    if (kind === "completed" || kind === "error") return kind;
    if (kind === "aborted" || kind === "interrupted") return "interrupted";
    return null;
  }

  function sessionContextFromMeta(meta, parsed = null) {
    if (!meta) return null;
    const todos = parsed ? source.latestTodos(parsed) : { todoTotal: 0, todoDone: 0 };
    const lastTodo = parsed?.todoSnapshots?.[parsed.todoSnapshots.length - 1];
    const parsedCounts = lastTodo
      ? (() => {
          const total = lastTodo.todos.length;
          const done = lastTodo.todos.filter((todo) => todo.status === "completed").length;
          return { todoTotal: total, todoDone: done };
        })()
      : null;
    const todoCounts = meta.todoCounts || { total: 0, completed: 0 };
    return {
      sessionId: meta.id,
      title: meta.title || (parsed ? parsed.title : ""),
      isLive: parsed ? Boolean(parsed.isLive) : Boolean(meta.isLive),
      turnCount: parsed ? parsed.turnCount : meta.turnCount || 0,
      lastTurnEnd: mapTurnEndKind(parsed ? parsed.lastTurnEnd?.kind : meta.lastTurnEnd?.kind),
      lastActivityAt: parsed ? parsed.lastActivityAt : meta.lastActivityAt || 0,
      todoTotal: parsedCounts ? parsedCounts.todoTotal : todoCounts.total || 0,
      todoDone: parsedCounts ? parsedCounts.todoDone : todoCounts.completed || 0,
    };
  }

  /** Deterministic v2 task context for one session (no LLM tokens). */
  function buildV2Context(parsed, meta, workspaceTitle) {
    return {
      sessionId: parsed.id,
      sessionTitle: parsed.title,
      timeBySeq: parsed.timeBySeq,
      workspaceId: meta?.workspaceId || null,
      workspaceTitle: workspaceTitle || meta?.workspaceTitle || null,
      workspacePath: meta?.workspacePath || null,
      artifacts: source.extractArtifacts(parsed, { workspacePath: meta?.workspacePath }),
      subtasks: source.extractSubtasks(parsed),
      sessionContext: sessionContextFromMeta(meta, parsed),
      sessionGoal: parsed.goal?.text
        ? { text: parsed.goal.text, status: parsed.goal.status || "active" }
        : meta?.goalText
          ? { text: meta.goalText, status: meta.goalStatus || "active" }
          : null,
    };
  }

  function dedupeByText(items, limit) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...item, text });
      if (result.length >= limit) break;
    }
    return result;
  }

  function mergeKeyFacts(primary = [], secondary = []) {
    const merged = dedupeByText([...(primary || []), ...(secondary || [])], KEYFACT_LIMIT);
    return merged.map((fact, index) => ({
      id: fact.id || shortId("k", `${fact.sessionId || ""}:${fact.seq || 0}:${fact.text}:${index}`),
      text: clipText(fact.text, 60),
      kind: ["status", "progress", "issue", "decision", "artifact", "goal"].includes(fact.kind) ? fact.kind : "status",
      sessionId: fact.sessionId || null,
      seq: Number(fact.seq) || 0,
    }));
  }

  function mergeSubtasks(...sources) {
    const manual = [];
    const others = [];
    for (const sourceList of sources) {
      for (const subtask of sourceList || []) {
        const text = typeof subtask?.text === "string" ? subtask.text.trim() : "";
        if (!text) continue;
        const item = {
          id: subtask.id || shortId("s", `${subtask.source || "ai"}:${text}`),
          text: clipText(text, 40),
          done: subtask.done === true,
          source: ["ai", "todo", "manual"].includes(subtask.source) ? subtask.source : "ai",
          seq: Number(subtask.seq) || 0,
        };
        if (item.source === "manual") manual.push(item);
        else others.push(item);
      }
    }
    // Manual subtasks win over generated ones with the same text.
    return dedupeByText([...manual, ...others], SUBTASK_LIMIT);
  }

  function mergeArtifacts(primary = [], secondary = []) {
    const seen = new Set();
    const merged = [];
    for (const item of [...(primary || []), ...(secondary || [])]) {
      if (!item || typeof item !== "object") continue;
      const key = item.absPath || item.path || item.name;
      if (!key || seen.has(key)) continue;
      // DSH preview needs the file to exist; drop stale paths (moved/deleted).
      if (item.absPath) {
        try {
          if (!fs.existsSync(item.absPath)) continue;
        } catch {
          continue;
        }
      }
      seen.add(key);
      merged.push(item);
      if (merged.length >= ARTIFACT_LIMIT) break;
    }
    return merged;
  }

  function progressFromSubtasks(subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
    const done = subtasks.filter((subtask) => subtask.done).length;
    return Math.round((done / subtasks.length) * 100);
  }

  /**
   * A task marked done must not keep unfinished subtasks (imported TODO plans can
   * be stale); close them so progress/subtask state stays self-consistent.
   */
  function closeSubtasksForDoneTask(task) {
    if (!task || task.status !== "done" || !Array.isArray(task.subtasks) || task.subtasks.length === 0) return false;
    if (!task.subtasks.some((subtask) => !subtask.done)) return false;
    task.subtasks = task.subtasks.map((subtask) => ({ ...subtask, done: true }));
    return true;
  }

  /** User unchecked/added unfinished work on a done card → move it back to in_progress. */
  function reopenIfSubtasksUnfinished(task) {
    if (!task || task.status !== "done" || !Array.isArray(task.subtasks) || task.subtasks.length === 0) return false;
    if (!task.subtasks.some((subtask) => !subtask.done)) return false;
    task.status = "in_progress";
    pushHistory(task, { kind: "status", from: "done", to: "in_progress", by: "user", note: "子任务未完成，任务回到进行中" });
    return true;
  }

  /** v2 contract: progress follows subtask completion when subtasks exist. */
  function syncProgressFromSubtasks(task) {
    if (!task || (task.lockedFields || []).includes("progress")) return false;
    const next = progressFromSubtasks(task.subtasks);
    if (next === null || task.progress === next) return false;
    task.progress = next;
    return true;
  }

  function goalObjectFor(analysis, context, status) {
    const sessionGoal = context?.sessionGoal;
    const text = clipText(sessionGoal?.text || analysis?.goalText || analysis?.goal || "", 160);
    const doneStatus = status === "done" ? "done" : null;
    if (sessionGoal?.text) {
      return { text, status: sessionGoal.status === "done" || doneStatus === "done" ? "done" : "active", source: "session" };
    }
    return { text, status: doneStatus === "done" ? "done" : text ? "active" : "none", source: "task" };
  }

  /** goal.status must follow task.status (active/done; none when no goal text). */
  function syncGoalStatus(task) {
    if (!task || !task.goal || typeof task.goal !== "object") return false;
    const next = task.goal.text ? (task.status === "done" ? "done" : "active") : "none";
    if (task.goal.status === next) return false;
    task.goal = { ...task.goal, status: next };
    return true;
  }

  /** Keep deterministic v2 fields fresh without touching AI verdicts. */
  function refreshTaskDeterministic(task, meta, context) {
    if (!task) return false;
    let changed = false;
    const previousSubtasks = JSON.stringify(task.subtasks || []);
    const manual = (task.subtasks || []).filter((subtask) => subtask.source === "manual");
    const mergedSubtasks = mergeSubtasks((context?.subtasks || []), (task.subtasks || []).filter((s) => s.source !== "manual"), manual);
    if (JSON.stringify(mergedSubtasks) !== previousSubtasks) {
      task.subtasks = mergedSubtasks;
      changed = true;
    }
    const artifacts = mergeArtifacts(context?.artifacts || [], task.artifacts || []);
    if (JSON.stringify(artifacts) !== JSON.stringify(task.artifacts || [])) {
      task.artifacts = artifacts;
      changed = true;
    }
    if (context?.sessionContext && (!task.sessionContext || task.primarySessionId === meta.id)) {
      const nextContext = { ...context.sessionContext };
      if (JSON.stringify(nextContext) !== JSON.stringify(task.sessionContext)) {
        task.sessionContext = nextContext;
        changed = true;
      }
    }
    if (context?.sessionGoal && (!task.goal || !task.goal.text)) {
      task.goal = goalObjectFor(null, context, task.status);
      changed = true;
    }
    if (closeSubtasksForDoneTask(task)) changed = true;
    if (syncProgressFromSubtasks(task)) changed = true;
    if (task.status === "done" && !(task.lockedFields || []).includes("progress") && task.progress !== 100) {
      task.progress = 100;
      changed = true;
    }
    if (syncGoalStatus(task)) changed = true;
    if (changed) {
      attachSession(task, meta, (task.evidence || []).length);
      task.lastActivityAt = Math.max(task.lastActivityAt || 0, meta.lastActivityAt || 0);
      task.updatedAt = new Date().toISOString();
      truncateTask(task);
    }
    return changed;
  }

  /**
   * Meaningful-change gate (v2 token efficiency).
   * Re-judge only when: first analysis, a turn ended after the last analysis, or
   * a new user message arrived (after the cooldown). Live turns wait for their
   * end — tool-only appends never trigger an LLM call.
   */
  function shouldRunAi(meta, cachedMeta) {
    if (!cachedMeta || !cachedMeta.aiAt) return true; // first analysis
    const lastAiSeq = Number(cachedMeta.aiLastSeq) || 0;
    const lastEndSeq = Number(meta.lastTurnEnd?.seq) || 0;
    const turnEndedSince = lastEndSeq > lastAiSeq;
    const userIncreased = (meta.userCount || 0) > (cachedMeta.aiUserCount || 0);
    const intervalOk = Date.now() - (Date.parse(cachedMeta.aiAt) || 0) >= MIN_AI_INTERVAL_MS;
    if (!intervalOk) return false;
    if (meta.isLive) {
      // Same live turn: wait for the turn to finish before spending tokens.
      return turnEndedSince;
    }
    return turnEndedSince || userIncreased;
  }

  /** Very small sessions are cheap to card with rules only. */
  function isLowValueForAi(meta) {
    const userCount = meta.userCount || 0;
    const eventCount = meta.eventCount || 0;
    const signals = (meta.deliverableCount || 0) + (meta.errorCount || 0);
    return userCount < 2 && eventCount < 60 && signals === 0;
  }

  function dailyAiRemaining() {
    const usage = rolloverUsage(state.usage);
    state.usage = usage;
    return Math.max(0, (state.settings.dailyAiCallLimit || DEFAULT_SETTINGS.dailyAiCallLimit) - usage.calls);
  }

  function recordUsage({ calls = 0, tokens = 0 } = {}) {
    state.usage = rolloverUsage(state.usage);
    state.usage.calls += Math.max(0, Number(calls) || 0);
    state.usage.tokens += Math.max(0, Number(tokens) || 0);
  }

  function applyAiMeta(metaId, meta, { digestBytes = 0 } = {}) {
    const entry = cache.sessions[metaId] || { sigKey: meta.sigKey, meta };
    entry.meta = {
      ...(entry.meta || meta),
      aiAt: new Date().toISOString(),
      aiLastSeq: meta.lastEventSeq || 0,
      aiUserCount: meta.userCount || 0,
      aiTurnEndKind: meta.lastTurnEnd?.kind || null,
      aiDigestBytes: digestBytes || 0,
    };
    cache.sessions[metaId] = entry;
    sessionsById.set(metaId, entry.meta);
    return entry.meta;
  }

  /* ------------------------------ scan ----------------------------- */

  function findTaskBySession(sessionId) {
    if (!sessionId) return null;
    return (
      state.tasks.find(
        (task) =>
          task.origin !== "manual" &&
          (task.primarySessionId === sessionId ||
            (Array.isArray(task.sessions) && task.sessions.some((session) => session.id === sessionId))),
      ) || null
    );
  }

  /* --------------------- cross-session duplicate merge --------------- */

  function normalizeTitleKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function titleBigrams(value) {
    const text = normalizeTitleKey(value);
    const set = new Set();
    for (let index = 0; index < text.length - 1; index++) set.add(text.slice(index, index + 2));
    return set;
  }

  function titleBigramSimilarity(left, right) {
    const a = titleBigrams(left);
    const b = titleBigrams(right);
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const gram of a) if (b.has(gram)) overlap += 1;
    return overlap / (a.size + b.size - overlap);
  }

  function titleCharOverlap(left, right) {
    const a = new Set(normalizeTitleKey(left));
    const b = new Set(normalizeTitleKey(right));
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const char of a) if (b.has(char)) overlap += 1;
    return overlap / Math.min(a.size, b.size);
  }

  /** Conservative duplicate score: bigram Jaccard, char overlap discounted. */
  function titleMergeScore(left, right) {
    return Math.max(titleBigramSimilarity(left, right), titleCharOverlap(left, right) * 0.9);
  }

  function dedupeByText(items, limit) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
      if (!item || typeof item.text !== "string") continue;
      const key = item.text.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Merge auto tasks that describe the same ongoing work (same workspace +
   * similar title), e.g. the same "workspace audit" run in two sessions.
   * Manual / user-edited / locked cards are never merged.
   */
  function mergeDuplicateTasks() {
    const me = [];
    for (const task of state.tasks) {
      if (task.archived) continue;
      if (task.origin !== "auto") continue; // manual + auto+edited are protected
      if ((task.lockedFields || []).length > 0) continue;
      me.push(task);
    }
    let mergedCount = 0;
    for (;;) {
      let best = null;
      for (let i = 0; i < me.length; i++) {
        const left = me[i];
        if (!left || !state.tasks.includes(left)) continue;
        for (let j = i + 1; j < me.length; j++) {
          const right = me[j];
          if (!right || !state.tasks.includes(right)) continue;
          if (!left.workspaceId || left.workspaceId !== right.workspaceId) continue;
          const sameSession = left.primarySessionId && left.primarySessionId === right.primarySessionId;
          const score = titleMergeScore(left.title, right.title);
          // Cards split from the very same session are usually intentional;
          // only accept near-identical titles for them.
          const threshold = sameSession ? 0.85 : 0.62;
          if (score < threshold) continue;
          if (!best || score > best.score) best = { left, right, score };
        }
      }
      if (!best) break;
      const [target, source] =
        (Date.parse(best.left.createdAt) || 0) <= (Date.parse(best.right.createdAt) || 0)
          ? [best.left, best.right]
          : [best.right, best.left];
      mergeTaskInto(target, source);
      mergedCount += 1;
    }
    return mergedCount;
  }

  function mergeTaskInto(target, source) {
    const nowIso = new Date().toISOString();
    const targetLastActivity = target.lastActivityAt || 0;
    const sessionMap = new Map();
    for (const session of [...(target.sessions || []), ...(source.sessions || [])]) {
      if (session?.id && !sessionMap.has(session.id)) sessionMap.set(session.id, session);
    }
    target.sessions = [...sessionMap.values()].slice(0, MAX_SESSIONS_PER_TASK);
    if (!target.primarySessionId) target.primarySessionId = source.primarySessionId;
    target.evidence = mergeTaskEvidence(target.evidence, source.evidence);
    target.issues = dedupeByText([...(target.issues || []), ...(source.issues || [])], 8);
    target.milestones = dedupeByText([...(target.milestones || []), ...(source.milestones || [])], 20);
    target.nextSteps = dedupeByText(
      [...(target.nextSteps || []).map((text) => ({ text })), ...(source.nextSteps || []).map((text) => ({ text }))],
      5,
    ).map((item) => item.text);
    target.lastActivityAt = Math.max(target.lastActivityAt || 0, source.lastActivityAt || 0);
    const sourceIsNewer = (source.lastActivityAt || 0) > targetLastActivity;
    // v2 fields merge: key facts / subtasks / artifacts / goal / sessionContext.
    target.keyFacts = mergeKeyFacts(target.keyFacts || [], source.keyFacts || []);
    target.subtasks = mergeSubtasks(source.subtasks || [], target.subtasks || []);
    target.artifacts = mergeArtifacts(target.artifacts || [], source.artifacts || []);
    if ((!target.goal || !target.goal.text) && source.goal?.text) target.goal = { ...source.goal };
    if (!target.sessionContext && source.sessionContext) target.sessionContext = { ...source.sessionContext };
    if (sourceIsNewer && source.sessionContext && target.primarySessionId === source.primarySessionId) {
      target.sessionContext = { ...source.sessionContext };
    }
    // The newer card carries the freshest verdict (status/progress/AI reason).
    if (sourceIsNewer && !(target.lockedFields || []).includes("status")) target.status = source.status;
    if (!(target.lockedFields || []).includes("progress")) {
      const subtaskProgress = progressFromSubtasks(target.subtasks);
      if (subtaskProgress !== null) target.progress = subtaskProgress;
      else if (sourceIsNewer) target.progress = source.progress;
    }
    if (source.ai && (!target.ai || Date.parse(source.ai.analyzedAt || 0) > Date.parse(target.ai.analyzedAt || 0))) {
      target.ai = source.ai;
    }
    refreshSessionEvidenceCounts(target);
    target.updatedAt = nowIso;
    pushHistory(target, {
      kind: "merge",
      by: "ai",
      note: `合并重复会话：${clipText(source.title, 60)}`,
    });
    state.tasks = state.tasks.filter((task) => task.id !== source.id);
    state.deletedLog.push({
      id: source.id,
      title: source.title,
      origin: source.origin,
      deletedAt: nowIso,
      sessionIds: (source.sessions || []).map((session) => session.id),
      reason: "merge",
      mergedInto: target.id,
    });
    if (state.deletedLog.length > 50) state.deletedLog = state.deletedLog.slice(-50);
    truncateTask(target);
    logger?.info?.(`[super-kanban] merged duplicate task「${clipText(source.title, 30)}」into「${clipText(target.title, 30)}」`);
  }

  function sessionEntryFromMeta(meta, evidenceCount = 0) {
    return {
      id: meta.id,
      title: meta.title || `会话 ${String(meta.id).slice(-6)}`,
      seqEnd: meta.lastEventSeq || 0,
      evidenceCount,
    };
  }

  function isEligibleForAutoTask(meta, cutoff) {
    if (meta.origin !== "main") return false;
    if (!meta.hasUserMessages) return false;
    if (state.ignoredSessions.includes(meta.id)) return false;
    if (state.suppressedSessions.includes(meta.id)) return false;
    if (meta.workspaceId && (state.settings.excludeWorkspaces || []).includes(meta.workspaceId)) return false;
    const bound = findTaskBySession(meta.id);
    const tooOld = meta.lastActivityAt && meta.lastActivityAt < cutoff;
    if (!bound && tooOld) return false;
    return true;
  }

  function promptCandidateTasks(meta) {
    const bound = findTaskBySession(meta.id);
    const result = [];
    if (bound) result.push(bound);
    for (const task of state.tasks) {
      if (result.length >= 6) break;
      if (task.origin === "manual" || task.archived) continue;
      if (result.includes(task)) continue;
      if (meta.workspaceId && task.workspaceId === meta.workspaceId) result.push(task);
    }
    return result.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      progress: task.progress,
      sessions: task.sessions,
    }));
  }

  /** Build the compact meta object persisted in sessions-cache.json. */
  function cacheEntryFor(parsed, discovered) {
    const meta = source.metaFromParsed(parsed);
    const previous = cache.sessions[meta.id]?.meta || null;
    meta.workspaceId = discovered?.workspaceId ?? previous?.workspaceId ?? null;
    meta.workspaceTitle = discovered?.workspaceTitle ?? previous?.workspaceTitle ?? null;
    meta.workspacePath = discovered?.workspacePath ?? previous?.workspacePath ?? null;
    meta.goalText = discovered?.goalText ?? meta.goalText ?? previous?.goalText ?? null;
    meta.goalStatus = discovered?.goalStatus ?? meta.goalStatus ?? previous?.goalStatus ?? null;
    meta.turnOutline = parsed.turnOutline || previous?.turnOutline || [];
    // Keep the meaningful-change gate markers across re-parses.
    meta.aiAt = previous?.aiAt || null;
    meta.aiLastSeq = previous?.aiLastSeq || 0;
    meta.aiUserCount = previous?.aiUserCount || 0;
    meta.aiTurnEndKind = previous?.aiTurnEndKind ?? null;
    meta.aiDigestBytes = previous?.aiDigestBytes || 0;
    meta.llmError = previous?.llmError || null;
    return { sigKey: meta.sigKey, meta };
  }

  function hydrateMeta(discovered) {
    const cached = cache.sessions[discovered.id];
    const meta = cached?.meta
      ? { ...cached.meta }
      : {
          id: discovered.id,
          file: discovered.file,
          dir: discovered.dir,
          sig: discovered.sig,
          sigKey: discovered.sigKey,
          title: discovered.title,
          createdAt: discovered.createdAt,
          cwd: discovered.cwd,
          parentSession: discovered.parentSession,
          delegationDepth: discovered.delegationDepth,
          origin: discovered.origin,
          lastActivityAt: discovered.lastActivityAt,
          lastEventSeq: 0,
          eventCount: 0,
          turnCount: discovered.turnCount,
          isLive: false,
          hasUserMessages: false,
          userCount: 0,
          deliverableCount: 0,
          errorCount: 0,
          todoCounts: { total: 0, completed: 0, pending: 0, inProgress: 0 },
          turnOutline: discovered.turnOutline,
          activity: {},
          aiAt: null,
        };
    // Workspace registry can change between scans — always trust discovery.
    meta.workspaceId = discovered.workspaceId ?? meta.workspaceId ?? null;
    meta.workspaceTitle = discovered.workspaceTitle ?? meta.workspaceTitle ?? null;
    meta.workspacePath = discovered.workspacePath ?? meta.workspacePath ?? null;
    meta.goalText = discovered.goalText ?? meta.goalText ?? null;
    meta.goalStatus = discovered.goalStatus ?? meta.goalStatus ?? null;
    meta.file = discovered.file;
    meta.dir = discovered.dir;
    meta.sig = discovered.sig;
    meta.sigKey = discovered.sigKey;
    return meta;
  }

  function collectSubagentSummary(parsed, meta) {
    return {
      id: parsed.id,
      title: parsed.title,
      isLive: parsed.isLive,
      lastActivityAt: parsed.lastActivityAt,
      lastEventSeq: parsed.lastEvent?.seq || 0,
      eventCount: parsed.eventCount,
      turnEndKind: parsed.lastTurnEnd?.kind || null,
      lastAssistantText: parsed.lastAssistantText?.text || "",
      deliverables: parsed.deliverables.length,
    };
  }

  /**
   * Fold subagent sessions into the parent task as evidence items, so the board
   * stays clean (no cards for subagents) while their work remains traceable.
   */
  function foldChildEvidence(analysis, meta, childSummaries) {
    const childIds = parentToChildren.get(meta.id) || [];
    if (!childIds.length) return analysis;
    const extra = [];
    for (const childId of childIds) {
      const child = childSummaries.get(childId);
      if (!child) continue;
      const stateLabel = child.isLive ? "进行中" : child.turnEndKind === "error" ? "以错误结束" : "已完成";
      const kind = child.isLive ? "tool" : "artifact";
      extra.push({
        id: `e_${childId.slice(-6)}_subagent`,
        kind,
        text: `子代理会话「${clipText(child.title, 40)}」${stateLabel}（${child.eventCount} 事件${child.deliverables ? `，${child.deliverables} 次交付` : ""}）`,
        quote: clipText(child.lastAssistantText || child.title, 240),
        seq: child.lastEventSeq,
        time: child.lastActivityAt,
        sessionId: child.id,
        sessionTitle: child.title,
      });
    }
    if (!extra.length) return analysis;
    const merged = [...(analysis.evidence || []), ...extra];
    return { ...analysis, evidence: merged.slice(0, EVIDENCE_LIMIT) };
  }

  /** Parse one discovered session; updates cache; returns parse result. */
  function parseDiscovered(discovered) {
    const meta = hydrateMeta(discovered);
    const parsed = source.loadParsed(meta);
    return { parsed, meta };
  }

  function startScan(mode = "incremental") {
    if (stopped) return { ok: false, error: "stopped", message: "服务已停止" };
    if (scanPromise) return { ok: false, error: "busy", message: "扫描正在进行中" };
    const scanMode = mode === "full" ? "full" : "incremental";
    scanCancel = false;
    scanAbort = new AbortController();
    const startedAt = new Date();
    state.scan = {
      ...emptyScanState(),
      state: "running",
      startedAt: startedAt.toISOString(),
      message: "正在发现会话…",
    };
    scanDigestBytes = [];
    broadcastScan(true);
    scanPromise = (async () => {
      let failure = null;
      try {
        await runScanBody(scanMode);
      } catch (error) {
        failure = error;
        logger?.warn?.(`[super-kanban] scan failed: ${String(error?.message || error)}`);
      } finally {
        const finishedAt = new Date();
        state.scan.state = failure ? "error" : "done";
        state.scan.finishedAt = finishedAt.toISOString();
        state.scan.error = failure ? String(failure?.message || failure) : null;
        if (failure) state.scan.message = `扫描失败：${state.scan.error}`;
        else if (scanCancel) state.scan.message = "扫描已取消（已完成部分保留）";
        else if (!state.scan.message || !String(state.scan.message).startsWith("扫描完成")) {
          state.scan.message = `扫描完成：${state.scan.processed}/${state.scan.total} 个会话`;
        }
        state.settings.lastScanAt = finishedAt.toISOString();
        state.activity = computeActivity();
        const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
        const digestBytesAvg =
          scanDigestBytes.length > 0
            ? Math.round(scanDigestBytes.reduce((sum, value) => sum + value, 0) / scanDigestBytes.length)
            : 0;
        state.usage = rolloverUsage(state.usage);
        state.usage.lastScan = {
          calls: state.scan.aiCalls,
          tokens: state.scan.tokens,
          durationMs,
          digestBytesAvg,
        };
        recordUsage({ calls: state.scan.aiCalls, tokens: state.scan.tokens });
        persistState();
        persistCache();
        scanPromise = null;
        scanAbort = null;
        broadcastScan(true);
        emitChanged("scan", state.scan.newTasks + state.scan.updatedTasks);
        logger?.info?.(
          `[super-kanban] scan ${failure ? "failed" : "done"} · processed=${state.scan.processed}/${state.scan.total} · new=${state.scan.newTasks} updated=${state.scan.updatedTasks} aiCalls=${state.scan.aiCalls}`,
        );
      }
    })();
    return { ok: true, data: { accepted: true, mode: scanMode, startedAt: state.scan.startedAt } };
  }

  async function runScanBody(mode) {
    const discovery = source.discover();
    parentToChildren = new Map();
    for (const [parentId, childId] of discovery.childToParent || []) {
      if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
      parentToChildren.get(parentId).push(childId);
    }
    const discoverySessions = discovery.sessions;
    state.scan.total = discoverySessions.length;
    state.scan.message = `发现 ${discoverySessions.length} 个会话，开始分析…`;
    broadcastScan(true);

    const cutoff = Date.now() - (state.settings.initialDays || 30) * DAY;
    const childSummaries = new Map();
    let orphanMerged = 0;
    let lowValueSkipped = 0;
    let aiBudgetExhausted = false;
    scanDigestBytes = [];
    /** @type {Array<{meta:object, digest:string, rules:object, context:object, needsAi:boolean}>} */
    const analysisJobs = [];

    for (const discovered of discoverySessions) {
      if (stopped || scanCancel) break;
      state.scan.processed += 1;
      try {
        const cached = cache.sessions[discovered.id];
        const changed = !cached || cached.sigKey !== discovered.sigKey;
        let meta = hydrationSafe(discovered);
        let parsed = null;
        const preEligible = meta ? isEligibleForAutoTask(meta, cutoff) : false;
        const aiMissing = state.settings.aiEnabled && !cached?.meta?.aiAt;
        const forceMainParse =
          preEligible && (mode === "full" || changed || !findTaskBySession(discovered.id) || aiMissing);
        if (changed || forceMainParse) {
          try {
            const result = parseDiscovered(discovered);
            parsed = result.parsed;
            const entry = cacheEntryFor(parsed, discovered);
            meta = entry.meta;
            cache.sessions[discovered.id] = entry;
          } catch (error) {
            cache.sessions[discovered.id] = cache.sessions[discovered.id] || {
              sigKey: discovered.sigKey,
              meta: { ...meta, parseError: String(error?.message || error) },
            };
            logger?.warn?.(`[super-kanban] skip session ${discovered.id}: ${String(error?.message || error)}`);
            continue;
          }
        } else if (meta) {
          cache.sessions[discovered.id] = { sigKey: discovered.sigKey, meta };
        }
        if (!meta) continue;
        const cachedMeta = cached?.meta || null;
        // Re-evaluate eligibility with fresh parse data (first scan has no cache).
        const eligible = isEligibleForAutoTask(meta, cutoff);
        if (parsed && meta.origin === "subagent") childSummaries.set(meta.id, collectSubagentSummary(parsed, meta));
        sessionsById.set(discovered.id, meta);
        if (parsed && eligible) {
          parsed.evidence = source.collectEvidence(parsed);
          const workspaceTitle = meta.workspaceTitle;
          const rules = analyzeSessionRules(parsed, {
            workspaceTitle,
            workspacePath: meta.workspacePath,
            maxTasks: state.settings.maxTasksPerSession || 3,
          });
          const context = buildV2Context(parsed, meta, workspaceTitle);
          // v2 token gate: low-value sessions and unchanged verdict inputs stay rules-only.
          const lowValue = isLowValueForAi(meta);
          if (lowValue) lowValueSkipped += 1;
          const aiDue = state.settings.aiEnabled && !lowValue && shouldRunAi(meta, cachedMeta);
          let digest = "";
          let digestBytes = 0;
          if (aiDue) {
            digest = source.buildDigest(parsed, {
              workspaceTitle,
              existingTasks: promptCandidateTasks(meta),
              baselineSeq: cachedMeta?.aiLastSeq || 0,
            });
            digestBytes = Buffer.byteLength(digest, "utf8");
            scanDigestBytes.push(digestBytes);
          }
          analysisJobs.push({
            meta,
            changed,
            digest,
            digestBytes,
            rules,
            context,
            lowValue,
            needsAi: aiDue,
          });
        }
        if (state.scan.processed % 4 === 0) {
          state.scan.message = `分析 ${state.scan.processed}/${state.scan.total} 个会话…`;
          broadcastScan();
        }
      } catch (error) {
        // One broken session must never break the scan.
        logger?.warn?.(`[super-kanban] session ${discovered.id} failed: ${String(error?.message || error)}`);
      }
      if (state.scan.processed % 6 === 0) schedulePersist();
    }

    // Phase B: LLM analysis (meaningful-change gate + per-scan/daily budgets).
    if (state.settings.aiEnabled && !scanCancel && !stopped && analysisJobs.length > 0) {
      const dailyRemaining = dailyAiRemaining();
      const perScanLimit = state.settings.maxAiCallsPerScan || DEFAULT_SETTINGS.maxAiCallsPerScan;
      const scanBudget = Math.max(0, Math.min(perScanLimit, dailyRemaining));
      analyzer.resetBudget(scanBudget);
      const aiJobs = analysisJobs.filter((job) => job.needsAi);
      if (aiJobs.length > 0) {
        if (!analyzer.hasCredential()) {
          state.scan.message = "未找到账号凭证，使用规则引擎分析";
          logger?.warn?.("[super-kanban] no DeepSeek account credential found; falling back to rules engine");
        } else if (scanBudget <= 0) {
          aiBudgetExhausted = true;
          state.scan.message = `今日 AI 预算已用完（${state.usage.calls}/${state.settings.dailyAiCallLimit}），本次仅规则分析`;
          for (const job of aiJobs) job.llmBudgetExceeded = true;
          logger?.warn?.("[super-kanban] daily AI budget exhausted; rules only this scan");
        } else {
          state.scan.message = `AI 研判 ${aiJobs.length} 个会话（预算 ${scanBudget}）…`;
          broadcastScan(true);
          for (let index = 0; index < aiJobs.length; index += MAX_AI_CONCURRENCY) {
            if (scanCancel || stopped) break;
            if (state.scan.aiCalls >= scanBudget) {
              aiBudgetExhausted = true;
              for (const job of aiJobs.slice(index)) job.llmBudgetExceeded = true;
              break;
            }
            const batch = aiJobs.slice(index, index + MAX_AI_CONCURRENCY);
            await Promise.all(
              batch.map(async (job) => {
                const result = await analyzer.analyze({
                  digest: job.digest,
                  existingTasks: promptCandidateTasks(job.meta),
                  model: state.settings.model,
                  signal: scanAbort?.signal,
                });
                if (result.ok) {
                  job.llm = result;
                  state.scan.aiCalls += 1;
                  state.scan.tokens += result.usage?.totalTokens || 0;
                } else if (result.code === "budget") {
                  job.llmBudgetExceeded = true;
                } else if (result.code !== "aborted") {
                  job.llmError = result.error;
                  const jobMeta = job.meta;
                  const entry = cache.sessions[jobMeta.id] || { sigKey: jobMeta.sigKey, meta: jobMeta };
                  entry.meta = { ...(entry.meta || jobMeta), llmError: result.error };
                  cache.sessions[jobMeta.id] = entry;
                  logger?.warn?.(`[super-kanban] LLM analysis degraded to rules: ${result.error}`);
                }
              }),
            );
            state.scan.message = `AI 研判 ${Math.min(state.scan.aiCalls, aiJobs.length)}/${aiJobs.length} 个会话…`;
            broadcastScan();
          }
        }
      }
    }

    // Phase C: merge analyses into the board.
    for (const job of analysisJobs) {
      if (stopped) break;
      if (scanCancel) break;
      const { meta, rules, context } = job;
      let applied = 0;
      try {
        if (job.llm) {
          if (job.llm.ignore) {
            applyAiMeta(meta.id, meta, { digestBytes: job.digestBytes });
            continue;
          }
          const normalized = job.llm.tasks
            .slice(0, Math.max(1, state.settings.maxTasksPerSession || 3))
            .map((raw) => normalizeAnalysis(raw, context, { engine: "llm", model: job.llm.model || state.settings.model }))
            .filter(Boolean)
            .map((analysis) => ({
              ...analysis,
              evidence: mergeTaskEvidence(analysis.evidence, rules.tasks?.[0]?.evidence || []),
              keyFacts: mergeKeyFacts(analysis.keyFacts, rules.tasks?.[0]?.keyFacts || []),
            }));
          if (normalized.length > 0) {
            const result = applyAnalysisList(normalized, meta, context, {
              engine: "llm",
              model: job.llm.model || state.settings.model,
              rules,
              childSummaries,
              context,
            });
            applied = result.applied;
            orphanMerged += pruneSessionOrphans(meta, result.targets);
          } else {
            applied = applyAnalysisList(rules.tasks, meta, context, {
              engine: "rules",
              model: state.settings.model,
              rules,
              childSummaries,
              context,
            }).applied;
          }
          applyAiMeta(meta.id, meta, { digestBytes: job.digestBytes });
        } else {
          // No AI this round (gated / low-value / budget / failure): never
          // downgrade an existing LLM verdict — only refresh deterministic v2
          // fields (sessionContext/artifacts/subtasks/progress).
          const bound = findTaskBySession(meta.id);
          const hasAiVerdict = Boolean(bound && bound.ai && bound.ai.engine === "llm");
          if (hasAiVerdict) {
            refreshTaskDeterministic(bound, meta, context);
          } else {
            applied = applyAnalysisList(rules.tasks, meta, context, {
              engine: "rules",
              model: state.settings.model,
              rules,
              childSummaries,
              context,
            }).applied;
          }
        }
        if (applied > 0) schedulePersist();
      } catch (error) {
        logger?.warn?.(`[super-kanban] merge failed for ${meta.id}: ${String(error?.message || error)}`);
      }
    }

    // Phase C2: collapse auto tasks that describe the same work.
    const mergedTasks = mergeDuplicateTasks() + orphanMerged;

    // Phase D: persist derived board data.
    state.workspaces = computeWorkspaces(discovery.workspaces, [...sessionsById.values()]);
    state.activity = computeActivity();
    if (scanCancel) {
      state.scan.message = "扫描已取消";
    } else {
      const parts = [`扫描完成：${state.scan.processed}/${state.scan.total} 个会话`];
      if (state.scan.aiCalls > 0) parts.push(`AI ${state.scan.aiCalls} 次/${state.scan.tokens} tokens`);
      else if (state.settings.aiEnabled) parts.push("本次无 AI 调用");
      if (lowValueSkipped > 0) parts.push(`低价值跳过 ${lowValueSkipped}`);
      if (aiBudgetExhausted) parts.push(`预算已用完（${state.usage.calls}/${state.settings.dailyAiCallLimit}）其余仅规则`);
      if (mergedTasks > 0) parts.push(`合并重复卡 ${mergedTasks}`);
      state.scan.message = parts.join(" · ");
    }
    broadcastScan(true);
    // Cache entries for sessions that were never parsed keep their old meta.
    for (const discovered of discoverySessions) {
      if (!cache.sessions[discovered.id]) {
        cache.sessions[discovered.id] = { sigKey: discovered.sigKey, meta: hydrateMeta(discovered) };
      }
    }
    pruneCache(discoverySessions);
  }

  function hydrationSafe(discovered) {
    try {
      return hydrateMeta(discovered);
    } catch {
      return null;
    }
  }

  function pruneCache(discoveredSessions) {
    const alive = new Set(discoveredSessions.map((session) => session.id));
    for (const id of Object.keys(cache.sessions)) if (!alive.has(id)) delete cache.sessions[id];
    for (const [id, meta] of sessionsById) if (!alive.has(id)) sessionsById.delete(id);
  }

  /* ------------------------------ merge ---------------------------- */

  function attachSession(task, meta, evidenceCount) {
    const entry = sessionEntryFromMeta(meta, evidenceCount);
    const existing = task.sessions.find((session) => session.id === entry.id);
    if (existing) {
      existing.title = entry.title;
      existing.seqEnd = entry.seqEnd;
      existing.evidenceCount = entry.evidenceCount;
    } else if (task.sessions.length < MAX_SESSIONS_PER_TASK) {
      task.sessions.push(entry);
    }
  }

  function resolveTargetTask(analysis, meta, index) {
    const stableId = stableTaskId(meta.id, index);
    const byStable = state.tasks.find((task) => task.id === stableId && task.origin !== "manual");
    if (byStable) return byStable;
    if (index === 0) {
      const bound = findTaskBySession(meta.id);
      if (bound) return bound;
    }
    if (analysis.mergeWith) {
      const explicit = state.tasks.find((task) => task.id === analysis.mergeWith && task.origin !== "manual");
      if (explicit) return explicit;
    }
    // Similar-title merge inside the same workspace (stable enough for rules).
    let best = null;
    let bestScore = 0;
    for (const candidate of state.tasks) {
      if (candidate.origin === "manual" || candidate.archived) continue;
      if (candidate.id === stableId) continue;
      if ((candidate.workspaceId || null) !== (meta.workspaceId || null)) continue;
      if (candidate.sessions.some((session) => session.id === meta.id)) continue;
      const score = titleSimilarity(candidate.title, analysis.title);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return bestScore >= 0.72 ? best : null;
  }

  function applyAnalysisList(analyses, meta, context, options) {
    const targets = [];
    analyses.forEach((analysis, index) => {
      const withChildren = index === 0 ? foldChildEvidence(analysis, meta, options.childSummaries) : analysis;
      const target = resolveTargetTask(withChildren, meta, index);
      const stableId = stableTaskId(meta.id, index);
      if (target) {
        updateTaskFromAnalysis(target, withChildren, meta, options);
        targets.push(target);
      } else {
        targets.push(createTaskFromAnalysis(withChildren, meta, stableId, options));
        state.scan.newTasks += 1;
      }
    });
    return { applied: targets.length, targets };
  }

  /**
   * When a session's fresh analysis yields fewer cards than before (e.g. the
   * model merged two splits), fold the now-orphaned auto cards back into the
   * primary card instead of leaving stale duplicates on the board.
   */
  function pruneSessionOrphans(meta, targets) {
    if (!targets.length) return 0;
    const keep = new Set(targets.map((task) => task.id));
    const primary = targets[0];
    const orphans = state.tasks.filter(
      (task) =>
        task.origin === "auto" &&
        !task.archived &&
        task.primarySessionId === meta.id &&
        !keep.has(task.id) &&
        (task.lockedFields || []).length === 0 &&
        (task.sessions || []).length <= 1,
    );
    for (const orphan of orphans) {
      mergeTaskInto(primary, orphan);
    }
    return orphans.length;
  }

  /**
   * Merge LLM-picked evidence with rules-extracted evidence (dedupe by
   * session+kind+seq). The LLM picks the most salient quotes; rules fill the
   * traceability gaps so every card keeps a usable timeline.
   */
  function mergeTaskEvidence(primary, secondary = [], limit = EVIDENCE_LIMIT) {
    const merged = [];
    const seen = new Set();
    for (const source of [primary || [], secondary || []]) {
      for (const item of source) {
        if (!item || typeof item !== "object") continue;
        const key = `${item.sessionId || ""}:${item.kind || ""}:${item.seq ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    merged.sort((left, right) => (left.time || 0) - (right.time || 0) || (left.seq || 0) - (right.seq || 0));
    if (merged.length <= limit) return merged;
    // Keep the opening context (first 6) plus the most recent evidence.
    return [...merged.slice(0, 6), ...merged.slice(-(limit - 6))];
  }

  /** Keep sessions[].evidenceCount truthful after evidence merges/refreshes. */
  function refreshSessionEvidenceCounts(task) {
    if (!task || !Array.isArray(task.evidence) || !Array.isArray(task.sessions)) return;
    const counts = new Map();
    for (const item of task.evidence) {
      if (!item || !item.sessionId) continue;
      counts.set(item.sessionId, (counts.get(item.sessionId) || 0) + 1);
    }
    for (const session of task.sessions) session.evidenceCount = counts.get(session.id) || 0;
  }

  function analysisAiInfo(analysis, { engine, model }) {
    return {
      analyzedAt: new Date().toISOString(),
      model: model || state.settings.model || DEFAULT_SETTINGS.model,
      confidence: Number.isFinite(analysis.confidence) ? analysis.confidence : null,
      reason: analysis.reason || "",
      engine,
    };
  }

  function createTaskFromAnalysis(analysis, meta, taskId, options) {
    const nowIso = new Date().toISOString();
    const context = options.context || {};
    const subtasks = mergeSubtasks(analysis.subtasks || [], context.subtasks || []);
    const progress = progressFromSubtasks(subtasks) ?? (Number.isFinite(analysis.progress) ? analysis.progress : null);
    const goal = goalObjectFor(analysis, context, analysis.status);
    const task = {
      id: taskId,
      title: clipText(analysis.title, 60),
      goal,
      status: STATUSES.includes(analysis.status) ? analysis.status : "backlog",
      progress,
      priority: PRIORITIES.includes(analysis.priority) ? analysis.priority : "P2",
      tags: Array.isArray(analysis.tags) ? analysis.tags.slice(0, 4) : [],
      origin: "auto",
      workspaceId: meta.workspaceId || null,
      workspaceTitle: meta.workspaceTitle || null,
      workspacePath: meta.workspacePath || null,
      sessions: [sessionEntryFromMeta(meta, (analysis.evidence || []).length)],
      primarySessionId: meta.id,
      keyFacts: mergeKeyFacts(analysis.keyFacts || [], []),
      subtasks,
      artifacts: mergeArtifacts(context.artifacts || [], []),
      sessionContext: context.sessionContext ? { ...context.sessionContext } : null,
      issues: analysis.issues || [],
      nextSteps: analysis.nextSteps || [],
      milestones: analysis.milestones || [],
      evidence: mergeTaskEvidence(analysis.evidence),
      ai: analysisAiInfo(analysis, options),
      lockedFields: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      lastActivityAt: meta.lastActivityAt || Date.now(),
      archived: false,
      history: [],
    };
    closeSubtasksForDoneTask(task);
    syncProgressFromSubtasks(task);
    if (task.status === "done") task.progress = 100;
    syncGoalStatus(task);
    refreshSessionEvidenceCounts(task);
    pushHistory(task, {
      kind: "create",
      by: "ai",
      note: `${options.engine} 引擎从会话「${clipText(meta.title || meta.id, 40)}」自动建卡`,
    });
    truncateTask(task);
    state.tasks.push(task);
    return task;
  }

  function updateTaskFromAnalysis(task, analysis, meta, options) {
    const locked = new Set(Array.isArray(task.lockedFields) ? task.lockedFields : []);
    const context = options.context || {};
    const nowIso = new Date().toISOString();
    let otherChanged = false;
    const setField = (field, value) => {
      if (locked.has(field)) return false;
      if (value === undefined || value === null) return false;
      const current = task[field];
      const same = Array.isArray(value) && Array.isArray(current) ? JSON.stringify(value) === JSON.stringify(current) : current === value;
      if (same) return false;
      task[field] = value;
      return true;
    };

    if (setField("title", clipText(analysis.title, 60))) otherChanged = true;
    if (setField("priority", PRIORITIES.includes(analysis.priority) ? analysis.priority : undefined)) otherChanged = true;
    if (setField("tags", Array.isArray(analysis.tags) ? analysis.tags.slice(0, 4) : undefined)) otherChanged = true;
    if (setField("issues", analysis.issues)) otherChanged = true;
    if (setField("nextSteps", analysis.nextSteps)) otherChanged = true;
    if (!locked.has("milestones") && Array.isArray(analysis.milestones) && analysis.milestones.length > 0) {
      task.milestones = analysis.milestones;
    }
    if (!locked.has("keyFacts") && Array.isArray(analysis.keyFacts) && analysis.keyFacts.length > 0) {
      const nextFacts = mergeKeyFacts(analysis.keyFacts, (task.keyFacts || []).slice(0, 2));
      if (JSON.stringify(nextFacts) !== JSON.stringify(task.keyFacts || [])) {
        task.keyFacts = nextFacts;
        otherChanged = true;
      }
    }

    if (!locked.has("goal")) {
      const nextGoal = context.sessionGoal?.text
        ? goalObjectFor(analysis, context, analysis.status)
        : { ...(task.goal || { text: "", status: "none", source: "task" }) };
      if (!context.sessionGoal?.text && analysis.goalText) {
        nextGoal.text = clipText(analysis.goalText, 160);
        nextGoal.source = "task";
      }
      nextGoal.status = nextGoal.text ? (analysis.status === "done" ? "done" : nextGoal.status === "done" ? "done" : "active") : "none";
      if (JSON.stringify(nextGoal) !== JSON.stringify(task.goal)) {
        task.goal = nextGoal;
        otherChanged = true;
      }
    }

    // Subtasks: deterministic todo import + LLM subtasks + user's manual items.
    if (!locked.has("subtasks")) {
      const manual = (task.subtasks || []).filter((subtask) => subtask.source === "manual");
      const mergedSubtasks = mergeSubtasks(analysis.subtasks || [], context.subtasks || [], manual);
      if (JSON.stringify(mergedSubtasks) !== JSON.stringify(task.subtasks || [])) {
        task.subtasks = mergedSubtasks;
        otherChanged = true;
      }
    }
    // Artifacts: deterministic union (deliverables + write/edit paths).
    const mergedArtifacts = mergeArtifacts(task.artifacts || [], context.artifacts || []);
    if (JSON.stringify(mergedArtifacts) !== JSON.stringify(task.artifacts || [])) {
      task.artifacts = mergedArtifacts;
      otherChanged = true;
    }
    if (context.sessionContext && (!task.sessionContext || task.primarySessionId === meta.id)) {
      task.sessionContext = { ...task.sessionContext, ...context.sessionContext };
    }

    const subtaskProgress = progressFromSubtasks(task.subtasks);
    if (!locked.has("progress") && subtaskProgress !== null) {
      const previous = task.progress;
      if (previous !== subtaskProgress) {
        task.progress = subtaskProgress;
        if (previous === null || previous === undefined || Math.abs(subtaskProgress - previous) >= 5) {
          pushHistory(task, { kind: "progress", from: previous, to: subtaskProgress, by: "ai", note: "按子任务完成率更新" });
        }
      }
    } else {
      const nextProgress = Number.isFinite(analysis.progress) ? analysis.progress : undefined;
      if (!locked.has("progress") && nextProgress !== undefined) {
        const previous = task.progress;
        if (previous !== nextProgress) {
          const delta = previous === null || previous === undefined ? 100 : Math.abs(nextProgress - previous);
          task.progress = nextProgress;
          if (delta >= 5) {
            pushHistory(task, { kind: "progress", from: previous, to: nextProgress, by: "ai", note: `${options.engine} 研判` });
          }
        }
      }
    }
    if (!locked.has("status") && STATUSES.includes(analysis.status) && analysis.status !== task.status) {
      const from = task.status;
      task.status = analysis.status;
      pushHistory(task, { kind: "status", from, to: analysis.status, by: "ai", note: `${options.engine} 研判` });
    }
    if (closeSubtasksForDoneTask(task)) otherChanged = true;
    syncProgressFromSubtasks(task);
    if (task.status === "done" && !locked.has("progress")) task.progress = 100;
    if (syncGoalStatus(task)) otherChanged = true;
    if (otherChanged) {
      pushHistory(task, {
        kind: "ai",
        by: "ai",
        note: `${options.engine} 更新了${options.engine === "llm" ? " AI" : ""}研判字段`,
      });
    }

    // Evidence is derived state and always refreshed (it is what makes cards traceable).
    if (Array.isArray(analysis.evidence) && analysis.evidence.length > 0) {
      task.evidence = mergeTaskEvidence(analysis.evidence, options.rules?.tasks?.[0]?.evidence || []);
    }
    attachSession(task, meta, (analysis.evidence || []).length);
    if (!task.primarySessionId) task.primarySessionId = meta.id;
    if (!task.workspaceId && meta.workspaceId) {
      task.workspaceId = meta.workspaceId;
      task.workspaceTitle = meta.workspaceTitle;
      task.workspacePath = meta.workspacePath;
    }
    refreshSessionEvidenceCounts(task);
    task.ai = analysisAiInfo(analysis, options);
    task.updatedAt = nowIso;
    task.lastActivityAt = Math.max(task.lastActivityAt || 0, meta.lastActivityAt || 0);
    if (options.engine === "llm") task.origin = task.origin === "manual" ? "manual" : "auto";
    truncateTask(task);
    state.scan.updatedTasks += 1;
    return task;
  }

  /* ------------------------------ commands ------------------------- */

  function requireTask(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task) throw notFound("task-not-found");
    return task;
  }

  function normalizedStatus(value, fallback) {
    return STATUSES.includes(value) ? value : fallback;
  }

  function normalizedPriority(value, fallback) {
    return PRIORITIES.includes(value) ? value : fallback;
  }

  function workspaceFromPayload(payload) {
    if (typeof payload.workspaceId !== "string" || !payload.workspaceId) return null;
    const workspace = workspaceById(payload.workspaceId);
    return workspace || null;
  }

  function metaForSessionId(sessionId) {
    if (!sessionId) return null;
    const known = sessionsById.get(sessionId);
    if (known) return known;
    const cached = cache.sessions[sessionId]?.meta;
    if (cached) return cached;
    return null;
  }

  function refreshSessionIndex() {
    try {
      const discovery = source.discover();
      parentToChildren = new Map();
      for (const [parentId, childId] of discovery.childToParent || []) {
        if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
        parentToChildren.get(parentId).push(childId);
      }
      for (const discovered of discovery.sessions) {
        if (!sessionsById.has(discovered.id)) sessionsById.set(discovered.id, hydrateMeta(discovered));
      }
      if (!state.workspaces.length) {
        state.workspaces = computeWorkspaces(discovery.workspaces, [...sessionsById.values()]);
      }
    } catch (error) {
      logger?.warn?.(`[super-kanban] refresh session index failed: ${String(error?.message || error)}`);
    }
  }

  const ops = {
    "task.create"(payload) {
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      if (!title) throw badRequest("title-required");
      const sessionMeta = metaForSessionId(payload.sessionId);
      const workspace = workspaceFromPayload(payload) || (sessionMeta ? workspaceById(sessionMeta.workspaceId) : null);
      const nowIso = new Date().toISOString();
      const task = {
        id: newManualTaskId(title),
        title: clipText(title, 80),
        goal: {
          text: clipText(typeof payload.goal === "string" ? payload.goal : payload.goal?.text || "", 160),
          status: "active",
          source: "task",
        },
        status: normalizedStatus(payload.status, "backlog"),
        progress: Number.isFinite(Number(payload.progress)) ? Math.max(0, Math.min(100, Math.round(Number(payload.progress)))) : null,
        priority: normalizedPriority(payload.priority, "P2"),
        tags: isStringArray(payload.tags) ? payload.tags.slice(0, 4).map((tag) => clipText(tag, 12)) : [],
        origin: "manual",
        workspaceId: workspace?.id || sessionMeta?.workspaceId || null,
        workspaceTitle: workspace?.title || sessionMeta?.workspaceTitle || null,
        workspacePath: workspace?.path || sessionMeta?.workspacePath || null,
        sessions: sessionMeta ? [sessionEntryFromMeta(sessionMeta, 0)] : [],
        primarySessionId: sessionMeta?.id || null,
        keyFacts: [],
        subtasks: [],
        artifacts: [],
        sessionContext: sessionMeta
          ? {
              sessionId: sessionMeta.id,
              title: sessionMeta.title || "",
              isLive: Boolean(sessionMeta.isLive),
              turnCount: sessionMeta.turnCount || 0,
              lastTurnEnd: mapTurnEndKind(sessionMeta.lastTurnEnd?.kind),
              lastActivityAt: sessionMeta.lastActivityAt || 0,
              todoTotal: sessionMeta.todoCounts?.total || 0,
              todoDone: sessionMeta.todoCounts?.completed || 0,
            }
          : null,
        issues: [],
        nextSteps: [],
        milestones: [],
        evidence: [],
        ai: null,
        lockedFields: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        lastActivityAt: sessionMeta?.lastActivityAt || Date.now(),
        archived: false,
        history: [],
      };
      if (!task.goal.text) task.goal.status = "none";
      if (sessionMeta) {
        state.suppressedSessions = state.suppressedSessions.filter((id) => id !== sessionMeta.id);
      }
      pushHistory(task, { kind: "create", by: "user", note: "手动创建任务" });
      state.tasks.push(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.update"(payload) {
      const task = requireTask(payload);
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
      let otherChanged = false;
      for (const field of FIELD_NAMES) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if (field === "status") {
          const next = normalizedStatus(value, task.status);
          if (next !== task.status) {
            const from = task.status;
            task.status = next;
            pushHistory(task, { kind: "status", from, to: next, by: "user", note: "用户编辑" });
          }
          continue;
        }
        if (field === "priority") {
          const next = normalizedPriority(value, task.priority);
          if (next !== task.priority) {
            task.priority = next;
            otherChanged = true;
          }
          continue;
        }
        if (field === "progress") {
          const next =
            value === null ? null : Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : task.progress;
          if (next !== task.progress) {
            pushHistory(task, { kind: "progress", from: task.progress, to: next, by: "user", note: "用户编辑" });
            task.progress = next;
          }
          continue;
        }
        if (field === "title") {
          if (typeof value === "string") {
            const next = clipText(value.trim(), 60);
            if (next && next !== task.title) {
              task.title = next;
              otherChanged = true;
            }
          }
          continue;
        }
        if (field === "goal") {
          const goalText = typeof value === "string" ? value : value?.text;
          if (typeof goalText === "string") {
            const next = { ...(task.goal || {}), text: clipText(goalText.trim(), 160), source: "task" };
            next.status = next.text ? (value?.status === "done" || task.status === "done" ? "done" : "active") : "none";
            if (JSON.stringify(next) !== JSON.stringify(task.goal)) {
              task.goal = next;
              otherChanged = true;
            }
          }
          continue;
        }
        if (field === "tags") {
          if (isStringArray(value)) {
            task.tags = value.slice(0, 6).map((tag) => clipText(tag, 12));
            otherChanged = true;
          }
          continue;
        }
        if (field === "nextSteps") {
          if (isStringArray(value)) {
            task.nextSteps = value.slice(0, 8).map((step) => clipText(step, 160));
            otherChanged = true;
          }
          continue;
        }
        if (field === "issues" || field === "milestones") {
          if (Array.isArray(value)) {
            task[field] = value.slice(0, field === "issues" ? 8 : 20);
            otherChanged = true;
          }
          continue;
        }
      }
      if (isStringArray(payload.lockFields) && payload.lockFields.length > 0) {
        const locks = new Set([...(task.lockedFields || []), ...payload.lockFields.filter((field) => LOCKABLE_FIELDS.includes(field))]);
        task.lockedFields = [...locks];
        otherChanged = true;
      }
      if (otherChanged) pushHistory(task, { kind: "edit", by: "user", note: "用户编辑任务" });
      if (task.origin === "auto") task.origin = "auto+edited";
      task.updatedAt = new Date().toISOString();
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.move"(payload) {
      const task = requireTask(payload);
      const nextStatus = normalizedStatus(payload.status, task.status);
      const index = Number.isFinite(Number(payload.index)) ? Number(payload.index) : null;
      const position = state.tasks.indexOf(task);
      if (position >= 0) state.tasks.splice(position, 1);
      if (nextStatus !== task.status) {
        pushHistory(task, { kind: "status", from: task.status, to: nextStatus, by: "user", note: "拖拽换列" });
        task.status = nextStatus;
      }
      const group = state.tasks
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter((entry) => entry.candidate.status === nextStatus);
      let insertAt;
      if (index !== null && index >= 0 && index < group.length) insertAt = group[index].candidateIndex;
      else insertAt = group.length > 0 ? group[group.length - 1].candidateIndex + 1 : state.tasks.length;
      state.tasks.splice(insertAt, 0, task);
      task.updatedAt = new Date().toISOString();
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.archive"(payload) {
      const task = requireTask(payload);
      const archived = payload.archived !== false;
      if (task.archived !== archived) {
        pushHistory(task, {
          kind: "archive",
          from: task.archived,
          to: archived,
          by: "user",
          note: archived ? "用户归档" : "用户恢复",
        });
        task.archived = archived;
        task.updatedAt = new Date().toISOString();
      }
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.delete"(payload) {
      const task = requireTask(payload);
      const sessionIds = (task.sessions || []).map((session) => session.id);
      state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
      state.deletedLog.push({
        id: task.id,
        title: task.title,
        origin: task.origin,
        deletedAt: new Date().toISOString(),
        sessionIds,
      });
      if (task.origin !== "manual") {
        state.suppressedSessions = [...new Set([...state.suppressedSessions, ...sessionIds])].slice(-500);
      }
      persistState();
      emitChanged("task", 1);
      return { id: task.id, deleted: true };
    },

    "task.relink"(payload) {
      const task = requireTask(payload);
      if (!isStringArray(payload.sessionIds)) throw badRequest("sessionIds-required");
      refreshSessionIndex();
      const sessions = [];
      for (const sessionId of payload.sessionIds.slice(0, MAX_SESSIONS_PER_TASK)) {
        const meta = metaForSessionId(sessionId);
        sessions.push(meta ? sessionEntryFromMeta(meta, 0) : { id: sessionId, title: sessionId, seqEnd: 0, evidenceCount: 0 });
      }
      task.sessions = sessions;
      task.primarySessionId = sessions[0]?.id || null;
      const firstMeta = sessions[0] ? metaForSessionId(sessions[0].id) : null;
      if (firstMeta) {
        task.workspaceId = firstMeta.workspaceId || task.workspaceId;
        task.workspaceTitle = firstMeta.workspaceTitle || task.workspaceTitle;
        task.workspacePath = firstMeta.workspacePath || task.workspacePath;
      }
      state.suppressedSessions = state.suppressedSessions.filter((id) => !payload.sessionIds.includes(id));
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `重新关联 ${sessions.length} 个来源会话` });
      if (task.origin === "auto") task.origin = "auto+edited";
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.unlock"(payload) {
      const task = requireTask(payload);
      const fields = isStringArray(payload.fields) && payload.fields.length > 0 ? payload.fields : null;
      task.lockedFields = fields ? task.lockedFields.filter((field) => !fields.includes(field)) : [];
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: fields ? `解锁字段：${fields.join("、")}` : "解锁全部字段" });
      persistState();
      emitChanged("task", 1);
      return task;
    },

    async "task.analyze"(payload) {
      const task = requireTask(payload);
      if (scanPromise) {
        const error = new Error("扫描进行中，请稍后再试");
        error.code = "busy";
        throw error;
      }
      refreshSessionIndex();
      const sessionIds = [...new Set([task.primarySessionId, ...(task.sessions || []).map((session) => session.id)].filter(Boolean))];
      if (sessionIds.length === 0) throw badRequest("task-has-no-session");
      const dailyRemaining = dailyAiRemaining();
      const budgetExhausted = state.settings.aiEnabled && analyzer.hasCredential() && dailyRemaining <= 0;
      const aiEnabled = state.settings.aiEnabled && analyzer.hasCredential() && dailyRemaining > 0;
      const perTaskBudget = Math.min(state.settings.maxAiCallsPerScan || DEFAULT_SETTINGS.maxAiCallsPerScan, dailyRemaining);
      analyzer.resetBudget(aiEnabled ? Math.min(perTaskBudget, sessionIds.length) : 0);
      let aiCalls = 0;
      let tokens = 0;
      let engine = "rules";
      let parsedAny = 0;
      let budgetHit = false;
      for (const sessionId of sessionIds.slice(0, MAX_SESSIONS_PER_TASK)) {
        const meta = metaForSessionId(sessionId);
        if (!meta || !meta.file) continue;
        let parsed;
        try {
          parsed = source.loadParsed(meta);
        } catch (error) {
          logger?.warn?.(`[super-kanban] analyze session ${sessionId} failed: ${String(error?.message || error)}`);
          continue;
        }
        parsedAny += 1;
        parsed.evidence = source.collectEvidence(parsed);
        const rules = analyzeSessionRules(parsed, {
          workspaceTitle: meta.workspaceTitle,
          workspacePath: meta.workspacePath,
          maxTasks: state.settings.maxTasksPerSession || 3,
        });
        const context = buildV2Context(parsed, meta, meta.workspaceTitle);
        let analyses = rules.tasks;
        let jobEngine = "rules";
        let model = state.settings.model;
        if (aiEnabled && !budgetHit && aiCalls < perTaskBudget) {
          const digest = source.buildDigest(parsed, {
            workspaceTitle: meta.workspaceTitle,
            existingTasks: promptCandidateTasks(meta),
            baselineSeq: 0, // manual re-judge: give the model the full recent picture
          });
          const result = await analyzer.analyze({
            digest,
            existingTasks: promptCandidateTasks(meta),
            model: state.settings.model,
          });
          if (result.ok) {
            const normalized = result.tasks
              .slice(0, Math.max(1, state.settings.maxTasksPerSession || 3))
              .map((raw) => normalizeAnalysis(raw, context, { engine: "llm", model: result.model }))
              .filter(Boolean)
              .map((analysis) => ({
                ...analysis,
                evidence: mergeTaskEvidence(analysis.evidence, rules.tasks?.[0]?.evidence || []),
                keyFacts: mergeKeyFacts(analysis.keyFacts, rules.tasks?.[0]?.keyFacts || []),
              }));
            if (normalized.length > 0 && !result.ignore) {
              analyses = normalized;
              jobEngine = "llm";
              model = result.model || model;
              engine = "llm";
              aiCalls += 1;
              tokens += result.usage?.totalTokens || 0;
            }
            applyAiMeta(sessionId, meta, { digestBytes: Buffer.byteLength(digest, "utf8") });
          } else if (result.code === "budget") {
            budgetHit = true;
            logger?.warn?.("[super-kanban] task.analyze budget exhausted; rules fallback");
          } else {
            logger?.warn?.(`[super-kanban] task.analyze LLM degraded: ${result.error}`);
          }
        }
        // Explicit analyze updates exactly this task (scan owns auto splitting).
        const primary = analyses[0];
        if (primary) {
          updateTaskFromAnalysis(task, primary, meta, { engine: jobEngine, model, rules, context });
        }
      }
      task.origin = task.origin === "auto" ? "auto+edited" : task.origin;
      task.updatedAt = new Date().toISOString();
      truncateTask(task);
      if (aiCalls > 0) recordUsage({ calls: aiCalls, tokens });
      persistState();
      emitChanged("task", 1);
      const message =
        engine === "llm"
          ? "AI 研判完成"
          : budgetHit || budgetExhausted
            ? "今日 AI 预算已用完，已用规则引擎重判"
            : "AI 不可用或未启用，已用规则引擎重判";
      return { task, engine, aiCalls, tokens, sessions: parsedAny, message };
    },

    /* ----------------------- v2 linkage ops ------------------------ */

    "task.continuePrompt"(payload) {
      const task = requireTask(payload);
      const target = payload.target === "newSession" ? "newSession" : "session";
      const meta = task.primarySessionId ? metaForSessionId(task.primarySessionId) : null;
      const sessionContext = task.sessionContext || (meta ? sessionContextFromMeta(meta) : null);
      const lines = [];
      lines.push("你将继续执行一个已有任务，请接手并把它推进到完成。", "");
      lines.push("## 任务");
      lines.push(`- 标题：${task.title}`);
      lines.push(`- 目标：${task.goal?.text || "未设置（请根据标题与会话判断）"}`);
      lines.push(`- 当前状态：${task.status}${Number.isFinite(task.progress) ? `（进度 ${task.progress}%）` : ""}`);
      if (task.workspaceTitle) lines.push(`- 工作区：${task.workspaceTitle}`);
      const keyFacts = (task.keyFacts || []).slice(0, 5);
      if (keyFacts.length) {
        lines.push("", "## 关键事实");
        for (const fact of keyFacts) lines.push(`- ${fact.text}`);
      }
      const issues = (task.issues || []).slice(0, 3);
      if (issues.length) {
        lines.push("", "## 待解决问题");
        for (const issue of issues) lines.push(`- [${issue.severity || "medium"}] ${issue.text}`);
      }
      const nextSteps = (task.nextSteps || []).slice(0, 3);
      if (nextSteps.length) {
        lines.push("", "## 建议下一步");
        for (const step of nextSteps) lines.push(`- ${step}`);
      }
      const pendingSubtasks = (task.subtasks || []).filter((subtask) => !subtask.done).slice(0, 5);
      if (pendingSubtasks.length) {
        lines.push("", "## 未完成子任务");
        for (const subtask of pendingSubtasks) lines.push(`- ${subtask.text}`);
      }
      if (sessionContext) {
        lines.push("", "## 来源会话");
        lines.push(
          `- ${sessionContext.title || meta?.title || "?"}（sessionId: ${sessionContext.sessionId || task.primarySessionId}）`,
        );
        lines.push(
          `- 状态：${sessionContext.isLive ? "进行中" : "已结束"}；轮次：${sessionContext.turnCount || 0}；待办：${sessionContext.todoDone || 0}/${sessionContext.todoTotal || 0}`,
        );
      }
      lines.push(
        "",
        "## 要求",
        "1. 先简要复述你对任务目标与当前进展的理解，并给出 2-4 步执行计划；",
        "2. 然后直接开始执行，优先解决阻塞问题；",
        "3. 完成后汇报产出（文件路径/结果）与验证方式；",
        "4. 遇到阻塞明确说明原因与需要用户决策的点，不要假装完成。",
      );
      return {
        prompt: lines.join("\n"),
        target,
        sessionId: task.primarySessionId || (sessionContext?.sessionId ?? null),
        workspaceId: task.workspaceId || meta?.workspaceId || null,
        workspaceTitle: task.workspaceTitle || meta?.workspaceTitle || null,
        isLive: Boolean(sessionContext?.isLive ?? meta?.isLive),
      };
    },

    "task.importTodos"(payload) {
      const task = requireTask(payload);
      refreshSessionIndex();
      const meta = task.primarySessionId ? metaForSessionId(task.primarySessionId) : null;
      if (!meta || !meta.file) throw badRequest("task-has-no-session");
      let parsed;
      try {
        parsed = source.loadParsed(meta);
      } catch (error) {
        throw badRequest(`session-parse-failed: ${String(error?.message || error)}`);
      }
      const todoSubtasks = source.extractSubtasks(parsed, { forceAll: true });
      const merged = mergeSubtasks(todoSubtasks, task.subtasks || []);
      if (JSON.stringify(merged) === JSON.stringify(task.subtasks || [])) return task;
      task.subtasks = merged;
      syncProgressFromSubtasks(task);
      task.sessionContext = sessionContextFromMeta(meta, parsed);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `从会话导入待办 ${todoSubtasks.length} 项` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.toggleSubtask"(payload) {
      const task = requireTask(payload);
      const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
      const subtask = (task.subtasks || []).find((item) => item.id === subtaskId);
      if (!subtask) throw notFound("subtask-not-found");
      subtask.done = typeof payload.done === "boolean" ? payload.done : !subtask.done;
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `${subtask.done ? "完成" : "取消完成"}子任务：${clipText(subtask.text, 30)}` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.addSubtask"(payload) {
      const task = requireTask(payload);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw badRequest("text-required");
      task.subtasks = mergeSubtasks(
        task.subtasks || [],
        [{ id: shortId("s", `manual:${task.id}:${Date.now()}:${text}`), text: clipText(text, 40), done: false, source: "manual", seq: 0 }],
      );
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `新增子任务：${clipText(text, 30)}` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.removeSubtask"(payload) {
      const task = requireTask(payload);
      const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
      const before = (task.subtasks || []).length;
      task.subtasks = (task.subtasks || []).filter((item) => item.id !== subtaskId);
      if (task.subtasks.length === before) throw notFound("subtask-not-found");
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: "删除子任务" });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    async "task.polishPrompt"(payload) {
      const original = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!original) throw badRequest("prompt-required");
      if (original.length > 3000) throw badRequest("prompt-too-long");
      if (scanPromise) {
        const error = new Error("扫描进行中，请稍后再试");
        error.code = "busy";
        throw error;
      }
      const dailyRemaining = dailyAiRemaining();
      if (!state.settings.aiEnabled || !analyzer.hasCredential() || dailyRemaining <= 0) {
        return { prompt: original, polished: false };
      }
      analyzer.resetBudget(1);
      const result = await analyzer.polish({ prompt: original, model: state.settings.model });
      if (!result.ok) return { prompt: original, polished: false };
      recordUsage({ calls: 1, tokens: result.usage?.totalTokens || 0 });
      persistState();
      return { prompt: result.prompt || original, polished: Boolean(result.prompt) };
    },

    "session.ignore"(payload) {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId) throw badRequest("sessionId-required");
      if (!state.ignoredSessions.includes(sessionId)) state.ignoredSessions.push(sessionId);
      state.suppressedSessions = state.suppressedSessions.filter((id) => id !== sessionId);
      persistState();
      emitChanged("settings", 0);
      return { sessionId, ignored: true };
    },

    "session.unignore"(payload) {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId) throw badRequest("sessionId-required");
      state.ignoredSessions = state.ignoredSessions.filter((id) => id !== sessionId);
      persistState();
      emitChanged("settings", 0);
      return { sessionId, ignored: false };
    },

    "settings.update"(payload) {
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : payload;
      const normalized = normalizeSettingsPatch(patch);
      const previous = state.settings;
      state.settings = { ...state.settings, ...normalized };
      if (Object.prototype.hasOwnProperty.call(normalized, "lastScanAt")) state.settings.lastScanAt = normalized.lastScanAt;
      if (JSON.stringify(previous) !== JSON.stringify(state.settings)) {
        state.workspaces = state.workspaces.map((workspace) => ({
          ...workspace,
          included: !(state.settings.excludeWorkspaces || []).includes(workspace.id),
        }));
        persistState();
        emitChanged("settings", 0);
      }
      return state.settings;
    },

    "scan.start"(payload) {
      const result = startScan(payload.mode === "full" ? "full" : "incremental");
      if (!result.ok) {
        const error = new Error(result.message || "扫描进行中");
        error.code = result.error || "busy";
        throw error;
      }
      return result.data;
    },

    "scan.cancel"() {
      if (!scanPromise) return { cancelling: false };
      scanCancel = true;
      try {
        scanAbort?.abort();
      } catch {
        /* ignore */
      }
      state.scan.message = "正在取消扫描…";
      broadcastScan(true);
      return { cancelling: true };
    },
  };

  function classifyError(error) {
    const code = error?.code || "internal";
    if (code === "invalid-input") return 400;
    if (code === "not-found") return 404;
    if (code === "busy") return 409;
    return 500;
  }

  /* ------------------------------ routes --------------------------- */

  function handleSse(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const client = { res, heartbeat: null };
    client.heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        removeSseClient(client);
      }
    }, SSE_HEARTBEAT_MS);
    if (typeof client.heartbeat.unref === "function") client.heartbeat.unref();
    sseClients.add(client);
    try {
      res.write(`event: scan\ndata: ${JSON.stringify(state.scan)}\n\n`);
      res.write(`event: changed\ndata: ${JSON.stringify({ reason: "init", tasksChanged: state.tasks.length })}\n\n`);
    } catch {
      removeSseClient(client);
    }
    const cleanup = () => removeSseClient(client);
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
  }

  function findSessionMeta(sessionId) {
    if (sessionsById.has(sessionId)) return sessionsById.get(sessionId);
    if (cache.sessions[sessionId]?.meta) {
      const cachedMeta = cache.sessions[sessionId].meta;
      if (!cachedMeta.dir && cachedMeta.file) cachedMeta.dir = path.dirname(cachedMeta.file);
      return cachedMeta;
    }
    try {
      const discovery = source.discover();
      for (const discovered of discovery.sessions) {
        if (discovered.id !== sessionId) continue;
        const meta = hydrateMeta(discovered);
        sessionsById.set(sessionId, meta);
        return meta;
      }
    } catch (error) {
      logger?.warn?.(`[super-kanban] session lookup failed: ${String(error?.message || error)}`);
    }
    return null;
  }

  function sessionStatus(parsed) {
    if (parsed.isLive) return "active";
    const kind = parsed.lastTurnEnd?.kind;
    if (!kind) return "unknown";
    return kind;
  }

  function buildSessionResponse(sessionId, { after, limit }) {
    const meta = findSessionMeta(sessionId);
    if (!meta) return null;
    const parsed = source.loadParsed(meta);
    const events = source.readApiEvents(parsed, { after, limit });
    const workspace = meta.workspaceId ? workspaceById(meta.workspaceId) : null;
    const todos = source.latestTodos(parsed);
    const goalText = parsed.goal?.text || meta.goalText || null;
    const goalStatus = parsed.goal?.status || meta.goalStatus || null;
    return {
      ok: true,
      session: {
        id: parsed.id,
        title: parsed.title,
        goalText,
        goalStatus,
        todos: todos.todos,
        todoTotal: todos.todoTotal,
        todoDone: todos.todoDone,
        workspaceId: meta.workspaceId || null,
        workspaceTitle: meta.workspaceTitle || workspace?.title || null,
        createdAt: parsed.session.createdAt,
        lastActivityAt: parsed.lastActivityAt,
        turns: parsed.turnCount,
        eventCount: parsed.eventCount,
        status: sessionStatus(parsed),
        path: parsed.file,
        cwd: parsed.session.cwd,
        parentSession: parsed.parentSession,
        delegationDepth: parsed.delegationDepth,
        isLive: parsed.isLive,
      },
      events,
    };
  }

  function buildExport() {
    const sessions = Object.entries(cache.sessions).map(([id, entry]) => ({
      id,
      title: entry?.meta?.title || null,
      workspaceTitle: entry?.meta?.workspaceTitle || null,
      lastActivityAt: entry?.meta?.lastActivityAt || null,
      eventCount: entry?.meta?.eventCount || 0,
      isLive: Boolean(entry?.meta?.isLive),
      aiAt: entry?.meta?.aiAt || null,
    }));
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      state: {
        version: state.version,
        tasks: state.tasks,
        settings: state.settings,
        usage: state.usage,
        ignoredSessions: state.ignoredSessions,
        workspaces: state.workspaces,
        activity: state.activity,
        scan: state.scan,
        stats: computeStats(),
      },
      sessions,
    };
  }

  async function handle(req, res, { route = "/", url, method = "GET" } = {}) {
    if (stopped) {
      json(res, 503, { ok: false, error: "stopped", message: "service stopped" });
      return;
    }
    try {
      if (route === "/ping" && method === "GET") {
        json(res, 200, {
          ok: true,
          plugin: "dsh-super-kanban",
          dshHome,
          version: 2,
          time: new Date().toISOString(),
        });
        return;
      }
      if (route === "/state" && method === "GET") {
        json(res, 200, buildStatePayload());
        return;
      }
      if (route === "/command" && method === "POST") {
        const body = await readBody(req);
        const op = typeof body.op === "string" ? body.op : "";
        const handler = ops[op];
        if (!handler) {
          json(res, 400, { ok: false, error: "unknown-op", message: `unknown op: ${op}` });
          return;
        }
        try {
          const data = await handler(body.payload && typeof body.payload === "object" ? body.payload : {});
          json(res, 200, { ok: true, data });
        } catch (error) {
          const status = classifyError(error);
          json(res, status, {
            ok: false,
            error: error?.code || "internal",
            message: String(error?.message || error),
          });
        }
        return;
      }
      if (route === "/export" && method === "GET") {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="super-kanban-${stamp}.json"`,
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(buildExport(), null, 2));
        return;
      }
      if (route === "/events" && method === "GET") {
        handleSse(req, res);
        return;
      }
      if (route.startsWith("/session/") && method === "GET") {
        const sessionId = decodeURIComponent(route.slice("/session/".length));
        if (!sessionId) {
          json(res, 400, { ok: false, error: "invalid-input", message: "session id required" });
          return;
        }
        const after = url?.searchParams?.get("after");
        const limit = url?.searchParams?.get("limit");
        const payload = buildSessionResponse(sessionId, {
          after: after === null || after === undefined || after === "" ? null : Number(after),
          limit: limit ? Number(limit) : 200,
        });
        if (!payload) {
          json(res, 404, { ok: false, error: "session-not-found", message: `session not found: ${sessionId}` });
          return;
        }
        json(res, 200, payload);
        return;
      }
      json(res, 404, { ok: false, error: "not-found", route });
    } catch (error) {
      logger?.warn?.(`[super-kanban] request failed ${method} ${route}: ${String(error?.message || error)}`);
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: "internal", message: String(error?.message || error) });
      } else {
        try {
          res.end();
        } catch {
          /* response already gone */
        }
      }
    }
  }

  /* ------------------------------ lifecycle ------------------------ */

  function maybeAutoScan() {
    if (stopped || scanPromise) return;
    if (!state.settings.autoScan) return;
    const last = Date.parse(state.settings.lastScanAt || "") || 0;
    const interval = (state.settings.scanIntervalSeconds || 120) * 1000;
    if (Date.now() - last >= interval) startScan("incremental");
  }

  function start() {
    if (stopped || autoTimer) return;
    // First scan should happen within ~8s of plugin boot.
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (stopped || scanPromise) return;
      if (state.settings.autoScan) startScan("incremental");
    }, 3000);
    if (typeof startupTimer.unref === "function") startupTimer.unref();
    autoTimer = setInterval(maybeAutoScan, 5000);
    if (typeof autoTimer.unref === "function") autoTimer.unref();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    scanCancel = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (autoTimer) clearInterval(autoTimer);
    if (saveTimer) clearTimeout(saveTimer);
    if (scanBroadcastTimer) clearTimeout(scanBroadcastTimer);
    for (const client of [...sseClients]) removeSseClient(client);
    persistState();
    persistCache();
    logger?.info?.("[super-kanban] host service stopped");
  }

  // The plugin entry never calls start() today; boot autonomously but keep the
  // documented start()/stop() surface for the host lifetime hooks.
  start();

  return { handle, start, stop };
}

export { DEFAULT_SETTINGS, EVIDENCE_LIMIT };
