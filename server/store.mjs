/**
 * Super Kanban — persistence (v2).
 *
 * Two JSON documents under $DSH_HOME/storages/super-kanban/:
 *   state.json          board state: tasks, settings, usage, ignored sessions, scan
 *   sessions-cache.json per-session parse signatures + compact metadata
 *
 * Writes are atomic (tmp file + rename). Corrupt files are moved to backups/
 * and replaced with defaults instead of crashing the plugin.
 *
 * v2 adds: state.version=2, usage counters, AI budget settings, task-v2 fields
 * (keyFacts/subtasks/artifacts/goal/sessionContext) and tighter storage caps.
 * Loading a v1 state migrates it; a failed migration backs up and rebuilds.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const STORE_VERSION = 2;

/** v2 storage caps (contract §E). */
export const EVIDENCE_LIMIT = 8;
export const KEYFACT_LIMIT = 6;
export const SUBTASK_LIMIT = 12;
export const ARTIFACT_LIMIT = 6;
export const HISTORY_LIMIT = 20;
export const EVIDENCE_QUOTE_LIMIT = 160;
export const KEYFACT_TEXT_LIMIT = 60;
export const SUBTASK_TEXT_LIMIT = 40;
const BACKUP_KEEP = 10;

export const DEFAULT_SETTINGS = {
  autoScan: true,
  scanIntervalSeconds: 120,
  aiEnabled: true,
  model: "deepseek-flash",
  initialDays: 30,
  maxTasksPerSession: 3,
  excludeWorkspaces: [],
  lastScanAt: null,
  // v2 AI budget
  maxAiCallsPerScan: 40,
  dailyAiCallLimit: 150,
};

export function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function emptyUsage() {
  return {
    date: todayKey(),
    calls: 0,
    tokens: 0,
    lastScan: { calls: 0, tokens: 0, durationMs: 0, digestBytesAvg: 0 },
  };
}

/** Roll the daily counters over at midnight (UTC day boundary). */
export function rolloverUsage(usage, now = Date.now()) {
  const base = usage && typeof usage === "object" ? usage : emptyUsage();
  const date = todayKey(now);
  if (base.date !== date) {
    return {
      date,
      calls: 0,
      tokens: 0,
      lastScan: { calls: 0, tokens: 0, durationMs: 0, digestBytesAvg: 0 },
    };
  }
  return {
    date,
    calls: Math.max(0, Number(base.calls) || 0),
    tokens: Math.max(0, Number(base.tokens) || 0),
    lastScan: {
      calls: Math.max(0, Number(base.lastScan?.calls) || 0),
      tokens: Math.max(0, Number(base.lastScan?.tokens) || 0),
      durationMs: Math.max(0, Number(base.lastScan?.durationMs) || 0),
      digestBytesAvg: Math.max(0, Number(base.lastScan?.digestBytesAvg) || 0),
    },
  };
}

export function emptyScanState() {
  return {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    processed: 0,
    total: 0,
    newTasks: 0,
    updatedTasks: 0,
    aiCalls: 0,
    tokens: 0,
    message: "等待首次扫描",
    error: null,
  };
}

export function createEmptyState() {
  return {
    version: STORE_VERSION,
    savedAt: new Date().toISOString(),
    tasks: [],
    settings: { ...DEFAULT_SETTINGS },
    usage: emptyUsage(),
    ignoredSessions: [],
    suppressedSessions: [], // sessions whose auto task was deleted by the user
    deletedLog: [], // last N deleted task tombstones (traceability)
    workspaces: [],
    activity: [],
    scan: emptyScanState(),
  };
}

export function createEmptyCache() {
  return { version: STORE_VERSION, updatedAt: null, sessions: {} };
}

/** Stable auto-task id: seeded by the primary session so rescans keep the id. */
export function stableTaskId(seed, index = 0) {
  const digest = crypto.createHash("sha1").update(`${seed}#${index}`).digest("hex");
  return `t_${digest.slice(0, 8)}`;
}

let manualCounter = 0;
export function newManualTaskId(title) {
  manualCounter = (manualCounter + 1) % 1000;
  const digest = crypto.createHash("sha1").update(`manual:${Date.now()}:${manualCounter}:${title}`).digest("hex");
  return `t_${digest.slice(0, 8)}`;
}

export function shortId(prefix, seed) {
  const digest = crypto.createHash("sha1").update(String(seed)).digest("hex");
  return `${prefix}_${digest.slice(0, 8)}`;
}

export function pushHistory(task, entry, limit = HISTORY_LIMIT) {
  if (!task || !entry) return;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ at: new Date().toISOString(), by: "ai", ...entry });
  if (task.history.length > limit) task.history = task.history.slice(-limit);
}

