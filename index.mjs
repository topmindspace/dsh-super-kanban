/**
 * Super Kanban — host half entry.
 *
 * Keeps the cordis wiring thin: mounts the plugin's HTTP surface on the DSH web
 * server and hands every request to the kanban service (server/service.mjs),
 * which owns session scanning, AI analysis, storage and the board state.
 */
import { createKanbanService } from "./server/service.mjs";

export const name = "super-kanban";

const API_PREFIX = "/super-kanban/api";

/** Only the DSH owner's authenticated peer may use this personal board. */
function ownerRejection(connection, req) {
  const admission = connection.admit(req);
  if ("rejection" in admission) return admission.rejection;
  return admission.peer.principal.kind === "owner" ? undefined : 403;
}

export function apply(ctx) {
  const service = createKanbanService({ ctx });

  ctx.effect(() => {
    const dispose = service.start?.();
    return () => {
      dispose?.();
      service.stop();
    };
  }, "super-kanban: service lifetime");

  ctx.inject(["connection", "webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: API_PREFIX,
          handler: async (req, res) => {
            const rejection = ownerRejection(webCtx.connection, req);
            if (rejection !== undefined) {
              res.writeHead(rejection, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
              return;
            }
            const url = new URL(req.url || "/", "http://localhost");
            const route = url.pathname.slice(API_PREFIX.length) || "/";
            try {
              await service.handle(req, res, { route, url, method: req.method || "GET" });
            } catch (error) {
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: "internal",
                    message: String(error?.message || error),
                  }),
                );
              } else {
                try {
                  res.end();
                } catch {
                  /* response already gone */
                }
              }
            }
          },
        }),
      "super-kanban: API routes",
    );
  });
}
