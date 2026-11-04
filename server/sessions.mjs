/**
 * Super Kanban — session source.
 *
 * Discovers DSH sessions on disk, decompresses their append-only zstd event log,
 * parses events into a compact structured form, and exposes three derived views:
 *
 *   - `buildDigest()`    compact text for the LLM analyzer (bounded size)
 *   - `collectEvidence()` traceable evidence candidates for rules analysis
 *   - `readApiEvents()`  event timeline served by GET /session/:id
 *
 * Layout (read-only):
 *   $DSH_HOME/storages/workspace.json                                   workspace registry
 *   $DSH_HOME/sessions/<escaped-path>/<session-id>/session.v4.jsonl.zstd
 *   $DSH_HOME/storages/session_projcache/sessions/<session-id>.json    title/turn cache
 *
 * The session log is NOT a single zstd frame: DSH appends one frame per write,
 * so a file is a concatenation of many frames. Node's zstdDecompressSync only
 * returns the first frame, hence the segment walk in `decompressSessionBuffer`.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const SESSION_FILE_NAME = "session.v4.jsonl.zstd";
const PROJCACHE_DIR = ["storages", "session_projcache", "sessions"];
/** Injected user-role events that are useful context but not human requests. */
const ASYNC_SIGNAL_KINDS = new Set(["agent-message", "subagent-settled", "tool-jobs", "model-selection"]);

/* ------------------------------------------------------------------ */
/* Low level: zstd + JSONL                                             */
/* ------------------------------------------------------------------ */

/**
 * Decompress an append-only DSH session buffer.
 * Returns "" for an empty buffer; throws only when nothing could be decoded.
 */
export function decompressSessionBuffer(buf) {
  if (!buf || buf.length === 0) return "";
  const starts = [];
  let cursor = 0;
  while ((cursor = buf.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    starts.push(cursor);
    cursor += ZSTD_MAGIC.length;
  }
  if (starts.length === 0) {
    // Future/uncompressed logs: a plain JSONL file starts with '{'.
    const head = buf.subarray(0, 32).toString("utf8").trimStart();
    if (head.startsWith("{")) return buf.toString("utf8");
    return zlib.zstdDecompressSync(buf).toString("utf8");
  }

  const outputs = [];
  let lastError = null;
  let i = 0;
  while (i < starts.length) {
    const start = starts[i];
    let out = null;
    let next = i + 1;
    let end = next < starts.length ? starts[next] : buf.length;
    // A magic sequence may also occur inside compressed payload: if a segment
    // fails, widen it across the next boundary and retry (bounded attempts).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        out = zlib.zstdDecompressSync(buf.subarray(start, end));
        break;
      } catch (error) {
        lastError = error;
      }
      if (next >= starts.length) break;
      next += 1;
      end = next < starts.length ? starts[next] : buf.length;
    }
    if (out) {
      outputs.push(out);
      i = next;
    } else {
      i += 1;
    }
  }
  if (outputs.length === 0) {
    // Empty/corrupt file: fall back to the first-frame-only decoder.
    try {
      return zlib.zstdDecompressSync(buf).toString("utf8");
    } catch {
      throw lastError || new Error("zstd-decompress-failed");
    }
  }
  return Buffer.concat(outputs).toString("utf8");
}

/** Parse JSONL text into events; malformed lines are counted, not fatal. */
export function parseJsonlEvents(text) {
  const events = [];
  let badLines = 0;
  if (!text) return { events, badLines };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || typeof event.type !== "string") {
        badLines += 1;
        continue;
      }
      if (typeof event.seq !== "number") event.seq = index;
      if (typeof event.time !== "number") event.time = 0;
      events.push(event);
    } catch {
      badLines += 1;
    }
  }
  // Events may be appended out of order by concurrent writers; sort defensively
  // only when the log is not already monotonic (cheap for sorted data).
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq < events[i - 1].seq) {
      events.sort((a, b) => a.seq - b.seq || a.time - b.time);
      break;
    }
  }
  return { events, badLines };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function clip(text, max) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function shortHash(value, length = 10) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