function clipText(value, max) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Keep task payloads bounded before persisting/serving them (v2 caps). */
export function truncateTask(task) {
  if (!task) return task;
  if (Array.isArray(task.evidence)) {
    task.evidence = task.evidence.slice(0, EVIDENCE_LIMIT).map((item) => ({
      ...item,
      text: clipText(item?.text, 200),
      quote: clipText(item?.quote, EVIDENCE_QUOTE_LIMIT),
    }));
  } else {
    task.evidence = [];
  }
  if (Array.isArray(task.keyFacts)) {
    task.keyFacts = task.keyFacts.slice(0, KEYFACT_LIMIT).map((item) => ({ ...item, text: clipText(item?.text, KEYFACT_TEXT_LIMIT) }));
  } else {
    task.keyFacts = [];
  }
  if (Array.isArray(task.subtasks)) {
    task.subtasks = task.subtasks.slice(0, SUBTASK_LIMIT).map((item) => ({ ...item, text: clipText(item?.text, SUBTASK_TEXT_LIMIT) }));
  } else {
    task.subtasks = [];
  }
  if (Array.isArray(task.artifacts)) {
    task.artifacts = task.artifacts.slice(0, ARTIFACT_LIMIT).map((item) => ({ ...item, name: clipText(item?.name, 80) }));
  } else {
    task.artifacts = [];
  }
  if (Array.isArray(task.history) && task.history.length > HISTORY_LIMIT) {
    task.history = task.history.slice(-HISTORY_LIMIT);
  }
  if (!Array.isArray(task.lockedFields)) task.lockedFields = [];
  if (!Array.isArray(task.tags)) task.tags = [];
  else task.tags = task.tags.slice(0, 4);
  if (!Array.isArray(task.issues)) task.issues = [];
  else task.issues = task.issues.slice(0, 5);
  if (!Array.isArray(task.nextSteps)) task.nextSteps = [];
  else task.nextSteps = task.nextSteps.slice(0, 5);
  if (!Array.isArray(task.milestones)) task.milestones = [];
  else task.milestones = task.milestones.slice(0, 20);
  if (!Array.isArray(task.sessions)) task.sessions = [];
  if (typeof task.title === "string") task.title = clipText(task.title, 60);
  if (task.goal && typeof task.goal === "object") {
    task.goal.text = clipText(task.goal.text, 160);
    if (!["active", "done", "none"].includes(task.goal.status)) task.goal.status = task.goal.text ? "active" : "none";
    if (!["session", "task"].includes(task.goal.source)) task.goal.source = "task";
  } else {
    const text = typeof task.goal === "string" ? task.goal : "";
    task.goal = { text: clipText(text, 160), status: text ? "active" : "none", source: "task" };
  }
  if (!task.sessionContext || typeof task.sessionContext !== "object") task.sessionContext = null;
  return task;
}

/* ------------------------------------------------------------------ */
/* v1 → v2 migration                                                   */
/* ------------------------------------------------------------------ */

function migrateTaskV1V2(task) {
  if (!task || typeof task !== "object") return task;
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const firstSession = sessions[0] || null;
  const evidence = (Array.isArray(task.evidence) ? task.evidence : []).slice(0, EVIDENCE_LIMIT).map((item) => ({
    ...item,
    quote: clipText(item?.quote || item?.text, EVIDENCE_QUOTE_LIMIT),
  }));
  const keyFacts = evidence.slice(0, 3).map((item, index) => ({
    id: shortId("k", `mig:${task.id}:${index}`),
    text: clipText(item?.text || item?.quote, KEYFACT_TEXT_LIMIT),
    kind: item?.kind === "error" ? "issue" : item?.kind === "deliverable" || item?.kind === "artifact" ? "artifact" : "status",
    sessionId: item?.sessionId || firstSession?.id || null,
    seq: Number(item?.seq) || 0,
  }));
  const subtasks = (Array.isArray(task.milestones) ? task.milestones : []).slice(0, SUBTASK_LIMIT).map((milestone, index) => ({
    id: shortId("s", `mig:${task.id}:${index}`),
    text: clipText(milestone?.text, SUBTASK_TEXT_LIMIT),
    done: milestone?.done === true,
    source: "manual",
    seq: Number(milestone?.seq) || 0,
  }));
  const goalText = clipText(typeof task.goal === "string" ? task.goal : task.goal?.text || "", 160);
  return {
    ...task,
    title: clipText(task.title, 60),
    goal: {
      text: goalText,
      status: goalText ? (task.status === "done" ? "done" : "active") : "none",
      source: "task",
    },
    keyFacts,
    subtasks,
    artifacts: [],
    sessionContext: firstSession
      ? {
          sessionId: firstSession.id,
          title: firstSession.title || "",
          isLive: false,
          turnCount: 0,
          lastTurnEnd: null,
          lastActivityAt: Number(task.lastActivityAt) || 0,
          todoTotal: 0,
          todoDone: 0,
        }
      : null,
    evidence,
    history: (Array.isArray(task.history) ? task.history : []).slice(-HISTORY_LIMIT),
    lockedFields: Array.isArray(task.lockedFields) ? task.lockedFields : [],
  };
}

