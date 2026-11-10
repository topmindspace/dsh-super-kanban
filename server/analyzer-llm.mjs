/**
 * Super Kanban — LLM analyzer over the DSH native model service.
 *
 * The board no longer talks to a provider endpoint itself: every analysis goes
 * through the host composition's `llm` service (`ctx.llm`), so credentials,
 * providers, third-party gateways and the model catalog are all owned by DSH.
 * This module keeps the board-side policy: prompt, JSON repair and correction
 * retries, per-scan call budget, request timeout and concurrency.
 *
 * Provider-request shape (verified against DSH 0.2.1-rc.5 / 0.2.2-rc.1):
 *   llm.stream({ provider, model, system, messages, maxTokens, signal })
 *   - `messages` accepts request-only user input: { role:'user', content:[{type:'text',text}] }
 *   - the stream ends with `usage` then exactly one terminal `finish`
 *   - there is NO JSON mode / response_format; JSON validity is handled here
 *   - never pass `sessionId`: that would let the official route attach its
 *     session-log payload to the request.
 *
 * The returned analyzer is transport-neutral for tests: the LLM service is
 * resolved lazily from `ctx`, and `createLlmAnalyzer({ ctx })` never throws
 * when the service is absent (analysis then degrades to the rules engine).
 */
import { llmOf } from "./native-llm.mjs";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 4096;
const POLISH_OUTPUT_TOKENS = 800;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;

/** Codes worth another provider attempt; everything else fails closed. */
const RETRYABLE_CODES = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "EMPTY_RESPONSE",
  "STREAM_CLOSED",
  "MALFORMED_RESPONSE",
  "UNKNOWN",
  "llm-failed",
  "timeout",
  "empty-response",
  "stream-closed",
]);

const SYSTEM_PROMPT = [
  "你是任务看板研判引擎。输入是一段 DSH（AI 编程助手）会话的紧凑摘要，输出任务卡 JSON。",
  "只输出一个 JSON 对象，不要 markdown 代码块，不要解释，不要任何 JSON 之外的文字。结构：",
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
  "4. 只归纳当前会话的任务；任务关联由用户管理，mergeWith 填 null。",
  "5. status：进行中→in_progress；正常结束且完成→done；报错卡住→blocked；未开始/搁置→backlog。done 时 progress=100。",
  "6. 摘要里 end:completed 表示最后一轮正常结束：若最后一条助手消息表明已交付/完成，且没有更新的用户指令，应判 done；end:interrupted/aborted 且无后续活动 → in_progress 或 blocked。",
  "7. 待办快照可能是很早以前的旧计划，只作参考，不要因旧快照未完成而把已完成任务判成进行中。",
  "8. 没有明确用户委托时 ignore=true、tasks=[]。输出必须紧凑完整，确保 JSON 闭合。",
].join("\n");

const POLISH_SYSTEM_PROMPT =
  "你是提示词润色助手。把用户给出的「继续任务」提示词改写得更清晰、可执行：保留原意与所有事实，补充验收标准与汇报要求，不要添加新需求，不要解释，只输出润色后的提示词正文（≤600字）。";

/**
 * Some model outputs contain a malformed evidence field like `"seq=917"`
 * instead of `"seq": 917`, or trailing commas. Repair those before giving up.
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

/** Validate the task payload shape without trusting model output. */
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

/** Build the user-visible part of an analysis request. */
export function buildUserText(digest, existingTasks) {
  const relevant = Array.isArray(existingTasks) ? existingTasks.slice(0, 3) : [];
  const taskLines = relevant.length
    ? relevant.map((task) => `- ${task.id}「${String(task.title || "").slice(0, 30)}」${task.status}`).join("\n")
    : "(无)";
  return `会话摘要：\n${digest}\n\n已有相关任务：\n${taskLines}\n\n输出 JSON。`;
}

/**
 * Map DSH TokenUsage onto the three fields the board stores.
 *
 * `totalTokens` is optional in the contract: adapters that omit it must not be
 * recorded as input+output only — DSH's TokenUsage also reports cache reads and
 * cache writes (disjoint from `inputTokens`), and dropping them under-counts the
 * board's token usage/cost display.
 */