export function isoDay(time) {
  if (!time) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Titles that merely echo a filesystem path (or are truncated mid-path) are
 * useless on a board; derive something readable from the first user message.
 */
function readableTitle(raw, fallbackText) {
  let title = typeof raw === "string" ? raw.trim() : "";
  const looksLikePath = !title || title.startsWith("/") || title.startsWith("~") || /^[A-Za-z]:[\\/]/.test(title);
  if (looksLikePath) title = "";
  if (!title) {
    const firstLine = String(fallbackText || "").split("\n").find((line) => line.trim()) || "";
    // Drop a leading @path / absolute path token and its punctuation.
    title = firstLine.replace(/^\s*@?["']?(?:\/|~\/)[^\s，,。;；:：]+["']?\s*[，,。;；:：\-—]?\s*/, "");
  }
  title = title.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
  return clip(title, 48);
}

/** Last path segment, used for unregistered workspaces (directory deleted). */
function basenameOf(p) {
  const normalized = String(p || "").replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

/* ------------------------------------------------------------------ */
/* Session source                                                      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} SessionMeta
 * @property {string} id
 * @property {string} file
 * @property {string} dir
 * @property {{size:number, mtimeMs:number}} sig
 * @property {string} sigKey   `${size}:${mtimeMs}`
 * @property {string} title
 * @property {number} createdAt
 * @property {string} cwd
 * @property {string|null} parentSession
 * @property {number} delegationDepth
 * @property {"main"|"subagent"} origin
 * @property {number} lastActivityAt
 * @property {number} eventCount
 * @property {number} turnCount
 * @property {boolean} isLive
 * @property {string|null} workspaceId
 * @property {string|null} workspaceTitle
 * @property {string|null} workspacePath
 * @property {{badLines:number, error?:string}} diagnostics
 */


/* ------------------------------------------------------------------ */
/* Deterministic extraction (v2 — no LLM tokens)                       */
/* ------------------------------------------------------------------ */

export const LOCAL_SUBTASK_LIMIT = 12;
export const LOCAL_ARTIFACT_LIMIT = 6;
const DIGEST_MAX_BYTES = 1500;

function parseToolArgs(call) {
  try {
    const args = JSON.parse(call.args || "{}");
    return args && typeof args === "object" ? args : {};
  } catch {
    return {};
  }
}

function resolveArtifactPath(rawPath, workspaceRoot, fallbackRoot) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 400) return null;
  const root = workspaceRoot || fallbackRoot || null;
  try {
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
    return root ? path.resolve(root, trimmed) : null;
  } catch {
    return null;
  }
}

/**
 * Artifacts = deliverable files + write/edit tool targets (deduped).
 * Relative to the workspace when possible; deterministic, zero tokens.
 */
export function extractArtifacts(parsed, { workspacePath = null, max = LOCAL_ARTIFACT_LIMIT } = {}) {
  const workspaceRoot = workspacePath
    ? path.resolve(workspacePath)
    : parsed?.session?.cwd
      ? path.resolve(parsed.session.cwd)
      : null;
  const candidates = [];
  for (const item of parsed.deliverables || []) {
    for (const file of item.files || []) {
      const absPath = resolveArtifactPath(file.path, workspaceRoot, parsed.session?.cwd);
      if (!absPath) continue;
      candidates.push({ absPath, seq: item.seq, time: item.time, description: file.description || "", priority: 0 });
    }
  }
  for (const call of parsed.toolCalls || []) {
    if (call.name !== "write" && call.name !== "edit") continue;
    const args = parseToolArgs(call);
    const absPath = resolveArtifactPath(
      args.path || args.file_path || args.filePath || args.file,
      workspaceRoot,
      parsed.session?.cwd,
    );
    if (!absPath) continue;
    candidates.push({ absPath, seq: call.seq, time: call.time, description: "", priority: 1 });
  }
  candidates.sort((left, right) => left.priority - right.priority || left.seq - right.seq);
  const seen = new Set();
  const chosen = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.absPath)) continue;
    // Only advertise artifacts that still exist on disk (DSH preview must open).
    try {
      if (!fs.existsSync(candidate.absPath)) continue;
    } catch {
      continue;
    }
    seen.add(candidate.absPath);
    chosen.push(candidate);
    if (chosen.length >= max) break;
  }
  return chosen.map((candidate) => ({
    id: `a_${shortHash(`${parsed.id}:${candidate.absPath}`)}`,
    name: path.basename(candidate.absPath),
    path:
      workspaceRoot && candidate.absPath.startsWith(workspaceRoot + path.sep)
        ? path.relative(workspaceRoot, candidate.absPath)
        : candidate.absPath,
    absPath: candidate.absPath,
    sessionId: parsed.id,
    seq: candidate.seq,
    time: candidate.time,
    description: clip(candidate.description, 120),
  }));
}

/**
 * Latest todo snapshot → subtasks. A snapshot written before the current turn
 * started is stale (the plan often changes); import it only when fully done.
 * `forceAll` powers the manual task.importTodos op.
 */
export function extractSubtasks(parsed, { max = LOCAL_SUBTASK_LIMIT, forceAll = false } = {}) {
  const last = parsed.todoSnapshots?.[parsed.todoSnapshots.length - 1];
  if (!last) return [];
  const lastTurnStartSeq = parsed.turnStarts?.[parsed.turnStarts.length - 1]?.seq ?? 0;
  const fresh = last.seq > lastTurnStartSeq;
  const allDone = last.todos.every((todo) => todo.status === "completed");
  if (!forceAll && !fresh && !allDone) return [];
  return last.todos.slice(0, max).map((todo, index) => ({
    id: `s_${shortHash(`${parsed.id}:todo:${last.seq}:${index}`)}`,
    text: clip(todo.content, 40),
    done: todo.status === "completed",
    source: "todo",
    seq: last.seq,
  }));
}

export function latestTodos(parsed) {
  const last = parsed.todoSnapshots?.[parsed.todoSnapshots.length - 1];
  const todos = last ? last.todos.map((todo) => ({ content: clip(todo.content, 80), status: todo.status })) : [];
  return { todos, todoTotal: todos.length, todoDone: todos.filter((todo) => todo.status === "completed").length };
}

/** Files written/edited + tool names since `baselineSeq` (digest tool summary). */
export function toolBrief(parsed, { baselineSeq = 0, workspacePath = null } = {}) {
  const workspaceRoot = workspacePath
    ? path.resolve(workspacePath)
    : parsed?.session?.cwd
      ? path.resolve(parsed.session.cwd)
      : null;
  const files = [];
  const seen = new Set();
  for (const call of parsed.toolCalls || []) {
    if (call.seq <= baselineSeq) continue;
    if (call.name !== "write" && call.name !== "edit") continue;
    const args = parseToolArgs(call);
    const absPath = resolveArtifactPath(
      args.path || args.file_path || args.filePath || args.file,
      workspaceRoot,
      parsed.session?.cwd,
    );
    if (!absPath) continue;
    const relative =
      workspaceRoot && absPath.startsWith(workspaceRoot + path.sep) ? path.relative(workspaceRoot, absPath) : absPath;
    if (seen.has(relative)) continue;
    seen.add(relative);
    files.push(clip(relative, 80));
    if (files.length >= 8) break;
  }
  const names = [];
  for (const call of parsed.toolCalls || []) {
    if (call.seq <= baselineSeq) continue;
    if (!names.includes(call.name)) names.push(call.name);
    if (names.length >= 8) break;
  }
  return { files, commandNames: names.slice(0, 5) };
}

