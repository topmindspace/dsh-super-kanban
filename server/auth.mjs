/**
 * Super Kanban — owner authentication for the plugin HTTP surface.

 * Boundary: the board exposes personal session data, so only the DSH owner may
 * call it. DSH's `connection.admit(req)` is the only trusted source of identity;
 * this module normalizes its (few) shapes and fails closed on anything else,
 * including an admission probe that throws.
 *
 * Kept separate from index.mjs so the decision table can be unit tested.
 */

/**
 * @typedef {{ok: true} | {ok: false, status: number, error?: Error}} OwnerAdmission
 */

/**
 * Decide whether an HTTP request may use the kanban API.
 * Fails closed: any unexpected/malformed admission result is rejected.
 *
 * @param {{admit?: (req: unknown) => unknown}} connection DSH connection service
 * @param {unknown} req incoming request
 * @returns {OwnerAdmission}
 */
export function ownerAdmission(connection, req) {
  try {
    if (!connection || typeof connection.admit !== "function") return { ok: false, status: 403 };
    const admission = connection.admit(req);
    if (!admission || typeof admission !== "object") return { ok: false, status: 403 };
    if ("rejection" in admission) {
      const status = Number(admission.rejection);
      return { ok: false, status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403 };
    }
    const principal = admission.peer?.principal;
    if (principal?.kind === "owner") return { ok: true };
    return { ok: false, status: 403 };
  } catch (error) {
    // An admission failure must never become an allow or an unhandled rejection.
    return { ok: false, status: 403, error };
  }
}
