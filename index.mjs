/**
 * Super Kanban — host half entry.
 *
 * Keeps the cordis wiring thin: mounts the plugin's HTTP surface on the DSH web
 * server and hands every request to the kanban service (server/service.mjs),
 * which owns session scanning, AI analysis, storage and the board state.
 */
import { createKanbanService } from "./server/service.mjs";
import { ownerAdmission } from "./server/auth.mjs";

export const name = "super-kanban";

const API_PREFIX = "/super-kanban/api";

/** Write a small JSON error without ever throwing into the DSH web server. */
function sendJson(res, status, body) {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  } catch {
    /* socket already closed */
  }
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
            // Owner-only: this board reads the user's private session logs.
            const admission = ownerAdmission(webCtx.connection, req);
            if (!admission.ok) {
              if (admission.error) {
                ctx.logger?.warn?.(`[super-kanban] admission failed: ${String(admission.error?.message || admission.error)}`);
              }
              sendJson(res, admission.status, { ok: false, error: "unauthorized" });
              return;
            }
            let url;
            try {
              url = new URL(req.url || "/", "http://localhost");
            } catch {
              sendJson(res, 400, { ok: false, error: "invalid-input", message: "invalid request URL" });
              return;
            }
            const route = url.pathname.slice(API_PREFIX.length) || "/";
            try {
              await service.handle(req, res, { route, url, method: req.method || "GET" });
            } catch (error) {
              ctx.logger?.warn?.(`[super-kanban] request failed: ${String(error?.message || error)}`);
              sendJson(res, 500, { ok: false, error: "internal", message: String(error?.message || error) });
            }
          },
        }),
      "super-kanban: API routes",
    );
  });
}
