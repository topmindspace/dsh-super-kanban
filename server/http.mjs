/**
 * Super Kanban — HTTP plumbing and payload validation.

 * Boundary: this module owns the tiny amount of generic protocol logic the host
 * service needs (JSON responses, bounded body reads, error taxonomy, id/payload
 * validation). It has no dependency on the board state, session source or store,
 * which is what makes it unit-testable without a running DSH web server.
 *
 * Errors are plain `Error`s carrying a `code` used by `classifyError`:
 *   invalid-input → 400, not-found → 404, busy → 409, stopped → 503, else 500.
 */

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
/** Session/task ids are short opaque tokens; anything longer is not a real id. */
const MAX_ID_LENGTH = 200;

/** Write a JSON response with the plugin's standard no-store headers. */
export function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/**
 * Read and JSON-parse a request body with hard byte and time limits.
 * Rejects with `code: "invalid-input"` for oversized, stalled or malformed bodies.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {{limit?: number, timeoutMs?: number}} [options]
 * @returns {Promise<unknown>} parsed JSON ({} for an empty body)
 */
export function readBody(req, { limit = DEFAULT_BODY_LIMIT, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    let timer = null;

    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fn(value);
    };
    const fail = (error) => settle(reject)(error);
    const succeed = (value) => settle(resolve)(value);
    const tooLarge = () => Object.assign(new Error("request-too-large"), { code: "invalid-input" });
    const invalidJson = () => Object.assign(new Error("invalid-json"), { code: "invalid-input" });
    const destroy = () => {
      try {
        req.destroy?.();
      } catch {
        /* already gone */
      }
    };

    // A stalled owner request must not pin memory forever (slowloris-style).
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(Object.assign(new Error("request-timeout"), { code: "invalid-input" }));
        destroy();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(tooLarge());
        destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        succeed(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        fail(invalidJson());
      }
    });
    req.on("error", (error) => fail(Object.assign(error || new Error("request-error"), { code: "invalid-input" })));
  });
}

/** An `invalid-input` (HTTP 400) error. */
export function badRequest(message) {
  return Object.assign(new Error(message), { code: "invalid-input" });
}

/** A `not-found` (HTTP 404) error. */
export function notFound(message) {
  return Object.assign(new Error(message), { code: "not-found" });
}

/** A `busy` (HTTP 409) error, used when a scan is already running. */
export function conflict(message) {
  return Object.assign(new Error(message), { code: "busy" });
}

/** Map an operation error to its HTTP status. */
export function classifyError(error) {
  const code = error?.code || "internal";
  if (code === "invalid-input") return 400;
  if (code === "not-found") return 404;
  if (code === "busy") return 409;
  if (code === "stopped") return 503;
  return 500;
}

/** Clip a string to `max` code units (non-strings become ""). */
export function clipText(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True when every array item is a string (empty array included). */
export function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Decode one path segment into an opaque id.
 * Returns null (→ 400) for malformed percent-encoding, over-long values and
 * path separators, so ids can never smuggle a filesystem path into a lookup.
 *
 * @param {string} raw raw (still percent-encoded) route segment
 * @param {{maxLength?: number}} [options]
 * @returns {string|null}
 */
export function decodeId(raw, { maxLength = MAX_ID_LENGTH } = {}) {
  if (typeof raw !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded || decoded.length > maxLength) return null;
  if (decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\")) return null;
  return decoded;
}
