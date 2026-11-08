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

/**
 * Persisted text limits — the single source of truth for host-side truncation.
 *
 * `task.create`, `task.update` and `truncateTask` (used on load and save) all
 * read these constants, so a value can never be clipped differently depending
 * on which code path wrote it. The board UI must use the same maxima:
 *   title ≤80, goal ≤280, tags ≤4×12, subtasks ≤12×60,
 *   issues ≤5×160, nextSteps ≤5×160, milestones ≤20×120,
 *   keyFacts ≤6×60, evidence ≤8 (text ≤200, quote ≤160), artifact name ≤80.
 */
export const TITLE_TEXT_LIMIT = 80;
export const GOAL_TEXT_LIMIT = 280;
export const TAG_LIMIT = 4;
export const TAG_TEXT_LIMIT = 12;
export const SUBTASK_TEXT_LIMIT = 60;
export const ISSUE_LIMIT = 5;
export const ISSUE_TEXT_LIMIT = 160;
export const NEXTSTEP_LIMIT = 5;
export const NEXTSTEP_TEXT_LIMIT = 160;
export const MILESTONE_LIMIT = 20;
export const MILESTONE_TEXT_LIMIT = 120;
export const ARTIFACT_NAME_LIMIT = 80;
export const EVIDENCE_TEXT_LIMIT = 200;

/** Frozen snapshot of the persisted maxima (exported for docs/client parity). */
export const TEXT_LIMITS = Object.freeze({
  title: TITLE_TEXT_LIMIT,
  goal: GOAL_TEXT_LIMIT,
  tags: TAG_LIMIT,
  tagText: TAG_TEXT_LIMIT,
  subtasks: SUBTASK_LIMIT,
  subtaskText: SUBTASK_TEXT_LIMIT,
  issues: ISSUE_LIMIT,
  issueText: ISSUE_TEXT_LIMIT,
  nextSteps: NEXTSTEP_LIMIT,
  nextStepText: NEXTSTEP_TEXT_LIMIT,
  milestones: MILESTONE_LIMIT,
  milestoneText: MILESTONE_TEXT_LIMIT,
  keyFacts: KEYFACT_LIMIT,
  keyFactText: KEYFACT_TEXT_LIMIT,
  evidence: EVIDENCE_LIMIT,
  evidenceText: EVIDENCE_TEXT_LIMIT,
  evidenceQuote: EVIDENCE_QUOTE_LIMIT,
  artifactName: ARTIFACT_NAME_LIMIT,
});

const BACKUP_KEEP = 10;

/**
 * v3 AI model selection. Provider ids come from the DSH model catalog and model
 * ids may contain real-world characters (`alibaba/qwen-3-14b`,
 * `amazon.nova-2-lite-v1:0`), so the charsets are permissive; the empty string
 * means "follow the DSH default model".
 */
const AI_PROVIDER_RE = /^[A-Za-z0-9._:-]{0,100}$/;
const AI_MODEL_RE = /^[A-Za-z0-9._:/@-]{0,200}$/;

/** v3: fixed per-scan AI budget bounds (`maxAiCallsPerScan`; auto is daily-bounded). */
export const AI_CALLS_PER_SCAN_MIN = 5;
export const AI_CALLS_PER_SCAN_MAX = 150;

/**
 * A model route is either fully explicit (provider + model) or "follow the DSH
 * default" (both empty). Half-set input is normalized to "follow default" so
 * the board never carries a mixed state that cannot be resolved.
 *
 * @param {object} settings mutated in place.
 * @returns {object} the same settings object.
 */
export function normalizeAiRoutePair(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const provider = typeof settings.aiProvider === "string" ? settings.aiProvider.trim() : "";
  const model = typeof settings.aiModel === "string" ? settings.aiModel.trim() : "";
  if (Boolean(provider) !== Boolean(model)) {
    settings.aiProvider = "";
    settings.aiModel = "";
  } else {
    settings.aiProvider = provider;
    settings.aiModel = model;
  }
  return settings;
}

export const DEFAULT_SETTINGS = {
  autoScan: true,
  scanIntervalSeconds: 120,
  aiEnabled: true,
  /**
   * @deprecated v0.5 — the model is resolved from the DSH native LLM service
   * (`settings.aiProvider/aiModel` or the DSH default). Kept only so old states
   * and third-party clients keep loading; it is normalized but never used for
   * analysis. Slated for removal in v0.6.
   */
  model: "deepseek-flash",
  initialDays: 30,
  maxTasksPerSession: 3,
  excludeWorkspaces: [],
  lastScanAt: null,
  // v2 AI budget
  maxAiCallsPerScan: 40,
  dailyAiCallLimit: 150,
  // v3 model selection: "" = follow the DSH default model; set together.
  aiProvider: "",
  aiModel: "",
  /** "auto" = min(due sessions, daily remaining); "fixed" = maxAiCallsPerScan. */
  aiBudgetMode: "auto",
};

