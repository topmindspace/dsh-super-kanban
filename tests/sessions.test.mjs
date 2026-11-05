/**
 * Hermetic unit tests for server/sessions.mjs.
 *
 * Everything runs against a throwaway $DSH_HOME under os.tmpdir(): synthetic
 * session.v4 JSONL logs are zstd-compressed per event (DSH appends one frame per
 * write), so the segment-walking decompressor is exercised for real. No network,
 * no real DSH home, no LLM calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  SESSION_FILE_NAME,
  buildDigest,
  createSessionSource,
  decompressSessionBuffer,
  extractArtifacts,
  extractSubtasks,
  isoDay,
  latestTodos,
  parseJsonlEvents,
  toolBrief,
} from "../server/sessions.mjs";

const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function tempDir(t, prefix = "sk-sessions-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function evt(type, seq, time, data = {}) {
  return { type, seq, time, data };
}

function lineOf(event) {
  return `${JSON.stringify(event)}\n`;
}

/** One zstd frame per line, like DSH's append-only session log. */
function framesOf(events) {
  return Buffer.concat(events.map((event) => zlib.zstdCompressSync(Buffer.from(lineOf(event)))));
}

function writeSessionAt(home, workspaceDir, sessionId, frames) {
  const dir = path.join(home, "sessions", workspaceDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE_NAME);
  fs.writeFileSync(file, frames);
  return { dir, file };
}

function writeProjcache(home, sessionId, record) {
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(record));
}

function projcacheRecord({ title = "Fix login flow", cwd, createdAt = T0, turns = 2, children = [], blank = false }) {
  return {
    record: {
      identity: { createdAt, cwd },
      rows: {
        title: { val: title },
        sessionStats: { val: { turns } },
        sessionListMetadata: { val: { blank, lastPromptAt: T0 + 5000 } },
        timeContext: { val: { lastMessageTime: T0 + 9000 } },
        ...(children.length
          ? { subagentCatalog: { val: { head: { values: children.map((childId) => ({ childId })) } } } }
          : {}),
      },
    },
  };
}

function writeWorkspaceRegistry(home, { workspaces, order = null }) {
  const dir = path.join(home, "storages");
  fs.mkdirSync(dir, { recursive: true });
  const tables = {};
  for (const workspace of workspaces) tables[workspace.id] = workspace;
  fs.writeFileSync(
    path.join(dir, "workspace.json"),
    JSON.stringify({ global: { workspaceIds: order || workspaces.map((workspace) => workspace.id) }, tables: { workspaces: tables } }),
  );
}

/** A realistic synthetic main-session event log (10 events, one completed turn). */
function mainSessionEvents() {
  return [
    evt("session", 1, T0, { id: "sess-alpha", createdAt: T0, cwd: "/projects/alpha" }),
    evt("session/title", 2, T0 + 1000, { title: "Fix login flow", source: { kind: "provider" } }),
    evt("user/message", 3, T0 + 2000, { content: [{ type: "text", text: "修复登录流程" }] }),
    evt("turn/start", 4, T0 + 3000, { turn: 1 }),
    evt("assistant/message", 5, T0 + 4000, {
      turn: 1,
      message: {
        content: [
          { type: "text", text: "已定位问题，开始修复" },
          { type: "tool-call", id: "call-1", name: "write", arguments: JSON.stringify({ path: "src/login.mjs", content: "x" }) },
        ],
      },
    }),
    evt("todo/write", 6, T0 + 5000, {
      todos: [
        { content: "定位问题", status: "completed" },
        { content: "补充测试", status: "in_progress" },
      ],
    }),
    evt("tool/call", 7, T0 + 6000, {
      name: "write",
      callId: "call-2",
      arguments: JSON.stringify({ file_path: "docs/login.md", content: "# login" }),
    }),
    evt("tool/result", 8, T0 + 7000, { toolCallId: "call-2", message: { content: [{ type: "text", text: "written" }] } }),
    evt("deliverables/presented", 9, T0 + 8000, { files: [{ path: "docs/login.md", description: "登录说明" }] }),
    evt("turn/end", 10, T0 + 9000, { turn: 1, reason: { kind: "completed" } }),
  ];
}

/**
 * Build a complete synthetic DSH home: workspace registry, one main session with
 * its projcache, one subagent child, a registered workspace directory containing
 * the artifact files, plus one unregistered-cwd session.
 */
