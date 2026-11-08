/**
 * Hermetic tests for the v3 AI route + budget scheduling (server/service.mjs).
 *
 * A synthetic `ctx.llm` (async-generator scripts) and a synthetic
 * `ctx.agentDefaultModel` stand in for the DSH host, so these tests never touch
 * the network or the real `$DSH_HOME`. Every case gets a temp home.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";

import { createKanbanService } from "../server/service.mjs";
import { SESSION_FILE_NAME } from "../server/sessions.mjs";
import { DEFAULT_SETTINGS, emptyUsage, todayKey } from "../server/store.mjs";

// Recent enough for initialDays=30 eligibility, old enough not to be "live".
const T0 = Date.now() - 3_600_000;

/* ------------------------------------------------------------------ */
/* Session fixtures                                                    */
/* ------------------------------------------------------------------ */

function event(type, seq, time, data = {}) {
  return { type, seq, time, data };
}

function writeFileDeep(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sessionFrames(sessionId, workspaceDir, title) {
  const zstd = (chunk) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(chunk)}\n`));
  const events = [
    event("session", 1, T0, { id: sessionId, createdAt: T0, cwd: workspaceDir }),
    event("session/title", 3, T0 + 1000, { title, source: { kind: "provider" } }),
    event("user/message", 3, T0 + 2000, { content: [{ type: "text", text: "修复登录流程并补测试" }] }),
    event("turn/start", 4, T0 + 3000, { turn: 1 }),
    event("assistant/message", 5, T0 + 4000, { message: { content: [{ type: "text", text: "已修复登录流程" }] } }),
    event("todo/write", 6, T0 + 5000, {
      todos: [
        { content: "定位问题", status: "completed" },
        { content: "补充测试", status: "pending" },
      ],
    }),
    event("tool/call", 7, T0 + 6000, { name: "write", callId: "call-1", arguments: JSON.stringify({ path: "README.md" }) }),
    event("tool/result", 8, T0 + 7000, { toolCallId: "call-1", message: { content: [{ type: "text", text: "written" }] } }),
    event("deliverables/presented", 9, T0 + 8000, { files: [{ path: "README.md", description: "说明" }] }),
    event("turn/end", 10, T0 + 9000, { turn: 1, reason: { kind: "completed" } }),
  ];
  return Buffer.concat(events.map(zstd));
}

/**
 * Seed N main sessions, each in its own workspace (distinct workspaceId keeps
 * the duplicate-merge phase from collapsing cards across sessions).
 */
function seedSessions(home, sessionIds) {
  const workspaces = {};
  const workspaceIds = [];
  for (const [index, sessionId] of sessionIds.entries()) {
    const workspaceId = `ws-${index}`;
    workspaceIds.push(workspaceId);
    const workspaceDir = path.join(home, `workspace-${index}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "README.md"), `# demo ${index}\n`);
    writeFileDeep(path.join(home, "sessions", "escaped-demo", sessionId, SESSION_FILE_NAME), sessionFrames(sessionId, workspaceDir, `会话 ${index}`));
    writeFileDeep(
      path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`),
      JSON.stringify({
        record: {
          identity: { createdAt: T0, cwd: workspaceDir },
          rows: {
            title: { val: `会话 ${index}` },
            sessionStats: { val: { turns: 1 } },
            timeContext: { val: { lastMessageTime: T0 + 9000 } },
          },
        },
      }),
    );
    workspaces[workspaceId] = {
      path: workspaceDir,
      title: `Workspace ${index}`,
      sessionIds: [sessionId],
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0 + 9000).toISOString(),
    };
  }
  writeFileDeep(
    path.join(home, "storages", "workspace.json"),
    JSON.stringify({ global: { workspaceIds }, tables: { workspaces } }),
  );
}

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

function call(service, { method = "GET", route = "/state", body } = {}) {
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

function command(service, op, payload = {}) {
  return call(service, { method: "POST", route: "/command", body: { op, payload } });
}

async function getState(service) {
  return (await call(service)).json;
}

async function runScan(service) {
  const started = await command(service, "scan.start", { mode: "full" });
  assert.equal(started.status, 200, `scan.start failed: ${JSON.stringify(started.json)}`);
  const deadline = Date.now() + 5000;
  for (;;) {
    const state = await getState(service);
    if (state.scan.state !== "running") return state;
    if (Date.now() > deadline) throw new Error("scan did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ */
/* Fake DSH host (ctx.llm + ctx.agentDefaultModel)                     */
/* ------------------------------------------------------------------ */

const TASK_PAYLOAD = (title = "修复登录流程") => ({
  sessionSummary: "修复登录并补测试",
  ignore: false,
  tasks: [
    {
      title,
      goal: "登录可用并通过测试",
      status: "in_progress",
      progress: 50,
      priority: "P1",
      tags: [],
      keyFacts: [],
      issues: [],
      nextSteps: [],
      subtasks: [],
      evidence: [],
      confidence: 0.8,
      reason: "已修复一半",
      mergeWith: null,
    },
  ],
});

function okScript(payload = TASK_PAYLOAD(), usage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }) {
  return [
    { type: "text-delta", index: 0, text: JSON.stringify(payload) },
    { type: "usage", usage },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function ignoreScript() {
  return [
    { type: "text-delta", index: 0, text: JSON.stringify({ sessionSummary: "无委托", ignore: true, tasks: [] }) },
    { type: "usage", usage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function errorScript(code) {
  return [
    { type: "usage", usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } },
    { type: "finish", reason: { kind: "error", failure: { code, message: `${code} failed` } } },
  ];
}

/**
 * @param {object} options
 * @param {boolean} [options.noLlm] host composition without the native llm service.
 * @param {Array<Array<object>>} [options.scripts] one chunk script per analyze call.
 * @param {Array<{id:string,name?:string}>} [options.providers] registered provider routes.
 * @param {object} [options.models] provider id -> model list | Error | function.
 * @param {{provider:string,model:string}|null} [options.defaultSelection]
 */
function makeHost({
  noLlm = false,
  scripts = [],
  providers = [{ id: "deepseek-account", name: "DeepSeek Account" }],
  models = { "deepseek-account": [{ id: "deepseek-flash", name: "DeepSeek Flash" }] },
  defaultSelection = { provider: "deepseek-account", model: "deepseek-flash" },
} = {}) {
  const streams = [];
  const listModelCalls = [];
  const warns = [];
  const onHandlers = [];
  const queue = [...scripts];
  const llm = {
    stream(options) {
      streams.push(options);
      const script = queue.shift() || errorScript("EMPTY_SCRIPT");
      return (async function* replay() {
        for (const chunk of script) yield chunk;
      })();
    },
    listProviders() {
      return providers.map((provider) => ({ ...provider }));
    },
    async listModels(providerId) {
      listModelCalls.push(providerId);
      const entry = models[providerId];
      if (entry instanceof Error) throw entry;
      if (typeof entry === "function") return entry();
      return (entry || []).map((model) => ({
        provider: providerId,
        id: model.id,
        name: model.name || model.id,
      }));
    },
  };
  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warns.push(String(message));
      },
    },
    get(name) {
      if (name === "llm") return noLlm ? undefined : llm;
      if (name === "agentDefaultModel") {
        if (!defaultSelection) return undefined;
        return {
          currentSelection: () => ({ ...defaultSelection, reasoningEffort: "max" }),
        };
      }
      return undefined;
    },
    on(event, handler) {
      onHandlers.push({ event, handler });
      return () => {};
    },
  };
  return { ctx, llm, streams, listModelCalls, warns, queue };
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function writeStateFile(home, { settings = {}, usage = {}, tasks = [] } = {}) {
  const dir = path.join(home, "storages", "super-kanban");
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    version: 2,
    savedAt: new Date().toISOString(),
    tasks,
    settings: { ...DEFAULT_SETTINGS, autoScan: false, ...settings },
    usage: { ...emptyUsage(), ...usage },
    ignoredSessions: [],
    suppressedSessions: [],
    deletedLog: [],
    workspaces: [],
    activity: [],
    scan: { state: "idle", message: "等待首次扫描" },
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
}

function writeCacheFile(home, sessions) {
  const dir = path.join(home, "storages", "super-kanban");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions-cache.json"), JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), sessions }));
}

function readCacheFile(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "storages", "super-kanban", "sessions-cache.json"), "utf8"));
}

async function setup(t, { sessionIds = [], state = {}, cache = null, host = makeHost(), serviceOptions = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-aibudget-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  if (sessionIds.length) seedSessions(home, sessionIds);
  writeStateFile(home, state);
  if (cache) writeCacheFile(home, cache);
  const service = createKanbanService({ ctx: host.ctx, ...serviceOptions });
  // Keep the autonomous scanner out of the assertions: state already has
  // autoScan=false, but a stale prepare() could flip it back on.
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

function aiTasks(state, engine) {
  return state.tasks.filter((task) => task.ai && task.ai.engine === engine);
}

/* ------------------------------------------------------------------ */
/* Budget: auto                                                        */
/* ------------------------------------------------------------------ */

test("auto budget analyzes every due session and reports no remainder", async (t) => {
  const host = makeHost({
    scripts: [okScript(TASK_PAYLOAD("修复登录流程")), okScript(TASK_PAYLOAD("更新部署文档")), okScript(TASK_PAYLOAD("补充单元测试"))],
  });
  const { service } = await setup(t, { sessionIds: ["sess-01", "sess-02", "sess-03"], host });

  const state = await runScan(service);
  const scan = state.scan;
  assert.equal(scan.state, "done");
  assert.equal(scan.aiDue, 3);
  assert.equal(scan.aiBudget, 3, "auto budget = min(due sessions, daily remaining)");
  assert.equal(scan.aiCalls, 3);
  assert.equal(scan.aiAttempts, 3);
  assert.equal(scan.aiPending, 0);
  assert.equal(scan.aiDeferredReason, null);
  assert.match(scan.message, /AI 3 次\/4500 tokens/);
  assert.doesNotMatch(scan.message, /剩余/);
  assert.equal(host.streams.length, 3);
  // The deprecated settings.model must never be used as the request model.
  for (const options of host.streams) {
    assert.equal(options.provider, "deepseek-account");
    assert.equal(options.model, "deepseek-flash");
    assert.equal("sessionId" in options, false);
  }
  const llmTasks = aiTasks(state, "llm");
  assert.equal(llmTasks.length, 3);
  for (const task of llmTasks) {
    assert.equal(task.ai.provider, "deepseek-account");
    assert.equal(task.ai.model, "deepseek-flash");
  }
  // usage is post-scan: 3 calls / 4500 tokens recorded for today.
  assert.equal(state.usage.calls, 3);
  assert.equal(state.usage.tokens, 4500);
});

/* ------------------------------------------------------------------ */
/* Budget: fixed / daily caps                                          */
/* ------------------------------------------------------------------ */

test("fixed budget truncates the scan and reports the remaining sessions", async (t) => {
  const scripts = Array.from({ length: 5 }, (_value, index) => okScript(TASK_PAYLOAD(`任务方向 ${index}`)));
  const host = makeHost({ scripts });
  const { service } = await setup(t, {
    sessionIds: ["sess-01", "sess-02", "sess-03", "sess-04", "sess-05", "sess-06", "sess-07", "sess-08"],
    state: { settings: { aiBudgetMode: "fixed", maxAiCallsPerScan: 5 } },
    host,
  });

  const state = await runScan(service);
  const scan = state.scan;
  assert.equal(scan.aiDue, 8);
  assert.equal(scan.aiBudget, 5);
  assert.equal(scan.aiCalls, 5);
  assert.equal(scan.aiAttempts, 5);
  assert.equal(scan.aiPending, 3, "aiPending counts sessions that got no AI verdict");
  assert.equal(scan.aiDeferredReason, "budget");
  assert.match(scan.message, /本次 AI 预算已用完（5 次）其余仅规则/);
  assert.match(scan.message, /剩余 3 个会话下次扫描继续/);
  assert.equal(host.streams.length, 5);
});

test("daily-capped budget reports post-scan usage and resumes after the limit is raised", async (t) => {
  const scripts = [
    okScript(TASK_PAYLOAD("修复登录流程")),
    okScript(TASK_PAYLOAD("更新部署文档")),
    okScript(TASK_PAYLOAD("补充单元测试")),
    okScript(TASK_PAYLOAD("重构计费服务")),
  ];
  const host = makeHost({ scripts });
  const { service } = await setup(t, {
    sessionIds: ["sess-01", "sess-02", "sess-03", "sess-04"],
    // 148/150 used: the daily remainder (2) binds below the fixed cap (5).
    state: { settings: { aiBudgetMode: "fixed", maxAiCallsPerScan: 5 }, usage: { date: todayKey(), calls: 148, tokens: 100 } },
    host,
  });

  const first = await runScan(service);
  assert.equal(first.scan.aiBudget, 2);
  assert.equal(first.scan.aiCalls, 2);
  assert.equal(first.scan.aiPending, 2);
  assert.equal(first.scan.aiDeferredReason, "daily");
  // Post-scan accounting: 148 + 2 = 150, never the stale pre-scan 148/150.
  assert.match(first.scan.message, /今日 AI 预算已用完（150\/150）/);
  assert.doesNotMatch(first.scan.message, /148\/150/);
  assert.match(first.scan.message, /剩余 2 个会话明日继续/);

  // Raising the daily limit lets the deferred sessions resume on the next scan.
  const patched = await command(service, "settings.update", { patch: { dailyAiCallLimit: 500 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.dailyAiCallLimit, 500);
  const second = await runScan(service);
  assert.equal(second.scan.aiDue, 2, "only the deferred sessions are still due");
  assert.equal(second.scan.aiCalls, 2);
  assert.equal(second.scan.aiPending, 0);
  assert.equal(second.scan.aiDeferredReason, null);
  assert.match(second.scan.message, /AI 2 次\/3000 tokens/);
});

test("daily budget already exhausted: no calls, rules cards, tomorrow message", async (t) => {
  const host = makeHost({ scripts: [okScript()] });
  const { service } = await setup(t, {
    sessionIds: ["sess-01", "sess-02"],
    state: { usage: { date: todayKey(), calls: 150, tokens: 5000 } },
    host,
  });

  const state = await runScan(service);
  assert.equal(state.scan.aiDue, 2);
  assert.equal(state.scan.aiBudget, 0);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(state.scan.aiPending, 2);
  assert.equal(state.scan.aiDeferredReason, "daily");
  assert.equal(host.streams.length, 0, "no provider call may happen when the daily budget is gone");
  assert.match(state.scan.message, /今日 AI 预算已用完（150\/150）/);
  assert.match(state.scan.message, /剩余 2 个会话明日继续/);
  assert.match(state.scan.message, /本次无 AI 调用/);
  // Rules cards are still produced and existing cards are untouched.
  assert.equal(state.tasks.length, 2);
  for (const task of state.tasks) {
    assert.equal(task.ai.engine, "rules");
    assert.equal(task.ai.model, "");
    assert.equal(task.ai.provider, null);
  }
});

/* ------------------------------------------------------------------ */
/* Priority                                                            */
/* ------------------------------------------------------------------ */

test("AI priority: never-analyzed debt wins over a changed session", async (t) => {
  const host = makeHost({ scripts: [okScript(TASK_PAYLOAD("重构计费服务幂等层"))] });
  // sess-changed already got an AI verdict earlier and has new activity since
  // (the cached signature differs, so this scan re-parses it); sess-debt has
  // never been analyzed. Budget 1 forces a choice between them.
  const cache = {
    "sess-changed": {
      sigKey: "0:0",
      meta: {
        id: "sess-changed",
        origin: "main",
        hasUserMessages: true,
        userCount: 1,
        eventCount: 10,
        deliverableCount: 1,
        errorCount: 0,
        lastActivityAt: T0 + 9000,
        aiAt: new Date(Date.now() - 300_000).toISOString(),
        aiLastSeq: 1,
        aiUserCount: 0,
      },
    },
  };
  const { service } = await setup(t, {
    sessionIds: ["sess-changed", "sess-debt"],
    state: { settings: { aiBudgetMode: "fixed", maxAiCallsPerScan: 5 }, usage: { date: todayKey(), calls: 149, tokens: 0 } },
    cache,
    host,
  });

  const state = await runScan(service);
  assert.equal(state.scan.aiDue, 2);
  assert.equal(state.scan.aiBudget, 1);
  assert.equal(state.scan.aiCalls, 1);
  assert.equal(state.scan.aiPending, 1);
  const llmCards = aiTasks(state, "llm");
  assert.equal(llmCards.length, 1);
  assert.equal(llmCards[0].primarySessionId, "sess-debt", "the never-analyzed session must spend the only budget unit");
  const rulesCards = aiTasks(state, "rules");
  assert.equal(rulesCards.length, 1);
  assert.equal(rulesCards[0].primarySessionId, "sess-changed");
});

/* ------------------------------------------------------------------ */
/* Wall clock                                                          */
/* ------------------------------------------------------------------ */

test("AI wall-clock guard defers the remaining sessions", async (t) => {
  const host = makeHost({ scripts: [okScript(), okScript()] });
  const { service } = await setup(t, {
    sessionIds: ["sess-01", "sess-02"],
    host,
    serviceOptions: { aiScanMaxMs: 0 },
  });

  const state = await runScan(service);
  assert.equal(state.scan.aiDue, 2);
  assert.equal(state.scan.aiBudget, 2);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(state.scan.aiAttempts, 0);
  assert.equal(state.scan.aiPending, 2);
  assert.equal(state.scan.aiDeferredReason, "time");
  assert.match(state.scan.message, /本次 AI 阶段已达 10 分钟上限/);
  assert.match(state.scan.message, /剩余 2 个会话下次扫描继续/);
  assert.equal(host.streams.length, 0);
});

/* ------------------------------------------------------------------ */
/* Failure cooldown                                                    */
/* ------------------------------------------------------------------ */

test("a failed analysis cools down and then retries after the cooldown", async (t) => {
  const host = makeHost({ scripts: [errorScript("AUTH")] });
  const { home, service } = await setup(t, { sessionIds: ["sess-01"], host });

  await runScan(service);
  assert.equal(host.streams.length, 1, "a non-retryable AUTH failure gets one attempt");
  const cache = readCacheFile(home);
  const entry = cache.sessions["sess-01"];
  assert.ok(entry?.meta?.llmError, "the failure is cached on the session meta");
  assert.ok(Number.isNaN(Date.parse(entry.meta.aiErrorAt)) === false, "aiErrorAt is an ISO timestamp");
  service.stop();

  // Second service, same home, immediately after the failure: cooling down.
  const secondHost = makeHost({ scripts: [okScript()] });
  const second = createKanbanService({ ctx: secondHost.ctx });
  t.after(() => second.stop());
  await command(second, "settings.update", { patch: { autoScan: false } });
  const cooling = await runScan(second);
  assert.equal(cooling.scan.aiDue, 0, "the failed session is cooling down");
  assert.equal(cooling.scan.aiCalls, 0);
  assert.equal(secondHost.streams.length, 0);
  assert.match(cooling.scan.message, /本次无 AI 调用/);
  second.stop();

  // Expire the cooldown on disk, then the session is retried and analyzed.
  const expired = readCacheFile(home);
  expired.sessions["sess-01"].meta.aiErrorAt = new Date(Date.now() - 600_000).toISOString();
  fs.writeFileSync(path.join(home, "storages", "super-kanban", "sessions-cache.json"), JSON.stringify(expired));
  const thirdHost = makeHost({ scripts: [okScript()] });
  const third = createKanbanService({ ctx: thirdHost.ctx });
  t.after(() => third.stop());
  await command(third, "settings.update", { patch: { autoScan: false } });
  const retried = await runScan(third);
  assert.equal(retried.scan.aiDue, 1);
  assert.equal(retried.scan.aiCalls, 1);
  assert.equal(thirdHost.streams.length, 1);
  const cards = aiTasks(retried, "llm");
  assert.equal(cards.length, 1);
});

/* ------------------------------------------------------------------ */
/* task.analyze                                                        */
/* ------------------------------------------------------------------ */

test("task.analyze counts an ignore verdict as a consumed AI call", async (t) => {
  const host = makeHost({ scripts: [ignoreScript()] });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });
  const created = await command(service, "task.create", { title: "Manual card", sessionId: "sess-01" });
  assert.equal(created.status, 200);
  const analyzed = await command(service, "task.analyze", { id: created.json.data.id });
  assert.equal(analyzed.status, 200, JSON.stringify(analyzed.json));
  const data = analyzed.json.data;
  assert.equal(data.engine, "rules", "an ignore verdict creates/updates no LLM card");
  assert.equal(data.aiCalls, 1, "the ignored analysis still consumed one budget unit");
  assert.equal(data.tokens, 920);
  assert.match(data.message, /无需建卡/);
  const state = await getState(service);
  assert.equal(state.usage.calls, 1);
});

test("task.analyze uses the resolved route and returns provider/model", async (t) => {
  const host = makeHost({
    scripts: [okScript(TASK_PAYLOAD("修复登录流程"))],
    providers: [{ id: "minimax-cn", name: "MiniMax" }],
    models: { "minimax-cn": [{ id: "MiniMax-M2.7" }] },
    defaultSelection: { provider: "minimax-cn", model: "MiniMax-M2.7" },
  });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });
  assert.equal((await command(service, "settings.update", { patch: { aiProvider: "minimax-cn", aiModel: "MiniMax-M2.7" } })).status, 200);
  const created = await command(service, "task.create", { title: "Explicit route", sessionId: "sess-01" });
  const analyzed = await command(service, "task.analyze", { id: created.json.data.id });
  assert.equal(analyzed.status, 200, JSON.stringify(analyzed.json));
  assert.equal(analyzed.json.data.engine, "llm");
  assert.equal(analyzed.json.data.provider, "minimax-cn");
  assert.equal(analyzed.json.data.model, "MiniMax-M2.7");
  assert.equal(host.streams[0].provider, "minimax-cn");
  assert.equal(host.streams[0].model, "MiniMax-M2.7");
  assert.equal(analyzed.json.data.task.ai.provider, "minimax-cn");
});

test("task.polishPrompt uses the resolved route and counts one AI call", async (t) => {
  const host = makeHost({ scripts: [[{ type: "text-delta", index: 0, text: "润色后的提示词" }, { type: "finish", reason: { kind: "stop" } }]] });
  const { service } = await setup(t, { host });
  const polished = await command(service, "task.polishPrompt", { prompt: "继续修复登录" });
  assert.equal(polished.status, 200, JSON.stringify(polished.json));
  assert.equal(polished.json.data.polished, true);
  assert.equal(polished.json.data.prompt, "润色后的提示词");
  assert.equal(host.streams[0].provider, "deepseek-account");
  assert.equal(host.streams[0].model, "deepseek-flash");
  const state = await getState(service);
  assert.equal(state.usage.calls, 1);
});

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

test("budget settings: auto/fixed roundtrip, clamp, invalid mode and old-client inference", async (t) => {
  const host = makeHost();
  const { service } = await setup(t, { host });

  let state = await getState(service);
  assert.equal(state.settings.aiBudgetMode, "auto");
  assert.equal(state.settings.maxAiCallsPerScan, 40);

  const fixed = await command(service, "settings.update", { patch: { aiBudgetMode: "fixed", maxAiCallsPerScan: 80 } });
  assert.equal(fixed.json.data.aiBudgetMode, "fixed");
  assert.equal(fixed.json.data.maxAiCallsPerScan, 80);

  const clamped = await command(service, "settings.update", { patch: { maxAiCallsPerScan: 9999 } });
  assert.equal(clamped.json.data.maxAiCallsPerScan, 150);

  const invalidMode = await command(service, "settings.update", { patch: { aiBudgetMode: "bogus" } });
  assert.equal(invalidMode.json.data.aiBudgetMode, "fixed", "an invalid mode leaves the previous value untouched");

  // Old clients only send a number: that update is inferred as fixed.
  await command(service, "settings.update", { patch: { aiBudgetMode: "auto" } });
  const legacy = await command(service, "settings.update", { patch: { maxAiCallsPerScan: 20 } });
  assert.equal(legacy.json.data.aiBudgetMode, "fixed");
  assert.equal(legacy.json.data.maxAiCallsPerScan, 20);

  // Unrelated updates never flip the mode.
  const unrelated = await command(service, "settings.update", { patch: { autoScan: false } });
  assert.equal(unrelated.json.data.aiBudgetMode, "fixed");

  const backToAuto = await command(service, "settings.update", { patch: { aiBudgetMode: "auto" } });
  assert.equal(backToAuto.json.data.aiBudgetMode, "auto");
  state = await getState(service);
  assert.equal(state.settings.aiBudgetMode, "auto");
  // Never persist the deprecated model as an AI route.
  assert.equal(typeof state.settings.model, "string");
});

/* ------------------------------------------------------------------ */
/* Model resolution (proposal §2.3-2 table)                            */
/* ------------------------------------------------------------------ */

test("no native llm service: rules-only scan, explicit message, rules provenance", async (t) => {
  const host = makeHost({ noLlm: true });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const state = await runScan(service);
  assert.equal(state.scan.aiDue, 1);
  assert.equal(state.scan.aiBudget, 0);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(state.scan.aiPending, 1);
  assert.equal(state.scan.aiDeferredReason, null);
  assert.match(state.scan.message, /当前 DSH 未提供 AI 模型服务/);
  assert.match(state.scan.message, /剩余 1 个会话下次扫描继续/, "CONTRACT §5.4: aiPending must be stated in the message");
  assert.equal(host.streams.length, 0);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].ai.engine, "rules");
  assert.equal(state.tasks[0].ai.model, "");
  assert.equal(state.tasks[0].ai.provider, null);
  // Prompt polish degrades to the original text instead of failing.
  const polished = await command(service, "task.polishPrompt", { prompt: "继续修复登录" });
  assert.equal(polished.status, 200);
  assert.equal(polished.json.data.polished, false);
  assert.equal(polished.json.data.prompt, "继续修复登录");
});

test("explicit route: used as-is, recorded in task.ai, and no catalog I/O in the scan path", async (t) => {
  const host = makeHost({
    scripts: [okScript()],
    providers: [{ id: "minimax-cn", name: "MiniMax" }],
    models: { "minimax-cn": [] }, // empty catalog: must NOT block the explicit route
    defaultSelection: { provider: "deepseek-account", model: "deepseek-flash" },
  });
  const { service } = await setup(t, {
    sessionIds: ["sess-01"],
    state: { settings: { aiProvider: "minimax-cn", aiModel: "MiniMax-M2.7" } },
    host,
  });

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 1);
  assert.equal(host.streams.length, 1);
  assert.equal(host.streams[0].provider, "minimax-cn");
  assert.equal(host.streams[0].model, "MiniMax-M2.7");
  assert.equal(host.listModelCalls.length, 0, "the scan hot path must not list models");
  const card = aiTasks(state, "llm")[0];
  assert.equal(card.ai.provider, "minimax-cn");
  assert.equal(card.ai.model, "MiniMax-M2.7");
});

test("explicit route with an unregistered provider: rules-only, never switches models", async (t) => {
  const host = makeHost({ scripts: [okScript()] });
  const { service } = await setup(t, {
    sessionIds: ["sess-01"],
    state: { settings: { aiProvider: "ghost-provider", aiModel: "ghost-model" } },
    host,
  });

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(state.scan.aiPending, 1);
  assert.equal(host.streams.length, 0);
  assert.match(state.scan.message, /所选模型提供方 ghost-provider 已不可用/);
  assert.equal(state.tasks[0].ai.engine, "rules");
});

test("half-set model route normalizes to follow-default with a warning", async (t) => {
  const host = makeHost({ scripts: [okScript()] });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const updated = await command(service, "settings.update", {
    patch: { aiProvider: "deepseek-account", aiModel: "" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.aiProvider, "");
  assert.equal(updated.json.data.aiModel, "");
  assert.ok(host.warns.some((message) => /half-set AI model route/.test(message)), "the normalization is logged");

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 1);
  assert.equal(host.streams[0].provider, "deepseek-account", "follows the DSH default after normalization");
});

test("unregistered DSH default provider: rules-only, never falls back to the catalog", async (t) => {
  const host = makeHost({
    scripts: [okScript()],
    providers: [{ id: "deepseek-account", name: "DeepSeek Account" }],
    models: { "deepseek-account": [{ id: "deepseek-flash" }] },
    defaultSelection: { provider: "ghost-default", model: "ghost-model" },
  });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(host.streams.length, 0);
  assert.match(state.scan.message, /DSH 默认模型提供方 ghost-default 不可用/);
  assert.equal(state.tasks[0].ai.engine, "rules");
});

test("no default model: falls back to the first catalog model", async (t) => {
  const host = makeHost({
    scripts: [okScript()],
    providers: [{ id: "p1", name: "Provider One" }],
    models: { p1: [{ id: "m1", name: "Model One" }] },
    defaultSelection: null,
  });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 1);
  assert.equal(host.streams.length, 1);
  assert.equal(host.streams[0].provider, "p1");
  assert.equal(host.streams[0].model, "m1");
  const card = aiTasks(state, "llm")[0];
  assert.equal(card.ai.provider, "p1");
  assert.equal(card.ai.model, "m1");
});

test("no default model and an empty catalog: rules-only with a setup message", async (t) => {
  const host = makeHost({
    scripts: [okScript()],
    providers: [{ id: "p1", name: "Provider One" }],
    models: { p1: [] },
    defaultSelection: null,
  });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const state = await runScan(service);
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(host.streams.length, 0);
  assert.match(state.scan.message, /DSH 尚未设置默认模型/);
  assert.equal(state.tasks[0].ai.engine, "rules");
});

test("registered provider with an empty catalog still gets one attempt, then degrades with a cooldown", async (t) => {
  const host = makeHost({
    scripts: [errorScript("MISSING_CREDENTIAL")],
    providers: [{ id: "deepseek-account", name: "DeepSeek Account" }],
    models: { "deepseek-account": [] },
  });
  const { service } = await setup(t, { sessionIds: ["sess-01"], host });

  const state = await runScan(service);
  assert.equal(host.streams.length, 1, "no pre-emptive block: one route attempt is made");
  assert.equal(state.scan.aiCalls, 0);
  assert.equal(state.scan.aiPending, 1);
  assert.match(state.scan.message, /1 个会话研判失败，5 分钟后重试/);
  assert.match(state.scan.message, /剩余 1 个会话下次扫描继续/);
  assert.equal(state.tasks[0].ai.engine, "rules");
});