/** Trim a digest to a UTF-8 byte budget, keeping the head (higher priority). */
function fitDigest(sections, maxBytes) {
  let text = sections.filter(Boolean).join("\n");
  while (Buffer.byteLength(text, "utf8") > maxBytes && text.length > 0) {
    const excess = Buffer.byteLength(text, "utf8") - maxBytes;
    const trimChars = Math.max(1, Math.ceil(excess / 2));
    text = text.slice(0, Math.max(0, text.length - trimChars));
  }
  return text;
}

/**
 * Compact v2 digest (≤1.5KB UTF-8 ≈ 500-700 tokens). Only recent changes:
 * users/assistant tail, latest todos, tool/error summary since `baselineSeq`,
 * plus the bound task summary for mergeWith decisions.
 */
export function buildDigest(
  parsed,
  { workspaceTitle = null, existingTasks = [], baselineSeq = 0, maxBytes = DIGEST_MAX_BYTES } = {},
) {
  const byteLen = (value) => Buffer.byteLength(value, "utf8");
  const pieces = [];
  const budget = maxBytes;
  let used = 0;
  /** Append a line if it fits (clipped to the remaining room when close). */
  const add = (label, value, maxItemChars = 240) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    const line = label ? `${label}${clip(text, maxItemChars)}` : clip(text, maxItemChars);
    const size = byteLen(line) + 1;
    if (used + size <= budget) {
      pieces.push(line);
      used += size;
      return true;
    }
    const room = budget - used - 1;
    if (room > 120) {
      // Clip by characters (UTF-8 CJK ≈3 bytes) until it fits.
      let cut = Math.floor(room / 3);
      let candidate = `${label}${text.slice(0, Math.max(20, cut))}…`;
      while (byteLen(candidate) > room && cut > 20) {
        cut -= 10;
        candidate = `${label}${text.slice(0, cut)}…`;
      }
      if (byteLen(candidate) <= room) {
        pieces.push(candidate);
        used += byteLen(candidate) + 1;
        return true;
      }
    }
    return false;
  };

  const endKind = parsed.lastTurnEnd?.kind || "none";
  const goal = parsed.goal?.text ? ` | 目标:${clip(parsed.goal.text, 60)}` : "";
  add(
    "",
    `会话:${clip(parsed.title, 36)} | 工作区:${workspaceTitle || "?"} | live:${parsed.isLive ? 1 : 0} | turns:${parsed.turnCount} | end:${endKind}${goal}`,
    260,
  );
  const bound = (Array.isArray(existingTasks) ? existingTasks : [])
    .slice(0, 3)
    .map((task) => `${task.id}「${clip(task.title, 24)}」${task.status}`);
  if (bound.length) add("已有任务:", bound.join("；"), 160);

  // Recent-change priority: latest user instruction, latest assistant summary,
  // then todos/errors/tools, then older context.
  const latestUser = [...(parsed.users || [])].reverse().find((message) => message.seq > baselineSeq) || parsed.users?.at(-1);
  if (latestUser) add(`U[${latestUser.seq}] `, latestUser.text, 200);
  const latestAssistant = parsed.assistants?.at(-1);
  if (latestAssistant) add(`A[${latestAssistant.seq}] `, latestAssistant.text, 200);

  const lastTodo = parsed.todoSnapshots?.[parsed.todoSnapshots.length - 1];
  if (lastTodo) {
    const mark = (status) => (status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]");
    add(
      "待办:",
      lastTodo.todos
        .slice(0, 6)
        .map((todo) => `${mark(todo.status)}${clip(todo.content, 24)}`)
        .join(" "),
      300,
    );
  }
  const errors = (parsed.errors || []).filter((error) => error.seq > baselineSeq).slice(-2);
  if (errors.length) add("错误:", errors.map((error) => `[${error.seq}] ${clip(error.text.replace(/\s+/g, " "), 90)}`).join(" "), 260);
  const brief = toolBrief(parsed, { baselineSeq, workspacePath: parsed.session?.cwd });
  const toolParts = [];
  if (brief.files.length) toolParts.push(`写入:${brief.files.slice(0, 5).join(",")}`);
  if (brief.commandNames.length) toolParts.push(`工具:${brief.commandNames.join(",")}`);
  if (toolParts.length) add("", toolParts.join(" | "), 220);

  // Fill remaining room with older context (never sacrifices the sections above).
  const olderUser = [...(parsed.users || [])].reverse().find((message) => message !== latestUser);
  if (olderUser) add(`U[${olderUser.seq}] `, olderUser.text, 120);
  const previousAssistant = parsed.assistants?.length > 1 ? parsed.assistants[parsed.assistants.length - 2] : null;
  if (previousAssistant && previousAssistant !== latestAssistant) add(`A[${previousAssistant.seq}] `, previousAssistant.text, 120);

  return pieces.join("\n");
}

