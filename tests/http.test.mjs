import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  badRequest,
  classifyError,
  clipText,
  conflict,
  decodeId,
  isStringArray,
  json,
  notFound,
  readBody,
} from "../server/http.mjs";

function mockReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
    req.emit("close");
  };
  return req;
}

function mockRes() {
  const res = {
    status: null,
    headers: null,
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
  return res;
}

test("json writes JSON headers and body", () => {
  const res = mockRes();
  json(res, 201, { ok: true, value: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual(JSON.parse(res.body), { ok: true, value: 1 });
});

test("readBody: empty body resolves to an empty object", async () => {
  const req = mockReq();
  const pending = readBody(req);
  req.emit("end");
  assert.deepEqual(await pending, {});
});

test("readBody: joins chunked bodies and parses JSON", async () => {
  const req = mockReq();
  const pending = readBody(req);
  req.emit("data", Buffer.from('{"op":"task.'));
  req.emit("data", Buffer.from('create","payload":{}}'));
  req.emit("end");
  assert.deepEqual(await pending, { op: "task.create", payload: {} });
});

test("readBody: malformed JSON rejects with invalid-input", async () => {
  const req = mockReq();
  const pending = readBody(req);
  req.emit("data", Buffer.from("{nope"));
  req.emit("end");
  await assert.rejects(pending, (error) => error.code === "invalid-input" && /invalid-json/.test(error.message));
});

test("readBody: enforces the byte limit and destroys the request", async () => {
  const req = mockReq();
  const pending = readBody(req, { limit: 8 });
  req.emit("data", Buffer.from("0123456789"));
  await assert.rejects(pending, (error) => error.code === "invalid-input" && /request-too-large/.test(error.message));
  assert.equal(req.destroyed, true);
});

test("readBody: stalled request times out instead of pinning memory", async () => {
  const req = mockReq();
  const pending = assert.rejects(readBody(req, { timeoutMs: 5 }), /request-timeout/);
  // The body timer is unref'd (it must not keep a server alive on its own), so
  // keep the event loop busy ourselves until it fires.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await pending;
  assert.equal(req.destroyed, true);
});

test("readBody: stream errors reject as invalid-input", async () => {
  const req = mockReq();
  const pending = readBody(req);
  req.emit("error", new Error("socket reset"));
  await assert.rejects(pending, (error) => error.code === "invalid-input" && /socket reset/.test(error.message));
});

test("classifyError maps the plugin error taxonomy to HTTP statuses", () => {
  assert.equal(classifyError(badRequest("x")), 400);
  assert.equal(classifyError(notFound("x")), 404);
  assert.equal(classifyError(conflict("x")), 409);
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "stopped" })), 503);
  assert.equal(classifyError(new Error("x")), 500);
  assert.equal(classifyError(null), 500);
});

test("clipText / isStringArray", () => {
  assert.equal(clipText("abcdef", 4), "abc…");
  assert.equal(clipText("abc", 4), "abc");
  assert.equal(clipText(null, 4), "");
  assert.equal(clipText(42, 4), "");
  assert.equal(isStringArray([]), true);
  assert.equal(isStringArray(["a", "b"]), true);
  assert.equal(isStringArray(["a", 1]), false);
  assert.equal(isStringArray("a"), false);
});

test("decodeId rejects malformed encodings, separators and over-long ids", () => {
  assert.equal(decodeId("sess-alpha"), "sess-alpha");
  assert.equal(decodeId("sess%2Dalpha"), "sess-alpha");
  assert.equal(decodeId("%E0%A4%A"), null, "invalid percent-encoding");
  assert.equal(decodeId("..%2F..%2Fstate"), null, "path separators");
  assert.equal(decodeId("..%5C..%5Cstate"), null, "windows separators");
  assert.equal(decodeId("a%00b"), null, "NUL byte");
  assert.equal(decodeId(""), null);
  assert.equal(decodeId("x".repeat(201)), null);
  assert.equal(decodeId("x".repeat(200)), "x".repeat(200));
  assert.equal(decodeId(42), null);
});