function migrateStateV1V2(raw) {
  const state = createEmptyState();
  state.tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((task) => truncateTask(migrateTaskV1V2(task)));
  if (raw.settings && typeof raw.settings === "object") {
    state.settings = { ...DEFAULT_SETTINGS, ...normalizeSettingsPatch(raw.settings), lastScanAt: raw.settings.lastScanAt || null };
  }
  if (Array.isArray(raw.ignoredSessions)) state.ignoredSessions = raw.ignoredSessions;
  if (Array.isArray(raw.suppressedSessions)) state.suppressedSessions = raw.suppressedSessions;
  if (Array.isArray(raw.deletedLog)) state.deletedLog = raw.deletedLog;
  if (Array.isArray(raw.workspaces)) state.workspaces = raw.workspaces;
  if (Array.isArray(raw.activity)) state.activity = raw.activity;
  if (raw.scan && typeof raw.scan === "object") state.scan = { ...emptyScanState(), ...raw.scan };
  state.usage = rolloverUsage(raw.usage);
  return state;
}

/** Coerce arbitrary settings patches into the contract shape + valid ranges. */
export function normalizeSettingsPatch(patch) {
  const result = {};
  if (!patch || typeof patch !== "object") return result;
  if (typeof patch.autoScan === "boolean") result.autoScan = patch.autoScan;
  if (Number.isFinite(Number(patch.scanIntervalSeconds))) {
    result.scanIntervalSeconds = Math.min(3600, Math.max(30, Math.round(Number(patch.scanIntervalSeconds))));
  }
  if (typeof patch.aiEnabled === "boolean") result.aiEnabled = patch.aiEnabled;
  if (typeof patch.model === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(patch.model.trim())) {
    result.model = patch.model.trim();
  }
  if (Number.isFinite(Number(patch.initialDays))) {
    result.initialDays = Math.min(365, Math.max(1, Math.round(Number(patch.initialDays))));
  }
  if (Number.isFinite(Number(patch.maxTasksPerSession))) {
    result.maxTasksPerSession = Math.min(10, Math.max(1, Math.round(Number(patch.maxTasksPerSession))));
  }
  if (Array.isArray(patch.excludeWorkspaces)) {
    result.excludeWorkspaces = [...new Set(patch.excludeWorkspaces.filter((id) => typeof id === "string"))].slice(0, 100);
  }
  if (Number.isFinite(Number(patch.maxAiCallsPerScan))) {
    result.maxAiCallsPerScan = Math.min(40, Math.max(5, Math.round(Number(patch.maxAiCallsPerScan))));
  }
  if (Number.isFinite(Number(patch.dailyAiCallLimit))) {
    result.dailyAiCallLimit = Math.min(500, Math.max(10, Math.round(Number(patch.dailyAiCallLimit))));
  }
  return result;
}