function standardHome(t) {
  const home = tempDir(t);
  const workspaceDir = path.join(home, "workspace-alpha");
  for (const relative of ["src/login.mjs", "docs/login.md"]) {
    const file = path.join(workspaceDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "// synthetic\n");
  }
  writeSessionAt(home, "escaped-alpha", "sess-alpha", framesOf(mainSessionEvents()));
  writeProjcache(
    home,
    "sess-alpha",
    projcacheRecord({ title: "Fix login flow", cwd: workspaceDir, children: ["sess-child"] }),
  );

  const childEvents = [
    evt("session", 1, T0, { id: "sess-child", parentSession: "sess-alpha", cwd: workspaceDir }),
    evt("user/message", 2, T0 + 1000, { content: [{ type: "text", text: "子任务：补测试" }] }),
    evt("turn/start", 3, T0 + 2000, { turn: 1 }),
    evt("assistant/message", 4, T0 + 3000, { message: { content: [{ type: "text", text: "完成子任务" }] } }),
    evt("turn/end", 5, T0 + 4000, { turn: 1, reason: { kind: "completed" } }),
  ];
  writeSessionAt(home, "escaped-alpha", "sess-child", framesOf(childEvents));
  writeProjcache(home, "sess-child", projcacheRecord({ title: "子代理：补测试", cwd: workspaceDir }));

  // Session whose cwd is not registered anywhere -> synthetic workspace.
  const looseEvents = [
    evt("session", 1, T0, { id: "sess-loose", createdAt: T0, cwd: "/projects/loose" }),
    evt("user/message", 2, T0 + 1000, { content: [{ type: "text", text: "整理会议纪要" }] }),
    evt("turn/start", 3, T0 + 2000, { turn: 1 }),
    evt("turn/end", 4, T0 + 3000, { turn: 1, reason: { kind: "completed" } }),
  ];
  writeSessionAt(home, "escaped-loose", "sess-loose", framesOf(looseEvents));
  writeProjcache(home, "sess-loose", projcacheRecord({ title: "整理会议纪要", cwd: "/projects/loose" }));

  writeWorkspaceRegistry(home, {
    workspaces: [
      {
        id: "ws-alpha",
        title: "Alpha Workspace",
        path: workspaceDir,
        sessionIds: ["sess-alpha"],
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0 + 9000).toISOString(),
      },
    ],
  });
  return { home, workspaceDir };
}

/* ------------------------------------------------------------------ */
/* decompressSessionBuffer                                             */
/* ------------------------------------------------------------------ */

test("decompressSessionBuffer: empty and plain-JSONL inputs", () => {
  assert.equal(decompressSessionBuffer(Buffer.alloc(0)), "");
  assert.equal(decompressSessionBuffer(null), "");
  assert.equal(decompressSessionBuffer(undefined), "");
  assert.equal(decompressSessionBuffer(new Uint8Array(0)), "");
  assert.equal(decompressSessionBuffer(Buffer.from('{"type":"session"}\n')), '{"type":"session"}\n');
});

test("decompressSessionBuffer: single frame", () => {
  const text = '{"type":"session","seq":1,"time":0,"data":{}}\n';
  assert.equal(decompressSessionBuffer(zlib.zstdCompressSync(Buffer.from(text))), text);
});

test("decompressSessionBuffer: walks every concatenated frame (DSH appends per write)", () => {
  const events = mainSessionEvents();
  const frames = framesOf(events);
  // One zstd frame per event, exactly how DSH appends.
  const magicCount = frames.indexOf(ZSTD_MAGIC) === frames.lastIndexOf(ZSTD_MAGIC) ? 1 : 0;
  assert.equal(magicCount, 0, "fixture must contain multiple frames");
  const output = decompressSessionBuffer(frames);
  const expected = events.map(lineOf).join("");
  assert.equal(output, expected);
  const parsed = parseJsonlEvents(output);
  assert.equal(parsed.events.length, events.length);
  assert.equal(parsed.badLines, 0);
});

test("decompressSessionBuffer: truncated tail keeps the frames that are complete", () => {
  const events = mainSessionEvents();
  const frames = framesOf(events);
  const truncated = frames.subarray(0, frames.length - 6);
  const output = decompressSessionBuffer(truncated);
  // The first frame always survives; a partially decoded last frame may add a
  // broken line, which parseJsonlEvents counts instead of throwing.
  assert.ok(output.startsWith(lineOf(events[0])), "first complete frame must decode");
  const parsed = parseJsonlEvents(output);
  assert.ok(parsed.events.length >= 1, "at least the complete frames must be parsed");
});

