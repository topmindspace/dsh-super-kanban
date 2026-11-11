/**
 * Hermetic tests for `GET /super-kanban/api/ai/models` (v3 flat model catalog).
 *
 * A synthetic `ctx.llm` / `ctx.agentDefaultModel` stands in for the DSH host;
 * no network and no real `$DSH_HOME` is ever touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { createKanbanService } from "../server/service.mjs";

/* ------------------------------------------------------------------ */
/* HTTP harness                                                        */
/* ------------------------------------------------------------------ */

class MockResponse {
  constructor() {
    this.status = null;
    this.headers = null;
    this.body = "";
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write() {
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== "") this.body += String(chunk);
    this.writableEnded = true;
  }

  flushHeaders() {}
}

function call(service, { method = "GET", route = "/ai/models", body } = {}) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  const res = new MockResponse();
  const url = new URL(`http://plugin.local${route}`);
  const pending = service.handle(req, res, { route, url, method });
  if (body !== undefined) {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  }
  return pending.then(() => {
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  });
}

async function command(service, op, payload = {}) {
  return call(service, { method: "POST", route: "/command", body: { op, payload } });
}

const getCatalog = (service) => call(service);

/* ------------------------------------------------------------------ */
/* Fake DSH host                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {boolean} [options.noLlm]
 * @param {Array<{id:string,name?:string}>} [options.providers]
 * @param {object} [options.models] provider id -> model list | Error | function.
 * @param {{provider:string,model:string}|null} [options.defaultSelection]
 */
