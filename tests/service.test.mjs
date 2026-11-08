/**
 * Hermetic tests for the host service (server/service.mjs) and the HTTP surface.
 *
 * Each test runs against a throwaway $DSH_HOME under os.tmpdir(), drives the
 * real `handle(req, res, ...)` entry point with mock streams and inspects the
 * on-disk store. AI is never enabled with a credential, so no network calls can
 * happen (the analyzer degrades to the rules engine).
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
import { TEXT_LIMITS } from "../server/store.mjs";

// Recent enough for the default initialDays=30 eligibility window, old enough
// that the session is not treated as live.
const T0 = Date.now() - 3_600_000;

/* ------------------------------------------------------------------ */
/* Fixtures and harness                                                */
/* ------------------------------------------------------------------ */

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

/**
 * Synthetic $DSH_HOME with one registered workspace and one main session.
 * `todo` picks the rules-engine verdict this session produces:
 *   - "freshPending": latest todo is fresh and unfinished → in_progress
 *   - "freshDone": latest todo is fresh and all completed → done
 *   - "stalePending": todo snapshot predates the last turn and is unfinished;
 *     with a deliverable that still means done, while extractSubtasks() skips it.
 */
function seedSessionHome(
  home,
  { sessionId = "sess-alpha", workspaceId = "ws-demo", title = "Fix login flow", todo = "freshPending" } = {},
) {
  const workspaceDir = path.join(home, "workspace-demo");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# demo\n");

  const todos =
    todo === "freshDone"
      ? [
          { content: "定位问题", status: "completed" },
          { content: "补充测试", status: "completed" },
        ]
      : [
          { content: "定位问题", status: "completed" },
          { content: "补充测试", status: "pending" },
        ];
  const todoSeq = todo === "stalePending" ? 2 : 6;
  const todoTime = todo === "stalePending" ? T0 + 1500 : T0 + 5000;

  const events = [
    event("session", 1, T0, { id: sessionId, createdAt: T0, cwd: workspaceDir }),
    event("session/title", 3, T0 + 1000, { title, source: { kind: "provider" } }),
    event("user/message", 3, T0 + 2000, { content: [{ type: "text", text: "修复登录流程并补测试" }] }),
    event("turn/start", 4, T0 + 3000, { turn: 1 }),
    event("assistant/message", 5, T0 + 4000, { message: { content: [{ type: "text", text: "已修复登录流程" }] } }),
    event("todo/write", todoSeq, todoTime, { todos }),
    event("tool/call", 7, T0 + 6000, { name: "write", callId: "call-1", arguments: JSON.stringify({ path: "README.md" }) }),
    event("tool/result", 8, T0 + 7000, { toolCallId: "call-1", message: { content: [{ type: "text", text: "written" }] } }),
    event("deliverables/presented", 9, T0 + 8000, { files: [{ path: "README.md", description: "说明" }] }),
    event("turn/end", 10, T0 + 9000, { turn: 1, reason: { kind: "completed" } }),
  ];
  const sessionDir = path.join(home, "sessions", "escaped-demo", sessionId);
  writeFileDeep(path.join(sessionDir, SESSION_FILE_NAME), framesOf(events));
  writeFileDeep(
    path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`),
    JSON.stringify({
      record: {
        identity: { createdAt: T0, cwd: workspaceDir },
        rows: {
          title: { val: title },
          sessionStats: { val: { turns: 1 } },
          timeContext: { val: { lastMessageTime: T0 + 9000 } },
        },
      },
    }),
  );
  writeFileDeep(
    path.join(home, "storages", "workspace.json"),
    JSON.stringify({
      global: { workspaceIds: [workspaceId] },
      tables: {
        workspaces: {
          [workspaceId]: {
            path: workspaceDir,
            title: "Demo Workspace",
            sessionIds: [sessionId],
            createdAt: new Date(T0).toISOString(),
            updatedAt: new Date(T0 + 9000).toISOString(),
          },
        },
      },
    }),
  );
  return { workspaceDir, sessionDir };
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

function mockRes() {
  return new MockResponse();
}

function beginRequest(service, { method = "GET", route = "/state", body, search = "" }) {
  const req = mockReq();
  const res = mockRes();
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
    /* non-JSON body (export download) */
  }
  return { status: res.status, headers: res.headers, body: res.body, json, res };
}

function command(service, op, payload = {}) {
  return request(service, { method: "POST", route: "/command", body: { op, payload } });
}

async function rawCommand(service, rawBody) {
  return request(service, { method: "POST", route: "/command", body: rawBody });
}

function beginCommand(service, op, payload = {}) {
  return beginRequest(service, { method: "POST", route: "/command", body: { op, payload } });
}

async function setup(t, { withSessions = false, logger = null, prepare = null, sessionOptions = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-service-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let fixture = null;
  if (withSessions) fixture = seedSessionHome(home, sessionOptions || {});
  if (prepare) prepare(home);
  const messages = { infos: [], warns: [] };
  const usedLogger =
    logger ||
    {
      info(message) {
        messages.infos.push(String(message));
      },
      warn(message) {
        messages.warns.push(String(message));
      },
    };
  const service = createKanbanService({ ctx: { logger: usedLogger } });
  // Background auto-scans would make the assertions time-dependent; each test
  // triggers the scans it wants explicitly.
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
  return { home, service, logger: usedLogger, messages, fixture };
}

function readStateFile(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "storages", "super-kanban", "state.json"), "utf8"));
}

function readCacheFile(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "storages", "super-kanban", "sessions-cache.json"), "utf8"));
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

/* ------------------------------------------------------------------ */
/* Basic routes                                                        */
/* ------------------------------------------------------------------ */

test("GET /ping exposes plugin identity and the DSH home", async (t) => {
  const { home, service } = await setup(t);
  const { status, json } = await request(service, { route: "/ping" });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.plugin, "dsh-super-kanban");
  assert.equal(json.dshHome, home);
  assert.equal(json.version, 2);
  assert.ok(Number.isNaN(Date.parse(json.time)) === false);
});

test("GET /state returns the documented board payload", async (t) => {
  const { service } = await setup(t);
  const { status, json } = await request(service, { route: "/state" });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.tasks));
  assert.deepEqual(json.stats.byStatus, { backlog: 0, in_progress: 0, blocked: 0, done: 0 });
  assert.equal(json.stats.total, 0);
  assert.ok(Array.isArray(json.activity));
  assert.ok(Array.isArray(json.workspaces));
  assert.equal(json.scan.state, "idle");
  assert.equal(typeof json.settings.autoScan, "boolean");
  assert.equal(typeof json.usage.date, "string");
  assert.ok(Number.isNaN(Date.parse(json.generatedAt)) === false);
});

test("unknown routes and wrong methods return 404", async (t) => {
  const { service } = await setup(t);
  assert.equal((await request(service, { route: "/nope" })).status, 404);
  assert.equal((await request(service, { route: "/command" })).status, 404);
  assert.equal((await request(service, { method: "POST", route: "/state" })).status, 404);
  assert.equal((await request(service, { method: "DELETE", route: "/session/sess-alpha" })).status, 404);
});

/* ------------------------------------------------------------------ */
/* Command envelope + payload validation                               */
/* ------------------------------------------------------------------ */

test("POST /command: unknown and prototype-inherited ops are rejected", async (t) => {
  const { service } = await setup(t);
  for (const op of ["nope", "constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const { status, json } = await command(service, op);
    assert.equal(status, 400, `op ${op}`);
    assert.equal(json.error, "unknown-op");
  }
});

test("POST /command: malformed JSON body returns 400, not 500", async (t) => {
  const { service } = await setup(t);
  const { status, json } = await rawCommand(service, "{broken");
  assert.equal(status, 400);
  assert.equal(json.error, "invalid-input");
});

test("POST /command: non-object JSON bodies are rejected", async (t) => {
  const { service } = await setup(t);
  for (const raw of ["null", "42", '"text"', "[1,2]"]) {
    const { status } = await rawCommand(service, raw);
    assert.equal(status, 400, `body ${raw}`);
  }
});

test("POST /command: oversized bodies are rejected without parsing", async (t) => {
  const { service } = await setup(t);
  const big = JSON.stringify({ op: "task.create", payload: { title: "x".repeat(1024 * 1024 + 1024) } });
  const { status, json } = await rawCommand(service, big);
  assert.equal(status, 400);
  assert.equal(json.error, "invalid-input");
});

test("POST /command: missing ops are 400 and missing tasks are 404", async (t) => {
  const { service } = await setup(t);
  assert.equal((await command(service, "task.create", {})).status, 400);
  const missing = await command(service, "task.update", { id: "t_missing", patch: { title: "x" } });
  assert.equal(missing.status, 404);
  assert.equal((await command(service, "task.delete", { id: "t_missing" })).status, 404);
  assert.equal((await command(service, "task.toggleSubtask", { id: "t_missing" })).status, 404);
});

/* ------------------------------------------------------------------ */
/* Task ops                                                            */
/* ------------------------------------------------------------------ */

test("task.create normalizes payloads and persists the card", async (t) => {
  const { home, service } = await setup(t);
  const created = await command(service, "task.create", {
    title: "  Ship the release  ",
    goal: "  ship it ",
    status: "done",
    priority: "P1",
    progress: 150,
    tags: ["dev", "dev", "ui"],
  });
  assert.equal(created.status, 200);
  const task = created.json.data;
  assert.match(task.id, /^t_[0-9a-f]{8}$/);
  assert.equal(task.title, "Ship the release");
  assert.equal(task.origin, "manual");
  assert.equal(task.status, "done");
  assert.equal(task.priority, "P1");
  assert.equal(task.progress, 100);
  assert.deepEqual(task.tags, ["dev", "dev", "ui"]);
  assert.deepEqual(task.lockedFields, []);
  assert.equal(task.goal.text, "ship it");
  assert.equal(task.goal.status, "done");
  assert.equal(task.sessions.length, 0);
  assert.ok(task.history.some((entry) => entry.kind === "create"));

  const state = readStateFile(home);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, task.id);

  const mixed = (await command(service, "task.create", { title: "Mixed tags", tags: ["dev", 42] })).json.data;
  assert.deepEqual(mixed.tags, [], "non-string array values are rejected wholesale");

  const listed = await request(service, { route: "/state" });
  assert.equal(listed.json.tasks.length, 2);
  assert.equal(listed.json.stats.total, 2);
});

test("task.create keeps an explicit null progress as null", async (t) => {
  const { service } = await setup(t);
  const created = await command(service, "task.create", { title: "No progress", progress: null });
  assert.equal(created.status, 200);
  assert.equal(created.json.data.progress, null);
});

test("task.update edits + locks fields and rejects invalid ids", async (t) => {
  const { service } = await setup(t);
  const task = (await command(service, "task.create", { title: "Edit me" })).json.data;
  const updated = await command(service, "task.update", {
    id: task.id,
    patch: { title: "  Edited  ", status: "in_progress", priority: "P0", progress: 40, tags: ["ui"], issues: [] },
    lockFields: ["status", "not-a-field"],
  });
  assert.equal(updated.status, 200);
  const next = updated.json.data;
  assert.equal(next.title, "Edited");
  assert.equal(next.status, "in_progress");
  assert.equal(next.priority, "P0");
  assert.equal(next.progress, 40);
  assert.deepEqual(next.tags, ["ui"]);
  assert.deepEqual(next.lockedFields, ["status"]);
  assert.ok(next.history.some((entry) => entry.kind === "status"));
  assert.ok(next.history.some((entry) => entry.kind === "edit"));

  // Invalid status/priority values keep the current ones.
  const kept = await command(service, "task.update", {
    id: task.id,
    patch: { status: "weird", priority: "P9", progress: "abc" },
  });
  assert.equal(kept.json.data.status, "in_progress");
  assert.equal(kept.json.data.priority, "P0");
  assert.equal(kept.json.data.progress, 40);
});

test("task.update cannot pollute Object.prototype through the patch", async (t) => {
  const { home, service } = await setup(t);
  const task = (await command(service, "task.create", { title: "Safe title" })).json.data;
  const raw = JSON.stringify({
    op: "task.update",
    payload: {
      id: task.id,
      patch: JSON.parse('{"__proto__":{"polluted":"yes"},"title":"Patched"}'),
    },
  });
  const { status, json } = await rawCommand(service, raw);
  assert.equal(status, 200);
  assert.equal(json.data.title, "Patched");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const state = readStateFile(home);
  assert.equal(state.tasks[0].title, "Patched");
  assert.equal(state.tasks[0].polluted, undefined);
});

test("task.update only detaches auto cards when a field really changes", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const state = (await request(service, { route: "/state" })).json;
  const auto = state.tasks.find((task) => task.origin === "auto");
  assert.ok(auto, "the scan must produce at least one auto card");

  // No-op / invalid patches must not wash away the automatic-card identity.
  const empty = await command(service, "task.update", { id: auto.id, patch: {} });
  assert.equal(empty.json.data.origin, "auto");
  const sameStatus = await command(service, "task.update", { id: auto.id, patch: { status: auto.status } });
  assert.equal(sameStatus.json.data.origin, "auto");
  const invalid = await command(service, "task.update", {
    id: auto.id,
    patch: { status: "weird", priority: "P9", progress: "abc" },
  });
  assert.equal(invalid.json.data.origin, "auto");

  // A real edit detaches the card (so duplicate merging no longer rewrites it).
  const edited = await command(service, "task.update", { id: auto.id, patch: { title: "用户改过的标题" } });
  assert.equal(edited.json.data.origin, "auto+edited");
  assert.equal(edited.json.data.title, "用户改过的标题");

  // Manual cards keep their origin through edits.
  const manual = (await command(service, "task.create", { title: "Manual card" })).json.data;
  const manualEdit = await command(service, "task.update", { id: manual.id, patch: { title: "Manual edited" } });
  assert.equal(manualEdit.json.data.origin, "manual");
});

test("task.move only detaches auto cards on a real column change", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const state = (await request(service, { route: "/state" })).json;
  const auto = state.tasks.find((task) => task.origin === "auto");
  assert.ok(auto, "the scan must produce at least one auto card");

  // Reordering inside the same column is not a status change.
  const sameColumn = await command(service, "task.move", { id: auto.id, status: auto.status, index: 0 });
  assert.equal(sameColumn.json.data.status, auto.status);
  assert.equal(sameColumn.json.data.origin, "auto");

  // An actual column change marks the card as user-edited.
  const target = auto.status === "done" ? "backlog" : "done";
  const moved = await command(service, "task.move", { id: auto.id, status: target, index: 0 });
  assert.equal(moved.json.data.status, target);
  assert.equal(moved.json.data.origin, "auto+edited");
});

test("task.move / archive / delete keep the board consistent", async (t) => {
  const { service } = await setup(t);
  const first = (await command(service, "task.create", { title: "First" })).json.data;
  const second = (await command(service, "task.create", { title: "Second" })).json.data;

  const moved = await command(service, "task.move", { id: second.id, status: "done", index: 0 });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.data.status, "done");
  assert.ok(moved.json.data.history.some((entry) => entry.note === "拖拽换列"));

  const archived = await command(service, "task.archive", { id: first.id, archived: true });
  assert.equal(archived.json.data.archived, true);
  const restored = await command(service, "task.archive", { id: first.id, archived: false });
  assert.equal(restored.json.data.archived, false);

  const deleted = await command(service, "task.delete", { id: first.id });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id: first.id, deleted: true });
  const state = (await request(service, { route: "/state" })).json;
  assert.deepEqual(
    state.tasks.map((task) => task.id),
    [second.id],
  );
});

test("task.relink validates and bounds session ids", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const task = (await command(service, "task.create", { title: "Ref" })).json.data;
  const invalid = await command(service, "task.relink", { id: task.id, sessionIds: ["../etc/passwd"] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "invalid-input");
  const missingShape = await command(service, "task.relink", { id: task.id, sessionIds: "sess-alpha" });
  assert.equal(missingShape.status, 400);
  const linked = await command(service, "task.relink", { id: task.id, sessionIds: ["sess-alpha"] });
  assert.equal(linked.status, 200);
  assert.deepEqual(
    linked.json.data.sessions.map((session) => session.id),
    ["sess-alpha"],
  );
  assert.equal(linked.json.data.primarySessionId, "sess-alpha");
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

test("settings.update clamps values, ignores unknown keys and stays pollution-safe", async (t) => {
  const { home, service } = await setup(t);
  const raw = JSON.stringify({
    op: "settings.update",
    payload: {
      patch: JSON.parse(
        '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"unknown":"x","scanIntervalSeconds":5,"maxAiCallsPerScan":1,"model":"bad model name"}',
      ),
    },
  });
  const { status, json } = await rawCommand(service, raw);
  assert.equal(status, 200);
  assert.equal(json.data.scanIntervalSeconds, 30);
  assert.equal(json.data.maxAiCallsPerScan, 5);
  assert.equal(json.data.model, "deepseek-flash");
  assert.equal(json.data.unknown, undefined);
  assert.equal(json.data.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(readStateFile(home).settings.scanIntervalSeconds, 30);

  const disabled = await command(service, "settings.update", { patch: { aiEnabled: false, autoScan: false } });
  assert.equal(disabled.json.data.aiEnabled, false);
  assert.equal(disabled.json.data.autoScan, false);
});

/* ------------------------------------------------------------------ */
/* Scan orchestration                                                  */
/* ------------------------------------------------------------------ */

test("scan.start runs a scan, rejects a concurrent one and reports state", async (t) => {
  const { service } = await setup(t);
  // Two commands issued in the same tick: the second must observe the scan mutex.
  const first = beginCommand(service, "scan.start", { mode: "incremental" });
  const second = beginCommand(service, "scan.start", { mode: "full" });
  await Promise.all([first.pending, second.pending]);
  const statuses = [first.res.status, second.res.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], `unexpected statuses: ${statuses}`);

  const scan = await waitForScan(service);
  assert.equal(scan.state, "done");
  assert.equal(scan.processed, 0);
  assert.equal(scan.total, 0);
  assert.ok(Number.isNaN(Date.parse(scan.finishedAt)) === false);
  assert.ok(Number.isNaN(Date.parse(scan.startedAt)) === false);

  const state = (await request(service, { route: "/state" })).json;
  assert.ok(Number.isNaN(Date.parse(state.settings.lastScanAt)) === false);
  assert.equal(state.usage.lastScan.durationMs >= 0, true);

  // Busy rejection is a 409 with the documented error code.
  const busy = await command(service, "scan.cancel");
  assert.equal(busy.status, 200);
  assert.deepEqual(busy.json.data, { cancelling: false });
});

test("scan.start accepts mode=full and reports the mode", async (t) => {
  const { service } = await setup(t);
  const started = await command(service, "scan.start", { mode: "full" });
  assert.equal(started.status, 200);
  assert.equal(started.json.data.mode, "full");
  await waitForScan(service);
});

test("a scan survives corrupt sessions and still cards the healthy ones", async (t) => {
  const { home, service } = await setup(t, { withSessions: true });
  // Corrupt log + a log with malformed JSONL lines next to the healthy session.
  writeFileDeep(path.join(home, "sessions", "escaped-demo", "sess-corrupt", SESSION_FILE_NAME), Buffer.from("not zstd at all"));
  writeFileDeep(
    path.join(home, "sessions", "escaped-demo", "sess-badlines", SESSION_FILE_NAME),
    Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event("session", 1, T0, { id: "sess-badlines", cwd: "/tmp/demo" }))}\n`)),
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event("user/message", 2, T0 + 1, { content: [{ type: "text", text: "hello" }] }))}\n`)),
      zlib.zstdCompressSync(Buffer.from("{broken line\n")),
    ]),
  );

  const started = await command(service, "scan.start", { mode: "incremental" });
  assert.equal(started.status, 200);
  const scan = await waitForScan(service);
  assert.equal(scan.state, "done");
  assert.equal(scan.total, 3);
  assert.equal(scan.processed, 3);
  assert.equal(scan.error, null);

  const state = (await request(service, { route: "/state" })).json;
  assert.ok(state.tasks.length >= 1);
  assert.ok(state.tasks.some((task) => task.primarySessionId === "sess-alpha"));
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.workspaces[0].id, "ws-demo");

  // The corrupt session is recorded in the cache (diagnosable) instead of
  // crashing the scan or being retried from a stale signature.
  const cache = readCacheFile(home);
  assert.ok(cache.sessions["sess-alpha"]);
  assert.match(cache.sessions["sess-corrupt"].meta.parseError, /decompress-failed/);
});

test("unchanged sessions are not re-parsed on every scan (no credential case)", async (t) => {
  const { home, service } = await setup(t, { withSessions: true });
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const first = readCacheFile(home).sessions["sess-alpha"].meta;
  assert.ok(first.parsedAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const second = readCacheFile(home).sessions["sess-alpha"].meta;
  assert.equal(second.parsedAt, first.parsedAt, "an unchanged session must not be re-parsed");
  assert.equal(second.sigKey, first.sigKey);
});

test("a corrupt log that replaces a healthy one updates its cache signature", async (t) => {
  const { home, service } = await setup(t, { withSessions: true });
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const before = readCacheFile(home).sessions["sess-alpha"];
  assert.ok(before.meta.title);

  const file = path.join(home, "sessions", "escaped-demo", "sess-alpha", SESSION_FILE_NAME);
  fs.writeFileSync(file, Buffer.from("corrupted after parse"));
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);

  const after = readCacheFile(home).sessions["sess-alpha"];
  const stat = fs.statSync(file);
  assert.equal(after.sigKey, `${stat.size}:${stat.mtimeMs}`, "cache must track the current signature");
  assert.match(after.meta.parseError, /decompress-failed/);
  assert.equal(after.meta.title, before.meta.title, "the last good metadata is preserved");
});

test("scan finalization failures cannot leave the scan mutex locked", async (t) => {
  // A logger whose info() throws used to be able to reject the scan promise.
  const logger = {
    info(message) {
      if (String(message).includes("scan ")) throw new Error("logger exploded");
    },
    warn() {},
  };
  const { service } = await setup(t, { logger });
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const started = await command(service, "scan.start", { mode: "incremental" });
  assert.equal(started.status, 200);
  await waitForScan(service);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const again = await command(service, "scan.start", { mode: "incremental" });
  assert.equal(again.status, 200, "the scan mutex must be released even if logging throws");
  await waitForScan(service);
  assert.equal(unhandled, 0);
});

test("task.analyze and task.polishPrompt reject while a scan owns the mutex", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const task = (await command(service, "task.create", { title: "Analyze me", sessionId: "sess-alpha" })).json.data;
  // Queue the scan first so its (synchronous) body starts in the next microtask;
  // the analyze command then observes the held scan mutex.
  const scan = beginCommand(service, "scan.start", { mode: "incremental" });
  const analyze = beginCommand(service, "task.analyze", { id: task.id });
  const polish = beginCommand(service, "task.polishPrompt", { prompt: "继续这个任务" });
  await Promise.all([scan.pending, analyze.pending, polish.pending]);
  assert.equal(scan.res.status, 200);
  assert.equal(analyze.res.status, 409);
  assert.equal(JSON.parse(analyze.res.body).error, "busy");
  assert.equal(polish.res.status, 409);
  await waitForScan(service);
});

/* ------------------------------------------------------------------ */
/* v2 linkage / subtask ops                                            */
/* ------------------------------------------------------------------ */

test("task subtasks: import from session, toggle, add and remove", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const task = (await command(service, "task.create", { title: "Todo task", sessionId: "sess-alpha" })).json.data;
  assert.deepEqual(task.sessions.map((session) => session.id), ["sess-alpha"]);

  const imported = await command(service, "task.importTodos", { id: task.id });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.data.subtasks.length, 2);
  assert.equal(imported.json.data.subtasks[0].text, "定位问题");
  assert.equal(imported.json.data.progress, 50);
  assert.ok(imported.json.data.history.some((entry) => /导入待办/.test(entry.note)));

  const pending = imported.json.data.subtasks.find((subtask) => subtask.done === false);
  const toggled = await command(service, "task.toggleSubtask", { id: task.id, subtaskId: pending.id, done: true });
  assert.equal(toggled.json.data.subtasks.find((subtask) => subtask.id === pending.id).done, true);
  assert.equal(toggled.json.data.progress, 100);

  const added = await command(service, "task.addSubtask", { id: task.id, text: "回归验证" });
  assert.equal(added.json.data.subtasks.some((subtask) => subtask.text === "回归验证" && subtask.source === "manual"), true);
  assert.equal(added.json.data.progress, 67);

  const manual = added.json.data.subtasks.find((subtask) => subtask.source === "manual");
  const removed = await command(service, "task.removeSubtask", { id: task.id, subtaskId: manual.id });
  assert.equal(removed.json.data.subtasks.some((subtask) => subtask.id === manual.id), false);
  assert.equal((await command(service, "task.removeSubtask", { id: task.id, subtaskId: "missing" })).status, 404);
  assert.equal((await command(service, "task.addSubtask", { id: task.id, text: "   " })).status, 400);
});

test("task.analyze falls back to the rules engine without an AI credential", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const task = (await command(service, "task.create", { title: "Analyze rules", sessionId: "sess-alpha" })).json.data;
  const analyzed = await command(service, "task.analyze", { id: task.id });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.json.data.engine, "rules");
  assert.equal(analyzed.json.data.aiCalls, 0);
  assert.equal(analyzed.json.data.sessions, 1);
  assert.match(analyzed.json.data.message, /规则引擎/);
  assert.ok(analyzed.json.data.task.ai);
  assert.equal(analyzed.json.data.task.ai.engine, "rules");
});

test("task.analyze on a task without a session is a 400", async (t) => {
  const { service } = await setup(t);
  const task = (await command(service, "task.create", { title: "No source" })).json.data;
  const analyzed = await command(service, "task.analyze", { id: task.id });
  assert.equal(analyzed.status, 400);
  assert.equal(analyzed.json.error, "invalid-input");
});

test("an AI/rule done verdict keeps the card in_progress while manual subtasks are unfinished", async (t) => {
  // freshDone makes the rules engine verdict "done" (last turn ok, todos complete).
  const { service } = await setup(t, { withSessions: true, sessionOptions: { todo: "freshDone" } });
  const task = (await command(service, "task.create", { title: "Trusted work", sessionId: "sess-alpha" })).json.data;
  await command(service, "task.addSubtask", { id: task.id, text: "用户手动确认项" });

  const analyzed = await command(service, "task.analyze", { id: task.id });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.json.data.engine, "rules");
  const next = analyzed.json.data.task;

  // The AI/rule verdict said done, but the user's own checklist is unfinished.
  assert.equal(next.status, "in_progress", "done verdict must not override unfinished manual work");
  assert.notEqual(next.progress, 100);
  const manual = next.subtasks.find((subtask) => subtask.text === "用户手动确认项");
  assert.ok(manual, "manual subtask must survive re-analysis");
  assert.equal(manual.done, false, "manual subtasks are never auto-closed");
  assert.ok(
    next.history.some((entry) => entry.kind === "status" && /建议完成/.test(entry.note) && /手动子任务/.test(entry.note)),
    "the AI done proposal must stay visible in history",
  );

  // Persisted state agrees with the response (round-trip).
  const state = (await request(service, { route: "/state" })).json;
  const persisted = state.tasks.find((candidate) => candidate.id === task.id);
  assert.equal(persisted.status, "in_progress");
  assert.equal(persisted.subtasks.find((subtask) => subtask.text === "用户手动确认项").done, false);
});

test("a locked subtask list is never auto-closed by a done verdict", async (t) => {
  const { service } = await setup(t, { withSessions: true, sessionOptions: { todo: "freshDone" } });
  const task = (await command(service, "task.create", { title: "Locked work", sessionId: "sess-alpha" })).json.data;
  await command(service, "task.addSubtask", { id: task.id, text: "锁定检查项" });
  await command(service, "task.update", { id: task.id, patch: { title: "Locked work" }, lockFields: ["subtasks"] });
  const before = (await request(service, { route: "/state" })).json.tasks.find((candidate) => candidate.id === task.id);

  const analyzed = await command(service, "task.analyze", { id: task.id });
  const next = analyzed.json.data.task;
  assert.equal(next.status, "in_progress");
  assert.deepEqual(next.subtasks, before.subtasks, "locked subtasks must not be rewritten or closed");
  assert.equal(next.subtasks.find((subtask) => subtask.text === "锁定检查项").done, false);
  assert.ok(next.history.some((entry) => entry.kind === "status" && /建议完成/.test(entry.note)));
});

test("a user-locked status is never overridden by the trust rule", async (t) => {
  const { service } = await setup(t, { withSessions: true, sessionOptions: { todo: "freshDone" } });
  const task = (await command(service, "task.create", { title: "User decided", sessionId: "sess-alpha" })).json.data;
  await command(service, "task.addSubtask", { id: task.id, text: "用户手动确认项" });
  // The user explicitly marks done and locks the status — their choice wins.
  await command(service, "task.update", { id: task.id, patch: { status: "done" }, lockFields: ["status"] });

  const analyzed = await command(service, "task.analyze", { id: task.id });
  const next = analyzed.json.data.task;
  assert.equal(next.status, "done");
  assert.equal(next.lockedFields.includes("status"), true);
  assert.equal(next.subtasks.find((subtask) => subtask.text === "用户手动确认项").done, false);
  assert.equal(next.history.some((entry) => /建议完成/.test(entry.note)), false, "no downgrade note when the user locked status");
});

test("generated todo subtasks still auto-close when the verdict is done", async (t) => {
  // stalePending: todo predates the final turn but a deliverable exists → rules
  // verdict "done" while the todo snapshot still contains unfinished items.
  const { service } = await setup(t, { withSessions: true, sessionOptions: { todo: "stalePending" } });
  const task = (await command(service, "task.create", { title: "Auto close", sessionId: "sess-alpha" })).json.data;
  const imported = await command(service, "task.importTodos", { id: task.id });
  assert.equal(imported.json.data.subtasks.length, 2);
  assert.ok(imported.json.data.subtasks.some((subtask) => subtask.done === false));
  assert.equal(imported.json.data.progress, 50);

  const analyzed = await command(service, "task.analyze", { id: task.id });
  const next = analyzed.json.data.task;
  assert.equal(next.status, "done");
  assert.ok(next.subtasks.length >= 2, "imported todo subtasks must not be dropped by analysis");
  assert.ok(next.subtasks.every((subtask) => subtask.done), "generated subtasks are closed with the task");
  assert.equal(next.progress, 100);
  assert.equal(next.goal.status, "done");
});

test("create/update/store share one set of text limits", async (t) => {
  const { home, service } = await setup(t);
  const longTitle = "标".repeat(TEXT_LIMITS.title + 20);
  const longGoal = "目".repeat(TEXT_LIMITS.goal + 40);
  const created = await command(service, "task.create", { title: longTitle, goal: longGoal });
  assert.equal(created.status, 200);
  const task = created.json.data;
  assert.equal(task.title.length, TEXT_LIMITS.title);
  assert.equal(task.goal.text.length, TEXT_LIMITS.goal);

  const updated = await command(service, "task.update", {
    id: task.id,
    patch: { title: `${longTitle}尾`, goal: { text: longGoal }, tags: ["a".repeat(40), "ok"] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.title.length, TEXT_LIMITS.title);
  assert.equal(updated.json.data.goal.text.length, TEXT_LIMITS.goal);
  assert.deepEqual(updated.json.data.tags, [`${"a".repeat(TEXT_LIMITS.tagText - 1)}…`, "ok"]);

  const added = await command(service, "task.addSubtask", { id: task.id, text: "子".repeat(TEXT_LIMITS.subtaskText + 10) });
  const longSubtask = added.json.data.subtasks.find((subtask) => subtask.source === "manual");
  assert.equal(longSubtask.text.length, TEXT_LIMITS.subtaskText);

  // Issue/milestone/next-step items are clipped too and non-string junk is dropped.
  const sanitized = await command(service, "task.update", {
    id: task.id,
    patch: {
      issues: [{ text: "问".repeat(TEXT_LIMITS.issueText + 30), severity: "weird" }, "字符串问题", 42, null],
      milestones: [{ text: "里".repeat(TEXT_LIMITS.milestoneText + 30), done: false }, "里程碑", {}],
      nextSteps: ["步".repeat(TEXT_LIMITS.nextStepText + 30), { text: "对象步骤" }, 7],
    },
  });
  const data = sanitized.json.data;
  assert.equal(data.issues.length, 2);
  assert.equal(data.issues[0].text.length, TEXT_LIMITS.issueText);
  assert.equal(data.issues[0].severity, "medium");
  assert.equal(data.issues[1].text, "字符串问题");
  assert.equal(data.milestones.length, 2);
  assert.equal(data.milestones[0].text.length, TEXT_LIMITS.milestoneText);
  assert.equal(data.milestones[1].text, "里程碑");
  assert.deepEqual(data.nextSteps, [`${"步".repeat(TEXT_LIMITS.nextStepText - 1)}…`, "对象步骤"]);

  // The persisted store must agree with the command response (no double clip).
  const persisted = readStateFile(home).tasks.find((candidate) => candidate.id === task.id);
  assert.equal(persisted.title.length, TEXT_LIMITS.title);
  assert.equal(persisted.goal.text.length, TEXT_LIMITS.goal);
  assert.equal(persisted.issues[0].text.length, TEXT_LIMITS.issueText);
  assert.deepEqual(persisted.nextSteps, data.nextSteps);
});
test("task.continuePrompt builds a local hand-off prompt", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const task = (await command(service, "task.create", { title: "Hand off", goal: "finish the fix", sessionId: "sess-alpha" })).json.data;
  await command(service, "task.addSubtask", { id: task.id, text: "补测试" });
  const result = await command(service, "task.continuePrompt", { id: task.id, target: "newSession" });
  assert.equal(result.status, 200);
  assert.equal(result.json.data.target, "newSession");
  assert.equal(result.json.data.sessionId, "sess-alpha");
  assert.equal(result.json.data.workspaceId, "ws-demo");
  assert.match(result.json.data.prompt, /Hand off/);
  assert.match(result.json.data.prompt, /finish the fix/);
  assert.match(result.json.data.prompt, /补测试/);
  assert.match(result.json.data.prompt, /要求/);
});

test("task.polishPrompt degrades to the original text without AI", async (t) => {
  const { service } = await setup(t);
  const polished = await command(service, "task.polishPrompt", { id: "any", prompt: "继续这个任务" });
  assert.equal(polished.status, 200);
  assert.deepEqual(polished.json.data, { prompt: "继续这个任务", polished: false });
  assert.equal((await command(service, "task.polishPrompt", { id: "any", prompt: "  " })).status, 400);
});

test("task.unlock releases locked fields", async (t) => {
  const { service } = await setup(t);
  const task = (await command(service, "task.create", { title: "Locked" })).json.data;
  await command(service, "task.update", { id: task.id, patch: { title: "Locked v2" }, lockFields: ["title", "status"] });
  const one = await command(service, "task.unlock", { id: task.id, fields: ["title"] });
  assert.deepEqual(one.json.data.lockedFields, ["status"]);
  assert.ok(one.json.data.history.some((entry) => /解锁字段/.test(entry.note)));
  const all = await command(service, "task.unlock", { id: task.id });
  assert.deepEqual(all.json.data.lockedFields, []);
});

test("session.ignore stops future auto cards for that session", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const ignored = await command(service, "session.ignore", { sessionId: "sess-alpha" });
  assert.equal(ignored.status, 200);
  assert.deepEqual(ignored.json.data, { sessionId: "sess-alpha", ignored: true });
  assert.equal((await command(service, "session.ignore", {})).status, 400);

  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const state = (await request(service, { route: "/state" })).json;
  assert.equal(state.tasks.some((task) => task.primarySessionId === "sess-alpha"), false);

  const unignored = await command(service, "session.unignore", { sessionId: "sess-alpha" });
  assert.deepEqual(unignored.json.data, { sessionId: "sess-alpha", ignored: false });
  await command(service, "scan.start", { mode: "incremental" });
  await waitForScan(service);
  const after = (await request(service, { route: "/state" })).json;
  assert.equal(after.tasks.some((task) => task.primarySessionId === "sess-alpha"), true);
});

test("scan.cancel acknowledges a scan that owns the mutex", async (t) => {
  const { service } = await setup(t);
  const scan = beginCommand(service, "scan.start", { mode: "incremental" });
  const cancel = beginCommand(service, "scan.cancel");
  await Promise.all([scan.pending, cancel.pending]);
  assert.equal(scan.res.status, 200);
  assert.equal(cancel.res.status, 200);
  assert.deepEqual(JSON.parse(cancel.res.body).data, { cancelling: true });
  const state = await waitForScan(service);
  assert.equal(state.state, "done");
  assert.match(state.message, /取消/);
});

/* ------------------------------------------------------------------ */
/* Session endpoint                                                    */
/* ------------------------------------------------------------------ */

test("GET /session/:id returns the parsed session timeline", async (t) => {
  const { fixture, service } = await setup(t, { withSessions: true });
  const { status, json } = await request(service, { route: "/session/sess-alpha" });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.session.id, "sess-alpha");
  assert.equal(json.session.title, "Fix login flow");
  assert.equal(json.session.workspaceId, "ws-demo");
  assert.equal(json.session.status, "completed");
  assert.equal(json.session.path, path.join(fixture.sessionDir, SESSION_FILE_NAME));
  assert.equal(json.session.todoTotal, 2);
  assert.equal(json.session.todoDone, 1);
  assert.ok(json.events.length > 0);
  assert.ok(json.events.some((event) => event.kind === "user"));
  assert.ok(json.events.some((event) => event.kind === "todo"));
});

test("GET /session/:id clamps paging parameters and validates ids", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  const nonNumeric = await request(service, { route: "/session/sess-alpha", search: "?limit=abc" });
  assert.equal(nonNumeric.status, 200);
  assert.ok(nonNumeric.json.events.length <= 200);
  const huge = await request(service, { route: "/session/sess-alpha", search: "?limit=9999" });
  assert.equal(huge.status, 200);
  assert.ok(huge.json.events.length <= 500);
  const after = await request(service, { route: "/session/sess-alpha", search: "?after=8" });
  assert.equal(after.status, 200);
  assert.ok(after.json.events.every((event) => event.seq > 8));

  // Malformed encodings and path separators are bad input, not a lookup miss.
  assert.equal((await request(service, { route: "/session/%E0%A4%A" })).status, 400);
  assert.equal((await request(service, { route: "/session/..%2F..%2Fstate" })).status, 400);
  assert.equal((await request(service, { route: "/session/unknown-session" })).status, 404);
});

test("GET /session/:id treats corrupt cache entries as not-found", async (t) => {
  const { service } = await setup(t, {
    prepare(home) {
      writeFileDeep(
        path.join(home, "storages", "super-kanban", "sessions-cache.json"),
        JSON.stringify({ version: 2, sessions: { "sess-cachemeta": { sigKey: "1:1", meta: { id: "sess-cachemeta" } } } }),
      );
    },
  });
  const { status, json } = await request(service, { route: "/session/sess-cachemeta" });
  assert.equal(status, 404);
  assert.equal(json.error, "session-not-found");
});

/* ------------------------------------------------------------------ */
/* Export + SSE                                                        */
/* ------------------------------------------------------------------ */

test("GET /export downloads board state without leaking credentials", async (t) => {
  const { service } = await setup(t, { withSessions: true });
  await command(service, "task.create", { title: "Export me" });
  const { status, headers, body, json } = await request(service, { route: "/export" });
  assert.equal(status, 200);
  assert.match(headers["Content-Disposition"], /super-kanban-\d{8}\.json/);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.ok(json.state.tasks.length >= 1);
  assert.ok(Array.isArray(json.sessions));
  assert.equal(json.ok, true);
  assert.ok(!body.includes("x-dsh-auth-token"));
  assert.ok(!/token"\s*:/.test(body));
});

test("GET /events streams scan/changed and cleans up on close or error", async (t) => {
  const { service } = await setup(t);
  const openSse = () => {
    const req = mockReq();
    const res = mockRes();
    const pending = service.handle(req, res, { route: "/events", url: new URL("http://plugin.local/events"), method: "GET" });
    return { req, res, pending };
  };

  const a = openSse();
  await a.pending;
  assert.equal(a.res.status, 200);
  assert.match(a.res.headers["Content-Type"], /text\/event-stream/);
  assert.match(a.res.body, /event: scan/);
  assert.match(a.res.body, /event: changed/);

  await command(service, "task.create", { title: "Broadcast" });
  assert.match(a.res.body, /"reason":"task"/);

  // Close cleanup: no further payloads are written to the dead stream.
  a.req.emit("close");
  const frozenLength = a.res.body.length;
  await command(service, "task.create", { title: "After close" });
  assert.equal(a.res.body.length, frozenLength);

  // Socket 'error' must also remove the client (previously unhandled).
  const b = openSse();
  await b.pending;
  b.res.emit("error", new Error("socket reset"));
  const bLength = b.res.body.length;
  await command(service, "task.create", { title: "After error" });
  assert.equal(b.res.body.length, bLength);
});

test("GET /events drops a slow/backed-up client instead of buffering without bound", async (t) => {
  const { service } = await setup(t);
  const openSse = () => {
    const req = mockReq();
    const res = mockRes();
    const pending = service.handle(req, res, { route: "/events", url: new URL("http://plugin.local/events"), method: "GET" });
    return { req, res, pending };
  };

  const slow = openSse();
  await slow.pending;
  const healthy = openSse();
  await healthy.pending;
  const slowLength = slow.res.body.length;

  // Simulate a tab that stopped reading: its unread socket buffer is already over
  // the 1MB cap when the next event is broadcast.
  slow.res.writableLength = 2 * 1024 * 1024;
  await command(service, "task.create", { title: "Broadcast with a slow client" });
  assert.equal(slow.res.writableEnded, true, "the backed-up stream must be disconnected");
  assert.equal(slow.res.body.length, slowLength, "no further payload is queued for it");
  assert.match(healthy.res.body, /"reason":"task"/, "healthy streams keep receiving events");

  // A stream whose write starts reporting back-pressure is dropped as well.
  const backedUp = openSse();
  await backedUp.pending;
  backedUp.res.write = () => false;
  await command(service, "task.create", { title: "Broadcast with back-pressure" });
  assert.equal(backedUp.res.writableEnded, true, "a write returning false must disconnect the stream");

  // A write that throws (socket reset) is dropped too.
  const broken = openSse();
  await broken.pending;
  broken.res.write = () => {
    throw new Error("EPIPE");
  };
  await command(service, "task.create", { title: "Broadcast with a broken write" });
  assert.equal(broken.res.writableEnded, true);

  slow.req.emit("close"); // idempotent: the slow client was already removed
  healthy.req.emit("close");
});

test("GET /events sends heartbeats and stops them after disconnect", async (t) => {
  const { service } = await setup(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const req = mockReq();
  const res = mockRes();
  const pending = service.handle(req, res, { route: "/events", url: new URL("http://plugin.local/events"), method: "GET" });
  await pending;
  const before = res.body.length;
  t.mock.timers.tick(15_000);
  assert.match(res.body.slice(before), /: ping/);
  req.emit("close");
  const afterClose = res.body.length;
  t.mock.timers.tick(15_000);
  assert.equal(res.body.length, afterClose, "heartbeat must be cleared on disconnect");
});

test("GET /events bounds the number of concurrent streams", async (t) => {
  const { service } = await setup(t);
  const clients = [];
  for (let index = 0; index < 32; index += 1) {
    const req = mockReq();
    const res = mockRes();
    const pending = service.handle(req, res, { route: "/events", url: new URL("http://plugin.local/events"), method: "GET" });
    await pending;
    assert.equal(res.status, 200);
    clients.push({ req, res });
  }
  const overflow = mockRes();
  await service.handle(mockReq(), overflow, { route: "/events", url: new URL("http://plugin.local/events"), method: "GET" });
  assert.equal(overflow.status, 429);
  for (const client of clients) client.req.emit("close");
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test("stop is idempotent, rejects further requests and flushes state", async (t) => {
  const { home, service } = await setup(t);
  await command(service, "task.create", { title: "Persisted" });
  service.stop();
  assert.doesNotThrow(() => service.stop());
  const stopped = await request(service, { route: "/state" });
  assert.equal(stopped.status, 503);
  assert.equal(stopped.json.error, "stopped");
  assert.equal((await command(service, "task.create", { title: "Nope" })).status, 503);
  const state = readStateFile(home);
  assert.equal(state.tasks.length, 1);
});