test("decompressSessionBuffer: throws only when nothing can be decoded", () => {
  assert.throws(() => decompressSessionBuffer(Buffer.from("definitely not a session log")));
  assert.throws(() => decompressSessionBuffer(Buffer.concat([ZSTD_MAGIC, Buffer.from("garbage")])));
});

/* ------------------------------------------------------------------ */
/* parseJsonlEvents                                                    */
/* ------------------------------------------------------------------ */

test("parseJsonlEvents: parses events and fills missing seq/time", () => {
  const { events, badLines } = parseJsonlEvents(
    [
      JSON.stringify({ type: "session", data: {} }),
      "",
      "   ",
      JSON.stringify({ type: "user/message", seq: 4, time: 1234, data: {} }),
    ].join("\n"),
  );
  assert.equal(badLines, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].time, 0);
  assert.equal(events[1].seq, 4);
  assert.equal(events[1].time, 1234);
});

test("parseJsonlEvents: counts malformed and schemaless lines, keeps the good ones", () => {
  const { events, badLines } = parseJsonlEvents(
    [
      '{"type":"session","seq":1,"time":0}',
      "not json at all",
      '{"seq":2,"time":0}', // no type
      '["array","not","object"]',
      "null",
      '{"type":"turn/start","seq":3,"time":0}',
    ].join("\n"),
  );
  assert.equal(badLines, 4);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session", "turn/start"],
  );
});

test("parseJsonlEvents: sorts defensively when concurrent writers emitted out of order", () => {
  const { events } = parseJsonlEvents(
    [
      '{"type":"turn/end","seq":9,"time":3}',
      '{"type":"turn/start","seq":8,"time":1}',
      '{"type":"user/message","seq":8,"time":2}',
    ].join("\n"),
  );
  assert.deepEqual(
    events.map((event) => [event.seq, event.time]),
    [
      [8, 1],
      [8, 2],
      [9, 3],
    ],
  );
});

test("parseJsonlEvents: normalizes non-finite seq/time from hostile logs", () => {
  // JSON.parse("1e999") is Infinity; Date math/sorting must survive it.
  const { events } = parseJsonlEvents(
    ['{"type":"session","seq":1e999,"time":1e999,"data":{}}', '{"type":"turn/start","seq":2,"time":1e999}'].join("\n"),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].time, 0);
  assert.equal(events[1].time, 0);
});

test("parseJsonlEvents: empty input", () => {
  assert.deepEqual(parseJsonlEvents(""), { events: [], badLines: 0 });
  assert.deepEqual(parseJsonlEvents(null), { events: [], badLines: 0 });
});

/* ------------------------------------------------------------------ */
/* discover + loadParsed (integration over the synthetic DSH home)     */
/* ------------------------------------------------------------------ */

test("createSessionSource requires dshHome", () => {
  assert.throws(() => createSessionSource({}), /requires dshHome/);
});

test("discover: registry workspaces, session metadata, subagent lineage, synthetic workspace", (t) => {
  const { home, workspaceDir } = standardHome(t);
  const source = createSessionSource({ dshHome: home });
  const discovery = source.discover();

  assert.deepEqual(discovery.diagnostics, []);
  const ids = discovery.sessions.map((session) => session.id).sort();
  assert.deepEqual(ids, ["sess-alpha", "sess-child", "sess-loose"]);

  const alpha = discovery.sessions.find((session) => session.id === "sess-alpha");
  assert.equal(alpha.title, "Fix login flow");
  assert.equal(alpha.workspaceId, "ws-alpha");
  assert.equal(alpha.workspaceTitle, "Alpha Workspace");
  assert.equal(alpha.workspacePath, workspaceDir);
  assert.equal(alpha.origin, "main");
  assert.equal(alpha.parentSession, null);
  assert.equal(alpha.turnCount, 2);
  assert.equal(alpha.sigKey, `${alpha.sig.size}:${alpha.sig.mtimeMs}`);
  assert.equal(alpha.diagnostics.badLines, 0);

  const child = discovery.sessions.find((session) => session.id === "sess-child");
  assert.equal(child.parentSession, "sess-alpha");
  assert.equal(child.origin, "subagent");
  assert.equal(child.delegationDepth, 1);
  assert.equal(child.workspaceId, "ws-alpha");

  const loose = discovery.sessions.find((session) => session.id === "sess-loose");
  assert.equal(loose.origin, "main");
  assert.ok(loose.workspaceId.startsWith("ws_"), `unexpected workspace id: ${loose.workspaceId}`);
  const synthetic = discovery.workspaces.find((workspace) => workspace.id === loose.workspaceId);
  assert.equal(synthetic.source, "discovered");
  assert.equal(synthetic.synthetic, true);

  const alphaWorkspace = discovery.workspaces.find((workspace) => workspace.id === "ws-alpha");
  assert.equal(alphaWorkspace.sessionCount, 1, "only main sessions count towards a workspace");
  // The registry list is extended with every discovered session of that
  // workspace (subagents included); sessionCount only counts main sessions.
  assert.deepEqual(alphaWorkspace.sessionIds, ["sess-alpha", "sess-child"]);
});

