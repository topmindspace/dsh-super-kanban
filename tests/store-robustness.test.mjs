/**
 * Hermetic robustness tests for server/store.mjs: corrupt files, migration,
 * atomic writes and backup retention. Every test uses a temp $DSH_HOME.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  STORE_VERSION,
  TEXT_LIMITS,
  createEmptyCache,
  createEmptyState,
  createStore,
  normalizeSettingsPatch,
  positiveSeqOrNull,
  truncateTask,
} from "../server/store.mjs";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeDir(home) {
  return path.join(home, "storages", "super-kanban");
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function backupNames(home) {
  return fs.readdirSync(path.join(storeDir(home), "backups"));
}

test("load: corrupt state.json is backed up and replaced with defaults", (t) => {
  const home = tempHome(t);
  writeJsonFile(path.join(storeDir(home), "state.json"), "{this is not json");
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  assert.equal(loaded.state.tasks.length, 0);
  assert.equal(loaded.state.version, STORE_VERSION);
  assert.ok(loaded.diagnostics.some((entry) => entry.kind === "state"));
  const backups = backupNames(home);
  assert.ok(backups.some((name) => name.startsWith("state.json.") && name.endsWith(".corrupt")));
});

test("load: corrupt sessions-cache.json is backed up and replaced with an empty cache", (t) => {
  const home = tempHome(t);
  writeJsonFile(path.join(storeDir(home), "sessions-cache.json"), "not json");
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  assert.deepEqual(loaded.cache.sessions, {});
  assert.ok(loaded.diagnostics.some((entry) => entry.kind === "cache"));
  assert.ok(backupNames(home).some((name) => name.endsWith(".corrupt")));
});

test("load: v1 state migrates to v2, keeps a v1 backup and derives v2 fields", (t) => {
  const home = tempHome(t);
  const v1 = {
    version: 1,
    tasks: [
      {
        id: "t_old",
        title: "Legacy card",
        goal: "legacy goal",
        status: "in_progress",
        progress: 40,
        priority: "P1",
        tags: ["legacy"],
        origin: "auto",
        workspaceId: "ws-a",
        sessions: [{ id: "sess-old", title: "Old session" }],
        primarySessionId: "sess-old",
        issues: [],
        nextSteps: [],
        milestones: [{ text: "milestone one", done: true }],
        evidence: [{ id: "e_1", kind: "error", text: "boom", quote: "boom", seq: 3 }],
        lockedFields: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        archived: false,
        history: [],
      },
    ],
    settings: { autoScan: false, scanIntervalSeconds: 90, lastScanAt: new Date(0).toISOString() },
    ignoredSessions: ["sess-ignored"],
    workspaces: [{ id: "ws-a", title: "A", path: "/projects/a" }],
    activity: [{ day: "2026-01-01", count: 3 }],
    scan: { state: "running", processed: 2 },
  };
  writeJsonFile(path.join(storeDir(home), "state.json"), v1);
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  assert.equal(loaded.state.version, STORE_VERSION);
  assert.ok(loaded.diagnostics.some((entry) => entry.kind === "migrate"));
  assert.equal(loaded.state.tasks.length, 1);
  const task = loaded.state.tasks[0];
  assert.equal(task.goal.text, "legacy goal");
  assert.equal(task.keyFacts.length, 1, "keyFacts derived from evidence");
  assert.equal(task.keyFacts[0].kind, "issue");
  assert.equal(task.subtasks.length, 1, "subtasks derived from milestones");
  assert.equal(task.subtasks[0].text, "milestone one");
  assert.ok(Array.isArray(task.artifacts));
  assert.equal(task.sessionContext.sessionId, "sess-old");
  assert.equal(loaded.state.settings.autoScan, false);
  assert.equal(loaded.state.settings.scanIntervalSeconds, 90);
  assert.deepEqual(loaded.state.ignoredSessions, ["sess-ignored"]);
  // A scan that was running when the process died is reset on load.
  assert.equal(loaded.state.scan.state, "idle");
  assert.ok(backupNames(home).some((name) => name.endsWith(".v1")));
});

test("load: hand-edited v2 state with hostile entries is sanitized, not crashed on", (t) => {
  const home = tempHome(t);
  const hostile = {
    version: 2,
    tasks: [
      null,
      42,
      "nope",
      {
        id: "t_ok",
        title: "Valid card",
        status: "backlog",
        sessions: [],
        evidence: [null, { text: "kept" }],
        history: [],
      },
    ],
    settings: { autoScan: "yes", scanIntervalSeconds: 99999, lastScanAt: "not-a-date" },
    ignoredSessions: ["sess-a", 7, null],
    suppressedSessions: [12, "sess-b"],
    workspaces: [null, { id: "ws-a", title: "A", path: "/projects/a" }, "junk"],
    activity: [null, { day: "2026-01-01", count: 2 }],
    deletedLog: [null, { id: "t_deleted" }],
    scan: "running",
    usage: { date: "1970-01-01", calls: -5 },
  };
  writeJsonFile(path.join(storeDir(home), "state.json"), hostile);
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  assert.equal(loaded.state.tasks.length, 1);
  assert.equal(loaded.state.tasks[0].id, "t_ok");
  assert.deepEqual(loaded.state.ignoredSessions, ["sess-a"]);
  assert.deepEqual(loaded.state.suppressedSessions, ["sess-b"]);
  assert.equal(loaded.state.workspaces.length, 1);
  assert.equal(loaded.state.deletedLog.length, 1);
  assert.equal(loaded.state.settings.autoScan, true, "invalid boolean falls back to the default");
  assert.equal(loaded.state.settings.scanIntervalSeconds, 3600, "out-of-range interval is clamped");
  assert.equal(loaded.state.scan.state, "idle");
  assert.equal(loaded.state.usage.calls, 0);
  // The service must be able to derive stats from the sanitized state.
  const activeTasks = loaded.state.tasks.filter((task) => !task.archived);
  assert.equal(activeTasks.length, 1);
});

test("load: cache entries without a usable meta are dropped", (t) => {
  const home = tempHome(t);
  writeJsonFile(path.join(storeDir(home), "sessions-cache.json"), {
    version: 2,
    sessions: {
      "sess-good": { sigKey: "1:1", meta: { id: "sess-good", title: "Good" } },
      "sess-bad": { sigKey: "2:2" },
      "sess-number": 42,
      "sess-null": null,
    },
  });
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  assert.deepEqual(Object.keys(loaded.cache.sessions).sort(), ["sess-good"]);
});

test("saveState/saveCache: atomic writes leave no temp files and round-trip", (t) => {
  const home = tempHome(t);
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const state = createEmptyState();
  state.tasks = [
    {
      id: "t_one",
      title: "One",
      goal: { text: "", status: "none", source: "task" },
      status: "backlog",
      sessions: [],
      evidence: [],
      issues: [],
      nextSteps: [],
      milestones: [],
      tags: [],
      lockedFields: [],
      history: [],
    },
  ];
  state.version = 99; // saveState normalizes the version
  state.ignoredSessions = Array.from({ length: 600 }, (_value, index) => `sess-${index}`);
  store.saveState(state);
  const cache = createEmptyCache();
  cache.sessions["sess-one"] = { sigKey: "3:4", meta: { id: "sess-one" } };
  store.saveCache(cache);

  const dir = store.dir;
  const tempFiles = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(tempFiles, [], "no partial temp files may remain");

  const reloaded = store.load();
  assert.equal(reloaded.state.version, STORE_VERSION);
  assert.equal(reloaded.state.tasks[0].id, "t_one");
  assert.equal(reloaded.state.ignoredSessions.length, 500, "ignored sessions stay bounded");
  assert.ok(reloaded.cache.sessions["sess-one"]);
  assert.ok(fs.existsSync(path.join(dir, "state.json")));
  assert.ok(fs.existsSync(path.join(dir, "sessions-cache.json")));
});

test("saveState: a failed rename cleans up its temp file and rethrows", (t) => {
  const home = tempHome(t);
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  store.ensureDirs();
  // A directory squatting on the target path makes rename() fail.
  fs.mkdirSync(store.stateFile);
  assert.throws(() => store.saveState(createEmptyState()));
  const tempFiles = fs.readdirSync(store.dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(tempFiles, []);
});

test("backups: retention also prunes failed-migration backups", (t) => {
  const home = tempHome(t);
  const dir = path.join(storeDir(home), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const items = [];
  for (let index = 1; index <= 12; index += 1) {
    const stamp = `2026-01-${String(index).padStart(2, "0")}T00-00-00.000Z`;
    const name = `state.json.${stamp}.migrate-failed`;
    writeJsonFile(path.join(dir, name), "{}");
    items.push(name);
  }
  writeJsonFile(path.join(storeDir(home), "state.json"), "{corrupt");
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  store.load();
  const names = backupNames(home);
  const failedMigrations = names.filter((name) => name.endsWith(".migrate-failed"));
  assert.ok(
    failedMigrations.length <= 10,
    `failed-migration backups must be pruned, still have ${failedMigrations.length}`,
  );
  assert.ok(names.some((name) => name.endsWith(".corrupt")));
});

test("normalizeSettingsPatch is not prototype-pollutable", () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"autoScan":false}');
  const result = normalizeSettingsPatch(parsed);
  assert.deepEqual(result, { autoScan: false });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  // The patch object itself must never be mutated.
  assert.equal(parsed.autoScan, false);
});

test("TEXT_LIMITS exposes the persisted maxima used by create/update/truncate", () => {
  assert.equal(TEXT_LIMITS.title, 80);
  assert.equal(TEXT_LIMITS.goal, 280);
  assert.equal(TEXT_LIMITS.tagText, 12);
  assert.equal(TEXT_LIMITS.tags, 4);
  assert.equal(TEXT_LIMITS.subtaskText, 60);
  assert.equal(TEXT_LIMITS.issueText, 160);
  assert.equal(TEXT_LIMITS.nextStepText, 160);
  assert.equal(TEXT_LIMITS.milestoneText, 120);
  assert.equal(Object.isFrozen(TEXT_LIMITS), true);
});

test("truncateTask is the single truncation authority", () => {
  const task = {
    title: "标".repeat(TEXT_LIMITS.title + 50),
    goal: { text: "目".repeat(TEXT_LIMITS.goal + 50), status: "active", source: "task" },
    tags: ["a".repeat(TEXT_LIMITS.tagText + 20), "ok", 42],
    subtasks: [{ text: "子".repeat(TEXT_LIMITS.subtaskText + 20) }],
    issues: [
      { text: "问".repeat(TEXT_LIMITS.issueText + 50), severity: "weird", sessionId: "sess-a", seq: 0 },
      "字符串问题",
      null,
      42,
    ],
    nextSteps: ["步".repeat(TEXT_LIMITS.nextStepText + 20), { text: "对象步骤" }, 7],
    milestones: [{ text: "里".repeat(TEXT_LIMITS.milestoneText + 20), done: false, seq: -2 }, "字符串里程碑", {}],
    keyFacts: [{ text: "关".repeat(TEXT_LIMITS.keyFactText + 20) }],
    evidence: [{ text: "证".repeat(TEXT_LIMITS.evidenceText + 20), quote: "引".repeat(TEXT_LIMITS.evidenceQuote + 20), seq: null }],
  };
  truncateTask(task);

  assert.equal(task.title.length, TEXT_LIMITS.title);
  assert.equal(task.goal.text.length, TEXT_LIMITS.goal);
  assert.deepEqual(task.tags, [`${"a".repeat(TEXT_LIMITS.tagText - 1)}…`, "ok"]);
  assert.equal(task.subtasks[0].text.length, TEXT_LIMITS.subtaskText);
  assert.equal(task.keyFacts[0].text.length, TEXT_LIMITS.keyFactText);

  assert.equal(task.issues.length, 2, "non-object issue junk is dropped");
  assert.equal(task.issues[0].text.length, TEXT_LIMITS.issueText);
  assert.equal(task.issues[0].severity, "medium", "unknown severity normalizes to medium");
  assert.equal(task.issues[0].seq, null, "invalid seq is null, never 0");
  assert.equal(task.issues[1].text, "字符串问题", "string issues become records");

  assert.deepEqual(task.nextSteps, [`${"步".repeat(TEXT_LIMITS.nextStepText - 1)}…`, "对象步骤"]);
  assert.equal(task.milestones.length, 2);
  assert.equal(task.milestones[0].text.length, TEXT_LIMITS.milestoneText);
  assert.equal(task.milestones[0].seq, null);
  assert.equal(task.milestones[1].text, "字符串里程碑");
  assert.equal(task.evidence[0].text.length, TEXT_LIMITS.evidenceText);
  assert.equal(task.evidence[0].quote.length, TEXT_LIMITS.evidenceQuote);

  // Idempotent: a second pass (e.g. load then save) must not change the payload.
  const snapshot = JSON.parse(JSON.stringify(task));
  truncateTask(task);
  assert.deepEqual(JSON.parse(JSON.stringify(task)), snapshot);
});

test("load applies truncateTask to persisted overlong values", (t) => {
  const home = tempHome(t);
  const state = createEmptyState();
  state.tasks = [
    {
      id: "t_overlong",
      title: "标".repeat(300),
      goal: { text: "目".repeat(600), status: "active", source: "task" },
      status: "backlog",
      sessions: [],
      evidence: [],
      issues: [{ text: "问".repeat(500), severity: "high" }],
      nextSteps: ["步".repeat(500)],
      milestones: [{ text: "里".repeat(500), done: false }],
      tags: ["标".repeat(50)],
      lockedFields: [],
      history: [],
      subtasks: [{ text: "子".repeat(200), source: "manual" }],
    },
  ];
  writeJsonFile(path.join(storeDir(home), "state.json"), state);
  const store = createStore({ dshHome: home, logger: { warn() {} } });
  const loaded = store.load();
  const task = loaded.state.tasks[0];
  assert.equal(task.title.length, TEXT_LIMITS.title);
  assert.equal(task.goal.text.length, TEXT_LIMITS.goal);
  assert.equal(task.issues[0].text.length, TEXT_LIMITS.issueText);
  assert.equal(task.nextSteps[0].length, TEXT_LIMITS.nextStepText);
  assert.equal(task.milestones[0].text.length, TEXT_LIMITS.milestoneText);
  assert.equal(task.tags[0].length, TEXT_LIMITS.tagText);
  assert.equal(task.subtasks[0].text.length, TEXT_LIMITS.subtaskText);
});

test("positiveSeqOrNull never invents seq 0", () => {
  assert.equal(positiveSeqOrNull(12), 12);
  assert.equal(positiveSeqOrNull("12"), 12);
  assert.equal(positiveSeqOrNull(12.7), 12);
  assert.equal(positiveSeqOrNull(0), null);
  assert.equal(positiveSeqOrNull(-1), null);
  assert.equal(positiveSeqOrNull(null), null);
  assert.equal(positiveSeqOrNull(undefined), null);
  assert.equal(positiveSeqOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(positiveSeqOrNull("nope"), null);
});