export function createStore({ dshHome, logger } = {}) {
  if (!dshHome) throw new Error("createStore requires dshHome");
  const dir = path.join(dshHome, "storages", "super-kanban");
  const backupsDir = path.join(dir, "backups");
  const stateFile = path.join(dir, "state.json");
  const cacheFile = path.join(dir, "sessions-cache.json");
  const log = logger || console;

  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  function backupCorrupt(file, error, label = "corrupt") {
    try {
      ensureDirs();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(backupsDir, `${path.basename(file)}.${stamp}.${label}`);
      fs.renameSync(file, target);
      log.warn?.(`[super-kanban] store file moved to ${target}: ${String(error?.message || error)}`);
      const backups = fs
        .readdirSync(backupsDir)
        .filter((name) => /\.(corrupt|v1)$/.test(name))
        .sort();
      for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
        try {
          fs.unlinkSync(path.join(backupsDir, name));
        } catch {
          /* ignore */
        }
      }
    } catch (backupError) {
      log.warn?.(`[super-kanban] could not back up ${file}: ${String(backupError?.message || backupError)}`);
    }
  }

  function copyToBackup(file, label = "v1") {
    try {
      ensureDirs();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(file, path.join(backupsDir, `${path.basename(file)}.${stamp}.${label}`));
      return true;
    } catch {
      return false;
    }
  }

  function readJson(file, fallback, { allowBackup = true } = {}) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error("not-an-object");
      return { data, error: null };
    } catch (error) {
      if (error?.code === "ENOENT") return { data: fallback, error: null, missing: true };
      if (allowBackup) backupCorrupt(file, error);
      return { data: fallback, error };
    }
  }

  /** Atomic write: JSON.stringify → tmp file → rename over the target. */
  function writeJson(file, data) {
    ensureDirs();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  function load() {
    const diagnostics = [];
    const stateRead = readJson(stateFile, null);
    if (stateRead.error) diagnostics.push({ kind: "state", message: String(stateRead.error.message || stateRead.error) });
    const cacheRead = readJson(cacheFile, null);
    if (cacheRead.error) diagnostics.push({ kind: "cache", message: String(cacheRead.error.message || cacheRead.error) });

    let state = createEmptyState();
    if (stateRead.data) {
      const version = Number(stateRead.data.version) || 1;
      try {
        if (version >= STORE_VERSION) {
          state = createEmptyState();
          copyFields(state, stateRead.data);
        } else {
          // Keep a pristine copy of the v1 document before rewriting it.
          copyToBackup(stateFile, "v1");
          state = migrateStateV1V2(stateRead.data);
          diagnostics.push({ kind: "migrate", message: `state v${version} → v${STORE_VERSION}（任务 ${state.tasks.length} 个）` });
        }
      } catch (error) {
        // Migration must never brick the board: back up and rebuild.
        backupCorrupt(stateFile, error, "migrate-failed");
        state = createEmptyState();
        diagnostics.push({ kind: "migrate", message: `迁移失败，已备份并重建：${String(error?.message || error)}` });
      }
      // A scan that was "running" when the process died can never finish.
      if (state.scan && state.scan.state === "running") {
        state.scan.state = "idle";
        state.scan.finishedAt = new Date().toISOString();
        state.scan.message = "上次扫描未完成（进程重启）";
      }
    }
    state.usage = rolloverUsage(state.usage);
    for (const task of state.tasks) truncateTask(task);

    const cache = createEmptyCache();
    if (cacheRead.data) {
      if (cacheRead.data.sessions && typeof cacheRead.data.sessions === "object") cache.sessions = cacheRead.data.sessions;
      if (typeof cacheRead.data.updatedAt === "string") cache.updatedAt = cacheRead.data.updatedAt;
      const cacheVersion = Number(cacheRead.data.version) || 1;
      if (cacheVersion < STORE_VERSION) {
        // v2 gate markers did not exist in v1: clear them so the first v2 scan
        // re-judges each session once (necessary to populate v2 fields).
        for (const entry of Object.values(cache.sessions)) {
          const meta = entry?.meta;
          if (!meta || typeof meta !== "object") continue;
          delete meta.aiAt;
          delete meta.aiLastSeq;
          delete meta.aiUserCount;
          delete meta.aiTurnEndKind;
          delete meta.aiDigestBytes;
          delete meta.llmError;
        }
        diagnostics.push({ kind: "migrate", message: `sessions-cache v${cacheVersion} → v${STORE_VERSION}（AI 门控标记已重置，首扫将重新研判）` });
      }
    }
    return { state, cache, diagnostics };
  }

  function copyFields(target, raw) {
    target.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    if (raw.settings && typeof raw.settings === "object") {
      target.settings = { ...DEFAULT_SETTINGS, ...normalizeSettingsPatch(raw.settings), lastScanAt: raw.settings.lastScanAt || null };
    }
    if (Array.isArray(raw.ignoredSessions)) target.ignoredSessions = raw.ignoredSessions;
    if (Array.isArray(raw.suppressedSessions)) target.suppressedSessions = raw.suppressedSessions;
    if (Array.isArray(raw.deletedLog)) target.deletedLog = raw.deletedLog;
    if (Array.isArray(raw.workspaces)) target.workspaces = raw.workspaces;
    if (Array.isArray(raw.activity)) target.activity = raw.activity;
    if (raw.scan && typeof raw.scan === "object") target.scan = { ...emptyScanState(), ...raw.scan };
    target.usage = rolloverUsage(raw.usage);
    for (const task of target.tasks) truncateTask(task);
  }

  function saveState(state) {
    state.version = STORE_VERSION;
    state.savedAt = new Date().toISOString();
    state.usage = rolloverUsage(state.usage);
    for (const task of state.tasks) truncateTask(task);
    // Tombstones and ignored lists stay bounded.
    if (state.deletedLog.length > 50) state.deletedLog = state.deletedLog.slice(-50);
    if (state.ignoredSessions.length > 500) state.ignoredSessions = state.ignoredSessions.slice(-500);
    if (state.suppressedSessions.length > 500) state.suppressedSessions = state.suppressedSessions.slice(-500);
    writeJson(stateFile, state);
  }

  function saveCache(cache) {
    cache.version = STORE_VERSION;
    cache.updatedAt = new Date().toISOString();
    writeJson(cacheFile, cache);
  }

  return {
    dir,
    stateFile,
    cacheFile,
    backupsDir,
    load,
    saveState,
    saveCache,
    ensureDirs,
    backupCorrupt,
  };
}