/**
 * The user's local calendar day as `YYYY-MM-DD`.
 * The AI daily budget and the "今日" counters must follow the user's day, not
 * the UTC day (they disagree near midnight for every non-UTC timezone).
 */
export function todayKey(now = Date.now()) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptyUsage() {
  return {
    date: todayKey(),
    calls: 0,
    tokens: 0,
    lastScan: { calls: 0, tokens: 0, durationMs: 0, digestBytesAvg: 0 },
  };
}

/** Roll the daily counters over at the user's local midnight. */
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
    // v3 additive observability fields (old clients ignore them).
    aiDue: 0,
    aiBudget: 0,
    aiAttempts: 0,
    aiPending: 0,
    aiDeferredReason: null, // null | "budget" | "time" | "daily"
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

/** Positive integer sequence number, or null when absent/invalid (never 0). */
export function positiveSeqOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/** Sanitize one issue entry (objects from the analyzer, strings via the API). */
export function normalizeIssueRecord(item) {
  if (typeof item === "string") {
    const text = clipText(item, ISSUE_TEXT_LIMIT);
    return text ? { text, severity: "medium", sessionId: null, seq: null } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const text = clipText(typeof item.text === "string" ? item.text : "", ISSUE_TEXT_LIMIT);
  if (!text) return null;
  const record = {
    text,
    severity: ["high", "medium", "low"].includes(item.severity) ? item.severity : "medium",
    sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
    seq: positiveSeqOrNull(item.seq),
  };
  if (typeof item.id === "string" && item.id) record.id = item.id;
  return record;
}

/** Sanitize one milestone entry (v1 field still surfaced by the client). */
export function normalizeMilestoneRecord(item) {
  if (typeof item === "string") {
    const text = clipText(item, MILESTONE_TEXT_LIMIT);
    return text ? { text, done: false, sessionId: null, seq: null } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const text = clipText(typeof item.text === "string" ? item.text : "", MILESTONE_TEXT_LIMIT);
  if (!text) return null;
  const record = {
    text,
    done: item.done === true,
    sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
    seq: positiveSeqOrNull(item.seq),
  };
  if (typeof item.id === "string" && item.id) record.id = item.id;
  return record;
}

/** Keep task payloads bounded before persisting/serving them (v2 caps). */
export function truncateTask(task) {
  if (!task) return task;
  if (Array.isArray(task.evidence)) {
    task.evidence = task.evidence
      .filter((item) => item && typeof item === "object")
      .slice(0, EVIDENCE_LIMIT)
      .map((item) => ({
        ...item,
        text: clipText(item.text, EVIDENCE_TEXT_LIMIT),
        quote: clipText(item.quote, EVIDENCE_QUOTE_LIMIT),
      }));
  } else {
    task.evidence = [];
  }
  if (Array.isArray(task.keyFacts)) {
    task.keyFacts = task.keyFacts
      .filter((item) => item && typeof item === "object")
      .slice(0, KEYFACT_LIMIT)
      .map((item) => ({ ...item, text: clipText(item.text, KEYFACT_TEXT_LIMIT) }));
  } else {
    task.keyFacts = [];
  }
  if (Array.isArray(task.subtasks)) {
    task.subtasks = task.subtasks
      .filter((item) => item && typeof item === "object")
      .slice(0, SUBTASK_LIMIT)
      .map((item) => ({ ...item, text: clipText(item.text, SUBTASK_TEXT_LIMIT) }));
  } else {
    task.subtasks = [];
  }
  if (Array.isArray(task.artifacts)) {
    task.artifacts = task.artifacts
      .filter((item) => item && typeof item === "object")
      .slice(0, ARTIFACT_LIMIT)
      .map((item) => ({ ...item, name: clipText(item.name, ARTIFACT_NAME_LIMIT) }));
  } else {
    task.artifacts = [];
  }
  if (Array.isArray(task.history) && task.history.length > HISTORY_LIMIT) {
    task.history = task.history.slice(-HISTORY_LIMIT);
  }
  if (!Array.isArray(task.lockedFields)) task.lockedFields = [];
  if (Array.isArray(task.tags)) {
    task.tags = task.tags
      .filter((tag) => typeof tag === "string")
      .slice(0, TAG_LIMIT)
      .map((tag) => clipText(tag, TAG_TEXT_LIMIT));
  } else {
    task.tags = [];
  }
  if (Array.isArray(task.issues)) {
    // Filter invalid entries before applying the cap, so junk cannot push real
    // entries out of the persisted list.
    task.issues = task.issues.map(normalizeIssueRecord).filter(Boolean).slice(0, ISSUE_LIMIT);
  } else {
    task.issues = [];
  }
  if (Array.isArray(task.nextSteps)) {
    task.nextSteps = task.nextSteps
      .map((step) => clipText(typeof step === "string" ? step : step?.text, NEXTSTEP_TEXT_LIMIT))
      .filter(Boolean)
      .slice(0, NEXTSTEP_LIMIT);
  } else {
    task.nextSteps = [];
  }
  if (Array.isArray(task.milestones)) {
    task.milestones = task.milestones.map(normalizeMilestoneRecord).filter(Boolean).slice(0, MILESTONE_LIMIT);
  } else {
    task.milestones = [];
  }
  if (!Array.isArray(task.sessions)) task.sessions = [];
  if (typeof task.title === "string") task.title = clipText(task.title, TITLE_TEXT_LIMIT);
  if (task.goal && typeof task.goal === "object") {
    task.goal.text = clipText(task.goal.text, GOAL_TEXT_LIMIT);
    if (!["active", "done", "none"].includes(task.goal.status)) task.goal.status = task.goal.text ? "active" : "none";
    if (!["session", "task"].includes(task.goal.source)) task.goal.source = "task";
  } else {
    const text = typeof task.goal === "string" ? task.goal : "";
    task.goal = { text: clipText(text, GOAL_TEXT_LIMIT), status: text ? "active" : "none", source: "task" };
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
  const goalText = clipText(typeof task.goal === "string" ? task.goal : task.goal?.text || "", GOAL_TEXT_LIMIT);
  return {
    ...task,
    title: clipText(task.title, TITLE_TEXT_LIMIT),
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

/** True for JSON objects (arrays/null excluded). */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Task records from untrusted JSON; non-objects are dropped, not crashed on. */
function taskList(value) {
  return (Array.isArray(value) ? value : []).filter(isRecord);
}

/** String list from untrusted JSON (ids are opaque strings). */
function stringList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === "string");
}

function migrateStateV1V2(raw) {
  const state = createEmptyState();
  state.tasks = taskList(raw.tasks).map((task) => truncateTask(migrateTaskV1V2(task)));
  if (isRecord(raw.settings)) {
    state.settings = normalizeAiRoutePair({
      ...DEFAULT_SETTINGS,
      ...normalizeSettingsPatch(raw.settings),
      lastScanAt: raw.settings.lastScanAt || null,
    });
  }
  if (Array.isArray(raw.ignoredSessions)) state.ignoredSessions = stringList(raw.ignoredSessions);
  if (Array.isArray(raw.suppressedSessions)) state.suppressedSessions = stringList(raw.suppressedSessions);
  if (Array.isArray(raw.deletedLog)) state.deletedLog = raw.deletedLog.filter(isRecord);
  if (Array.isArray(raw.workspaces)) state.workspaces = raw.workspaces.filter(isRecord);
  if (Array.isArray(raw.activity)) state.activity = raw.activity.filter(isRecord);
  if (isRecord(raw.scan)) state.scan = { ...emptyScanState(), ...raw.scan };
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
    result.maxAiCallsPerScan = Math.min(
      AI_CALLS_PER_SCAN_MAX,
      Math.max(AI_CALLS_PER_SCAN_MIN, Math.round(Number(patch.maxAiCallsPerScan))),
    );
  }
  if (typeof patch.aiProvider === "string") {
    const value = patch.aiProvider.trim();
    if (AI_PROVIDER_RE.test(value)) result.aiProvider = value;
  }
  if (typeof patch.aiModel === "string") {
    const value = patch.aiModel.trim();
    if (AI_MODEL_RE.test(value)) result.aiModel = value;
  }
  if (patch.aiBudgetMode === "auto" || patch.aiBudgetMode === "fixed") {
    result.aiBudgetMode = patch.aiBudgetMode;
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
        .filter((name) => /\.(corrupt|v1|migrate-failed)$/.test(name))
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
      if (isRecord(cacheRead.data.sessions)) {
        for (const [id, entry] of Object.entries(cacheRead.data.sessions)) {
          // Only entries the scanner can actually consume: a corrupt cache must
          // degrade to "scan this session again", never crash the scan.
          if (isRecord(entry) && isRecord(entry.meta)) cache.sessions[id] = entry;
        }
      }
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
    // Hand-edited/partially corrupted JSON must never crash the board later:
    // keep only records with the shape the rest of the service assumes.
    target.tasks = taskList(raw.tasks);
    if (isRecord(raw.settings)) {
      target.settings = normalizeAiRoutePair({
        ...DEFAULT_SETTINGS,
        ...normalizeSettingsPatch(raw.settings),
        lastScanAt: raw.settings.lastScanAt || null,
      });
    }
    if (Array.isArray(raw.ignoredSessions)) target.ignoredSessions = stringList(raw.ignoredSessions);
    if (Array.isArray(raw.suppressedSessions)) target.suppressedSessions = stringList(raw.suppressedSessions);
    if (Array.isArray(raw.deletedLog)) target.deletedLog = raw.deletedLog.filter(isRecord);
    if (Array.isArray(raw.workspaces)) target.workspaces = raw.workspaces.filter(isRecord);
    if (Array.isArray(raw.activity)) target.activity = raw.activity.filter(isRecord);
    if (isRecord(raw.scan)) target.scan = { ...emptyScanState(), ...raw.scan };
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
