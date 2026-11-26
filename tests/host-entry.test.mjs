/**
 * Tests for the host entry (index.mjs): DSH wiring + owner-only admission.
 * Runs the real plugin apply() against a fake cordis context and a temp
 * $DSH_HOME; the DSH connection service is the only mocked boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, name } from "../index.mjs";

const API_PREFIX = "/super-kanban/api";

class MockResponse {
  constructor() {
    this.status = null;
    this.headers = null;
    this.body = "";
    this.headersSent = false;
    this.writableEnded = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== "") this.body += String(chunk);
    this.writableEnded = true;
  }
}

function fakeCtx(admit) {
  const captured = { disposers: [] };
  const connection = { admit };
  const track = (value) => {
    if (typeof value === "function") captured.disposers.push(value);
    return value;
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      return track(fn());
    },
    inject(_deps, callback) {
      callback({
        effect(fn) {
          return track(fn());
        },
        webServer: {
          register(config) {
            captured.registered = config;
            return () => {};
          },
        },
        connection,
      });
    },
  };
  return { ctx, captured, connection };
}

function setup(t, admit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-host-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const { ctx, captured, connection } = fakeCtx(admit);
  apply(ctx);
  t.after(() => {
    for (const dispose of captured.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  return { home, captured, connection };
}

async function callHandler(registered, { url = `${API_PREFIX}/ping`, method = "GET", headers = {}, peer } = {}) {
  const res = new MockResponse();
  const req = { url, method, headers };
  if (peer === undefined) await registered.handler(req, res);
  else await registered.handler(req, res, peer);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, body: res.body, json };
}

const owner = { peer: { principal: { kind: "owner" } } };

test("index exports the plugin name and mounts an auth-required prefix route", (t) => {
  assert.equal(name, "super-kanban");
  const { captured } = setup(t, () => owner);
  assert.ok(captured.registered, "webServer.register must be called");
  assert.equal(captured.registered.kind, "prefix");
  assert.equal(captured.registered.path, API_PREFIX);
  assert.equal(captured.registered.auth, "required");
  assert.equal(typeof captured.registered.handler, "function");
});

test("DSH >= 0.2.3 WebServer owner peer is admitted even when connection.admit(req) rejects (#19)", async (t) => {
  const { captured } = setup(t, () => ({ rejection: 401 }));
  const { status, json } = await callHandler(captured.registered, {
    url: `${API_PREFIX}/state`,
    peer: { principal: { kind: "owner" }, signal: new AbortController().signal },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.tasks));
});

test("DSH >= 0.2.3 non-owner WebServer peer is rejected with 403 and never falls back to connection.admit", async (t) => {
  const { captured } = setup(t, () => owner);
  const { status, headers, json } = await callHandler(captured.registered, {
    headers: { "x-super-kanban-locale": "en-US" },
    peer: { principal: { kind: "guest" } },
  });
  assert.equal(status, 403);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(json.ok, false);
  assert.equal(json.error, "unauthorized");
  assert.match(json.message, /Only the owner/);
});

test("owner can read the AI model catalog through the real wiring", async (t) => {
  const { captured } = setup(t, () => owner);
  const { status, json } = await callHandler(captured.registered, { url: `${API_PREFIX}/ai/models` });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // This fake context has no `llm` service: the endpoint degrades, never throws.
  assert.equal(json.catalogAvailable, false);
  assert.equal(json.default, null);
  assert.deepEqual(json.providers, []);
  assert.deepEqual(json.models, []);
  assert.deepEqual(json.failures, []);
});

test("owner requests are forwarded to the kanban service", async (t) => {
  const { captured } = setup(t, () => owner);
  const ping = await callHandler(captured.registered);
  assert.equal(ping.status, 200);
  assert.equal(ping.json.ok, true);
  assert.equal(ping.json.plugin, "dsh-super-kanban");

  const notFound = await callHandler(captured.registered, { url: `${API_PREFIX}/nope` });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error, "not-found");
});

test("DSH admission rejections are passed through as unauthorized with localized message", async (t) => {
  const { captured } = setup(t, () => ({ rejection: 401 }));
  const zh = await callHandler(captured.registered);
  assert.equal(zh.status, 401);
  assert.equal(zh.headers["Cache-Control"], "no-store");
  assert.equal(zh.json.ok, false);
  assert.equal(zh.json.error, "unauthorized");
  assert.match(zh.json.message, /登录态已失效/);

  const en = await callHandler(captured.registered, { headers: { "x-super-kanban-locale": "en" } });
  assert.equal(en.status, 401);
  assert.equal(en.json.error, "unauthorized");
  assert.match(en.json.message, /Session expired or not authenticated/);
});

test("non-owner peers are rejected with 403 before touching the service", async (t) => {
  const { captured } = setup(t, () => ({ peer: { principal: { kind: "member" } } }));
  const { status, json } = await callHandler(captured.registered);
  assert.equal(status, 403);
  assert.equal(json.ok, false);
  assert.equal(json.error, "unauthorized");
  assert.match(json.message, /持有者/);
});

test("a throwing admission probe fails closed with 403 and no rejected promise", async (t) => {
  const { captured } = setup(t, () => {
    throw new Error("connection unavailable");
  });
  const { status, json } = await callHandler(captured.registered);
  assert.equal(status, 403);
  assert.equal(json.ok, false);
  assert.equal(json.error, "unauthorized");
  assert.match(json.message, /持有者/);
});

test("GET /session/:id/tool-call enforces owner admission end-to-end through index.mjs", async (t) => {
  const { captured } = setup(t, () => ({ rejection: 401 }));
  const allowed = await callHandler(captured.registered, {
    url: `${API_PREFIX}/session/sess-demo/tool-call?callId=call-1`,
    peer: { principal: { kind: "owner" }, signal: new AbortController().signal },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.ok, true);
  assert.equal(allowed.json.found, false);

  const denied = await callHandler(captured.registered, {
    url: `${API_PREFIX}/session/sess-demo/tool-call?callId=call-1`,
    peer: { principal: { kind: "guest" } },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, "unauthorized");
});

test("malformed admission shapes fail closed", async (t) => {
  for (const admission of [null, "owner", [], { peer: {} }, { peer: { principal: {} } }]) {
    const { captured } = setup(t, () => admission);
    const { status } = await callHandler(captured.registered);
    assert.equal(status, 403, `admission ${JSON.stringify(admission)} must be rejected`);
  }
});