export function createSessionSource({ dshHome } = {}) {
  if (!dshHome) throw new Error("createSessionSource requires dshHome");
  const home = dshHome;
  const sessionsRoot = path.join(home, "sessions");

  function readWorkspaceRegistry() {
    const file = path.join(home, "storages", "workspace.json");
    const diagnostics = [];
    let registry = { workspaces: [], sessionWorkspace: new Map() };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const table = raw?.tables?.workspaces || {};
      const order = Array.isArray(raw?.global?.workspaceIds) ? raw.global.workspaceIds : Object.keys(table);
      const workspaces = [];
      const sessionWorkspace = new Map();
      for (const id of order) {
        const entry = table[id];
        if (!entry || !entry.path) continue;
        const workspace = {
          id,
          title: entry.title || basenameOf(entry.path),
          path: entry.path,
          sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds : [],
          createdAt: Date.parse(entry.createdAt || "") || 0,
          updatedAt: Date.parse(entry.updatedAt || "") || 0,
          source: "registry",
        };
        workspaces.push(workspace);
        for (const sessionId of workspace.sessionIds) sessionWorkspace.set(sessionId, workspace);
      }
      registry = { workspaces, sessionWorkspace };
    } catch (error) {
      diagnostics.push({
        kind: "workspace-registry",
        message: error?.code === "ENOENT" ? "workspace.json not found" : String(error?.message || error),
      });
    }
    return { ...registry, diagnostics };
  }

  /**
   * DSH Session Goal lives in projcache `rows.goal.val.current` and may be
   * null. Accept string or {objective|description|text, status} shapes.
   */
  function parseProjcacheGoal(rows) {
    const current = rows?.goal?.val?.current;
    if (!current) return { text: null, status: null };
    const text =
      typeof current === "string"
        ? current
        : current.objective || current.description || current.text || current.goal || current.summary || "";
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) return { text: null, status: null };
    const rawStatus = current.status || current.state;
    const done = rawStatus === "done" || rawStatus === "completed" || current.done === true;
    return { text: clean, status: done ? "done" : "active" };
  }

  function readProjcache(sessionId) {
    const file = path.join(home, ...PROJCACHE_DIR, `${sessionId}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const record = raw?.record || {};
      const rows = record.rows || {};
      const catalogValues = rows.subagentCatalog?.val?.head?.values;
      const teamMembers = rows.agentTeam?.val?.members;
      const children = new Set();
      if (Array.isArray(catalogValues)) {
        for (const child of catalogValues) if (child?.childId) children.add(String(child.childId));
      }
      if (Array.isArray(teamMembers)) {
        for (const member of teamMembers) if (member?.id) children.add(String(member.id));
      }
      return {
        title: typeof rows.title?.val === "string" ? rows.title.val : null,
        createdAt: Number(record.identity?.createdAt) || 0,
        cwd: typeof record.identity?.cwd === "string" ? record.identity.cwd : rows.workingDirectory?.val || null,
        turns: Number(rows.sessionStats?.val?.turns) || 0,
        turnOutline: Array.isArray(rows.turnOutline?.val?.turns) ? rows.turnOutline.val.turns : [],
        blank: rows.sessionListMetadata?.val?.blank === true,
        lastPromptAt: Number(rows.sessionListMetadata?.val?.lastPromptAt) || 0,
        lastMessageTime: Number(rows.timeContext?.val?.lastMessageTime) || 0,
        children: [...children],
        goal: parseProjcacheGoal(rows),
      };
    } catch {
      return null;
    }
  }

  /**
   * Walk $DSH_HOME/sessions. Cheap: only stats files and reads small projcache
   * JSON blobs — no zstd work here (that happens lazily in loadParsed).
   */
  function discover() {
    const registry = readWorkspaceRegistry();
    const diagnostics = [...registry.diagnostics];
    const discovered = [];
    let sessionDirs = [];
    try {
      sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (error) {
      diagnostics.push({
        kind: "sessions-root",
        message: error?.code === "ENOENT" ? "sessions directory not found" : String(error?.message || error),
      });
      return { workspaces: registry.workspaces.map((w) => ({ ...w })), sessions: [], diagnostics };
    }

    const projcache = new Map();
    for (const dirEntry of sessionDirs) {
      const dir = path.join(sessionsRoot, dirEntry.name);
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch {
        continue;
      }
      for (const entry of names) {
        const sessionDir = path.join(dir, entry.name);
        const file = path.join(sessionDir, SESSION_FILE_NAME);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue; // dir without a log (e.g. lock-only) — not a session
        }
        const cache = readProjcache(entry.name);
        projcache.set(entry.name, cache);
        discovered.push({
          id: entry.name,
          file,
          dir: sessionDir,
          escapedWorkspace: dirEntry.name,
          sig: { size: stat.size, mtimeMs: stat.mtimeMs },
          projcache: cache,
        });
      }
    }

    // Parent/child: DSH records spawned subagents in the parent's projcache
    // (subagentCatalog / agentTeam). Build the reverse index once.
    const childToParent = new Map();
    for (const [parentId, cache] of projcache) {
      for (const childId of cache?.children || []) {
        if (!childToParent.has(childId)) childToParent.set(childId, parentId);
      }
    }
    const depthOf = (sessionId) => {
      let depth = 0;
      let current = sessionId;
      const seen = new Set();
      while (childToParent.has(current) && depth < 8 && !seen.has(current)) {
        seen.add(current);
        current = childToParent.get(current);
        depth += 1;
      }
      return depth;
    };

    // Workspace mapping: registry session list first, then cwd, then parent.
    const byPath = new Map();
    for (const workspace of registry.workspaces) byPath.set(path.resolve(workspace.path), workspace);
    const sessionWorkspace = registry.sessionWorkspace;
    const synthetic = new Map(); // path -> workspace

    const workspaceFor = (sessionId, cwd) => {
      const registered = sessionWorkspace.get(sessionId);
      if (registered) return registered;
      if (cwd) {
        const match = byPath.get(path.resolve(cwd));
        if (match) return match;
      }
      const parentId = childToParent.get(sessionId);
      if (parentId) {
        const parentCache = projcache.get(parentId);
        const parentCwd = parentCache?.cwd;
        if (parentCwd) {
          const parentMatch = byPath.get(path.resolve(parentCwd));
          if (parentMatch) return parentMatch;
          if (synthetic.has(path.resolve(parentCwd))) return synthetic.get(path.resolve(parentCwd));
        }
      }
      if (!cwd) return null;
      const key = path.resolve(cwd);
      if (!synthetic.has(key)) {
        synthetic.set(key, {
          id: `ws_${shortHash(key, 12)}`,
          title: basenameOf(cwd),
          path: cwd,
          sessionIds: [],
          createdAt: 0,
          updatedAt: 0,
          source: "discovered",
        });
      }
      return synthetic.get(key);
    };

    /** @type {SessionMeta[]} */
    const sessions = discovered.map((item) => {
      const cache = item.projcache;
      const createdAt = cache?.createdAt || 0;
      const cwd = cache?.cwd || null;
      const parentSession = childToParent.get(item.id) || null;
      const depth = depthOf(item.id);
      const workspace = workspaceFor(item.id, cwd);
      return {
        id: item.id,
        file: item.file,
        dir: item.dir,
        sig: item.sig,
        sigKey: `${item.sig.size}:${item.sig.mtimeMs}`,
        title: cache?.title || null,
        createdAt,
        cwd,
        parentSession,
        delegationDepth: depth,
        origin: depth > 0 ? "subagent" : "main",
        lastActivityAt: cache?.lastMessageTime || 0,
        lastPromptAt: cache?.lastPromptAt || 0,
        eventCount: 0,
        turnCount: cache?.turns || 0,
        isLive: false,
        workspaceId: workspace?.id || null,
        workspaceTitle: workspace?.title || null,
        workspacePath: workspace?.path || null,
        blank: cache?.blank === true,
        goalText: cache?.goal?.text || null,
        goalStatus: cache?.goal?.status || null,
        turnOutline: cache?.turnOutline || [],
        cached: false,
        diagnostics: { badLines: 0 },
      };
    });

    // Merge synthetic workspaces into the public workspace list.
    const workspaces = [...registry.workspaces.map((workspace) => ({ ...workspace, synthetic: false }))];
    for (const candidate of synthetic.values()) workspaces.push({ ...candidate, synthetic: true });

    const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    for (const session of sessions) {
      const workspace = session.workspaceId ? byWorkspace.get(session.workspaceId) : null;
      if (!workspace) continue;
      workspace.sessionIds = workspace.sessionIds || [];
      if (!workspace.sessionIds.includes(session.id)) workspace.sessionIds.push(session.id);
    }
    for (const workspace of workspaces) {
      workspace.sessionCount = sessions.filter(
        (session) => session.workspaceId === workspace.id && session.origin === "main",
      ).length;
    }
    workspaces.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.title.localeCompare(b.title, "zh"));
    return { workspaces, sessions, diagnostics, childToParent };
  }

  /** Read + decompress + parse one session file (synchronous, ~10-300ms). */
  function loadParsed(meta) {
    const diagnostics = [];
    let text = "";
    try {
      text = decompressSessionBuffer(fs.readFileSync(meta.file));
    } catch (error) {
      throw new Error(`decompress-failed: ${String(error?.message || error)}`);
    }
    const { events, badLines } = parseJsonlEvents(text);
    if (badLines > 0) diagnostics.push({ kind: "jsonl", badLines });
    if (events.length === 0) throw new Error("empty-session-log");
    return parseEvents(meta, events, diagnostics);
  }

  /**
   * Parse raw events into the compact structure consumed by analyzers and API.
   * Unknown event types are ignored defensively; every single-session parse
   * failure is isolated by the caller (scan records diagnostics and continues).
   */
  function parseEvents(meta, events, diagnostics = []) {
    const sessionEvent = events.find((event) => event.type === "session") || {};
    const users = [];
    const assistants = [];
    const toolCallsById = new Map();
    const toolResults = [];
    const todoSnapshots = [];
    const turnEnds = [];
    const turnStarts = [];
    const deliverables = [];
    const workspaceChanges = [];
    const errors = [];
    const signals = [];
    const systemNotices = [];
    const activity = Object.create(null);
    let title = null;
    let titleSource = null;
    let lastActivityAt = 0;
    let lastEvent = null;
    let lastAssistantText = null;
    let assistantTexts = 0;
    let turnsSeen = 0;

    for (const event of events) {
      const data = event.data || {};
      if (event.time > lastActivityAt) lastActivityAt = event.time;
      lastEvent = event;
      const day = isoDay(event.time);
      if (day) activity[day] = (activity[day] || 0) + 1;

      switch (event.type) {
        case "user/message": {
          const text = textOfContent(data.content).trim();
          if (!text) break;
          const sourceKind = data.source?.kind;
          if (sourceKind === undefined || sourceKind === "user") {
            users.push({ seq: event.seq, time: event.time, text, images: countImages(data.content) });
          } else if (ASYNC_SIGNAL_KINDS.has(sourceKind)) {
            // Injected context (team mail, background-job notices, model switch…)
            // is not a user request but can explain state changes in the digest.
            signals.push({ seq: event.seq, time: event.time, kind: sourceKind, text });
          }
          break;
        }
        case "assistant/message": {
          assistantTexts += 1;
          const text = textOfContent(data.message?.content).trim();
          if (text) {
            assistants.push({ seq: event.seq, time: event.time, turn: Number(data.turn) || 0, text });
            lastAssistantText = { seq: event.seq, time: event.time, text };
          }
          for (const content of data.message?.content || []) {
            if (content?.type === "tool-call" && content.name && content.id && !toolCallsById.has(content.id)) {
              // The authoritative call event is `tool/call`; keep this as fallback
              // for older logs where that event was not written.
              toolCallsById.set(content.id, {
                seq: event.seq,
                time: event.time,
                name: String(content.name),
                callId: content.id,
                args: typeof content.arguments === "string" ? content.arguments : JSON.stringify(content.arguments ?? ""),
              });
            }
          }
          break;
        }
        case "tool/call": {
          if (data.name) {
            toolCallsById.set(data.callId || `seq:${event.seq}`, {
              seq: event.seq,
              time: event.time,
              name: String(data.name),
              callId: data.callId || null,
              args: typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? ""),
            });
          }
          break;
        }
        case "tool/result": {
          const isError = data.message?.isError === true;
          const text = textOfContent(data.message?.content);
          toolResults.push({
            seq: event.seq,
            time: event.time,
            isError,
            text,
            toolCallId: data.toolCallId || data.message?.source?.callId || null,
          });
          if (isError) errors.push({ seq: event.seq, time: event.time, source: "tool", text });
          break;
        }
        case "todo/write": {
          if (Array.isArray(data.todos)) {
            todoSnapshots.push({
              seq: event.seq,
              time: event.time,
              todos: data.todos
                .filter((todo) => todo && typeof todo.content === "string")
                .map((todo) => ({ content: todo.content, status: String(todo.status || "pending") })),
            });
          }
          break;
        }
        case "turn/start": {
          turnsSeen += 1;
          turnStarts.push({ seq: event.seq, time: event.time, turn: Number(data.turn) || turnsSeen });
          break;
        }
        case "turn/end": {
          const reason = data.reason || {};
          const kind = String(reason.kind || "completed");
          turnEnds.push({
            seq: event.seq,
            time: event.time,
            turn: Number(data.turn) || 0,
            kind,
            error: reason.error ? String(reason.error.message || reason.error) : null,
          });
          if (kind !== "completed") {
            errors.push({ seq: event.seq, time: event.time, source: "turn", text: reason.error?.message || `turn ${kind}` });
          }
          break;
        }
        case "session/title": {
          const candidate = typeof data.title === "string" ? data.title.trim() : "";
          const source = data.source?.kind;
          // prefer provider/LLM titles, fall back to any title
          if (candidate && (source === "provider" || !title || titleSource !== "provider")) {
            title = candidate;
            titleSource = source || "event";
          }
          break;
        }
        case "deliverables/presented": {
          const files = Array.isArray(data.files) ? data.files : [];
          if (files.length) {
            deliverables.push({
              seq: event.seq,
              time: event.time,
              files: files
                .filter((file) => file && file.path)
                .map((file) => ({ path: String(file.path), description: clip(file.description || "", 120) })),
            });
          }
          break;
        }
        case "workspace/changes": {
          workspaceChanges.push({ seq: event.seq, time: event.time, turn: Number(data.turn) || 0 });
          break;
        }
        case "system/message": {
          const text = textOfContent(data.message?.content);
          if (text) systemNotices.push({ seq: event.seq, time: event.time, text });
          break;
        }
        default:
          break;
      }
    }

    const toolCalls = [...toolCallsById.values()].sort((a, b) => a.seq - b.seq);
    // seq → wall-clock time, used to enrich LLM evidence citations (which only
    // know seq numbers) when mapping into the task model.
    const timeBySeq = new Map();
    for (const list of [
      users,
      signals,
      timeBySeq,
      assistants,
      toolCalls,
      toolResults,
      todoSnapshots,
      turnStarts,
      turnEnds,
      deliverables,
      workspaceChanges,
      errors,
    ]) {
      for (const item of list) if (!timeBySeq.has(item.seq)) timeBySeq.set(item.seq, item.time);
    }
    const parentSession = typeof sessionEvent.parentSession === "string" ? sessionEvent.parentSession : meta.parentSession;
    const delegationDepth = Number.isFinite(sessionEvent.delegationDepth)
      ? Number(sessionEvent.delegationDepth)
      : parentSession
        ? Math.max(1, meta.delegationDepth || 1)
        : 0;
    const createdAt = Number(sessionEvent.createdAt) || meta.createdAt || (events[0]?.time ?? 0);
    const cwd = typeof sessionEvent.cwd === "string" ? sessionEvent.cwd : meta.cwd;
    const resolvedTitle =
      readableTitle(meta.title, users[0]?.text) ||
      readableTitle(title, users[0]?.text) ||
      `会话 ${meta.id.slice(-6)}`;
    const lastTurnEnd = turnEnds[turnEnds.length - 1] || null;
    const sessionDir = meta.dir || (meta.file ? path.dirname(meta.file) : "");
    let lockAgeMs = null;
    if (sessionDir) {
      try {
        lockAgeMs = Date.now() - fs.statSync(path.join(sessionDir, "session.lock")).mtimeMs;
      } catch {
        lockAgeMs = null;
      }
    }
    const structuralLive =
      Boolean(lastEvent) && lastEvent.type !== "turn/end" && lastEvent.type !== "session/end-seed";
    const recentlyActive = lastActivityAt > 0 && Date.now() - lastActivityAt < 30 * 60_000;
    const isLive = (structuralLive && recentlyActive) || (lockAgeMs !== null && lockAgeMs < 5 * 60_000);

    return {
      id: meta.id,
      file: meta.file,
      dir: meta.dir,
      sig: meta.sig,
      sigKey: meta.sigKey,
      origin: delegationDepth > 0 ? "subagent" : "main",
      parentSession,
      delegationDepth,
      session: {
        id: sessionEvent.id || meta.id,
        createdAt,
        cwd: cwd || null,
        origin: sessionEvent.origin || (delegationDepth > 0 ? "subagent" : "main"),
        agentPreset: sessionEvent.agentPreset || null,
      },
      title: resolvedTitle,
      titleSource,
      goal: {
        text: typeof meta.goalText === "string" && meta.goalText.trim() ? clip(meta.goalText.trim(), 160) : null,
        status: meta.goalStatus === "done" ? "done" : meta.goalStatus ? "active" : null,
      },
      users,
      signals,
      timeBySeq,
      assistants,
      toolCalls,
      toolResults,
      todoSnapshots,
      turnEnds,
      turnStarts,
      deliverables,
      workspaceChanges,
      errors,
      systemNotices,
      activity,
      lastActivityAt,
      lastEvent: lastEvent ? { type: lastEvent.type, seq: lastEvent.seq, time: lastEvent.time } : null,
      lastAssistantText,
      lastTurnEnd,
      turnCount: Math.max(turnStarts.length, turnEnds.length),
      turnOutline: Array.isArray(meta.turnOutline) ? meta.turnOutline : [],
      assistantMessageCount: assistantTexts,
      eventCount: events.length,
      isLive,
      diagnostics,
    };
  }

  function countImages(content) {
    if (!Array.isArray(content)) return 0;
    return content.filter((item) => item && item.type === "image").length;
  }

  /** Compact meta persisted in sessions-cache.json (no event payloads). */
  function metaFromParsed(parsed) {
    const lastTodoSnapshot = parsed.todoSnapshots[parsed.todoSnapshots.length - 1] || null;
    const todoCounts = { total: 0, completed: 0, pending: 0, inProgress: 0 };
    if (lastTodoSnapshot) {
      todoCounts.total = lastTodoSnapshot.todos.length;
      for (const todo of lastTodoSnapshot.todos) {
        if (todo.status === "completed") todoCounts.completed += 1;
        else if (todo.status === "in_progress") todoCounts.inProgress += 1;
        else todoCounts.pending += 1;
      }
    }
    return {
      id: parsed.id,
      file: parsed.file,
      dir: parsed.dir,
      sig: parsed.sig,
      sigKey: parsed.sigKey,
      title: parsed.title,
      titleSource: parsed.titleSource,
      createdAt: parsed.session.createdAt,
      cwd: parsed.session.cwd,
      parentSession: parsed.parentSession,
      delegationDepth: parsed.delegationDepth,
      origin: parsed.origin,
      lastActivityAt: parsed.lastActivityAt,
      eventCount: parsed.eventCount,
      turnCount: parsed.turnCount,
      isLive: parsed.isLive,
      lastEventType: parsed.lastEvent?.type || null,
      lastEventSeq: parsed.lastEvent?.seq ?? 0,
      lastTurnEnd: parsed.lastTurnEnd,
      userCount: parsed.users.length,
      hasUserMessages: parsed.users.length > 0,
      signalCount: parsed.signals.length,
      deliverableCount: parsed.deliverables.reduce((sum, item) => sum + item.files.length, 0),
      errorCount: parsed.errors.length,
      todoCounts,
      lastTodoSeq: lastTodoSnapshot?.seq ?? null,
      lastTurnStartSeq: parsed.turnStarts[parsed.turnStarts.length - 1]?.seq ?? 0,
      goalText: parsed.goal?.text || null,
      goalStatus: parsed.goal?.status || null,
      activity: parsed.activity,
      parsedAt: new Date().toISOString(),
    };
  }

  /* ------------------------------ digest ---------------------------- */

  function toolCallLabel(call) {
    const name = call.name;
    const args = parseToolArgs(call);
    const description = args.description || args.command || args.code || args.path || args.query || "";
    const compact = String(description).replace(/\s+/g, " ").trim();
    return `${name}(${clip(compact, 90)})`;
  }

  /* --------------------------- evidence ---------------------------- */

  const EVIDENCE_LIMIT = 8;
  const QUOTE_LIMIT = 160;

  /**
   * Traceable evidence candidates, ranked by signal value then capped at 40.
   * `sessionId`/`sessionTitle`/`seq`/`time` always point back to the real log.
   */
  function collectEvidence(parsed, { limit = EVIDENCE_LIMIT } = {}) {
    const sessionId = parsed.id;
    const sessionTitle = parsed.title;
    /** @type {Array<{priority:number, order:number, kind:string, text:string, quote:string, seq:number, time:number}>} */
    const candidates = [];
    const push = (priority, order, kind, text, quote, seq, time) => {
      candidates.push({ priority, order, kind, text: clip(String(text || ""), 220), quote: clip(String(quote || text || ""), QUOTE_LIMIT), seq, time: time || 0 });
    };

    const firstUser = parsed.users[0];
    if (firstUser) {
      push(100, 0, "user", "用户提出初始需求", firstUser.text, firstUser.seq, firstUser.time);
    }
    const lastUser = parsed.users[parsed.users.length - 1];
    if (lastUser && lastUser !== firstUser) {
      push(80, 1, "user", "用户最新指令", lastUser.text, lastUser.seq, lastUser.time);
    }

    parsed.deliverables.forEach((item, index) => {
      const names = item.files.map((file) => path.basename(file.path)).join("、");
      const descriptions = item.files
        .map((file) => file.description)
        .filter(Boolean)
        .join("；");
      push(98, 10 + index, "deliverable", `交付物：${clip(names, 160)}`, descriptions || item.files.map((file) => file.path).join("\n"), item.seq, item.time);
    });

    parsed.workspaceChanges.forEach((change, index) => {
      push(60, 20 + index, "artifact", `第 ${change.turn || "?"} 轮产生了工作区文件变更`, "", change.seq, change.time);
    });

    const lastAssistant = parsed.lastAssistantText;
    if (lastAssistant) {
      push(90, 30, "assistant", "助手最新总结", lastAssistant.text, lastAssistant.seq, lastAssistant.time);
    }
    const finalAssistant = [...parsed.assistants].reverse().find((message) => message.seq < (parsed.lastTurnEnd?.seq ?? Number.MAX_SAFE_INTEGER));
    if (finalAssistant && finalAssistant !== lastAssistant) {
      push(70, 31, "assistant", "上一轮完成时的答复", finalAssistant.text, finalAssistant.seq, finalAssistant.time);
    }

    parsed.errors.slice(-6).forEach((error, index) => {
      push(92, 40 + index, "error", `错误：${clip(error.text.replace(/\s+/g, " "), 140)}`, error.text, error.seq, error.time);
    });

    const lastTodos = parsed.todoSnapshots[parsed.todoSnapshots.length - 1];
    if (lastTodos) {
      const summary = lastTodos.todos
        .slice(0, 12)
        .map((todo) => `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.content}`)
        .join("\n");
      const done = lastTodos.todos.filter((todo) => todo.status === "completed").length;
      push(88, 50, "todo", `待办进度 ${done}/${lastTodos.todos.length}`, summary, lastTodos.seq, lastTodos.time);
    }

    const interestingCalls = parsed.toolCalls.filter((call) =>
      ["write", "edit", "present", "bash", "run_code"].includes(call.name),
    );
    interestingCalls.slice(-10).forEach((call, index) => {
      const label = toolCallLabel(call);
      push(50, 60 + index, "tool", `工具：${label}`, label, call.seq, call.time);
    });

    const olderUsers = parsed.users.slice(Math.max(0, parsed.users.length - 8), -1);
    olderUsers.forEach((message, index) => {
      push(55, 80 + index, "user", "用户反馈", message.text, message.seq, message.time);
    });

    parsed.assistants.slice(-5).forEach((message, index) => {
      push(45, 100 + index, "assistant", "助手进展", message.text, message.seq, message.time);
    });

    // Rank, dedupe by (kind,seq), then present in timeline order.
    candidates.sort((a, b) => b.priority - a.priority || b.seq - a.seq);
    const seen = new Set();
    const chosen = [];
    for (const candidate of candidates) {
      const key = `${candidate.kind}:${candidate.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chosen.push(candidate);
      if (chosen.length >= limit) break;
    }
    chosen.sort((a, b) => a.seq - b.seq);
    return chosen.map((candidate) => ({
      id: `e_${shortHash(`${sessionId}:${candidate.kind}:${candidate.seq}`)}`,
      kind: candidate.kind,
      text: candidate.text,
      quote: candidate.quote,
      seq: candidate.seq,
      time: candidate.time,
      sessionId,
      sessionTitle,
    }));
  }

  /* --------------------------- API events -------------------------- */

  const API_KINDS = new Set(["user", "assistant", "todo", "tool", "error", "deliverable"]);

  /** Convert parsed events to the GET /session contract event list. */
  function readApiEvents(parsed, { after = null, limit = 200 } = {}) {
    const events = [];
    const push = (event) => {
      if (!API_KINDS.has(event.kind)) return;
      events.push(event);
    };
    const toolNames = new Map();
    for (const call of parsed.toolCalls) if (call.callId) toolNames.set(call.callId, call.name);

    for (const message of parsed.users) {
      push({ seq: message.seq, time: message.time, kind: "user", role: "user", text: clip(message.text, 2000), toolName: null, todos: null, isError: false });
    }
    for (const message of parsed.assistants) {
      push({ seq: message.seq, time: message.time, kind: "assistant", role: "assistant", text: clip(message.text, 2000), toolName: null, todos: null, isError: false });
    }
    for (const call of parsed.toolCalls) {
      push({
        seq: call.seq,
        time: call.time,
        kind: "tool",
        role: "assistant",
        text: clip(toolCallLabel(call), 2000),
        toolName: call.name,
        todos: null,
        isError: false,
      });
    }
    for (const result of parsed.toolResults) {
      push({
        seq: result.seq,
        time: result.time,
        kind: result.isError ? "error" : "tool",
        role: "tool",
        text: clip(result.text, 2000),
        toolName: result.toolCallId ? toolNames.get(result.toolCallId) || null : null,
        todos: null,
        isError: result.isError,
      });
    }
    for (const snapshot of parsed.todoSnapshots) {
      push({
        seq: snapshot.seq,
        time: snapshot.time,
        kind: "todo",
        role: "system",
        text: snapshot.todos.map((todo) => `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.content}`).join("\n"),
        toolName: null,
        todos: snapshot.todos,
        isError: false,
      });
    }
    for (const item of parsed.deliverables) {
      push({
        seq: item.seq,
        time: item.time,
        kind: "deliverable",
        role: "system",
        text: item.files.map((file) => `${file.path}${file.description ? ` —— ${file.description}` : ""}`).join("\n"),
        toolName: null,
        todos: null,
        isError: false,
      });
    }
    for (const end of parsed.turnEnds) {
      if (end.kind === "completed") continue;
      push({
        seq: end.seq,
        time: end.time,
        kind: "error",
        role: "system",
        text: clip(`本轮${end.kind === "error" ? "失败" : "中止"}：${end.error || end.kind}`, 2000),
        toolName: null,
        todos: null,
        isError: true,
      });
    }

    events.sort((a, b) => a.seq - b.seq || a.time - b.time);
    const capped = Math.min(Math.max(1, limit), 500);
    if (after !== null && Number.isFinite(after)) {
      return events.filter((event) => event.seq > after).slice(0, capped);
    }
    return events.slice(-capped);
  }

  return {
    discover,
    loadParsed,
    metaFromParsed,
    buildDigest,
    collectEvidence,
    readApiEvents,
    extractArtifacts,
    extractSubtasks,
    latestTodos,
    toolBrief,
    parseJsonlEvents,
    decompressSessionBuffer,
    sessionsRoot,
    registryPath: path.join(home, "storages", "workspace.json"),
  };
}

export { readableTitle, shortHash, clip };
