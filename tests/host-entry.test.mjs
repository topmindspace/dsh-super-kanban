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

async function callHandler(registered, { url = `${API_PREFIX}/ping`, method = "GET" } = {}) {
  const res = new MockResponse();
  const req = { url, method };
  await registered.handler(req, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, body: res.body, json };
}

const owner = { peer: { principal: { kind: "owner" } } };

test("index exports the plugin name and mounts a prefix route", (t) => {
  assert.equal(name, "super-kanban");
  const { captured } = setup(t, () => owner);
  assert.ok(captured.registered, "webServer.register must be called");
  assert.equal(captured.registered.kind, "prefix");
  assert.equal(captured.registered.path, API_PREFIX);
  assert.equal(typeof captured.registered.handler, "function");
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

test("DSH admission rejections are passed through as unauthorized", async (t) => {
  const { captured } = setup(t, () => ({ rejection: 401 }));
  const { status, json } = await callHandler(captured.registered);
  assert.equal(status, 401);
  assert.deepEqual(json, { ok: false, error: "unauthorized" });
});

test("non-owner peers are rejected with 403 before touching the service", async (t) => {
  const { captured } = setup(t, () => ({ peer: { principal: { kind: "member" } } }));
  const { status, json } = await callHandler(captured.registered);
  assert.equal(status, 403);
  assert.deepEqual(json, { ok: false, error: "unauthorized" });
});

test("a throwing admission probe fails closed with 403 and no rejected promise", async (t) => {
  const { captured } = setup(t, () => {
    throw new Error("connection unavailable");
  });
  const { status, json } = await callHandler(captured.registered);
  assert.equal(status, 403);
  assert.deepEqual(json, { ok: false, error: "unauthorized" });
});

test("malformed admission shapes fail closed", async (t) => {
  for (const admission of [null, "owner", [], { peer: {} }, { peer: { principal: {} } }]) {
    const { captured } = setup(t, () => admission);
    const { status } = await callHandler(captured.registered);
    assert.equal(status, 403, `admission ${JSON.stringify(admission)} must be rejected`);
  }
});
