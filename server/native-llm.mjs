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