test("discover: corrupt registry/projcache degrade to diagnostics instead of throwing", (t) => {
  const home = tempDir(t);
  writeSessionAt(home, "escaped-broken", "sess-broken", framesOf([
    evt("session", 1, T0, { id: "sess-broken", cwd: "/projects/broken" }),
    evt("user/message", 2, T0 + 1, { content: [{ type: "text", text: "hello" }] }),
  ]));
  fs.mkdirSync(path.join(home, "storages", "session_projcache", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "storages", "session_projcache", "sessions", "sess-broken.json"), "{not json");
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), "[1,2,3]");
  const source = createSessionSource({ dshHome: home });
  const discovery = source.discover();
  assert.equal(discovery.sessions.length, 1);
  const broken = discovery.sessions[0];
  assert.equal(broken.title, null);
  assert.equal(broken.origin, "main");
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.kind === "workspace-registry"));

  // Registry with hostile shapes must not break path resolution.
  fs.writeFileSync(
    path.join(home, "storages", "workspace.json"),
    JSON.stringify({ tables: { workspaces: { bad: { path: 42 }, "": null, ok: { path: "/projects/broken", title: "Broken" } } } }),
  );
  const second = source.discover();
  assert.equal(second.sessions.length, 1);
  assert.equal(second.workspaces.length, 1);
  assert.equal(second.workspaces[0].id, "ok");
});

test("discover: missing sessions root yields diagnostics and no sessions", (t) => {
  const home = tempDir(t);
  const source = createSessionSource({ dshHome: home });
  const discovery = source.discover();
  assert.deepEqual(discovery.sessions, []);
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.kind === "sessions-root"));
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.kind === "workspace-registry"));
});

test("loadParsed: builds the compact parsed structure analyzers consume", (t) => {
  const { home, workspaceDir } = standardHome(t);
  const source = createSessionSource({ dshHome: home });
  const discovery = source.discover();
  const alphaMeta = discovery.sessions.find((session) => session.id === "sess-alpha");
  const parsed = source.loadParsed(alphaMeta);

  assert.equal(parsed.id, "sess-alpha");
  assert.equal(parsed.title, "Fix login flow");
  assert.equal(parsed.session.cwd, "/projects/alpha");
  assert.equal(parsed.eventCount, 10);
  assert.equal(parsed.turnCount, 1);
  assert.equal(parsed.lastEvent.type, "turn/end");
  assert.equal(parsed.lastTurnEnd.kind, "completed");
  assert.equal(parsed.isLive, false, "a completed turn in the past is not live");

  assert.equal(parsed.users.length, 1);
  assert.equal(parsed.users[0].text, "修复登录流程");
  assert.equal(parsed.assistants.length, 1);
  assert.equal(parsed.assistants[0].text, "已定位问题，开始修复");

  // tool-call from assistant/message (fallback) + canonical tool/call are deduped
  // by callId and both survive as distinct calls.
  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(
    parsed.toolCalls.map((call) => call.name),
    ["write", "write"],
  );
  assert.equal(parsed.toolResults.length, 1);
  assert.equal(parsed.todoSnapshots.length, 1);
  assert.equal(parsed.deliverables.length, 1);
  assert.equal(parsed.workspaceChanges.length, 0);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.activity["2026-01-05"], 10);
  assert.equal(Object.getPrototypeOf(parsed.activity), null, "activity map is a null-prototype dictionary");
  assert.equal(parsed.lastActivityAt, T0 + 9000);
  assert.ok(parsed.timeBySeq instanceof Map);
  assert.equal(parsed.timeBySeq.get(3), T0 + 2000);

  // Artifact extraction only advertises files that exist under the workspace.
  const artifacts = source.extractArtifacts(parsed, { workspacePath: workspaceDir });
  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ["docs/login.md", "src/login.mjs"],
  );
  assert.ok(artifacts.every((artifact) => artifact.id.startsWith("a_")));

  // The digest is built from the parsed view and stays within its byte budget.
  const digest = source.buildDigest(parsed, { workspaceTitle: "Alpha Workspace" });
  assert.ok(Buffer.byteLength(digest, "utf8") <= 1500);
  assert.match(digest, /会话:Fix login flow/);
  assert.match(digest, /U\[3\]/);
  assert.match(digest, /A\[5\]/);
  assert.match(digest, /待办:/);

  const { todoTotal, todoDone } = source.latestTodos(parsed);
  assert.equal(todoTotal, 2);
  assert.equal(todoDone, 1);

  const api = source.readApiEvents(parsed);
  // 1 user + 1 assistant + 2 tool calls + 1 tool result + 1 todo + 1 deliverable.
  assert.equal(api.length, 7);
  assert.deepEqual([...new Set(api.map((event) => event.kind))].sort(), ["assistant", "deliverable", "todo", "tool", "user"]);
  assert.ok(api.every((event) => Number.isFinite(event.seq)));

  // The `session` event payload lives under `data`: the authoritative log values
  // (not the projcache fallback) must win.
  assert.equal(parsed.session.id, "sess-alpha");
  assert.equal(parsed.session.createdAt, T0);
  assert.equal(parsed.session.origin, "main");
  const childMeta = discovery.sessions.find((session) => session.id === "sess-child");
  const childParsed = source.loadParsed(childMeta);
  assert.equal(childParsed.parentSession, "sess-alpha");
  assert.equal(childParsed.delegationDepth, 1);
  assert.equal(childParsed.origin, "subagent");
  assert.equal(childParsed.session.cwd, workspaceDir);

  const meta = source.metaFromParsed(parsed);
  assert.equal(meta.userCount, 1);
  assert.equal(meta.hasUserMessages, true);
  assert.equal(meta.todoCounts.total, 2);
  assert.equal(meta.todoCounts.completed, 1);
  assert.equal(meta.todoCounts.inProgress, 1);
  assert.equal(meta.lastTurnStartSeq, 4);
});