function makeHost({
  noLlm = false,
  providers = [
    { id: "deepseek-account", name: "DeepSeek Account" },
    { id: "minimax-cn", name: "MiniMax CN" },
  ],
  models = {
    "deepseek-account": [{ id: "deepseek-flash", name: "DeepSeek Flash" }, { id: "deepseek-pro" }],
    "minimax-cn": [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
  },
  defaultSelection = { provider: "deepseek-account", model: "deepseek-flash" },
} = {}) {
  const listModelCalls = [];
  const onHandlers = [];
  let disposed = 0;
  let selection = defaultSelection;
  const llm = {
    stream() {
      throw new Error("catalog tests never stream");
    },
    listProviders() {
      return providers.map((provider) => ({ ...provider }));
    },
    async listModels(providerId) {
      listModelCalls.push(providerId);
      const entry = models[providerId];
      if (entry instanceof Error) throw entry;
      if (typeof entry === "function") return entry();
      return (entry || []).map((model) => ({ provider: providerId, id: model.id, name: model.name || model.id }));
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "llm") return noLlm ? undefined : llm;
      if (name === "agentDefaultModel") {
        if (!selection) return undefined;
        return { currentSelection: () => ({ ...selection, reasoningEffort: "max" }) };
      }
      return undefined;
    },
    on(event, handler) {
      onHandlers.push({ event, handler });
      return () => {
        disposed += 1;
      };
    },
  };
  return {
    ctx,
    llm,
    listModelCalls,
    onHandlers,
    disposed: () => disposed,
    setDefaultSelection: (next) => {
      selection = next;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

async function setup(t, { host = makeHost(), serviceOptions = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-aimodels-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = createKanbanService({ ctx: host.ctx, ...serviceOptions });
  await command(service, "settings.update", { patch: { autoScan: false } });
  t.after(() => {
    try {
      service.stop();
    } catch {
      /* already stopped */
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  return { home, service, host };
}

async function stopService(service) {
  service.stop();
}

/* ------------------------------------------------------------------ */
/* Contract shape                                                      */
/* ------------------------------------------------------------------ */

test("GET /ai/models returns the flat catalog contract", async (t) => {
  const host = makeHost();
  const { service } = await setup(t, { host });
  const { status, json } = await getCatalog(service);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.catalogAvailable, true);
  assert.deepEqual(json.default, { provider: "deepseek-account", model: "deepseek-flash" });
  assert.equal("reasoningEffort" in json.default, false, "the board does not consume reasoningEffort");
  assert.deepEqual(json.providers, [
    { id: "deepseek-account", name: "DeepSeek Account", modelCount: 2 },
    { id: "minimax-cn", name: "MiniMax CN", modelCount: 1 },
  ]);
  assert.deepEqual(json.models, [
    { provider: "deepseek-account", id: "deepseek-flash", name: "DeepSeek Flash" },
    { provider: "deepseek-account", id: "deepseek-pro", name: "deepseek-pro" },
    { provider: "minimax-cn", id: "MiniMax-M2.7", name: "MiniMax M2.7" },
  ]);
  assert.deepEqual(json.failures, []);
  assert.ok(Number.isNaN(Date.parse(json.fetchedAt)) === false);
  // /state must stay small: the catalog is not part of it.
  const state = await call(service, { route: "/state" });
  assert.equal("providers" in state.json, false);
  assert.equal("models" in state.json, false);
});

test("provider display names fall back to the provider id", async (t) => {
  const host = makeHost({ providers: [{ id: "minimax-cn" }], models: { "minimax-cn": [] } });
  const { service } = await setup(t, { host });
  const { json } = await getCatalog(service);
  assert.deepEqual(json.providers, [{ id: "minimax-cn", name: "minimax-cn", modelCount: 0 }]);
  assert.deepEqual(json.models, []);
  assert.deepEqual(json.failures, []);
});

/* ------------------------------------------------------------------ */
/* Cache + invalidation                                                */
/* ------------------------------------------------------------------ */

test("the catalog is cached for 30s", async (t) => {
  const host = makeHost();
  const { service } = await setup(t, { host });
  const first = await getCatalog(service);
  assert.equal(host.listModelCalls.length, 2);
  const second = await getCatalog(service);
  assert.equal(host.listModelCalls.length, 2, "a second read inside the TTL must not re-list models");
  assert.equal(second.json.fetchedAt, first.json.fetchedAt);
});

test("DSH model events invalidate the catalog cache and the default selection is refreshed", async (t) => {
  const host = makeHost();
  const { service } = await setup(t, { host });
  await getCatalog(service);
  assert.equal(host.listModelCalls.length, 2);

  host.setDefaultSelection({ provider: "minimax-cn", model: "MiniMax-M2.7" });
  const modelsUpdated = host.onHandlers.find((entry) => entry.event === "llm/models-updated");
  assert.ok(modelsUpdated, "llm/models-updated is subscribed");
  modelsUpdated.handler("minimax-cn");
  const afterModelsEvent = await getCatalog(service);
  assert.equal(host.listModelCalls.length, 4, "llm/models-updated must invalidate the cache");
  assert.deepEqual(afterModelsEvent.json.default, { provider: "minimax-cn", model: "MiniMax-M2.7" });

  const adaptersUpdated = host.onHandlers.find((entry) => entry.event === "llm/adapters-updated");
  assert.ok(adaptersUpdated, "llm/adapters-updated is subscribed");
  adaptersUpdated.handler();
  await getCatalog(service);
  assert.equal(host.listModelCalls.length, 6, "llm/adapters-updated must invalidate the cache");
});

test("stop() disposes the catalog and session event subscriptions", async (t) => {
  const host = makeHost();
  const { service } = await setup(t, { host });
  await getCatalog(service);
  assert.deepEqual(
    host.onHandlers.map((entry) => entry.event),
    ["llm/adapters-updated", "llm/models-updated", "session/event"],
  );
  await stopService(service);
  assert.equal(host.disposed(), 3);
});

/* ------------------------------------------------------------------ */
/* Failure isolation + timeouts                                        */
/* ------------------------------------------------------------------ */

test("one provider failure is isolated without exposing its raw diagnostic", async (t) => {
  const host = makeHost({ models: { "minimax-cn": new Error("credential unavailable"), "deepseek-account": [{ id: "deepseek-flash" }] } });
  const { service } = await setup(t, { host });
  const { status, json } = await getCatalog(service);
  assert.equal(status, 200);
  assert.equal(json.catalogAvailable, true);
  assert.deepEqual(json.providers, [
    { id: "deepseek-account", name: "DeepSeek Account", modelCount: 1 },
    { id: "minimax-cn", name: "MiniMax CN", modelCount: 0 },
  ]);
  assert.deepEqual(json.models, [{ provider: "deepseek-account", id: "deepseek-flash", name: "deepseek-flash" }]);
  assert.deepEqual(json.failures, [{ provider: "minimax-cn", name: "MiniMax CN", message: "读取模型目录失败" }]);
  assert.doesNotMatch(JSON.stringify(json), /credential unavailable/);
});

test("a hanging provider is cut off by the catalog timeout without hiding the others", async (t) => {
  const host = makeHost({
    models: { slow: () => new Promise(() => {}), fast: [{ id: "fast-model" }] },
    providers: [{ id: "slow" }, { id: "fast" }],
    defaultSelection: { provider: "fast", model: "fast-model" },
  });
  const { service } = await setup(t, { host, serviceOptions: { aiCatalogTimeoutMs: 25 } });
  const started = Date.now();
  const { status, json } = await getCatalog(service);
  assert.equal(status, 200);
  assert.ok(Date.now() - started < 2000, "the timeout keeps the endpoint bounded");
  assert.deepEqual(json.providers, [
    { id: "slow", name: "slow", modelCount: 0 },
    { id: "fast", name: "fast", modelCount: 1 },
  ]);
  assert.deepEqual(json.models, [{ provider: "fast", id: "fast-model", name: "fast-model" }]);
  assert.deepEqual(json.failures, [{ provider: "slow", name: "slow", message: "读取模型目录超时" }]);
});

/* ------------------------------------------------------------------ */
/* Degraded hosts                                                      */
/* ------------------------------------------------------------------ */

test("without the native llm service the endpoint reports catalogAvailable:false", async (t) => {
  const host = makeHost({ noLlm: true });
  const { service } = await setup(t, { host });
  const { status, json } = await getCatalog(service);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.catalogAvailable, false);
  assert.equal(json.default, null);
  assert.deepEqual(json.providers, []);
  assert.deepEqual(json.models, []);
  assert.deepEqual(json.failures, []);
  assert.ok(Number.isNaN(Date.parse(json.fetchedAt)) === false);
});

test("an old ctx without get/on still serves /ai/models (no crash)", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-aimodels-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = createKanbanService({ ctx: { logger: { info() {}, warn() {} } } });
  t.after(() => {
    try {
      service.stop();
    } catch {
      /* ignore */
    }
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const { status, json } = await getCatalog(service);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.catalogAvailable, false);
  assert.deepEqual(json.failures, []);
});

test("only GET is accepted on /ai/models", async (t) => {
  const { service } = await setup(t);
  const post = await call(service, { method: "POST", route: "/ai/models", body: {} });
  assert.equal(post.status, 404);
  assert.equal(post.json.error, "not-found");
});
