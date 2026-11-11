/**
 * Super Kanban — access to the DSH native LLM service.
 *
 * The board must work even when the host composition has no `llm` service (old
 * DSH or a minimal profile), so this module never imports `@deepseek-ai/*`
 * packages. It only reads the already-registered service from the Cordis
 * context, which keeps the plugin at zero third-party dependencies.
 *
 * NOTE: do not use `ctx.llm` property access here — without an `inject`
 * declaration Cordis throws `cannot get property "llm" without inject`.
 * `ctx.inject` cannot be used for availability probing either: its callback
 * simply never runs when the service is absent. `ctx.get(name)` is the only
 * safe, non-blocking lookup.
 */

/**
 * Resolve the DSH LLM runtime service from a Cordis context.
 * @param {object|undefined} ctx host context created by the plugin entry.
 * @returns {object|undefined} the `llm` service, or undefined when the host
 *   composition does not provide one.
 */
export function llmOf(ctx) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get("llm");
  } catch {
    return undefined;
  }
}

/** @returns {boolean} whether the host composition exposes the native LLM service. */
export function llmAvailable(ctx) {
  return Boolean(llmOf(ctx));
}

export const TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_TOKENS = 4096;

/** Include cache reads and writes when DSH omits the aggregate token count. */
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
async function collectStream({ llm, provider, model, system, messages, maxTokens = MAX_OUTPUT_TOKENS, onText, maxChars = 96_000 }, controller) {
  let text = "";
  let usage = null;
  let finish = null;
  let thrown = null;
  try {
    const call = await prepareCall({ llm, provider, model, signal: controller.signal, maxTokens });
    if (controller.signal.aborted) return { ok: false, code: "aborted" };
    const config = call ? { ...call.config } : { provider, model, maxTokens };
    const options = { ...config, messages, system, signal: controller.signal };
    const iterable = call ? call.stream(options) : llm.stream(options);
    for await (const chunk of iterable) {
      if (controller.signal.aborted) break;
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
        const delta = chunk.text.slice(0, maxChars - text.length);
        text += delta;
        if (delta) onText?.(delta);
        if (delta.length < chunk.text.length) {
          finish = { kind: "max-tokens" };
          controller.abort();
          break;
        }
      } else if (chunk.type === "usage") usage = normalizeUsage(chunk.usage);
      else if (chunk.type === "finish") {
        finish = chunk.reason;
        break;
      }
    }
  } catch (error) {
    thrown = error;
  }
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

export async function streamOnce({ signal, timeoutMs = TIMEOUT_MS, waitForCleanup = false, ...request }) {
  if (signal?.aborted) return { ok: false, code: "aborted" };
  const controller = new AbortController();
  let cancellation = null;
  const cancelled = Promise.withResolvers();
  const cancel = (code) => {
    cancellation ||= { ok: false, code };
    controller.abort();
    cancelled.resolve(cancellation);
  };
  const onOuterAbort = () => cancel("aborted");
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), timeoutMs);
  timer.unref?.();
  try {
    const response = collectStream(request, controller);
    const outcome = await (waitForCleanup ? response : Promise.race([response, cancelled.promise]));
    return cancellation || outcome;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