test("loadParsed: malformed lines are counted in diagnostics, not fatal", (t) => {
  const home = tempDir(t);
  const good = [evt("session", 1, T0, { id: "sess-mixed" }), evt("turn/start", 2, T0 + 1, { turn: 1 })];
  const frames = Buffer.concat([
    ...good.map((event) => zlib.zstdCompressSync(Buffer.from(lineOf(event)))),
    zlib.zstdCompressSync(Buffer.from("{broken json\n")),
  ]);
  writeSessionAt(home, "escaped-mixed", "sess-mixed", frames);
  const source = createSessionSource({ dshHome: home });
  const meta = source.discover().sessions[0];
  const parsed = source.loadParsed(meta);
  assert.equal(parsed.eventCount, 2);
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.kind === "jsonl" && diagnostic.badLines === 1));
});

test("loadParsed: corrupt or empty logs throw stable error codes", (t) => {
  const home = tempDir(t);
  const corruptDir = path.join(home, "sessions", "escaped-a", "sess-corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, SESSION_FILE_NAME), Buffer.from("not zstd"));

  const garbageDir = path.join(home, "sessions", "escaped-b", "sess-garbage");
  fs.mkdirSync(garbageDir, { recursive: true });
  fs.writeFileSync(
    path.join(garbageDir, SESSION_FILE_NAME),
    zlib.zstdCompressSync(Buffer.from("no valid events here\n")),
  );

  const source = createSessionSource({ dshHome: home });
  const sessions = source.discover().sessions;
  const corrupt = sessions.find((session) => session.id === "sess-corrupt");
  assert.throws(() => source.loadParsed(corrupt), /decompress-failed/);
  const garbage = sessions.find((session) => session.id === "sess-garbage");
  assert.throws(() => source.loadParsed(garbage), /empty-session-log/);
});

test("loadParsed: hostile timestamps do not abort the whole parse", (t) => {
  const home = tempDir(t);
  const events = [
    evt("session", 1, 1e300, { id: "sess-time" }), // out of Date range
    evt("user/message", 2, 1e300, { content: [{ type: "text", text: "hi" }] }),
    evt("turn/start", 3, T0, { turn: 1 }),
  ];
  writeSessionAt(home, "escaped-time", "sess-time", framesOf(events));
  const source = createSessionSource({ dshHome: home });
  const parsed = source.loadParsed(source.discover().sessions[0]);
  assert.equal(parsed.users.length, 1);
  assert.equal(parsed.eventCount, 3);
  assert.equal(parsed.lastActivityAt, T0);
});

/* ------------------------------------------------------------------ */
/* buildDigest                                                         */
/* ------------------------------------------------------------------ */

function digestFixture(overrides = {}) {
  const base = {
    id: "sess-digest",
    title: "Adversarial digest session",
    isLive: true,
    turnCount: 7,
    lastTurnEnd: { kind: "completed", seq: 900, error: null },
    goal: { text: "把登录流程修好并补测试", status: "active" },
    session: { cwd: "/projects/digest" },
    users: [{ seq: 1, time: T0, text: "请修复登录" }],
    assistants: [{ seq: 2, time: T0 + 1, text: "已修复" }],
    todoSnapshots: [],
    turnStarts: [],
    errors: [],
    toolCalls: [],
    ...overrides,
  };
  return base;
}

test("buildDigest: stays within 1500 UTF-8 bytes on adversarial input", () => {
  const mountain = "汉".repeat(4000) + "🙂".repeat(2000);
  const parsed = digestFixture({
    title: mountain,
    goal: { text: mountain },
    users: [
      { seq: 1, time: T0, text: mountain },
      { seq: 3, time: T0 + 2, text: mountain },
      { seq: 5, time: T0 + 4, text: mountain },
    ],
    assistants: [
      { seq: 2, time: T0 + 1, text: mountain },
      { seq: 4, time: T0 + 3, text: mountain },
      { seq: 6, time: T0 + 5, text: mountain },
    ],
    todoSnapshots: [
      {
        seq: 7,
        time: T0 + 6,
        todos: Array.from({ length: 40 }, () => ({ content: mountain, status: "in_progress" })),
      },
    ],
    errors: Array.from({ length: 10 }, (_value, index) => ({ seq: 10 + index, time: T0 + index, text: mountain })),
    toolCalls: Array.from({ length: 30 }, (_value, index) => ({
      seq: 100 + index,
      time: T0 + index,
      name: "write",
      callId: `call-${index}`,
      args: JSON.stringify({ path: `src/f${index}.mjs`, content: mountain }),
    })),
  });
  const digest = buildDigest(parsed, {
    workspaceTitle: mountain,
    existingTasks: Array.from({ length: 10 }, (_value, index) => ({
      id: `t_${index}`,
      title: mountain,
      status: "in_progress",
    })),
  });
  const bytes = Buffer.byteLength(digest, "utf8");
  assert.ok(bytes > 0, "digest must not be empty");
  assert.ok(bytes <= 1500, `digest must stay <=1500 bytes, got ${bytes}`);
});

test("buildDigest: honors a custom byte budget and never exceeds it", () => {
  const parsed = digestFixture({
    users: Array.from({ length: 20 }, (_value, index) => ({ seq: index + 1, time: T0 + index, text: "汉".repeat(200) })),
  });
  for (const maxBytes of [0, 120, 300, 800]) {
    const digest = buildDigest(parsed, { maxBytes });
    assert.ok(Buffer.byteLength(digest, "utf8") <= maxBytes, `budget ${maxBytes} exceeded`);
  }
});

test("buildDigest: prioritizes recent changes, todos, errors and tool summary", () => {
  const parsed = digestFixture({
    users: [
      { seq: 1, time: T0, text: "旧需求" },
      { seq: 10, time: T0 + 10, text: "最新指令：补测试" },
    ],
    assistants: [{ seq: 11, time: T0 + 11, text: "收到" }],
    todoSnapshots: [
      { seq: 12, time: T0 + 12, todos: [{ content: "写测试", status: "completed" }, { content: "跑通", status: "pending" }] },
    ],
    errors: [{ seq: 13, time: T0 + 13, text: "npm test 失败" }],
    toolCalls: [{ seq: 14, time: T0 + 14, name: "write", callId: "c1", args: JSON.stringify({ path: "tests/a.test.mjs" }) }],
  });
  const digest = buildDigest(parsed, {
    workspaceTitle: "Alpha",
    existingTasks: [{ id: "t_abc", title: "已有卡片", status: "in_progress" }],
    baselineSeq: 5,
  });
  assert.match(digest, /live:1/);
  assert.match(digest, /end:completed/);
  assert.match(digest, /U\[10\] 最新指令：补测试/);
  assert.match(digest, /待办:/);
  assert.match(digest, /\[x\]写测试/);
  assert.match(digest, /错误:\[13\]/);
  assert.match(digest, /写入:tests\/a\.test\.mjs/);
  assert.match(digest, /已有任务:t_abc「已有卡片」in_progress/);
});

test("buildDigest: a bare parsed view still yields a bounded header line", () => {
  const digest = buildDigest({ id: "x" });
  assert.ok(Buffer.byteLength(digest, "utf8") <= 1500);
  assert.match(digest, /会话:/);
});

/* ------------------------------------------------------------------ */
/* extractArtifacts / extractSubtasks / latestTodos / toolBrief        */
/* ------------------------------------------------------------------ */

function artifactsFixture(workspaceDir) {
  return {
    id: "sess-artifacts",
    session: { cwd: workspaceDir },
    deliverables: [
      { seq: 20, time: T0 + 20, files: [{ path: "docs/guide.md", description: "指南" }] },
      { seq: 21, time: T0 + 21, files: [{ path: "docs/guide.md", description: "重复" }, { path: "docs/missing.md" }] },
    ],
    toolCalls: [
      { seq: 10, time: T0 + 10, name: "write", callId: "c1", args: JSON.stringify({ path: "src/app.mjs" }) },
      { seq: 11, time: T0 + 11, name: "edit", callId: "c2", args: JSON.stringify({ file_path: "src/app.mjs" }) },
      { seq: 12, time: T0 + 12, name: "bash", callId: "c3", args: JSON.stringify({ command: "ls" }) },
      { seq: 13, time: T0 + 13, name: "write", callId: "c4", args: "{broken" },
      { seq: 14, time: T0 + 14, name: "write", callId: "c5", args: JSON.stringify({ path: "/outside/report.txt" }) },
    ],
  };
}

test("extractArtifacts: dedupes, resolves paths, keeps deliverables first, filters missing files", (t) => {
  const workspaceDir = tempDir(t, "sk-artifacts-");
  for (const relative of ["docs/guide.md", "src/app.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(workspaceDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, relative), "x");
  }
  const parsed = artifactsFixture(workspaceDir);
  const artifacts = extractArtifacts(parsed);
  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ["docs/guide.md", "src/app.mjs"],
  );
  assert.equal(artifacts[0].description, "指南");
  assert.equal(artifacts[0].sessionId, "sess-artifacts");
  assert.equal(artifacts[1].name, "app.mjs");
  assert.ok(artifacts.every((artifact) => artifact.id.startsWith("a_")));

  const limited = extractArtifacts(parsed, { max: 1 });
  assert.equal(limited.length, 1);

  // Fallback to session.cwd when no workspacePath is given, and max=0.
  assert.equal(extractArtifacts(parsed, { workspacePath: workspaceDir, max: 0 }).length, 0);

  // An absolute path outside the workspace is kept absolute (never rewritten
  // relative), and only advertised when the file exists.
  const outsideDir = tempDir(t, "sk-outside-");
  const outsideFile = path.join(outsideDir, "report.txt");
  fs.writeFileSync(outsideFile, "x");
  const outside = extractArtifacts({
    id: "sess-outside",
    session: { cwd: workspaceDir },
    deliverables: [],
    toolCalls: [{ seq: 1, time: 1, name: "write", callId: "c", args: JSON.stringify({ path: outsideFile }) }],
  });
  assert.equal(outside.length, 1);
  assert.equal(outside[0].path, outsideFile);
  assert.equal(outside[0].absPath, outsideFile);

  const empty = extractArtifacts({ id: "x", session: {}, toolCalls: [] });
  assert.deepEqual(empty, []);
});

test("extractSubtasks: imports the latest todo snapshot only when fresh/all-done", () => {
  const parsed = {
    id: "sess-sub",
    turnStarts: [{ seq: 30 }],
    todoSnapshots: [
      { seq: 10, todos: [{ content: "old", status: "pending" }] },
      { seq: 40, todos: [{ content: "写测试", status: "completed" }, { content: "跑通", status: "in_progress" }] },
    ],
  };
  const fresh = extractSubtasks(parsed);
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].text, "写测试");
  assert.equal(fresh[0].done, true);
  assert.equal(fresh[1].done, false);
  assert.equal(fresh[0].source, "todo");
  assert.equal(fresh[0].seq, 40);
  assert.ok(fresh[0].id.startsWith("s_"));

  const stale = { ...parsed, todoSnapshots: [{ seq: 10, todos: [{ content: "old", status: "pending" }] }] };
  assert.deepEqual(extractSubtasks(stale), []);
  assert.equal(extractSubtasks(stale, { forceAll: true }).length, 1);

  const staleButDone = { ...parsed, todoSnapshots: [{ seq: 10, todos: [{ content: "old", status: "completed" }] }] };
  assert.equal(extractSubtasks(staleButDone).length, 1);

  assert.deepEqual(extractSubtasks({ id: "x", todoSnapshots: [] }), []);
  assert.equal(extractSubtasks(parsed, { max: 1 }).length, 1);
});

