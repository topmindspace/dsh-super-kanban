/**
 * Super Kanban — LLM analyzer.
 *
 * Reuses the DSH account quota: the bearer token lives in
 * $DSH_HOME/.credentials.yaml under `records.deepseek-account-platform/default`
 * and is sent as `x-dsh-auth-token` to the OpenAI-compatible endpoint.
 *
 * Hardening: 60s timeout, one retry, ≤3 concurrent requests, per-scan call
 * budget, strict JSON extraction and graceful degradation to the rules engine.
 * The account token is never logged and never leaves this module.
 */
import fs from "node:fs";
import path from "node:path";

const CREDENTIALS_FILE = ".credentials.yaml";
const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";
const MAX_CONCURRENCY = 2;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 2200;
const TOKEN_PATTERN = /\bdeepseek-account-platform\/default:/;

const SYSTEM_PROMPT = [
  "你是任务看板研判引擎。输入是一段 DSH（AI 编程助手）会话的紧凑摘要，输出任务卡 JSON。",
  "只输出一个 JSON 对象，不要 markdown，不要解释。结构：",
  '{ "sessionSummary":"≤60字", "ignore":false,',
  '  "tasks":[ { "title":"≤40字 动词开头", "goal":"≤100字 目标/完成标准",',
  '    "status":"backlog|in_progress|blocked|done", "progress":0, "priority":"P0|P1|P2|P3",',
  '    "tags":["≤4个"],',
  '    "keyFacts":[{"text":"≤60字关键事实","kind":"status|progress|issue|decision|artifact|goal","seq":0}],',
  '    "issues":[{"text":"≤60字问题/风险","severity":"high|medium|low","seq":0}],',
  '    "nextSteps":["≤60字下一步"],',
  '    "subtasks":[{"text":"≤40字子任务","done":true,"seq":0}],',
  '    "evidence":[{"seq":0,"kind":"user|assistant|todo|tool|artifact|error|deliverable","quote":"≤80字原文"}],',
  '    "confidence":0.0, "reason":"≤120字研判理由", "mergeWith":"已有任务id或null" } ] }',
  "规则：",
  "1. keyFacts 只放 1-5 条最关键事实（状态/进度/问题/决策/产物/目标），不要复述全篇。",
  "2. 每任务 evidence ≤5 条，quote 只摘原文短句；seq 必须来自摘要中的 [数字]。",
  "3. 默认一个会话只建 1 张卡；只有确实无关的多件事才拆（最多 3 张）。",
  "4. 若本次工作与「已有任务」中某项是同一工作的延续，mergeWith 填其 id，不要新建卡。",
  "5. status：进行中→in_progress；正常结束且完成→done；报错卡住→blocked；未开始/搁置→backlog。done 时 progress=100。",
  "6. 摘要里 end:completed 表示最后一轮正常结束：若最后一条助手消息表明已交付/完成，且没有更新的用户指令，应判 done；end:interrupted/aborted 且无后续活动 → in_progress 或 blocked。",
  "7. 待办快照可能是很早以前的旧计划，只作参考，不要因旧快照未完成而把已完成任务判成进行中。",
  "8. 没有明确用户委托时 ignore=true、tasks=[]。输出必须紧凑完整，确保 JSON 闭合。",
].join("\n");

/** Read the DeepSeek account token. Never log the returned value. */
export function readAccountToken(dshHome) {
  const file = path.join(dshHome, CREDENTIALS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const marker = text.match(TOKEN_PATTERN);
  if (!marker || marker.index === undefined) return null;
  const rest = text.slice(marker.index + marker[0].length);
  // Stop at the next top-level (2-space indented) record key.
  const block = rest.split(/\n(?= {2}\S[^\n]*:)/)[0];
  const tokenMatch = block.match(/\n[ \t]+token:[ \t]*["']?([^\s"']+)["']?/);
  return tokenMatch ? tokenMatch[1] : null;
}

/**
 * Some deepseek-flash outputs contain a malformed evidence field like
 * `"seq=917"` instead of `"seq": 917`, or trailing commas. Repair those before
 * giving up on a response.
 */
function repairModelJson(text) {
  return String(text || "")
    .replace(/"seq\s*=\s*(\d+)"/g, '"seq": $1')
    .replace(/([({,]\s*)"?seq"?\s*=\s*(\d+)/g, '$1"seq": $2')
    .replace(/,?\s*"seq"\s*:\s*(\d+)\s*"(?=\s*[,}])/g, '"seq": $1')
    .replace(/,\s*([}\]])/g, "$1");
}

/** Extract the first balanced JSON object from model output. */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  const parse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      try {
        return JSON.parse(repairModelJson(value));
      } catch {
        return null;
      }
    }
  };
  const direct = parse(candidate.slice(start));
  if (direct) return direct;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index++) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return parse(candidate.slice(start, index + 1));
    }
  }
  return null;
}