function normalizeUsage(usage) {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const cacheRead = Number(usage?.cacheReadTokens) || 0;
  const cacheWrite = Number(usage?.cacheWriteTokens) || 0;
  const total = Number.isFinite(Number(usage?.totalTokens))
    ? Number(usage.totalTokens)
    : input + output + cacheRead + cacheWrite;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: Math.max(0, total),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Prepare one call, picking the model's least reasoning effort and a sane
 * output cap. Falls back to a plain stream when the adapter has no prepareCall.
 */
async function prepareCall({ llm, provider, model, signal, maxTokens = MAX_OUTPUT_TOKENS }) {
  if (typeof llm.prepareCall !== "function") return null;
  try {
    const call = await llm.prepareCall({ provider, model }, signal, (controls, modelInfo) => {
      const effort = modelInfo?.reasoning?.efforts?.[0]?.id;
      const modelDefault = Number(modelInfo?.defaultMaxTokens);
      const cap = Number.isFinite(modelDefault) && modelDefault > 0 ? Math.min(maxTokens, modelDefault) : maxTokens;
      const next = { ...controls, maxTokens: cap };
      return effort === undefined ? next : { ...next, reasoningEffort: effort };
    });
    return call && typeof call.stream === "function" ? call : null;
  } catch {
    return null;
  }
}

/**
 * One provider attempt: accumulate text deltas, capture usage and the terminal
 * finish. Never throws for provider outcomes — they become `{ok:false, code}`.
 */
async function streamOnce({ llm, provider, model, system, messages, signal, maxTokens = MAX_OUTPUT_TOKENS }) {
  if (signal?.aborted) return { ok: false, code: "aborted" };
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  let text = "";
  let usage = null;
  let finish = null;
  let thrown = null;
  try {
    const call = await prepareCall({ llm, provider, model, signal: controller.signal, maxTokens });
    const config = call ? { ...call.config } : { provider, model, maxTokens };
    const options = { ...config, messages, system, signal: controller.signal };
    const iterable = call ? call.stream(options) : llm.stream(options);
    for await (const chunk of iterable) {
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "usage") usage = normalizeUsage(chunk.usage);
      else if (chunk.type === "finish") finish = chunk.reason;
    }
  } catch (error) {
    thrown = error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
  if (signal?.aborted) return { ok: false, code: "aborted" };
  if (timedOut) return { ok: false, code: "timeout", message: `LLM timed out after ${TIMEOUT_MS}ms` };
  if (thrown) return { ok: false, code: "llm-failed", message: String(thrown?.message || thrown) };
  if (!finish) return { ok: false, code: "stream-closed", message: "LLM stream ended without a terminal finish" };
  if (finish.kind === "aborted") return { ok: false, code: "aborted" };
  if (finish.kind === "error") {
    const providerCode = String(finish.failure?.code || "UNKNOWN");
    return {
      ok: false,
      code: providerCode,
      providerCode,
      message: String(finish.failure?.message || providerCode),
      retryAfterMs: Number(finish.failure?.providerRetryAfterMs) || 0,
    };
  }
  if (finish.kind === "max-tokens") return { ok: false, code: "truncated", message: "output truncated by maxTokens" };
  if (finish.kind === "tool-calls") return { ok: false, code: "tool-calls", message: "unexpected tool call" };
  if (!text.trim()) return { ok: false, code: "empty-response", message: "provider returned empty content" };
  return { ok: true, text, usage: usage || normalizeUsage(null) };
}

/**
 * Create the board's LLM analyzer bound to the host context.
 * @param {object} options
 * @param {object} options.ctx Cordis host context (may expose `llm` / `logger`).
 * @param {object} [options.logger] logger override (tests).
 */
export function createLlmAnalyzer({ ctx, logger } = {}) {
  const log = logger || ctx?.logger || console;
  let budget = { limit: 40, calls: 0, attempts: 0, tokens: 0 };

  /** @returns {boolean} whether the host composition exposes `ctx.llm`. */
  function hasService() {
    return Boolean(llmOf(ctx));
  }

  /**
   * Analyze one session digest.
   * @returns {Promise<{ok:true, tasks:Array<object>, sessionSummary:string, ignore:boolean,
   *   usage:{promptTokens:number, completionTokens:number, totalTokens:number},
   *   model:string, provider:string} | {ok:false, error:string, code:string}>}
   */
  async function analyze({ provider, model, digest, existingTasks, signal } = {}) {
    const llm = llmOf(ctx);
    if (!llm) return { ok: false, error: "llm service unavailable", code: "llm-unavailable" };
    if (!provider || !model) return { ok: false, error: "provider and model are required", code: "no-route" };
    if (budget.calls >= budget.limit) return { ok: false, error: "scan-call-budget-exhausted", code: "budget" };

    const messages = [{ role: "user", content: [{ type: "text", text: buildUserText(digest, existingTasks) }] }];
    const correctionMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: '注意：你上一次的输出不是合法 JSON（例如把 evidence 的 seq 写成了 "seq=917"）。请严格输出一个完整闭合的 JSON 对象；evidence 必须是 {"seq": 数字, "kind": "...", "quote": "..."}。不要输出 markdown 代码块。',
        },
      ],
    };
    let lastExtractFailed = false;
    let lastError = null;
    budget.calls += 1;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const attemptMessages = lastExtractFailed ? [...messages, correctionMessage] : messages;
        const outcome = await streamOnce({ llm, provider, model, system: SYSTEM_PROMPT, messages: attemptMessages, signal });
        budget.attempts += 1;
        if (!outcome.ok) {
          lastError = { code: outcome.code, error: outcome.message || outcome.code };
          if (outcome.code === "aborted") return { ok: false, error: "aborted", code: "aborted" };
          if (outcome.code === "truncated" || outcome.code === "tool-calls") break;
          const retryable = RETRYABLE_CODES.has(outcome.code);
          if (retryable && attempt < MAX_ATTEMPTS - 1) {
            const delay = Number(outcome.retryAfterMs) > 0 ? Math.min(Number(outcome.retryAfterMs), MAX_RETRY_DELAY_MS) : 800 * (attempt + 1);
            await sleep(delay);
            continue;
          }
          break;
        }
        budget.tokens += outcome.usage.totalTokens;
        const parsed = extractJsonObject(outcome.text);
        if (!parsed) {
          lastExtractFailed = true;
          lastError = { code: "json", error: "json-extract-failed" };
          continue;
        }
        const validated = validatePayload(parsed);
        if (validated.error) {
          lastError = { code: "schema", error: validated.error };
          continue;
        }
        return { ok: true, ...validated.data, usage: outcome.usage, model, provider };
      }
      return { ok: false, error: lastError?.error || "llm-failed", code: lastError?.code || "llm-failed" };
    } finally {
      /* budget bookkeeping happens above; nothing to release */
    }
  }

  /**
   * Optional one-shot prompt polish (task.polishPrompt). Counts against the
   * same budget and returns ok:false instead of throwing when unavailable.
   */
  async function polish({ provider, model, prompt, signal } = {}) {
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) return { ok: false, error: "prompt-required", code: "invalid-input" };
    const llm = llmOf(ctx);
    if (!llm) return { ok: false, error: "llm service unavailable", code: "llm-unavailable" };
    if (!provider || !model) return { ok: false, error: "provider and model are required", code: "no-route" };
    if (budget.calls >= budget.limit) return { ok: false, error: "call-budget-exhausted", code: "budget" };
    budget.calls += 1;
    const outcome = await streamOnce({
      llm,
      provider,
      model,
      system: POLISH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: text.slice(0, 3000) }] }],
      signal,
      maxTokens: POLISH_OUTPUT_TOKENS,
    });
    budget.attempts += 1;
    if (!outcome.ok) return { ok: false, error: outcome.message || outcome.code, code: outcome.code };
    budget.tokens += outcome.usage.totalTokens;
    const polished = outcome.text.trim().slice(0, 2000);
    if (!polished) return { ok: false, error: "empty-response", code: "empty-response" };
    return { ok: true, prompt: polished, usage: outcome.usage, model, provider };
  }

  return {
    analyze,
    polish,
    hasService,
    resetBudget: (limit = 40) => {
      budget = { limit: Math.max(0, Math.round(Number(limit) || 0)), calls: 0, attempts: 0, tokens: 0 };
    },
    getBudget: () => ({ ...budget }),
    log,
  };
}

export { SYSTEM_PROMPT, POLISH_SYSTEM_PROMPT, TIMEOUT_MS, MAX_OUTPUT_TOKENS };