test("latestTodos: clips text and counts completion", () => {
  const parsed = {
    todoSnapshots: [
      {
        seq: 1,
        todos: [
          { content: "a".repeat(200), status: "completed" },
          { content: "b", status: "pending" },
          { content: "c", status: "in_progress" },
        ],
      },
    ],
  };
  const result = latestTodos(parsed);
  assert.equal(result.todos.length, 3);
  assert.equal(result.todos[0].content.length, 80);
  assert.equal(result.todoTotal, 3);
  assert.equal(result.todoDone, 1);
  assert.deepEqual(latestTodos({ todoSnapshots: [] }), { todos: [], todoTotal: 0, todoDone: 0 });
});

test("toolBrief: recent write/edit targets and tool names since a baseline", () => {
  const workspaceDir = "/projects/toolbrief";
  const parsed = {
    id: "sess-tools",
    session: { cwd: workspaceDir },
    toolCalls: [
      { seq: 1, time: 1, name: "write", callId: "c1", args: JSON.stringify({ path: "a.mjs" }) },
      { seq: 2, time: 2, name: "bash", callId: "c2", args: "{}" },
      { seq: 3, time: 3, name: "edit", callId: "c3", args: JSON.stringify({ file_path: "a.mjs" }) },
      { seq: 4, time: 4, name: "write", callId: "c4", args: JSON.stringify({ filePath: "b/c.mjs" }) },
      { seq: 5, time: 5, name: "write", callId: "c5", args: JSON.stringify({ file: "d.mjs" }) },
      { seq: 6, time: 6, name: "write", callId: "c6", args: "{broken" },
    ],
  };
  const all = toolBrief(parsed);
  assert.deepEqual(all.files, ["a.mjs", "b/c.mjs", "d.mjs"]);
  assert.deepEqual(all.commandNames, ["write", "bash", "edit"]);

  const recent = toolBrief(parsed, { baselineSeq: 3 });
  assert.deepEqual(recent.files, ["b/c.mjs", "d.mjs"]);
  assert.deepEqual(recent.commandNames, ["write"]);

  const capped = toolBrief(
    {
      ...parsed,
      toolCalls: Array.from({ length: 20 }, (_value, index) => ({
        seq: index + 1,
        time: index,
        name: index % 2 === 0 ? "write" : "read",
        callId: `c-${index}`,
        args: JSON.stringify({ path: `f${index}.mjs` }),
      })),
    },
    {},
  );
  assert.equal(capped.files.length, 8);
  // Only the two distinct tool names occurred, so the 5-name cap is not reached.
  assert.equal(capped.commandNames.length, 2);
  assert.deepEqual(toolBrief({ id: "x", toolCalls: [] }).files, []);
});