function validatePayload(data) {
  if (!data || typeof data !== "object") return { error: "not-an-object" };
  let tasks = [];
  if (Array.isArray(data.tasks)) tasks = data.tasks;
  else if (typeof data.title === "string") tasks = [data]; // tolerate a bare task object
  const cleaned = tasks.filter((task) => task && typeof task === "object").slice(0, 3);
  return {
    data: {
      tasks: cleaned,
      sessionSummary: typeof data.sessionSummary === "string" ? data.sessionSummary.slice(0, 300) : "",
      ignore: data.ignore === true,
    },
  };
}

function buildMessages(digest, existingTasks, model) {
  const relevant = Array.isArray(existingTasks) ? existingTasks.slice(0, 3) : [];
  const taskLines = relevant.length
    ? relevant.map((task) => `- ${task.id}「${String(task.title || "").slice(0, 30)}」${task.status}`).join("\n")
    : "(无)";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `模型:${model}\n\n会话摘要：\n${digest}\n\n已有相关任务：\n${taskLines}\n\n输出 JSON。`,
    },
  ];
}

export function createLlmAnalyzer({ dshHome, logger } = {}) {
  if (!dshHome) throw new Error("createLlmAnalyzer requires dshHome");
  const log = logger || console;
  let credential = { token: null, mtimeMs: -1, checkedAt: 0 };
  let inflight = 0;
  const waiters = [];
  let budget = { limit: 40, calls: 0, tokens: 0 };

  function getToken({ force = false } = {}) {
    const file = path.join(dshHome, CREDENTIALS_FILE);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      credential = { token: null, mtimeMs: -1, checkedAt: Date.now() };
      return null;
    }
    const stale = force || Date.now() - credential.checkedAt > 5 * 60_000 || stat.mtimeMs !== credential.mtimeMs;
    if (stale) {
      credential = { token: readAccountToken(dshHome), mtimeMs: stat.mtimeMs, checkedAt: Date.now() };
    }
    return credential.token;
  }

  async function acquire(signal) {
    if (inflight < MAX_CONCURRENCY) {
      inflight += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.push(waiter);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(Object.assign(new Error("aborted"), { code: "aborted" }));
          },
          { once: true },
        );
      }
    });
    inflight += 1;
  }

  function release() {
    inflight = Math.max(0, inflight - 1);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve();
  }

  async function requestOnce({ model, messages, token, signal, jsonMode, maxTokens = MAX_OUTPUT_TOKENS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("llm-timeout"), { code: "timeout" })), TIMEOUT_MS);
    const onAbort = () => controller.abort(Object.assign(new Error("aborted"), { code: "aborted" }));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw Object.assign(new Error("aborted"), { code: "aborted" });
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsh-auth-token": token,
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`http-${response.status}`);
        error.status = response.status;
        error.body = text.slice(0, 300);
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw Object.assign(new Error("invalid-json-response"), { body: text.slice(0, 200) });
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw Object.assign(new Error("empty-content"), { usage: payload?.usage || null });
      }
      return { content, usage: payload?.usage || null, model: payload?.model || model };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Analyze one session digest.
   *
   * @returns {Promise<{ok:true, tasks:Array<object>, sessionSummary:string, ignore:boolean,
   *                    usage:{promptTokens:number, completionTokens:number, totalTokens:number}, model:string}
   *                 | {ok:false, error:string, code:string}>}
   */
  async function analyze({ digest, existingTasks, model = DEFAULT_MODEL, signal } = {}) {
    const token = getToken();
    if (!token) return { ok: false, error: "no-credential", code: "no-credential" };
    if (budget.calls >= budget.limit) return { ok: false, error: "scan-call-budget-exhausted", code: "budget" };

    const messages = buildMessages(digest, existingTasks, model);
    const correctionMessage = {
      role: "user",
      content:
        "注意：你上一次的输出不是合法 JSON（例如把 evidence 的 seq 写成了 \"seq=917\"）。请严格输出一个完整闭合的 JSON 对象；evidence 必须是 {\"seq\": 数字, \"kind\": \"...\", \"quote\": \"...\"}。",
    };
    let lastExtractFailed = false;
    budget.calls += 1;
    let lastError = null;
    let forcedRefresh = false;
    try {
      await acquire(signal);
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: "aborted" };
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const jsonMode = attempt === 0;
        try {
          const attemptMessages = lastExtractFailed ? [...messages, correctionMessage] : messages;
          const response = await requestOnce({ model, messages: attemptMessages, token: getToken({ force: forcedRefresh }), signal, jsonMode });
          const parsed = extractJsonObject(response.content);
          if (!parsed) {
            lastExtractFailed = true;
            lastError = Object.assign(new Error("json-extract-failed"), { code: "json", raw: response.content.slice(0, 200) });
            continue;
          }
          const validated = validatePayload(parsed);
          if (validated.error) {
            lastError = Object.assign(new Error(validated.error), { code: "schema" });
            continue;
          }
          const usage = response.usage || {};
          budget.tokens += Number(usage.total_tokens) || 0;
          return {
            ok: true,
            ...validated.data,
            usage: {
              promptTokens: Number(usage.prompt_tokens) || 0,
              completionTokens: Number(usage.completion_tokens) || 0,
              totalTokens: Number(usage.total_tokens) || 0,
            },
            model: response.model,
          };
        } catch (error) {
          lastError = error;
          if (error?.code === "aborted" || signal?.aborted) {
            return { ok: false, error: "aborted", code: "aborted" };
          }
          // Invalid/unsupported response_format: retry once without JSON mode.
          if (error?.status === 400 && /response_format|json/i.test(String(error.body || "")) && jsonMode) {
            lastError = Object.assign(new Error("json-mode-unsupported"), { code: "json-mode" });
            continue;
          }
          if (error?.status === 401 || error?.status === 403) {
            forcedRefresh = true;
            getToken({ force: true });
          }
          // Retry only transient failures (network/timeout/429/5xx); also retry
          // once when JSON extraction failed.
          const transient =
            !error?.status || error?.code === "timeout" || error.status === 429 || (error.status >= 500 && error.status < 600);
          if (transient && attempt < 2) {
            const delay = error?.status === 429 || /rate/i.test(String(error?.body || error?.message || "")) ? 3000 : 800;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          break;
        }
      }
      return {
        ok: false,
        error: String(lastError?.message || lastError || "llm-failed"),
        code: lastError?.code || "llm-failed",
      };
    } finally {
      release();
    }
  }

  /**
   * Optional one-shot prompt polish (task.polishPrompt). Counts against the
   * same AI budget; returns ok:false instead of throwing when unavailable.
   */
  async function polish({ prompt, model = DEFAULT_MODEL, signal } = {}) {
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) return { ok: false, error: "prompt-required", code: "invalid-input" };
    if (!getToken()) return { ok: false, error: "no-credential", code: "no-credential" };
    if (budget.calls >= budget.limit) return { ok: false, error: "call-budget-exhausted", code: "budget" };
    budget.calls += 1;
    try {
      await acquire(signal);
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: "aborted" };
    }
    try {
      const messages = [
        {
          role: "system",
          content:
            "你是提示词润色助手。把用户给出的「继续任务」提示词改写得更清晰、可执行：保留原意与所有事实，补充验收标准与汇报要求，不要添加新需求，不要解释，只输出润色后的提示词正文（≤600字）。",
        },
        { role: "user", content: text.slice(0, 3000) },
      ];
      const response = await requestOnce({ model, messages, token: getToken(), signal, jsonMode: false, maxTokens: 800 });
      const usage = response.usage || {};
      budget.tokens += Number(usage.total_tokens) || 0;
      return {
        ok: true,
        prompt: String(response.content || "").trim().slice(0, 2000),
        usage: {
          promptTokens: Number(usage.prompt_tokens) || 0,
          completionTokens: Number(usage.completion_tokens) || 0,
          totalTokens: Number(usage.total_tokens) || 0,
        },
        model: response.model,
      };
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: "aborted", code: "aborted" };
      return { ok: false, error: String(error?.message || error), code: "llm-failed" };
    } finally {
      release();
    }
  }

  return {
    analyze,
    polish,
    hasCredential: () => Boolean(getToken()),
    invalidateCredential: () => {
      credential = { token: null, mtimeMs: -1, checkedAt: 0 };
    },
    resetBudget: (limit = 40) => {
      budget = { limit: Math.max(0, Math.round(limit)), calls: 0, tokens: 0 };
    },
    getBudget: () => ({ ...budget }),
    addTokens: (count) => {
      budget.tokens += Math.max(0, Number(count) || 0);
    },
    defaultModel: DEFAULT_MODEL,
    apiUrl: API_URL,
    log,
  };
}
