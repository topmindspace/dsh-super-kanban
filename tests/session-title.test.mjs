/**
 * Auto-task titles follow the source session's latest session/title event
 * and never overwrite a title the user edited (issue #4).
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
import { stableTaskId } from "../server/store.mjs";

const T0 = Date.now() - 3_600_000;
const SESSION_ID = "sess-ab12cd";
const PLACEHOLDER = `会话 ${SESSION_ID.slice(-6)}`;
const REAL_TITLE = "重构登录流程";

function lineOf(event) {
  return `${JSON.stringify(event)}\n`;
}

function framesOf(events) {
  return Buffer.concat(events.map((event) => zlib.zstdCompressSync(Buffer.from(lineOf(event)))));
}

function event(type, seq, time, data = {}) {
  return { type, seq, time, data };
}

function writeFileDeep(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sessionEvents({ sessionId = SESSION_ID, titleEvent = null, time = T0, extra = [] } = {}) {
  const events = [
    event("session", 1, time, { id: sessionId, createdAt: time, cwd: null }),
    event("user/message", 2, time + 2000, { content: [{ type: "text", text: "修复登录流程并补测试" }] }),
    event("turn/start", 3, time + 3000, { turn: 1 }),
    event("assistant/message", 4, time + 4000, { message: { content: [{ type: "text", text: "已修复登录流程" }] } }),
    event("todo/write", 5, time + 5000, {
      todos: [
        { content: "定位问题", status: "completed" },
        { content: "补充测试", status: "pending" },
      ],
    }),
    event("turn/end", 6, time + 6000, { turn: 1, reason: { kind: "completed" } }),
  ];
  if (titleEvent) events.push(titleEvent);
  events.push(...extra);
  events.sort((left, right) => left.seq - right.seq);
  return events;
}

function seedTitleHome(
  home,
  {
    sessionId = SESSION_ID,
    workspaceId = "ws-demo",
    projcacheTitle = PLACEHOLDER,
    titleEvent = event("session/title", 7, T0 + 7000, { title: REAL_TITLE, source: { kind: "provider" } }),
    extraEvents = [],
    time = T0,
  } = {},
) {
  const workspaceDir = path.join(home, "workspace-demo");
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeFileDeep(path.join(workspaceDir, "README.md"), "# demo\n");
  const events = sessionEvents({
    sessionId,
    titleEvent,
    time,
    extra: extraEvents,
  }).map((item) => {
    if (item.type === "session") return event("session", item.seq, item.time, { ...item.data, cwd: workspaceDir });
    return item;
  });
  const sessionDir = path.join(home, "sessions", "escaped-demo", sessionId);
  writeFileDeep(path.join(sessionDir, SESSION_FILE_NAME), framesOf(events));
  const lastTime = Math.max(...events.map((item) => item.time));
  writeFileDeep(
    path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`),
    JSON.stringify({
      record: {
        identity: { createdAt: time, cwd: workspaceDir },
        rows: {
          title: { val: projcacheTitle },
          sessionStats: { val: { turns: 1 } },
          timeContext: { val: { lastMessageTime: lastTime } },
        },
      },
    }),
  );
  const registryFile = path.join(home, "storages", "workspace.json");
  let registry = { global: { workspaceIds: [workspaceId] }, tables: { workspaces: {} } };
  if (fs.existsSync(registryFile)) registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.global.workspaceIds = [...new Set([...(registry.global.workspaceIds || []), workspaceId])];
  registry.tables.workspaces[workspaceId] = {
    path: workspaceDir,
    title: "Demo Workspace",
    sessionIds: [...new Set([...(registry.tables.workspaces[workspaceId]?.sessionIds || []), sessionId])],
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(lastTime).toISOString(),
  };
  writeFileDeep(registryFile, JSON.stringify(registry));
  return { workspaceDir, sessionDir, events };
}

function appendEvents(home, sessionId, events) {
  const file = path.join(home, "sessions", "escaped-demo", sessionId, SESSION_FILE_NAME);
  fs.appendFileSync(file, framesOf(events));
}

function mockReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  return req;
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
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
  write(chunk) {
    if (this.writableEnded) return false;
    this.body += String(chunk);
    return true;
  }
  end(chunk) {
    if (chunk !== undefined && chunk !== "") this.body += String(chunk);
    this.writableEnded = true;
  }
  flushHeaders() {}
}

function beginRequest(service, { method = "GET", route = "/state", body, search = "", headers = {} }) {
  const req = mockReq();
  req.headers = headers;
  const res = new MockResponse();
  const url = new URL(`http://plugin.local${route}${search}`);
  const pending = service.handle(req, res, { route, url, method });
  if (body !== undefined) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    req.emit("data", Buffer.from(text));
    req.emit("end");
  }
  return { req, res, pending };
}

async function request(service, options) {
  const { res, pending } = beginRequest(service, options);
  await pending;
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, body: res.body, json, res };
}

function command(service, op, payload = {}) {
  return request(service, { method: "POST", route: "/command", body: { op, payload } });
}

async function setup(t, { prepare = null, ctx = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-title-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  if (prepare) prepare(home);
  const service = createKanbanService({ ctx: { ...ctx, logger: { info() {}, warn() {} } } });
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
  return { home, service };
}

async function waitForScan(service, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const { json } = await request(service, { route: "/state" });
    if (json.scan.state !== "running") return json.scan;
    if (Date.now() - started > timeoutMs) throw new Error("scan did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function scanBoard(service, mode = "incremental") {
  const started = await command(service, "scan.start", { mode });
  assert.equal(started.status, 200);
  const scan = await waitForScan(service);
  assert.equal(scan.state, "done", scan.message);
  return (await request(service, { route: "/state" })).json;
}

function autoTask(state, sessionId = SESSION_ID) {
  return state.tasks.find((task) => task.primarySessionId === sessionId || task.sessions?.some((session) => session.id === sessionId));
}

test("an auto task takes the latest session/title even when projcache still holds the placeholder", async (t) => {
  const { service } = await setup(t, { prepare: (home) => seedTitleHome(home) });
  const state = await scanBoard(service);
  const task = autoTask(state);
  assert.ok(task, "scan should create an auto task");
  assert.equal(task.title, REAL_TITLE);
  assert.equal(task.sessions[0].title, REAL_TITLE);
  assert.equal(task.sessionContext.title, REAL_TITLE);
  const exported = (await request(service, { route: "/export" })).json;
  const exportedTask = exported.state.tasks.find((item) => item.id === task.id);
  assert.equal(exportedTask.title, REAL_TITLE);
});

test("a later session/title event refreshes an auto task that still shows the placeholder", async (t) => {
  const { home, service } = await setup(t, {
    prepare: (home) => seedTitleHome(home, { titleEvent: null, projcacheTitle: PLACEHOLDER }),
  });
  const first = await scanBoard(service);
  const task = autoTask(first);
  assert.ok(task);
  assert.equal(task.title, PLACEHOLDER);
  appendEvents(home, SESSION_ID, [
    event("session/title", 8, T0 + 8000, { title: REAL_TITLE, source: { kind: "provider" } }),
  ]);
  const second = await scanBoard(service);
  const updated = autoTask(second);
  assert.equal(updated.id, task.id);
  assert.equal(updated.title, REAL_TITLE);
  assert.equal(updated.sessions[0].title, REAL_TITLE);
  assert.equal(updated.origin, "auto");
});

test("a locked or user-edited title is never overwritten when the session is renamed", async (t) => {
  const { home, service } = await setup(t, { prepare: (home) => seedTitleHome(home) });
  const first = await scanBoard(service);
  const lockedTask = autoTask(first);
  assert.equal(lockedTask.title, REAL_TITLE);
  const locked = await command(service, "task.update", {
    id: lockedTask.id,
    patch: { title: "我自己起的名字" },
    lockFields: ["title"],
  });
  assert.equal(locked.status, 200);
  assert.equal(locked.json.data.lockedFields.includes("title"), true);

  const secondId = "sess-cd34ef";
  seedTitleHome(home, {
    sessionId: secondId,
    projcacheTitle: `会话 ${secondId.slice(-6)}`,
    titleEvent: event("session/title", 7, T0 + 7000, { title: "先用占位", source: { kind: "provider" } }),
  });
  const secondScan = await scanBoard(service, "full");
  const unlockedTask = autoTask(secondScan, secondId);
  assert.ok(unlockedTask);
  const edited = await command(service, "task.update", {
    id: unlockedTask.id,
    patch: { title: "没有加锁的手改标题" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.origin, "auto+edited");
  assert.equal(edited.json.data.lockedFields?.includes("title") ?? false, false);

  appendEvents(home, SESSION_ID, [
    event("session/title", 20, T0 + 20_000, { title: "会话又改名了", source: { kind: "provider" } }),
  ]);
  appendEvents(home, secondId, [
    event("session/title", 20, T0 + 20_000, { title: "第二会话也改名了", source: { kind: "provider" } }),
  ]);
  const after = await scanBoard(service, "full");
  assert.equal(autoTask(after, SESSION_ID).title, "我自己起的名字");
  assert.equal(autoTask(after, secondId).title, "没有加锁的手改标题");
  assert.equal(autoTask(after, SESSION_ID).sessions[0].title, "会话又改名了");
  assert.equal(autoTask(after, secondId).sessions[0].title, "第二会话也改名了");
});

test("accepting a card does not freeze a placeholder title; a later session title still lands", async (t) => {
  const { home, service } = await setup(t, {
    prepare: (home) => seedTitleHome(home, { titleEvent: null, projcacheTitle: PLACEHOLDER }),
  });
  const first = await scanBoard(service);
  const task = autoTask(first);
  assert.equal(task.title, PLACEHOLDER);
  const accepted = await command(service, "task.accept", { id: task.id });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.data.origin, "auto+edited");
  assert.equal(accepted.json.data.title, PLACEHOLDER);
  appendEvents(home, SESSION_ID, [
    event("session/title", 8, T0 + 8000, { title: REAL_TITLE, source: { kind: "provider" } }),
  ]);
  const second = await scanBoard(service);
  assert.equal(autoTask(second).title, REAL_TITLE);
  assert.equal(autoTask(second).status, "done");
});

test("a hand-built task keeps its title when the linked session is renamed", async (t) => {
  const { home, service } = await setup(t, { prepare: (home) => seedTitleHome(home) });
  await scanBoard(service);
  const created = await command(service, "task.create", { title: "手工规划的卡片" });
  assert.equal(created.status, 200);
  // The auto card already owns this session; merge would conflict. Build a
  // fresh session for the manual card instead.
  const manualSession = "sess-manual";
  seedTitleHome(home, {
    sessionId: manualSession,
    projcacheTitle: "初始会话名",
    titleEvent: event("session/title", 7, T0 + 7000, { title: "初始会话名", source: { kind: "provider" } }),
  });
  await scanBoard(service, "full");
  const autoForManual = autoTask((await request(service, { route: "/state" })).json, manualSession);
  if (autoForManual) {
    assert.equal((await command(service, "task.delete", { id: autoForManual.id })).status, 200);
  }
  const linked = await command(service, "task.linkSession", { id: created.json.data.id, sessionId: manualSession });
  assert.equal(linked.status, 200);
  appendEvents(home, manualSession, [
    event("session/title", 20, T0 + 20_000, { title: "会话改名不该动手工卡", source: { kind: "provider" } }),
  ]);
  const after = await scanBoard(service, "full");
  const manual = after.tasks.find((task) => task.id === created.json.data.id);
  assert.equal(manual.title, "手工规划的卡片");
  assert.equal(manual.origin, "manual");
  assert.equal(manual.sessions.find((session) => session.id === manualSession).title, "会话改名不该动手工卡");
});

test("a multi-session task follows only the primary session's title", async (t) => {
  const { home, service } = await setup(t, { prepare: (home) => seedTitleHome(home) });
  const first = await scanBoard(service);
  const task = autoTask(first);
  assert.equal(task.title, REAL_TITLE);
  const supportId = "sess-support";
  seedTitleHome(home, {
    sessionId: supportId,
    projcacheTitle: `会话 ${supportId.slice(-6)}`,
    titleEvent: event("session/title", 7, T0 + 7000, { title: "辅助会话标题", source: { kind: "provider" } }),
  });
  const withSupport = await scanBoard(service, "full");
  const supportTask = autoTask(withSupport, supportId);
  assert.ok(supportTask);
  assert.equal((await command(service, "task.delete", { id: supportTask.id })).status, 200);
  const linked = await command(service, "task.linkSession", { id: task.id, sessionId: supportId });
  assert.equal(linked.status, 200);
  assert.equal(linked.json.data.primarySessionId, SESSION_ID);

  appendEvents(home, supportId, [
    event("session/title", 20, T0 + 20_000, { title: "辅助会话新标题", source: { kind: "provider" } }),
  ]);
  const afterSupport = await scanBoard(service, "full");
  const same = autoTask(afterSupport, SESSION_ID);
  assert.equal(same.title, REAL_TITLE, "a supporting session rename must not change the task title");
  assert.equal(same.sessions.find((session) => session.id === supportId).title, "辅助会话新标题");

  appendEvents(home, SESSION_ID, [
    event("session/title", 21, T0 + 21_000, { title: "主会话新标题", source: { kind: "provider" } }),
  ]);
  const afterPrimary = await scanBoard(service, "full");
  const followed = autoTask(afterPrimary, SESSION_ID);
  assert.equal(followed.title, "主会话新标题");
  assert.equal(followed.sessions.find((session) => session.id === SESSION_ID).title, "主会话新标题");
});


test("an existing cache that preferred the placeholder is re-parsed and refreshes the card", async (t) => {
  const { service } = await setup(t, {
    prepare(home) {
      seedTitleHome(home);
      const file = path.join(home, "sessions", "escaped-demo", SESSION_ID, SESSION_FILE_NAME);
      const stat = fs.statSync(file);
      const sigKey = `${stat.size}:${stat.mtimeMs}`;
      const taskId = stableTaskId(SESSION_ID, 0);
      const now = new Date().toISOString();
      writeFileDeep(
        path.join(home, "storages", "super-kanban", "state.json"),
        JSON.stringify({
          version: 2,
          tasks: [
            {
              id: taskId,
              title: PLACEHOLDER,
              status: "in_progress",
              origin: "auto",
              primarySessionId: SESSION_ID,
              sessions: [{ id: SESSION_ID, title: PLACEHOLDER, seqEnd: 7, evidenceCount: 0 }],
              workspaceId: "ws-demo",
              workspaceTitle: "Demo Workspace",
              lockedFields: [],
              createdAt: now,
              updatedAt: now,
              lastActivityAt: T0 + 7000,
              archived: false,
              history: [],
            },
          ],
        }),
      );
      writeFileDeep(
        path.join(home, "storages", "super-kanban", "sessions-cache.json"),
        JSON.stringify({
          version: 2,
          sessions: {
            [SESSION_ID]: {
              sigKey,
              meta: {
                id: SESSION_ID,
                file,
                dir: path.dirname(file),
                sig: { size: stat.size, mtimeMs: stat.mtimeMs },
                sigKey,
                title: PLACEHOLDER,
                origin: "main",
                hasUserMessages: true,
                userCount: 1,
                lastActivityAt: T0 + 7000,
                lastEventSeq: 7,
                eventCount: 7,
                turnCount: 1,
                isLive: false,
                hasOpenTurn: false,
                workspaceId: "ws-demo",
                workspaceTitle: "Demo Workspace",
                workspacePath: path.join(home, "workspace-demo"),
                aiAt: now,
                aiLastSeq: 7,
                aiUserCount: 1,
              },
            },
          },
        }),
      );
    },
  });
  const state = await scanBoard(service);
  const task = autoTask(state);
  assert.ok(task);
  assert.equal(task.title, REAL_TITLE);
  assert.equal(task.sessions[0].title, REAL_TITLE);
  const again = await scanBoard(service);
  assert.equal(autoTask(again).title, REAL_TITLE);
});

test("a rules-only follow-up after an LLM verdict still refreshes a tracked placeholder title", async (t) => {
  let llmCalls = 0;
  const llm = {
    listProviders: () => [{ id: "fake" }],
    async *stream() {
      llmCalls += 1;
      yield { type: "text-delta", text: JSON.stringify({ tasks: [{ title: PLACEHOLDER, status: "in_progress", goal: "把登录修好" }] }) };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const extraUser = event("user/message", 8, T0 + 5500, { content: [{ type: "text", text: "再检查一遍边界情况" }] });
  const { home, service } = await setup(t, {
    prepare: (home) => seedTitleHome(home, {
      titleEvent: null,
      // A second user message takes the session out of the low-value AI skip.
      extraEvents: [extraUser],
    }),
    ctx: {
      get(name) {
        return {
          llm,
          agentDefaultModel: { currentSelection: () => ({ provider: "fake", model: "fake" }) },
        }[name];
      },
    },
  });
  await command(service, "settings.update", { patch: { aiEnabled: true } });
  const first = await scanBoard(service);
  const task = autoTask(first);
  assert.ok(task);
  assert.equal(task.ai?.engine, "llm", JSON.stringify(task.ai));
  assert.equal(task.title, PLACEHOLDER);
  assert.equal(llmCalls, 1);
  appendEvents(home, SESSION_ID, [
    event("session/title", 20, T0 + 20_000, { title: REAL_TITLE, source: { kind: "provider" } }),
  ]);
  const second = await scanBoard(service);
  assert.equal(autoTask(second).title, REAL_TITLE);
  assert.equal(llmCalls, 1, "a title-only change must not spend another LLM call");
  assert.equal(autoTask(second).ai?.engine, "llm");
});

test("a long session title on the card follows readableTitle clipping", async (t) => {
  const longTitle = `重构${"登录流程并补齐全部边界测试和文档说明".repeat(3)}`;
  const { service } = await setup(t, {
    prepare: (home) => seedTitleHome(home, {
      titleEvent: event("session/title", 7, T0 + 7000, { title: longTitle, source: { kind: "provider" } }),
    }),
  });
  const state = await scanBoard(service);
  const task = autoTask(state);
  assert.ok(task);
  assert.equal(task.title.endsWith("…"), true);
  assert.ok(task.title.length <= 80);
  assert.equal(task.title.startsWith("重构"), true);
  assert.notEqual(task.title, PLACEHOLDER);
});