/* ------------------------------------------------------------------ */
/* readApiEvents paging hardening                                      */
/* ------------------------------------------------------------------ */

test("readApiEvents: non-numeric or huge limits cannot disable the cap", (t) => {
  const source = createSessionSource({ dshHome: tempDir(t) });
  const parsed = {
    id: "sess-api",
    title: "API session",
    users: Array.from({ length: 300 }, (_value, index) => ({
      seq: index + 1,
      time: T0 + index,
      text: `message ${index}`,
      images: 0,
    })),
    assistants: [],
    toolCalls: [],
    toolResults: [],
    todoSnapshots: [],
    deliverables: [],
    turnEnds: [],
  };
  assert.equal(source.readApiEvents(parsed).length, 200);
  assert.equal(source.readApiEvents(parsed, { limit: Number.NaN }).length, 200);
  assert.equal(source.readApiEvents(parsed, { limit: 9999 }).length, 300);
  assert.equal(source.readApiEvents(parsed, { limit: 0 }).length, 1);
  assert.equal(source.readApiEvents(parsed, { limit: 500 }).length, 300);
  const tail = source.readApiEvents(parsed, { after: 295 });
  assert.deepEqual(
    tail.map((event) => event.seq),
    [296, 297, 298, 299, 300],
  );
  assert.deepEqual(source.readApiEvents(parsed, { after: 999 }).length, 0);
});

test("isoDay: null for missing/out-of-range timestamps", () => {
  assert.equal(isoDay(0), null);
  assert.equal(isoDay(null), null);
  assert.equal(isoDay(Number.POSITIVE_INFINITY), null);
  assert.equal(isoDay(1e300), null);
  assert.equal(isoDay(T0), "2026-01-05");
});
