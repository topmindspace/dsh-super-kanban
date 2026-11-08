/**
 * Super Kanban — host service.
 *
 * Orchestrates the whole host half:
 *   - session discovery + rules/LLM analysis on an automatic scan schedule
 *   - merge policy (stable session↔task binding, locked fields, history)
 *   - persistence (state.json / sessions-cache.json)
 *   - the HTTP surface consumed by client.js (contract: docs/CONTRACT.md)
 *
 * Module boundaries: sessions.mjs = read-only session parsing; analyzer-*.mjs =
 * the two analysis engines; store.mjs = persistence + migrations; http.mjs =
 * protocol/payload helpers; auth.mjs = owner admission; titles.mjs = merge
 * scoring. This file owns board state + orchestration only.
 *
 * Public surface (also the contract with index.mjs):
 *   createKanbanService({ ctx }) -> { handle(req,res,{route,url,method}), start(), stop() }
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { createSessionSource } from "./sessions.mjs";
import { analyzeSessionRules, normalizeAnalysis, titleSimilarity } from "./analyzer-rules.mjs";
import { createLlmAnalyzer } from "./analyzer-llm.mjs";
import { llmOf } from "./native-llm.mjs";
import { badRequest, classifyError, clipText, conflict, decodeId, isStringArray, json, notFound, readBody } from "./http.mjs";
import { titleMergeScore } from "./titles.mjs";
import {
  AI_CALLS_PER_SCAN_MAX,
  AI_CALLS_PER_SCAN_MIN,
  ARTIFACT_LIMIT,
  createStore,
  DEFAULT_SETTINGS,
  EVIDENCE_LIMIT,
  emptyScanState,
  GOAL_TEXT_LIMIT,
  ISSUE_LIMIT,
  KEYFACT_LIMIT,
  KEYFACT_TEXT_LIMIT,
  MILESTONE_LIMIT,
  newManualTaskId,
  NEXTSTEP_LIMIT,
  NEXTSTEP_TEXT_LIMIT,
  normalizeAiRoutePair,
  normalizeSettingsPatch,
  positiveSeqOrNull,
  pushHistory,
  rolloverUsage,
  shortId,
  stableTaskId,
  SUBTASK_LIMIT,
  SUBTASK_TEXT_LIMIT,
  TAG_LIMIT,
  TAG_TEXT_LIMIT,
  TITLE_TEXT_LIMIT,
  truncateTask,
} from "./store.mjs";

const DAY = 86_400_000;
const MAX_AI_CONCURRENCY = 2;
const MAX_SESSIONS_PER_TASK = 12;
const MIN_AI_INTERVAL_MS = 180_000; // v2: same-session re-analysis cooldown
/** v3 AI-phase guards (code constants, not user settings). */
const AI_SCAN_MAX_MS = 600_000; // 10 min wall clock for the whole AI stage
const AI_ERROR_COOLDOWN_MS = 300_000; // 5 min cooldown for sessions whose analysis failed
const AI_CATALOG_TTL_MS = 30_000; // GET /ai/models cache
const AI_CATALOG_TIMEOUT_MS = 12_000; // GET /ai/models and fallback-catalog timeout
const FIELD_NAMES = ["title", "goal", "status", "progress", "priority", "tags", "issues", "nextSteps", "milestones"];
const LOCKABLE_FIELDS = [...FIELD_NAMES, "keyFacts", "subtasks", "artifacts", "goalObject"];
const STATUSES = ["backlog", "in_progress", "blocked", "done"];
/** Chinese labels for generated prompt text (users read the prompt, not the raw key). */
const STATUS_LABELS = { backlog: "待办", in_progress: "进行中", blocked: "受阻", done: "已完成" };
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_CLIENTS = 32;
/** Drop an SSE client whose unread socket buffer exceeds this (backpressure). */
const SSE_MAX_BUFFER_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createKanbanService({ ctx, aiScanMaxMs, aiCatalogTimeoutMs } = {}) {
  const logger = ctx?.logger;
  const dshHome = process.env.DSH_HOME || path.join(homedir(), ".dsh");
  const source = createSessionSource({ dshHome, logger });
  // The analyzer resolves the DSH native llm service lazily from `ctx`; a host
  // composition without one degrades AI analysis to the rules engine.
  const analyzer = createLlmAnalyzer({ ctx, logger });
  const store = createStore({ dshHome, logger });
  /**
   * Test seams only (production uses the module constants): the AI-phase wall
   * clock and the model-catalog timeout.
   */
  const aiScanMaxMsValue = Number.isFinite(aiScanMaxMs) && aiScanMaxMs >= 0 ? aiScanMaxMs : AI_SCAN_MAX_MS;
  const aiCatalogTimeoutMsValue =
    Number.isFinite(aiCatalogTimeoutMs) && aiCatalogTimeoutMs > 0 ? aiCatalogTimeoutMs : AI_CATALOG_TIMEOUT_MS;

  const loaded = store.load();
  let state = loaded.state;
  let cache = loaded.cache;
  let stopped = false;
  state.usage = rolloverUsage(state.usage);

  /** id -> SessionMeta (compact, includes workspace + last todo counts). */
  let sessionsById = new Map();
  /** parent session id -> child (subagent) session ids. */
  let parentToChildren = new Map();

  let scanPromise = null;
  let scanCancel = false;
  let scanAbort = null;
  /**
   * Single in-process AI mutex. `task.analyze` / `task.polishPrompt` and scans
   * share ONE analyzer instance (budget, transport, retries), so overlapping them
   * would let the two flows reset each other's budget and corrupt usage/session
   * accounting. Explicit AI commands own this flag; scans are refused while it is
   * set (and auto scans silently retry on their next tick).
   */
  let aiBusy = false;
  let lastAiBusySkipLoggedAt = 0;
  let startupTimer = null;
  let autoTimer = null;
  let saveTimer = null;
  const sseClients = new Set();
  let lastScanBroadcast = 0;
  let scanBroadcastTimer = null;
  let suppressPersist = false;
  let scanDigestBytes = []; // digest byte sizes of the current scan (usage.lastScan.digestBytesAvg)

  /** Host loggers are external code: a broken logger must never break the board. */
  function logInfo(message) {
    try {
      logger?.info?.(message);
    } catch {
      /* ignore logger failures */
    }
  }
  function logWarn(message) {
    try {
      logger?.warn?.(message);
    } catch {
      /* ignore logger failures */
    }
  }

  /* --------------------- AI: route + catalog helpers ------------------ */

  /** Short single-line error text safe for logs (never digests/tokens/keys). */
  function shortError(error) {
    const text = String(error?.message || error || "unknown")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }

  /** Reject with `code:"timeout"` after `timeoutMs`; the timer is always cleared. */
  async function withTimeout(promise, timeoutMs, label = "timeout") {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(label), { code: "timeout" })), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function llmService() {
    return llmOf(ctx);
  }

  /** Registered providers as `{id,name}` records; external host code is never trusted. */
  function providerRoutes(llm) {
    try {
      const routes = llm.listProviders();
      if (!Array.isArray(routes)) return [];
      return routes
        .filter((route) => route && typeof route.id === "string" && route.id)
        .map((route) => ({ id: route.id, name: typeof route.name === "string" && route.name ? route.name : route.id }));
    } catch (error) {
      logWarn(`[super-kanban] listProviders failed: ${shortError(error)}`);
      return [];
    }
  }

  /** The DSH default model selection (live reference), or null when unreadable. */
  function defaultModelSelection() {
    try {
      if (typeof ctx?.get !== "function") return null;
      const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
      if (
        selection &&
        typeof selection.provider === "string" &&
        selection.provider &&
        typeof selection.model === "string" &&
        selection.model
      ) {
        return { provider: selection.provider, model: selection.model };
      }
    } catch {
      /* optional service: absent in minimal hosts, may also throw */
    }
    return null;
  }

  /**
   * Sync route check (no catalog I/O — the scan hot path stays fast):
   * explicit provider+model wins, otherwise the live DSH default is followed.
   * Provider availability is a registry check only; a model id missing from the
   * catalog is not a hard error because the core route may still accept it.
   */
  function syncAiSelection() {
    const llm = llmService();
    if (!llm) return { ok: false, reason: "llm-unavailable" };
    const explicitProvider = typeof state.settings.aiProvider === "string" ? state.settings.aiProvider.trim() : "";
    const explicitModel = typeof state.settings.aiModel === "string" ? state.settings.aiModel.trim() : "";
    const routes = providerRoutes(llm);
    const registered = (id) => routes.some((route) => route.id === id);
    if (explicitProvider && explicitModel) {
      if (!registered(explicitProvider)) {
        return { ok: false, reason: "provider-unavailable", source: "settings", provider: explicitProvider, model: explicitModel };
      }
      return { ok: true, source: "settings", provider: explicitProvider, model: explicitModel };
    }
    const fallback = defaultModelSelection();
    if (fallback) {
      if (!registered(fallback.provider)) {
        return { ok: false, reason: "provider-unavailable", source: "default", provider: fallback.provider, model: fallback.model };
      }
      return { ok: true, source: "default", provider: fallback.provider, model: fallback.model };
    }
    return { ok: false, reason: "no-default-model" };
  }

  /** First model of the first provider that returns a usable catalog. */
  async function firstCatalogModel(llm) {
    for (const route of providerRoutes(llm)) {
      try {
        const models = await withTimeout(llm.listModels(route.id), aiCatalogTimeoutMsValue, "catalog-timeout");
        const first = Array.isArray(models) ? models.find((model) => model && typeof model.id === "string" && model.id) : null;
        if (first) return { provider: route.id, model: first.id };
      } catch {
        /* try the next provider */
      }
    }
    return null;
  }

  /** Rules-only explanation for an unavailable model route (host-side text). */
  function aiRouteFailureMessage(selection) {
    switch (selection.reason) {
      case "llm-unavailable":
        return "当前 DSH 未提供 AI 模型服务，本次仅规则分析；升级 DSH 后可用";
      case "provider-unavailable":
        return selection.source === "default"
          ? `DSH 默认模型提供方 ${selection.provider} 不可用，请在 DSH 设置 → 模型 中配置`
          : `所选模型提供方 ${selection.provider} 已不可用，请在设置中重新选择模型`;
      case "no-default-model":
        return "DSH 尚未设置默认模型，请在看板设置中选择模型（或先在 DSH 设置 → 模型 中配置）";
      case "no-models":
        return `${selection.provider} 没有可用模型（可能未配置 API Key 或未登录），请在 DSH 设置 → 模型 中完成配置`;
      case "catalog-error":
        return "读取模型目录失败，本次仅规则分析";
      default:
        return "AI 模型不可用，本次仅规则分析";
    }
  }

  /**
   * Async route resolution (once per scan / explicit command).
   * Only the "no default model at all" case consults the catalog (first-model
   * fallback); an explicit/default provider that is down stays an error so the
   * board never silently switches the user's model.
   */
  async function resolveAiRoute() {
    const llm = llmService();
    if (!llm) {
      const failure = { ok: false, reason: "llm-unavailable" };
      return { ...failure, message: aiRouteFailureMessage(failure) };
    }
    const selection = syncAiSelection();
    if (selection.ok) return selection;
    if (selection.reason === "no-default-model") {
      let fallback = null;
      try {
        // Bound the whole fallback (not just each provider) so an explicit
        // command cannot hang on a host with several slow providers.
        fallback = await withTimeout(firstCatalogModel(llm), aiCatalogTimeoutMsValue, "catalog-timeout");
      } catch {
        fallback = null;
      }
      if (fallback) return { ok: true, source: "catalog-fallback", ...fallback };
    }
    return { ...selection, message: aiRouteFailureMessage(selection) };
  }

  /** Whether AI analysis can run at all (presence of the native llm service). */
  function analyzerHasService() {
    try {
      return Boolean(analyzer.hasService());
    } catch {
      return Boolean(llmService());
    }
  }

  /** Snapshot of the analyzer budget (call/attempt accounting; never throws). */
  function readAnalyzerBudget() {
    try {
      const budget = typeof analyzer.getBudget === "function" ? analyzer.getBudget() : null;
      return {
        calls: Math.max(0, Number(budget?.calls) || 0),
        attempts: Math.max(0, Number(budget?.attempts) || 0),
        tokens: Math.max(0, Number(budget?.tokens) || 0),
      };
    } catch {
      return { calls: 0, attempts: 0, tokens: 0 };
    }
  }

  /** Record a failed analysis so the session cools down before the next try. */
  function markAiError(meta, error) {
    const entry = cache.sessions[meta.id] || { sigKey: meta.sigKey, meta };
    entry.meta = {
      ...(entry.meta || meta),
      llmError: shortError(error),
      aiErrorAt: new Date().toISOString(),
    };
    cache.sessions[meta.id] = entry;
    sessionsById.set(meta.id, entry.meta);
  }

  /**
   * Per-scan AI budget limit: "auto" is unbounded here (the daily remaining caps
   * it), "fixed" is the sanitized `maxAiCallsPerScan`.
   */
  function perScanAiLimit() {
    if (state.settings.aiBudgetMode !== "fixed") return Number.POSITIVE_INFINITY;
    const value = Number(state.settings.maxAiCallsPerScan);
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.maxAiCallsPerScan;
    return Math.min(AI_CALLS_PER_SCAN_MAX, Math.max(AI_CALLS_PER_SCAN_MIN, Math.round(value)));
  }

  /** Deterministic AI order: never-analyzed debt > changed > recent activity > id. */
  function compareAiJobs(a, b) {
    if (Boolean(a.firstAnalysis) !== Boolean(b.firstAnalysis)) return a.firstAnalysis ? -1 : 1;
    if (Boolean(a.changed) !== Boolean(b.changed)) return a.changed ? -1 : 1;
    const byActivity = (b.meta.lastActivityAt || 0) - (a.meta.lastActivityAt || 0);
    if (byActivity !== 0) return byActivity;
    return String(a.meta.id).localeCompare(String(b.meta.id));
  }

  /**
   * Claim the shared AI mutex for one explicit command.
   * Throws before any budget/usage bookkeeping starts; the caller must release
   * it in a `finally` so every return/throw path frees it. `stopped` maps to 503
   * through the shared http.classifyError.
   */
  function acquireAiTask() {
    if (stopped) throw Object.assign(new Error("服务已停止"), { code: "stopped" });
    if (scanPromise) throw conflict("扫描进行中，请稍后再试");
    if (aiBusy) throw conflict("其他 AI 任务进行中，请稍后再试");
    aiBusy = true;
  }

  function releaseAiTask() {
    aiBusy = false;
  }

  /** Compose the human-readable scan conclusion (the host owns scan.message). */
  function buildScanMessage({
    lowValueSkipped = 0,
    mergedTasks = 0,
    aiRouteMessage = null,
    aiDeferredReason = null,
    aiBudget = 0,
    aiPending = 0,
    aiFailureCount = 0,
  } = {}) {
    const parts = [`扫描完成：${state.scan.processed}/${state.scan.total} 个会话`];
    // Post-scan counters: finalizeScan() adds scan.aiCalls to usage.calls later, so
    // the message must not read the pre-scan usage value (old accounting bug).
    const usedAfter = (Number(state.usage.calls) || 0) + (Number(state.scan.aiCalls) || 0);
    const dailyLimit = Number(state.settings.dailyAiCallLimit) || DEFAULT_SETTINGS.dailyAiCallLimit;
    const pending = Math.max(0, Math.round(Number(aiPending) || 0));
    if (state.scan.aiCalls > 0) parts.push(`AI ${state.scan.aiCalls} 次/${state.scan.tokens} tokens`);
    else if (state.settings.aiEnabled) parts.push("本次无 AI 调用");
    if (lowValueSkipped > 0) parts.push(`低价值跳过 ${lowValueSkipped}`);
    if (aiRouteMessage) parts.push(aiRouteMessage);
    if (aiDeferredReason === "daily") {
      parts.push(`今日 AI 预算已用完（${usedAfter}/${dailyLimit}）`);
      if (pending > 0) parts.push(`剩余 ${pending} 个会话明日继续（本次其余仅规则）`);
    } else if (aiDeferredReason === "time") {
      parts.push("本次 AI 阶段已达 10 分钟上限");
      if (pending > 0) parts.push(`剩余 ${pending} 个会话下次扫描继续`);
    } else if (aiDeferredReason === "budget") {
      parts.push(`本次 AI 预算已用完（${Math.max(0, Math.round(Number(aiBudget) || 0))} 次）其余仅规则`);
      if (pending > 0) parts.push(`剩余 ${pending} 个会话下次扫描继续`);
    } else if (pending > 0) {
      parts.push(`剩余 ${pending} 个会话下次扫描继续`);
    }
    if (mergedTasks > 0) parts.push(`合并重复卡 ${mergedTasks}`);
    if (aiFailureCount > 0) parts.push(`${aiFailureCount} 个会话研判失败，5 分钟后重试`);
    return parts.join(" · ");
  }

  /* ------------------------- AI model catalog ----------------------- */

  /** 30s catalog cache + in-flight dedupe; invalidated by DSH model events. */
  let aiCatalogCache = { at: 0, data: null };
  let aiCatalogPromise = null;
  let aiCatalogGeneration = 0;
  const aiCatalogOffs = [];

  function invalidateAiCatalog() {
    aiCatalogGeneration += 1;
    aiCatalogCache = { at: 0, data: null };
    aiCatalogPromise = null;
  }

  /** Build the flat `GET /ai/models` payload (one provider failure never hides the rest). */
  async function buildAiCatalog() {
    const llm = llmService();
    const fetchedAt = new Date().toISOString();
    if (!llm) {
      return { catalogAvailable: false, default: null, providers: [], models: [], failures: [], fetchedAt };
    }
    const routes = providerRoutes(llm);
    const perProvider = await Promise.all(
      routes.map(async (route) => {
        try {
          const models = await withTimeout(llm.listModels(route.id), aiCatalogTimeoutMsValue, "catalog-timeout");
          const list = (Array.isArray(models) ? models : [])
            .filter((model) => model && typeof model.id === "string" && model.id)
            .map((model) => ({
              provider: route.id,
              id: model.id,
              name: typeof model.name === "string" && model.name ? model.name : model.id,
            }));
          return { id: route.id, name: route.name, models: list, failure: null };
        } catch (error) {
          logWarn(`[super-kanban] listModels(${route.id}) failed: ${shortError(error)}`);
          return { id: route.id, name: route.name, models: [], failure: shortError(error) };
        }
      }),
    );
    return {
      catalogAvailable: true,
      default: defaultModelSelection(),
      providers: perProvider.map((provider) => ({ id: provider.id, name: provider.name, modelCount: provider.models.length })),
      models: perProvider.flatMap((provider) => provider.models),
      failures: perProvider
        .filter((provider) => provider.failure)
        .map((provider) => ({ provider: provider.id, name: provider.name, message: provider.failure })),
      fetchedAt,
    };
  }

  async function getAiCatalog() {
    if (aiCatalogCache.data && Date.now() - aiCatalogCache.at < AI_CATALOG_TTL_MS) return aiCatalogCache.data;
    if (aiCatalogPromise) return aiCatalogPromise;
    const generation = aiCatalogGeneration;
    const promise = buildAiCatalog();
    aiCatalogPromise = promise;
    try {
      const data = await promise;
      // Do not repopulate a cache that an event invalidated while we were listing.
      if (generation === aiCatalogGeneration) aiCatalogCache = { at: Date.now(), data };
      return data;
    } catch (error) {
      // The endpoint must degrade instead of 500: report it through `failures[]`.
      logWarn(`[super-kanban] AI model catalog failed: ${shortError(error)}`);
      return {
        catalogAvailable: Boolean(llmService()),
        default: defaultModelSelection(),
        providers: [],
        models: [],
        failures: [{ provider: "", name: "", message: shortError(error) }],
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      if (aiCatalogPromise === promise) aiCatalogPromise = null;
    }
  }

  /** Subscribe to DSH catalog events when the host event bus exists. */
  function subscribeAiCatalogEvents() {
    if (typeof ctx?.on !== "function") return;
    const invalidate = () => invalidateAiCatalog();
    for (const event of ["llm/adapters-updated", "llm/models-updated"]) {
      try {
        const off = ctx.on(event, invalidate);
        if (typeof off === "function") aiCatalogOffs.push(off);
      } catch {
        /* absent event: the 30s TTL still bounds staleness */
      }
    }
  }

  for (const diagnostic of loaded.diagnostics) {
    logWarn(`[super-kanban] store: ${diagnostic.kind}: ${diagnostic.message}`);
  }
  logInfo(
    `[super-kanban] host ready · tasks=${state.tasks.length} · sessions cached=${Object.keys(cache.sessions).length}`,
  );

  /* ------------------------------ broadcast ------------------------ */

  function broadcast(event, data) {
    if (sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...sseClients]) {
      // A client that half-closed without firing 'close' yet is dropped instead
      // of accumulating buffered payloads in memory.
      if (client.res.writableEnded || client.res.destroyed) {
        removeSseClient(client);
        continue;
      }
      // Backpressure: a tab that stopped reading but kept the socket open would
      // make Node buffer event payloads without bound. Drop it when >1MB is
      // already queued (a write that reports back-pressure on an unread socket
      // is also dropped); EventSource reconnects automatically.
      if ((Number(client.res.writableLength) || 0) > SSE_MAX_BUFFER_BYTES) {
        removeSseClient(client);
        continue;
      }
      try {
        const accepted = client.res.write(payload);
        if (accepted === false || (Number(client.res.writableLength) || 0) > SSE_MAX_BUFFER_BYTES) {
          removeSseClient(client);
        }
      } catch {
        removeSseClient(client);
      }
    }
  }

  function removeSseClient(client) {
    if (!sseClients.has(client)) return;
    sseClients.delete(client);
    clearInterval(client.heartbeat);
    try {
      client.res.end();
    } catch {
      /* response already closed */
    }
  }

  function emitChanged(reason, tasksChanged = 0) {
    broadcast("changed", { reason, tasksChanged });
  }

  function broadcastScan(force = false) {
    if (sseClients.size === 0) return;
    const now = Date.now();
    const send = () => {
      lastScanBroadcast = Date.now();
      broadcast("scan", state.scan);
    };
    if (force || now - lastScanBroadcast > 450) {
      if (scanBroadcastTimer) {
        clearTimeout(scanBroadcastTimer);
        scanBroadcastTimer = null;
      }
      send();
      return;
    }
    if (!scanBroadcastTimer) {
      scanBroadcastTimer = setTimeout(() => {
        scanBroadcastTimer = null;
        send();
      }, Math.max(50, 450 - (now - lastScanBroadcast)));
    }
  }

  /* ------------------------------ persistence ---------------------- */

  function persistState() {
    if (suppressPersist) return;
    try {
      store.saveState(state);
    } catch (error) {
      logWarn(`[super-kanban] failed to save state: ${String(error?.message || error)}`);
    }
  }

  function persistCache() {
    try {
      store.saveCache(cache);
    } catch (error) {
      logWarn(`[super-kanban] failed to save session cache: ${String(error?.message || error)}`);
    }
  }

  /** Persist state at most every few seconds during a long scan. */
  function schedulePersist() {
    if (saveTimer || suppressPersist || stopped) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistState();
      persistCache();
    }, 2000);
  }

  /* ------------------------------ derived state -------------------- */

  function workspaceById(id) {
    return state.workspaces.find((workspace) => workspace.id === id) || null;
  }

  function computeStats() {
    const active = state.tasks.filter((task) => !task.archived);
    const byStatus = { backlog: 0, in_progress: 0, blocked: 0, done: 0 };
    let progressSum = 0;
    let progressCount = 0;
    let issues = 0;
    let aiAnalyzed = 0;
    for (const task of active) {
      if (byStatus[task.status] !== undefined) byStatus[task.status] += 1;
      if (Number.isFinite(task.progress)) {
        progressSum += task.progress;
        progressCount += 1;
      }
      issues += Array.isArray(task.issues) ? task.issues.length : 0;
      if (task.ai && task.ai.analyzedAt) aiAnalyzed += 1;
    }
    const total = state.tasks.length;
    const archived = total - active.length;
    const now = Date.now();
    let activeSessions = 0;
    for (const entry of Object.values(cache.sessions)) {
      if (entry?.meta?.lastActivityAt && now - entry.meta.lastActivityAt < DAY) activeSessions += 1;
    }
    if (activeSessions === 0) {
      activeSessions = active.filter((task) => now - (task.lastActivityAt || 0) < DAY).length;
    }
    return {
      total,
      archived,
      byStatus,
      doneRate: active.length > 0 ? Math.round((byStatus.done / active.length) * 100) / 100 : 0,
      activeSessions,
      avgProgress: progressCount > 0 ? Math.round(progressSum / progressCount) : 0,
      aiAnalyzed,
      issues,
    };
  }

  function computeActivity(days = 14) {
    const counts = new Map();
    const now = Date.now();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      counts.set(new Date(now - offset * DAY).toISOString().slice(0, 10), 0);
    }
    for (const entry of Object.values(cache.sessions)) {
      const activity = entry?.meta?.activity;
      if (!activity) continue;
      for (const [day, count] of Object.entries(activity)) {
        if (counts.has(day)) counts.set(day, counts.get(day) + count);
      }
    }
    return [...counts.entries()].map(([day, count]) => ({ day, count }));
  }

  function computeWorkspaces(discoveryWorkspaces = null, sessions = null) {
    const metas = sessions || [...sessionsById.values()];
    const lastActivity = new Map();
    for (const meta of metas) {
      if (!meta.workspaceId) continue;
      const previous = lastActivity.get(meta.workspaceId) || 0;
      lastActivity.set(meta.workspaceId, Math.max(previous, meta.lastActivityAt || 0));
    }
    const base = discoveryWorkspaces || state.workspaces;
    const excluded = new Set(state.settings.excludeWorkspaces || []);
    return base.map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount:
        discoveryWorkspaces && sessions
          ? sessions.filter((meta) => meta.workspaceId === workspace.id && meta.origin === "main").length
          : workspace.sessionCount || 0,
      included: !excluded.has(workspace.id),
      lastActivityAt: lastActivity.get(workspace.id) || workspace.lastActivityAt || 0,
      source: workspace.source || "registry",
    }));
  }

  function buildStatePayload() {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      tasks: state.tasks,
      stats: computeStats(),
      activity: state.activity,
      workspaces: state.workspaces,
      scan: state.scan,
      settings: state.settings,
      usage: state.usage,
    };
  }

  /* --------------------------- v2 helpers -------------------------- */

  function mapTurnEndKind(kind) {
    if (kind === "completed" || kind === "error") return kind;
    if (kind === "aborted" || kind === "interrupted") return "interrupted";
    return null;
  }

  function sessionContextFromMeta(meta, parsed = null) {
    if (!meta) return null;
    const todos = parsed ? source.latestTodos(parsed) : { todoTotal: 0, todoDone: 0 };
    const lastTodo = parsed?.todoSnapshots?.[parsed.todoSnapshots.length - 1];
    const parsedCounts = lastTodo
      ? (() => {
          const total = lastTodo.todos.length;
          const done = lastTodo.todos.filter((todo) => todo.status === "completed").length;
          return { todoTotal: total, todoDone: done };
        })()
      : null;
    const todoCounts = meta.todoCounts || { total: 0, completed: 0 };
    return {
      sessionId: meta.id,
      title: meta.title || (parsed ? parsed.title : ""),
      isLive: parsed ? Boolean(parsed.isLive) : Boolean(meta.isLive),
      turnCount: parsed ? parsed.turnCount : meta.turnCount || 0,
      lastTurnEnd: mapTurnEndKind(parsed ? parsed.lastTurnEnd?.kind : meta.lastTurnEnd?.kind),
      lastActivityAt: parsed ? parsed.lastActivityAt : meta.lastActivityAt || 0,
      todoTotal: parsedCounts ? parsedCounts.todoTotal : todoCounts.total || 0,
      todoDone: parsedCounts ? parsedCounts.todoDone : todoCounts.completed || 0,
    };
  }

  /** Deterministic v2 task context for one session (no LLM tokens). */
  function buildV2Context(parsed, meta, workspaceTitle) {
    return {
      sessionId: parsed.id,
      sessionTitle: parsed.title,
      timeBySeq: parsed.timeBySeq,
      workspaceId: meta?.workspaceId || null,
      workspaceTitle: workspaceTitle || meta?.workspaceTitle || null,
      workspacePath: meta?.workspacePath || null,
      artifacts: source.extractArtifacts(parsed, { workspacePath: meta?.workspacePath }),
      subtasks: source.extractSubtasks(parsed),
      sessionContext: sessionContextFromMeta(meta, parsed),
      sessionGoal: parsed.goal?.text
        ? { text: parsed.goal.text, status: parsed.goal.status || "active" }
        : meta?.goalText
          ? { text: meta.goalText, status: meta.goalStatus || "active" }
          : null,
    };
  }

  function mergeKeyFacts(primary = [], secondary = []) {
    const merged = dedupeByText([...(primary || []), ...(secondary || [])], KEYFACT_LIMIT);
    return merged.map((fact, index) => {
      // Never invent seq 0: unresolved citations stay null (UI hides them).
      const seq = positiveSeqOrNull(fact.seq);
      return {
        id: fact.id || shortId("k", `${fact.sessionId || ""}:${seq ?? "na"}:${fact.text}:${index}`),
        text: clipText(fact.text, KEYFACT_TEXT_LIMIT),
        kind: ["status", "progress", "issue", "decision", "artifact", "goal"].includes(fact.kind) ? fact.kind : "status",
        sessionId: fact.sessionId || null,
        seq,
      };
    });
  }

  function mergeSubtasks(...sources) {
    const manual = [];
    const others = [];
    for (const sourceList of sources) {
      for (const subtask of sourceList || []) {
        const text = typeof subtask?.text === "string" ? subtask.text.trim() : "";
        if (!text) continue;
        const item = {
          id: subtask.id || shortId("s", `${subtask.source || "ai"}:${text}`),
          text: clipText(text, SUBTASK_TEXT_LIMIT),
          done: subtask.done === true,
          source: ["ai", "todo", "manual"].includes(subtask.source) ? subtask.source : "ai",
          seq: positiveSeqOrNull(subtask.seq),
        };
        if (item.source === "manual") manual.push(item);
        else others.push(item);
      }
    }
    // Manual subtasks win over generated ones with the same text.
    return dedupeByText([...manual, ...others], SUBTASK_LIMIT);
  }

  function mergeArtifacts(primary = [], secondary = []) {
    const seen = new Set();
    const merged = [];
    for (const item of [...(primary || []), ...(secondary || [])]) {
      if (!item || typeof item !== "object") continue;
      const key = item.absPath || item.path || item.name;
      if (!key || seen.has(key)) continue;
      // DSH preview needs the file to exist; drop stale paths (moved/deleted).
      if (item.absPath) {
        try {
          if (!fs.existsSync(item.absPath)) continue;
        } catch {
          continue;
        }
      }
      seen.add(key);
      merged.push(item);
      if (merged.length >= ARTIFACT_LIMIT) break;
    }
    return merged;
  }

  function progressFromSubtasks(subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
    const done = subtasks.filter((subtask) => subtask.done).length;
    return Math.round((done / subtasks.length) * 100);
  }

  /**
   * Unfinished subtasks the user owns (source manual) or explicitly locked via
   * `lockedFields: ["subtasks"]`. These may never be auto-closed by an AI/rule
   * "done" verdict: the user's checklist is authoritative for their own work.
   */
  function trustedUnfinishedSubtasks(task) {
    if (!task || !Array.isArray(task.subtasks)) return [];
    const subtasksLocked = (task.lockedFields || []).includes("subtasks");
    return task.subtasks.filter((subtask) => !subtask.done && (subtask.source === "manual" || subtasksLocked));
  }

  /**
   * Keep a card in_progress when an AI/rule verdict says done but the user still
   * has unfinished manual (or locked) subtasks. The proposal stays visible in the
   * task history, so the user can decide to finish it from the board.
   * Returns true when the status was downgraded.
   */
  function keepInProgressForUnfinishedUserWork(task, engine) {
    if (!task || task.status !== "done") return false;
    // The user owns the status field when locked; never override their choice.
    if ((task.lockedFields || []).includes("status")) return false;
    const unfinished = trustedUnfinishedSubtasks(task);
    if (unfinished.length === 0) return false;
    const manual = unfinished.filter((subtask) => subtask.source === "manual").length;
    const reason = manual > 0 ? `${manual} 个手动子任务` : `${unfinished.length} 个锁定的子任务`;
    const label = engine === "llm" ? "AI" : "规则引擎";
    task.status = "in_progress";
    pushHistory(task, {
      kind: "status",
      from: "done",
      to: "in_progress",
      by: "ai",
      note: `${label}建议完成，但仍有 ${reason}未完成；保持进行中，请手动确认后归档`,
    });
    return true;
  }

  /**
   * A task marked done must not keep unfinished *generated* subtasks (imported
   * TODO plans can be stale); close them so progress/subtask state stays
   * self-consistent. User-owned (manual) subtasks and locked subtask lists are
   * never touched automatically.
   */
  function closeSubtasksForDoneTask(task) {
    if (!task || task.status !== "done" || !Array.isArray(task.subtasks) || task.subtasks.length === 0) return false;
    if ((task.lockedFields || []).includes("subtasks")) return false;
    const closable = task.subtasks.filter((subtask) => !subtask.done && subtask.source !== "manual");
    if (closable.length === 0) return false;
    task.subtasks = task.subtasks.map((subtask) =>
      !subtask.done && subtask.source !== "manual" ? { ...subtask, done: true } : subtask,
    );
    return true;
  }

  /** User unchecked/added unfinished work on a done card → move it back to in_progress. */
  function reopenIfSubtasksUnfinished(task) {
    if (!task || task.status !== "done" || !Array.isArray(task.subtasks) || task.subtasks.length === 0) return false;
    if (!task.subtasks.some((subtask) => !subtask.done)) return false;
    task.status = "in_progress";
    pushHistory(task, { kind: "status", from: "done", to: "in_progress", by: "user", note: "子任务未完成，任务回到进行中" });
    return true;
  }

  /** v2 contract: progress follows subtask completion when subtasks exist. */
  function syncProgressFromSubtasks(task) {
    if (!task || (task.lockedFields || []).includes("progress")) return false;
    const next = progressFromSubtasks(task.subtasks);
    if (next === null || task.progress === next) return false;
    task.progress = next;
    return true;
  }

  function goalObjectFor(analysis, context, status) {
    const sessionGoal = context?.sessionGoal;
    const text = clipText(sessionGoal?.text || analysis?.goalText || analysis?.goal || "", GOAL_TEXT_LIMIT);
    const doneStatus = status === "done" ? "done" : null;
    if (sessionGoal?.text) {
      return { text, status: sessionGoal.status === "done" || doneStatus === "done" ? "done" : "active", source: "session" };
    }
    return { text, status: doneStatus === "done" ? "done" : text ? "active" : "none", source: "task" };
  }

  /** goal.status must follow task.status (active/done; none when no goal text). */
  function syncGoalStatus(task) {
    if (!task || !task.goal || typeof task.goal !== "object") return false;
    const next = task.goal.text ? (task.status === "done" ? "done" : "active") : "none";
    if (task.goal.status === next) return false;
    task.goal = { ...task.goal, status: next };
    return true;
  }

  /** Keep deterministic v2 fields fresh without touching AI verdicts. */
  function refreshTaskDeterministic(task, meta, context) {
    if (!task) return false;
    let changed = false;
    const previousSubtasks = JSON.stringify(task.subtasks || []);
    const manual = (task.subtasks || []).filter((subtask) => subtask.source === "manual");
    const mergedSubtasks = mergeSubtasks((context?.subtasks || []), (task.subtasks || []).filter((s) => s.source !== "manual"), manual);
    if (JSON.stringify(mergedSubtasks) !== previousSubtasks) {
      task.subtasks = mergedSubtasks;
      changed = true;
    }
    const artifacts = mergeArtifacts(context?.artifacts || [], task.artifacts || []);
    if (JSON.stringify(artifacts) !== JSON.stringify(task.artifacts || [])) {
      task.artifacts = artifacts;
      changed = true;
    }
    if (context?.sessionContext && (!task.sessionContext || task.primarySessionId === meta.id)) {
      const nextContext = { ...context.sessionContext };
      if (JSON.stringify(nextContext) !== JSON.stringify(task.sessionContext)) {
        task.sessionContext = nextContext;
        changed = true;
      }
    }
    if (context?.sessionGoal && (!task.goal || !task.goal.text)) {
      task.goal = goalObjectFor(null, context, task.status);
      changed = true;
    }
    if (closeSubtasksForDoneTask(task)) changed = true;
    if (syncProgressFromSubtasks(task)) changed = true;
    if (
      task.status === "done" &&
      !(task.lockedFields || []).includes("progress") &&
      task.progress !== 100 &&
      trustedUnfinishedSubtasks(task).length === 0
    ) {
      task.progress = 100;
      changed = true;
    }
    if (syncGoalStatus(task)) changed = true;
    if (changed) {
      attachSession(task, meta, (task.evidence || []).length);
      task.lastActivityAt = Math.max(task.lastActivityAt || 0, meta.lastActivityAt || 0);
      task.updatedAt = new Date().toISOString();
      truncateTask(task);
    }
    return changed;
  }

  /**
   * Meaningful-change gate (v2 token efficiency).
   * Re-judge only when: first analysis, a turn ended after the last analysis, or
   * a new user message arrived (after the cooldown). Live turns wait for their
   * end — tool-only appends never trigger an LLM call.
   */
  function shouldRunAi(meta, cachedMeta) {
    if (!cachedMeta || !cachedMeta.aiAt) return true; // first analysis
    const lastAiSeq = Number(cachedMeta.aiLastSeq) || 0;
    const lastEndSeq = Number(meta.lastTurnEnd?.seq) || 0;
    const turnEndedSince = lastEndSeq > lastAiSeq;
    const userIncreased = (meta.userCount || 0) > (cachedMeta.aiUserCount || 0);
    const intervalOk = Date.now() - (Date.parse(cachedMeta.aiAt) || 0) >= MIN_AI_INTERVAL_MS;
    if (!intervalOk) return false;
    if (meta.isLive) {
      // Same live turn: wait for the turn to finish before spending tokens.
      return turnEndedSince;
    }
    return turnEndedSince || userIncreased;
  }

  /** Very small sessions are cheap to card with rules only. */
  function isLowValueForAi(meta) {
    const userCount = meta.userCount || 0;
    const eventCount = meta.eventCount || 0;
    const signals = (meta.deliverableCount || 0) + (meta.errorCount || 0);
    return userCount < 2 && eventCount < 60 && signals === 0;
  }

  function dailyAiRemaining() {
    const usage = rolloverUsage(state.usage);
    state.usage = usage;
    return Math.max(0, (state.settings.dailyAiCallLimit || DEFAULT_SETTINGS.dailyAiCallLimit) - usage.calls);
  }

  function recordUsage({ calls = 0, tokens = 0 } = {}) {
    state.usage = rolloverUsage(state.usage);
    state.usage.calls += Math.max(0, Number(calls) || 0);
    state.usage.tokens += Math.max(0, Number(tokens) || 0);
  }

  function applyAiMeta(metaId, meta, { digestBytes = 0 } = {}) {
    const entry = cache.sessions[metaId] || { sigKey: meta.sigKey, meta };
    entry.meta = {
      ...(entry.meta || meta),
      aiAt: new Date().toISOString(),
      aiLastSeq: meta.lastEventSeq || 0,
      aiUserCount: meta.userCount || 0,
      aiTurnEndKind: meta.lastTurnEnd?.kind || null,
      aiDigestBytes: digestBytes || 0,
      // A successful analysis clears the previous failure/cooldown markers so a
      // stale error can never gate the next meaningful change.
      llmError: null,
      aiErrorAt: null,
    };
    cache.sessions[metaId] = entry;
    sessionsById.set(metaId, entry.meta);
    return entry.meta;
  }

  /* ------------------------------ scan ----------------------------- */

  function findTaskBySession(sessionId) {
    if (!sessionId) return null;
    return (
      state.tasks.find(
        (task) =>
          task.origin !== "manual" &&
          (task.primarySessionId === sessionId ||
            (Array.isArray(task.sessions) && task.sessions.some((session) => session.id === sessionId))),
      ) || null
    );
  }

  /* --------------------- cross-session duplicate merge --------------- */

  function dedupeByText(items, limit) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
      if (!item || typeof item.text !== "string") continue;
      const key = item.text.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Merge auto tasks that describe the same ongoing work (same workspace +
   * similar title), e.g. the same "workspace audit" run in two sessions.
   * Manual / user-edited / locked cards are never merged.
   */
  function mergeDuplicateTasks() {
    const me = [];
    for (const task of state.tasks) {
      if (task.archived) continue;
      if (task.origin !== "auto") continue; // manual + auto+edited are protected
      if ((task.lockedFields || []).length > 0) continue;
      me.push(task);
    }
    let mergedCount = 0;
    for (;;) {
      let best = null;
      for (let i = 0; i < me.length; i++) {
        const left = me[i];
        if (!left || !state.tasks.includes(left)) continue;
        for (let j = i + 1; j < me.length; j++) {
          const right = me[j];
          if (!right || !state.tasks.includes(right)) continue;
          if (!left.workspaceId || left.workspaceId !== right.workspaceId) continue;
          const sameSession = left.primarySessionId && left.primarySessionId === right.primarySessionId;
          const score = titleMergeScore(left.title, right.title);
          // Cards split from the very same session are usually intentional;
          // only accept near-identical titles for them.
          const threshold = sameSession ? 0.85 : 0.62;
          if (score < threshold) continue;
          if (!best || score > best.score) best = { left, right, score };
        }
      }
      if (!best) break;
      const [target, source] =
        (Date.parse(best.left.createdAt) || 0) <= (Date.parse(best.right.createdAt) || 0)
          ? [best.left, best.right]
          : [best.right, best.left];
      mergeTaskInto(target, source);
      mergedCount += 1;
    }
    return mergedCount;
  }

  function mergeTaskInto(target, source) {
    const nowIso = new Date().toISOString();
    const targetLastActivity = target.lastActivityAt || 0;
    const sessionMap = new Map();
    for (const session of [...(target.sessions || []), ...(source.sessions || [])]) {
      if (session?.id && !sessionMap.has(session.id)) sessionMap.set(session.id, session);
    }
    target.sessions = [...sessionMap.values()].slice(0, MAX_SESSIONS_PER_TASK);
    if (!target.primarySessionId) target.primarySessionId = source.primarySessionId;
    target.evidence = mergeTaskEvidence(target.evidence, source.evidence);
    target.issues = dedupeByText([...(target.issues || []), ...(source.issues || [])], 8);
    target.milestones = dedupeByText([...(target.milestones || []), ...(source.milestones || [])], 20);
    target.nextSteps = dedupeByText(
      [...(target.nextSteps || []).map((text) => ({ text })), ...(source.nextSteps || []).map((text) => ({ text }))],
      5,
    ).map((item) => item.text);
    target.lastActivityAt = Math.max(target.lastActivityAt || 0, source.lastActivityAt || 0);
    const sourceIsNewer = (source.lastActivityAt || 0) > targetLastActivity;
    // v2 fields merge: key facts / subtasks / artifacts / goal / sessionContext.
    target.keyFacts = mergeKeyFacts(target.keyFacts || [], source.keyFacts || []);
    target.subtasks = mergeSubtasks(source.subtasks || [], target.subtasks || []);
    target.artifacts = mergeArtifacts(target.artifacts || [], source.artifacts || []);
    if ((!target.goal || !target.goal.text) && source.goal?.text) target.goal = { ...source.goal };
    if (!target.sessionContext && source.sessionContext) target.sessionContext = { ...source.sessionContext };
    if (sourceIsNewer && source.sessionContext && target.primarySessionId === source.primarySessionId) {
      target.sessionContext = { ...source.sessionContext };
    }
    // The newer card carries the freshest verdict (status/progress/AI reason).
    if (sourceIsNewer && !(target.lockedFields || []).includes("status")) target.status = source.status;
    if (!(target.lockedFields || []).includes("progress")) {
      const subtaskProgress = progressFromSubtasks(target.subtasks);
      if (subtaskProgress !== null) target.progress = subtaskProgress;
      else if (sourceIsNewer) target.progress = source.progress;
    }
    if (source.ai && (!target.ai || Date.parse(source.ai.analyzedAt || 0) > Date.parse(target.ai.analyzedAt || 0))) {
      target.ai = source.ai;
    }
    refreshSessionEvidenceCounts(target);
    target.updatedAt = nowIso;
    pushHistory(target, {
      kind: "merge",
      by: "ai",
      note: `合并重复会话：${clipText(source.title, 60)}`,
    });
    state.tasks = state.tasks.filter((task) => task.id !== source.id);
    state.deletedLog.push({
      id: source.id,
      title: source.title,
      origin: source.origin,
      deletedAt: nowIso,
      sessionIds: (source.sessions || []).map((session) => session.id),
      reason: "merge",
      mergedInto: target.id,
    });
    if (state.deletedLog.length > 50) state.deletedLog = state.deletedLog.slice(-50);
    truncateTask(target);
    // Privacy: ids only — task titles come from user sessions and do not belong in logs.
    logInfo(`[super-kanban] merged duplicate task ${source.id} into ${target.id}`);
  }

  function sessionEntryFromMeta(meta, evidenceCount = 0) {
    return {
      id: meta.id,
      title: meta.title || `会话 ${String(meta.id).slice(-6)}`,
      seqEnd: meta.lastEventSeq || 0,
      evidenceCount,
    };
  }

  function isEligibleForAutoTask(meta, cutoff) {
    if (meta.origin !== "main") return false;
    if (!meta.hasUserMessages) return false;
    if (state.ignoredSessions.includes(meta.id)) return false;
    if (state.suppressedSessions.includes(meta.id)) return false;
    if (meta.workspaceId && (state.settings.excludeWorkspaces || []).includes(meta.workspaceId)) return false;
    const bound = findTaskBySession(meta.id);
    const tooOld = meta.lastActivityAt && meta.lastActivityAt < cutoff;
    if (!bound && tooOld) return false;
    return true;
  }

  function promptCandidateTasks(meta) {
    const bound = findTaskBySession(meta.id);
    const result = [];
    if (bound) result.push(bound);
    for (const task of state.tasks) {
      if (result.length >= 6) break;
      if (task.origin === "manual" || task.archived) continue;
      if (result.includes(task)) continue;
      if (meta.workspaceId && task.workspaceId === meta.workspaceId) result.push(task);
    }
    return result.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      progress: task.progress,
      sessions: task.sessions,
    }));
  }

  /** Build the compact meta object persisted in sessions-cache.json. */
  function cacheEntryFor(parsed, discovered) {
    const meta = source.metaFromParsed(parsed);
    const previous = cache.sessions[meta.id]?.meta || null;
    meta.workspaceId = discovered?.workspaceId ?? previous?.workspaceId ?? null;
    meta.workspaceTitle = discovered?.workspaceTitle ?? previous?.workspaceTitle ?? null;
    meta.workspacePath = discovered?.workspacePath ?? previous?.workspacePath ?? null;
    meta.goalText = discovered?.goalText ?? meta.goalText ?? previous?.goalText ?? null;
    meta.goalStatus = discovered?.goalStatus ?? meta.goalStatus ?? previous?.goalStatus ?? null;
    meta.turnOutline = parsed.turnOutline || previous?.turnOutline || [];
    // Keep the meaningful-change gate markers across re-parses.
    meta.aiAt = previous?.aiAt || null;
    meta.aiLastSeq = previous?.aiLastSeq || 0;
    meta.aiUserCount = previous?.aiUserCount || 0;
    meta.aiTurnEndKind = previous?.aiTurnEndKind ?? null;
    meta.aiDigestBytes = previous?.aiDigestBytes || 0;
    meta.llmError = previous?.llmError || null;
    meta.aiErrorAt = previous?.aiErrorAt || null;
    return { sigKey: meta.sigKey, meta };
  }

  function hydrateMeta(discovered) {
    const cached = cache.sessions[discovered.id];
    const meta = cached?.meta
      ? { ...cached.meta }
      : {
          id: discovered.id,
          file: discovered.file,
          dir: discovered.dir,
          sig: discovered.sig,
          sigKey: discovered.sigKey,
          title: discovered.title,
          createdAt: discovered.createdAt,
          cwd: discovered.cwd,
          parentSession: discovered.parentSession,
          delegationDepth: discovered.delegationDepth,
          origin: discovered.origin,
          lastActivityAt: discovered.lastActivityAt,
          lastEventSeq: 0,
          eventCount: 0,
          turnCount: discovered.turnCount,
          isLive: false,
          hasUserMessages: false,
          userCount: 0,
          deliverableCount: 0,
          errorCount: 0,
          todoCounts: { total: 0, completed: 0, pending: 0, inProgress: 0 },
          turnOutline: discovered.turnOutline,
          activity: {},
          aiAt: null,
        };
    // Workspace registry can change between scans — always trust discovery.
    meta.workspaceId = discovered.workspaceId ?? meta.workspaceId ?? null;
    meta.workspaceTitle = discovered.workspaceTitle ?? meta.workspaceTitle ?? null;
    meta.workspacePath = discovered.workspacePath ?? meta.workspacePath ?? null;
    meta.goalText = discovered.goalText ?? meta.goalText ?? null;
    meta.goalStatus = discovered.goalStatus ?? meta.goalStatus ?? null;
    meta.file = discovered.file;
    meta.dir = discovered.dir;
    meta.sig = discovered.sig;
    meta.sigKey = discovered.sigKey;
    return meta;
  }

  function collectSubagentSummary(parsed, meta) {
    return {
      id: parsed.id,
      title: parsed.title,
      isLive: parsed.isLive,
      lastActivityAt: parsed.lastActivityAt,
      lastEventSeq: parsed.lastEvent?.seq || 0,
      eventCount: parsed.eventCount,
      turnEndKind: parsed.lastTurnEnd?.kind || null,
      lastAssistantText: parsed.lastAssistantText?.text || "",
      deliverables: parsed.deliverables.length,
    };
  }

  /**
   * Fold subagent sessions into the parent task as evidence items, so the board
   * stays clean (no cards for subagents) while their work remains traceable.
   */
  function foldChildEvidence(analysis, meta, childSummaries) {
    const childIds = parentToChildren.get(meta.id) || [];
    if (!childIds.length) return analysis;
    const extra = [];
    for (const childId of childIds) {
      const child = childSummaries.get(childId);
      if (!child) continue;
      const stateLabel = child.isLive ? "进行中" : child.turnEndKind === "error" ? "以错误结束" : "已完成";
      const kind = child.isLive ? "tool" : "artifact";
      extra.push({
        id: `e_${childId.slice(-6)}_subagent`,
        kind,
        text: `子代理会话「${clipText(child.title, 40)}」${stateLabel}（${child.eventCount} 事件${child.deliverables ? `，${child.deliverables} 次交付` : ""}）`,
        quote: clipText(child.lastAssistantText || child.title, 240),
        seq: child.lastEventSeq,
        time: child.lastActivityAt,
        sessionId: child.id,
        sessionTitle: child.title,
      });
    }
    if (!extra.length) return analysis;
    const merged = [...(analysis.evidence || []), ...extra];
    return { ...analysis, evidence: merged.slice(0, EVIDENCE_LIMIT) };
  }

  /** Parse one discovered session; updates cache; returns parse result. */
  function parseDiscovered(discovered) {
    const meta = hydrateMeta(discovered);
    const parsed = source.loadParsed(meta);
    return { parsed, meta };
  }

  function startScan(mode = "incremental") {
    if (stopped) return { ok: false, error: "stopped", message: "服务已停止" };
    // The analyzer instance (budget/transport) is shared with explicit AI
    // commands, so a scan must never overlap task.analyze/task.polishPrompt.
    if (aiBusy) return { ok: false, error: "busy", message: "AI 任务进行中，请稍后再试" };
    if (scanPromise) return { ok: false, error: "busy", message: "扫描正在进行中" };
    const scanMode = mode === "full" ? "full" : "incremental";
    scanCancel = false;
    scanAbort = new AbortController();
    const startedAt = new Date();
    state.scan = {
      ...emptyScanState(),
      state: "running",
      startedAt: startedAt.toISOString(),
      message: "正在发现会话…",
    };
    scanDigestBytes = [];
    broadcastScan(true);
    scanPromise = (async () => {
      let failure = null;
      try {
        await runScanBody(scanMode);
      } catch (error) {
        failure = error;
        logWarn(`[super-kanban] scan failed: ${String(error?.message || error)}`);
      } finally {
        // Finalization must never reject: scanPromise is the scan mutex, so a
        // throw here would leave every future scan permanently "busy" and emit
        // an unhandled rejection into the host process.
        try {
          finalizeScan(failure, startedAt);
        } catch (error) {
          logWarn(`[super-kanban] scan finalize failed: ${String(error?.message || error)}`);
        } finally {
          scanPromise = null;
          scanAbort = null;
        }
      }
    })();
    return { ok: true, data: { accepted: true, mode: scanMode, startedAt: state.scan.startedAt } };
  }

  /** Commit one scan's outcome, usage counters and derived board data. */
  function finalizeScan(failure, startedAt) {
    const finishedAt = new Date();
    state.scan.state = failure ? "error" : "done";
    state.scan.finishedAt = finishedAt.toISOString();
    state.scan.error = failure ? String(failure?.message || failure) : null;
    if (failure) state.scan.message = `扫描失败：${state.scan.error}`;
    else if (scanCancel) state.scan.message = "扫描已取消（已完成部分保留）";
    else if (!state.scan.message || !String(state.scan.message).startsWith("扫描完成")) {
      state.scan.message = `扫描完成：${state.scan.processed}/${state.scan.total} 个会话`;
    }
    state.settings.lastScanAt = finishedAt.toISOString();
    state.activity = computeActivity();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const digestBytesAvg = scanDigestBytes.length
      ? Math.round(scanDigestBytes.reduce((sum, value) => sum + value, 0) / scanDigestBytes.length)
      : 0;
    state.usage = rolloverUsage(state.usage);
    state.usage.lastScan = {
      calls: state.scan.aiCalls,
      tokens: state.scan.tokens,
      durationMs,
      digestBytesAvg,
    };
    recordUsage({ calls: state.scan.aiCalls, tokens: state.scan.tokens });
    persistState();
    persistCache();
    broadcastScan(true);
    emitChanged("scan", state.scan.newTasks + state.scan.updatedTasks);
    logInfo(
      `[super-kanban] scan ${failure ? "failed" : "done"} · processed=${state.scan.processed}/${state.scan.total} · new=${state.scan.newTasks} updated=${state.scan.updatedTasks} aiCalls=${state.scan.aiCalls}`,
    );
  }

  async function runScanBody(mode) {
    const discovery = source.discover();
    parentToChildren = new Map();
    for (const [parentId, childId] of discovery.childToParent || []) {
      if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
      parentToChildren.get(parentId).push(childId);
    }
    const discoverySessions = discovery.sessions;
    state.scan.total = discoverySessions.length;
    state.scan.message = `发现 ${discoverySessions.length} 个会话，开始分析…`;
    broadcastScan(true);

    const cutoff = Date.now() - (state.settings.initialDays || 30) * DAY;
    const childSummaries = new Map();
    let orphanMerged = 0;
    let lowValueSkipped = 0;
    let aiBudgetExhausted = false;
    scanDigestBytes = [];
    /** @type {Array<{meta:object, digest:string, rules:object, context:object, needsAi:boolean}>} */
    const analysisJobs = [];

    for (const discovered of discoverySessions) {
      if (stopped || scanCancel) break;
      state.scan.processed += 1;
      try {
        const cached = cache.sessions[discovered.id];
        const changed = !cached || cached.sigKey !== discovered.sigKey;
        let meta = hydrationSafe(discovered);
        let parsed = null;
        const preEligible = meta ? isEligibleForAutoTask(meta, cutoff) : false;
        // "aiMissing" re-parses a session that never got an AI verdict. Only
        // worth the parse when an AI service exists; otherwise every incremental
        // scan would re-parse every unchanged session forever.
        const aiMissing = state.settings.aiEnabled && analyzerHasService() && !cached?.meta?.aiAt;
        const forceMainParse =
          preEligible && (mode === "full" || changed || !findTaskBySession(discovered.id) || aiMissing);
        if (changed || forceMainParse) {
          try {
            const result = parseDiscovered(discovered);
            parsed = result.parsed;
            const entry = cacheEntryFor(parsed, discovered);
            meta = entry.meta;
            cache.sessions[discovered.id] = entry;
          } catch (error) {
            const previous = cache.sessions[discovered.id];
            const message = String(error?.message || error);
            // Keep the last good metadata (the board stays usable) but store the
            // CURRENT signature: an unchanged corrupt file is then not re-read on
            // every scan. A partially-written log keeps growing, so its sigKey
            // changes and the next scan retries the parse automatically.
            cache.sessions[discovered.id] = {
              sigKey: discovered.sigKey,
              meta: { ...(previous?.meta || meta || {}), id: discovered.id, parseError: message },
            };
            logWarn(`[super-kanban] skip session ${discovered.id}: ${message}`);
            continue;
          }
        } else if (meta) {
          cache.sessions[discovered.id] = { sigKey: discovered.sigKey, meta };
        }
        if (!meta) continue;
        const cachedMeta = cached?.meta || null;
        // Re-evaluate eligibility with fresh parse data (first scan has no cache).
        const eligible = isEligibleForAutoTask(meta, cutoff);
        if (parsed && meta.origin === "subagent") childSummaries.set(meta.id, collectSubagentSummary(parsed, meta));
        sessionsById.set(discovered.id, meta);
        if (parsed && eligible) {
          parsed.evidence = source.collectEvidence(parsed);
          const workspaceTitle = meta.workspaceTitle;
          const rules = analyzeSessionRules(parsed, {
            workspaceTitle,
            workspacePath: meta.workspacePath,
            maxTasks: state.settings.maxTasksPerSession || 3,
          });
          const context = buildV2Context(parsed, meta, workspaceTitle);
          // v2 token gate: low-value sessions and unchanged verdict inputs stay rules-only.
          const lowValue = isLowValueForAi(meta);
          if (lowValue) lowValueSkipped += 1;
          // A session whose last analysis failed cools down before it burns
          // another budget unit (upstream outages must not drain the daily budget).
          const failureCooling =
            cachedMeta?.aiErrorAt && Date.now() - (Date.parse(cachedMeta.aiErrorAt) || 0) < AI_ERROR_COOLDOWN_MS;
          const aiDue = state.settings.aiEnabled && !lowValue && !failureCooling && shouldRunAi(meta, cachedMeta);
          let digest = "";
          let digestBytes = 0;
          if (aiDue) {
            digest = source.buildDigest(parsed, {
              workspaceTitle,
              existingTasks: promptCandidateTasks(meta),
              baselineSeq: cachedMeta?.aiLastSeq || 0,
            });
            digestBytes = Buffer.byteLength(digest, "utf8");
            scanDigestBytes.push(digestBytes);
          }
          analysisJobs.push({
            meta,
            changed,
            firstAnalysis: !cachedMeta?.aiAt,
            digest,
            digestBytes,
            rules,
            context,
            lowValue,
            needsAi: aiDue,
          });
        }
        if (state.scan.processed % 4 === 0) {
          state.scan.message = `分析 ${state.scan.processed}/${state.scan.total} 个会话…`;
          broadcastScan();
        }
      } catch (error) {
        // One broken session must never break the scan.
        logWarn(`[super-kanban] session ${discovered.id} failed: ${String(error?.message || error)}`);
      }
      if (state.scan.processed % 6 === 0) schedulePersist();
    }

    // Phase B: LLM analysis (model route + meaningful-change gate + budgets).
    // The model route is resolved once per scan; an unavailable route degrades
    // the whole AI phase to rules-only instead of failing the scan.
    let aiDeferredReason = null;
    let aiRouteMessage = null;
    let aiFailureCount = 0;
    const aiJobs = analysisJobs.filter((job) => job.needsAi).sort(compareAiJobs);
    state.scan.aiDue = aiJobs.length;
    if (aiJobs.length > 0) {
      const dailyRemaining = dailyAiRemaining();
      if (!state.settings.aiEnabled || scanCancel || stopped) {
        state.scan.aiBudget = 0;
        state.scan.aiPending = aiJobs.length;
      } else {
        const route = await resolveAiRoute();
        if (!route.ok) {
          aiRouteMessage = route.message;
          state.scan.aiBudget = 0;
          state.scan.aiPending = aiJobs.length;
          logWarn(`[super-kanban] AI route unavailable (${route.reason}); rules only this scan`);
        } else {
          const perScanLimit = perScanAiLimit();
          // The contract defines the scan budget as min(due sessions, per-scan
          // limit, daily remaining); capping at the due count also keeps the
          // reported budget/progress meaningful (e.g. 1/2, not 1/150).
          const scanBudget = Math.max(0, Math.min(perScanLimit, dailyRemaining, aiJobs.length));
          const dailyCapped = dailyRemaining <= perScanLimit;
          state.scan.aiBudget = scanBudget;
          analyzer.resetBudget(scanBudget);
          if (scanBudget <= 0) {
            aiDeferredReason = "daily";
            aiBudgetExhausted = true;
            state.scan.aiPending = aiJobs.length;
            for (const job of aiJobs) job.llmBudgetExceeded = true;
            state.scan.message = `今日 AI 预算已用完（${state.usage.calls}/${state.settings.dailyAiCallLimit}），本次仅规则分析`;
            logWarn("[super-kanban] daily AI budget exhausted; rules only this scan");
          } else {
            state.scan.message = `AI 研判 ${aiJobs.length} 个会话（预算 ${scanBudget}）…`;
            broadcastScan(true);
            // Wall-clock guard for the whole AI stage: a slow/retrying provider
            // must never keep the scan mutex for hours.
            const aiDeadline = Date.now() + aiScanMaxMsValue;
            for (let index = 0; index < aiJobs.length; index += MAX_AI_CONCURRENCY) {
              if (scanCancel || stopped) break;
              if (Date.now() >= aiDeadline) {
                aiDeferredReason = "time";
                for (const job of aiJobs.slice(index)) job.llmDeferred = true;
                logWarn("[super-kanban] AI stage wall-clock limit reached; remaining sessions deferred");
                break;
              }
              // Budget accounting uses analyzer attempts (failed analyses count
              // against the budget too), not just successful calls.
              if (readAnalyzerBudget().calls >= scanBudget) {
                aiDeferredReason = dailyCapped ? "daily" : "budget";
                aiBudgetExhausted = true;
                for (const job of aiJobs.slice(index)) job.llmBudgetExceeded = true;
                logWarn("[super-kanban] per-scan AI budget exhausted; remaining sessions deferred");
                break;
              }
              const batch = aiJobs.slice(index, index + MAX_AI_CONCURRENCY);
              await Promise.all(
                batch.map(async (job) => {
                  const result = await analyzer.analyze({
                    provider: route.provider,
                    model: route.model,
                    digest: job.digest,
                    existingTasks: promptCandidateTasks(job.meta),
                    signal: scanAbort?.signal,
                  });
                  if (result.ok) {
                    job.llm = result;
                    state.scan.aiCalls += 1;
                    state.scan.tokens += result.usage?.totalTokens || 0;
                  } else if (result.code === "budget") {
                    job.llmBudgetExceeded = true;
                    // Fix the mixed case: a budget hit alone must still emit the
                    // "budget used up" hint even when other calls failed.
                    aiBudgetExhausted = true;
                  } else if (result.code === "aborted") {
                    job.llmAborted = true;
                  } else {
                    job.llmError = result.error;
                    aiFailureCount += 1;
                    markAiError(job.meta, result.error);
                    logWarn(`[super-kanban] LLM analysis degraded to rules: ${result.code || "llm-failed"}`);
                  }
                }),
              );
              const usedCalls = state.usage.calls + state.scan.aiCalls;
              state.scan.message = `AI 研判 ${Math.min(state.scan.aiCalls, aiJobs.length)}/${aiJobs.length} 个会话（今日 ${usedCalls}/${state.settings.dailyAiCallLimit}）…`;
              broadcastScan();
            }
          }
          const budgetAfter = readAnalyzerBudget();
          state.scan.aiAttempts = budgetAfter.attempts;
          state.scan.aiPending = aiJobs.filter((job) => !job.llm).length;
          if (!aiDeferredReason && aiBudgetExhausted) aiDeferredReason = dailyCapped ? "daily" : "budget";
          state.scan.aiDeferredReason = aiDeferredReason;
        }
      }
    }

    // Phase C: merge analyses into the board.
    for (const job of analysisJobs) {
      if (stopped) break;
      if (scanCancel) break;
      const { meta, rules, context } = job;
      let applied = 0;
      try {
        if (job.llm) {
          if (job.llm.ignore) {
            applyAiMeta(meta.id, meta, { digestBytes: job.digestBytes });
            continue;
          }
          const llmModel = job.llm.model || "";
          const llmProvider = job.llm.provider || null;
          const normalized = job.llm.tasks
            .slice(0, Math.max(1, state.settings.maxTasksPerSession || 3))
            .map((raw) => normalizeAnalysis(raw, context, { engine: "llm", model: llmModel }))
            .filter(Boolean)
            .map((analysis) => ({
              ...analysis,
              evidence: mergeTaskEvidence(analysis.evidence, rules.tasks?.[0]?.evidence || []),
              keyFacts: mergeKeyFacts(analysis.keyFacts, rules.tasks?.[0]?.keyFacts || []),
            }));
          if (normalized.length > 0) {
            const result = applyAnalysisList(normalized, meta, context, {
              engine: "llm",
              model: llmModel,
              provider: llmProvider,
              rules,
              childSummaries,
              context,
            });
            applied = result.applied;
            orphanMerged += pruneSessionOrphans(meta, result.targets);
          } else {
            applied = applyAnalysisList(rules.tasks, meta, context, {
              engine: "rules",
              model: "",
              provider: null,
              rules,
              childSummaries,
              context,
            }).applied;
          }
          applyAiMeta(meta.id, meta, { digestBytes: job.digestBytes });
        } else {
          // No AI this round (gated / low-value / budget / failure): never
          // downgrade an existing LLM verdict — only refresh deterministic v2
          // fields (sessionContext/artifacts/subtasks/progress).
          const bound = findTaskBySession(meta.id);
          const hasAiVerdict = Boolean(bound && bound.ai && bound.ai.engine === "llm");
          if (hasAiVerdict) {
            refreshTaskDeterministic(bound, meta, context);
          } else {
            applied = applyAnalysisList(rules.tasks, meta, context, {
              engine: "rules",
              model: "",
              provider: null,
              rules,
              childSummaries,
              context,
            }).applied;
          }
        }
        if (applied > 0) schedulePersist();
      } catch (error) {
        logWarn(`[super-kanban] merge failed for ${meta.id}: ${String(error?.message || error)}`);
      }
    }

    // Phase C2: collapse auto tasks that describe the same work.
    const mergedTasks = mergeDuplicateTasks() + orphanMerged;

    // Phase D: persist derived board data + the human-readable scan conclusion.
    state.workspaces = computeWorkspaces(discovery.workspaces, [...sessionsById.values()]);
    state.activity = computeActivity();
    if (scanCancel) {
      state.scan.message = "扫描已取消";
    } else {
      state.scan.message = buildScanMessage({
        lowValueSkipped,
        mergedTasks,
        aiRouteMessage,
        aiDeferredReason,
        aiBudget: state.scan.aiBudget,
        aiPending: state.scan.aiPending,
        aiFailureCount,
      });
    }
    broadcastScan(true);
    // Cache entries for sessions that were never parsed keep their old meta.
    for (const discovered of discoverySessions) {
      if (!cache.sessions[discovered.id]) {
        cache.sessions[discovered.id] = { sigKey: discovered.sigKey, meta: hydrateMeta(discovered) };
      }
    }
    pruneCache(discoverySessions);
  }

  function hydrationSafe(discovered) {
    try {
      return hydrateMeta(discovered);
    } catch {
      return null;
    }
  }

  function pruneCache(discoveredSessions) {
    const alive = new Set(discoveredSessions.map((session) => session.id));
    for (const id of Object.keys(cache.sessions)) if (!alive.has(id)) delete cache.sessions[id];
    for (const [id, meta] of sessionsById) if (!alive.has(id)) sessionsById.delete(id);
  }

  /* ------------------------------ merge ---------------------------- */

  function attachSession(task, meta, evidenceCount) {
    const entry = sessionEntryFromMeta(meta, evidenceCount);
    const existing = task.sessions.find((session) => session.id === entry.id);
    if (existing) {
      existing.title = entry.title;
      existing.seqEnd = entry.seqEnd;
      existing.evidenceCount = entry.evidenceCount;
    } else if (task.sessions.length < MAX_SESSIONS_PER_TASK) {
      task.sessions.push(entry);
    }
  }

  function resolveTargetTask(analysis, meta, index) {
    const stableId = stableTaskId(meta.id, index);
    const byStable = state.tasks.find((task) => task.id === stableId && task.origin !== "manual");
    if (byStable) return byStable;
    if (index === 0) {
      const bound = findTaskBySession(meta.id);
      if (bound) return bound;
    }
    if (analysis.mergeWith) {
      const explicit = state.tasks.find((task) => task.id === analysis.mergeWith && task.origin !== "manual");
      if (explicit) return explicit;
    }
    // Similar-title merge inside the same workspace (stable enough for rules).
    let best = null;
    let bestScore = 0;
    for (const candidate of state.tasks) {
      if (candidate.origin === "manual" || candidate.archived) continue;
      if (candidate.id === stableId) continue;
      if ((candidate.workspaceId || null) !== (meta.workspaceId || null)) continue;
      if (candidate.sessions.some((session) => session.id === meta.id)) continue;
      const score = titleSimilarity(candidate.title, analysis.title);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return bestScore >= 0.72 ? best : null;
  }

  function applyAnalysisList(analyses, meta, context, options) {
    const targets = [];
    analyses.forEach((analysis, index) => {
      const withChildren = index === 0 ? foldChildEvidence(analysis, meta, options.childSummaries) : analysis;
      const target = resolveTargetTask(withChildren, meta, index);
      const stableId = stableTaskId(meta.id, index);
      if (target) {
        updateTaskFromAnalysis(target, withChildren, meta, options);
        targets.push(target);
      } else {
        targets.push(createTaskFromAnalysis(withChildren, meta, stableId, options));
        state.scan.newTasks += 1;
      }
    });
    return { applied: targets.length, targets };
  }

  /**
   * When a session's fresh analysis yields fewer cards than before (e.g. the
   * model merged two splits), fold the now-orphaned auto cards back into the
   * primary card instead of leaving stale duplicates on the board.
   */
  function pruneSessionOrphans(meta, targets) {
    if (!targets.length) return 0;
    const keep = new Set(targets.map((task) => task.id));
    const primary = targets[0];
    const orphans = state.tasks.filter(
      (task) =>
        task.origin === "auto" &&
        !task.archived &&
        task.primarySessionId === meta.id &&
        !keep.has(task.id) &&
        (task.lockedFields || []).length === 0 &&
        (task.sessions || []).length <= 1,
    );
    for (const orphan of orphans) {
      mergeTaskInto(primary, orphan);
    }
    return orphans.length;
  }

  /**
   * Merge LLM-picked evidence with rules-extracted evidence (dedupe by
   * session+kind+seq). The LLM picks the most salient quotes; rules fill the
   * traceability gaps so every card keeps a usable timeline.
   */
  function mergeTaskEvidence(primary, secondary = [], limit = EVIDENCE_LIMIT) {
    const merged = [];
    const seen = new Set();
    for (const source of [primary || [], secondary || []]) {
      for (const item of source) {
        if (!item || typeof item !== "object") continue;
        // Unresolved citations (seq null) must dedupe by identity/content, not by
        // a shared "null" slot, otherwise distinct quoted evidence disappears.
        const key =
          item.seq === null || item.seq === undefined
            ? `${item.sessionId || ""}:${item.kind || ""}:t:${item.id || item.quote || item.text || ""}`
            : `${item.sessionId || ""}:${item.kind || ""}:s:${item.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    merged.sort((left, right) => (left.time || 0) - (right.time || 0) || (left.seq || 0) - (right.seq || 0));
    if (merged.length <= limit) return merged;
    // Keep the opening context (first 6) plus the most recent evidence.
    return [...merged.slice(0, 6), ...merged.slice(-(limit - 6))];
  }

  /** Keep sessions[].evidenceCount truthful after evidence merges/refreshes. */
  function refreshSessionEvidenceCounts(task) {
    if (!task || !Array.isArray(task.evidence) || !Array.isArray(task.sessions)) return;
    const counts = new Map();
    for (const item of task.evidence) {
      if (!item || !item.sessionId) continue;
      counts.set(item.sessionId, (counts.get(item.sessionId) || 0) + 1);
    }
    for (const session of task.sessions) session.evidenceCount = counts.get(session.id) || 0;
  }

  /**
   * `task.ai` provenance. LLM verdicts record the requested provider+model;
   * rules verdicts keep an empty model and a null provider (the deprecated
   * `settings.model` is never attributed to a rules result).
   */
  function analysisAiInfo(analysis, { engine, model, provider } = {}) {
    const isLlm = engine === "llm";
    return {
      analyzedAt: new Date().toISOString(),
      model: isLlm ? String(model || "") : "",
      provider: isLlm && typeof provider === "string" && provider ? provider : null,
      confidence: Number.isFinite(analysis.confidence) ? analysis.confidence : null,
      reason: analysis.reason || "",
      engine,
    };
  }

  function createTaskFromAnalysis(analysis, meta, taskId, options) {
    const nowIso = new Date().toISOString();
    const context = options.context || {};
    const subtasks = mergeSubtasks(analysis.subtasks || [], context.subtasks || []);
    const progress = progressFromSubtasks(subtasks) ?? (Number.isFinite(analysis.progress) ? analysis.progress : null);
    const goal = goalObjectFor(analysis, context, analysis.status);
    const task = {
      id: taskId,
      title: clipText(analysis.title, TITLE_TEXT_LIMIT),
      goal,
      status: STATUSES.includes(analysis.status) ? analysis.status : "backlog",
      progress,
      priority: PRIORITIES.includes(analysis.priority) ? analysis.priority : "P2",
      tags: Array.isArray(analysis.tags) ? analysis.tags.slice(0, TAG_LIMIT) : [],
      origin: "auto",
      workspaceId: meta.workspaceId || null,
      workspaceTitle: meta.workspaceTitle || null,
      workspacePath: meta.workspacePath || null,
      sessions: [sessionEntryFromMeta(meta, (analysis.evidence || []).length)],
      primarySessionId: meta.id,
      keyFacts: mergeKeyFacts(analysis.keyFacts || [], []),
      subtasks,
      artifacts: mergeArtifacts(context.artifacts || [], []),
      sessionContext: context.sessionContext ? { ...context.sessionContext } : null,
      issues: analysis.issues || [],
      nextSteps: analysis.nextSteps || [],
      milestones: analysis.milestones || [],
      evidence: mergeTaskEvidence(analysis.evidence),
      ai: analysisAiInfo(analysis, options),
      lockedFields: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      lastActivityAt: meta.lastActivityAt || Date.now(),
      archived: false,
      history: [],
    };
    closeSubtasksForDoneTask(task);
    syncProgressFromSubtasks(task);
    if (task.status === "done" && trustedUnfinishedSubtasks(task).length === 0) task.progress = 100;
    syncGoalStatus(task);
    refreshSessionEvidenceCounts(task);
    pushHistory(task, {
      kind: "create",
      by: "ai",
      note: `${options.engine} 引擎从会话「${clipText(meta.title || meta.id, 40)}」自动建卡`,
    });
    truncateTask(task);
    state.tasks.push(task);
    return task;
  }

  function updateTaskFromAnalysis(task, analysis, meta, options) {
    const locked = new Set(Array.isArray(task.lockedFields) ? task.lockedFields : []);
    const context = options.context || {};
    const nowIso = new Date().toISOString();
    let otherChanged = false;
    const setField = (field, value) => {
      if (locked.has(field)) return false;
      if (value === undefined || value === null) return false;
      const current = task[field];
      const same = Array.isArray(value) && Array.isArray(current) ? JSON.stringify(value) === JSON.stringify(current) : current === value;
      if (same) return false;
      task[field] = value;
      return true;
    };

    if (setField("title", clipText(analysis.title, TITLE_TEXT_LIMIT))) otherChanged = true;
    if (setField("priority", PRIORITIES.includes(analysis.priority) ? analysis.priority : undefined)) otherChanged = true;
    if (setField("tags", Array.isArray(analysis.tags) ? analysis.tags.slice(0, TAG_LIMIT) : undefined)) otherChanged = true;
    if (setField("issues", analysis.issues)) otherChanged = true;
    if (setField("nextSteps", analysis.nextSteps)) otherChanged = true;
    if (!locked.has("milestones") && Array.isArray(analysis.milestones) && analysis.milestones.length > 0) {
      task.milestones = analysis.milestones;
    }
    if (!locked.has("keyFacts") && Array.isArray(analysis.keyFacts) && analysis.keyFacts.length > 0) {
      const nextFacts = mergeKeyFacts(analysis.keyFacts, (task.keyFacts || []).slice(0, 2));
      if (JSON.stringify(nextFacts) !== JSON.stringify(task.keyFacts || [])) {
        task.keyFacts = nextFacts;
        otherChanged = true;
      }
    }

    if (!locked.has("goal")) {
      const nextGoal = context.sessionGoal?.text
        ? goalObjectFor(analysis, context, analysis.status)
        : { ...(task.goal || { text: "", status: "none", source: "task" }) };
      if (!context.sessionGoal?.text && analysis.goalText) {
        nextGoal.text = clipText(analysis.goalText, GOAL_TEXT_LIMIT);
        nextGoal.source = "task";
      }
      nextGoal.status = nextGoal.text ? (analysis.status === "done" ? "done" : nextGoal.status === "done" ? "done" : "active") : "none";
      if (JSON.stringify(nextGoal) !== JSON.stringify(task.goal)) {
        task.goal = nextGoal;
        otherChanged = true;
      }
    }

    // Subtasks: AI/rule subtasks + deterministic todo import + the user's items.
    // User-managed items always win; previously imported todo items are kept so a
    // re-analysis that returns no subtasks cannot silently wipe them.
    if (!locked.has("subtasks")) {
      const manual = (task.subtasks || []).filter((subtask) => subtask.source === "manual");
      const deterministic = (task.subtasks || []).filter((subtask) => subtask.source === "todo");
      const mergedSubtasks = mergeSubtasks(analysis.subtasks || [], context.subtasks || [], deterministic, manual);
      if (JSON.stringify(mergedSubtasks) !== JSON.stringify(task.subtasks || [])) {
        task.subtasks = mergedSubtasks;
        otherChanged = true;
      }
    }
    // Artifacts: deterministic union (deliverables + write/edit paths).
    const mergedArtifacts = mergeArtifacts(task.artifacts || [], context.artifacts || []);
    if (JSON.stringify(mergedArtifacts) !== JSON.stringify(task.artifacts || [])) {
      task.artifacts = mergedArtifacts;
      otherChanged = true;
    }
    if (context.sessionContext && (!task.sessionContext || task.primarySessionId === meta.id)) {
      task.sessionContext = { ...task.sessionContext, ...context.sessionContext };
    }

    const subtaskProgress = progressFromSubtasks(task.subtasks);
    if (!locked.has("progress") && subtaskProgress !== null) {
      const previous = task.progress;
      if (previous !== subtaskProgress) {
        task.progress = subtaskProgress;
        if (previous === null || previous === undefined || Math.abs(subtaskProgress - previous) >= 5) {
          pushHistory(task, { kind: "progress", from: previous, to: subtaskProgress, by: "ai", note: "按子任务完成率更新" });
        }
      }
    } else {
      const nextProgress = Number.isFinite(analysis.progress) ? analysis.progress : undefined;
      if (!locked.has("progress") && nextProgress !== undefined) {
        const previous = task.progress;
        if (previous !== nextProgress) {
          const delta = previous === null || previous === undefined ? 100 : Math.abs(nextProgress - previous);
          task.progress = nextProgress;
          if (delta >= 5) {
            pushHistory(task, { kind: "progress", from: previous, to: nextProgress, by: "ai", note: `${options.engine} 研判` });
          }
        }
      }
    }
    if (!locked.has("status") && STATUSES.includes(analysis.status) && analysis.status !== task.status) {
      const from = task.status;
      task.status = analysis.status;
      pushHistory(task, { kind: "status", from, to: analysis.status, by: "ai", note: `${options.engine} 研判` });
    }
    // Trust rule: an AI/rule "done" may never silently finish user-owned work.
    // Unfinished manual subtasks (or a locked subtask list) keep the card
    // in_progress; the proposal is preserved in history instead.
    if (keepInProgressForUnfinishedUserWork(task, options.engine)) otherChanged = true;
    if (closeSubtasksForDoneTask(task)) otherChanged = true;
    syncProgressFromSubtasks(task);
    if (task.status === "done" && !locked.has("progress") && trustedUnfinishedSubtasks(task).length === 0) {
      task.progress = 100;
    }
    if (syncGoalStatus(task)) otherChanged = true;
    if (otherChanged) {
      pushHistory(task, {
        kind: "ai",
        by: "ai",
        note: `${options.engine} 更新了${options.engine === "llm" ? " AI" : ""}研判字段`,
      });
    }

    // Evidence is derived state and always refreshed (it is what makes cards traceable).
    if (Array.isArray(analysis.evidence) && analysis.evidence.length > 0) {
      task.evidence = mergeTaskEvidence(analysis.evidence, options.rules?.tasks?.[0]?.evidence || []);
    }
    attachSession(task, meta, (analysis.evidence || []).length);
    if (!task.primarySessionId) task.primarySessionId = meta.id;
    if (!task.workspaceId && meta.workspaceId) {
      task.workspaceId = meta.workspaceId;
      task.workspaceTitle = meta.workspaceTitle;
      task.workspacePath = meta.workspacePath;
    }
    refreshSessionEvidenceCounts(task);
    task.ai = analysisAiInfo(analysis, options);
    task.updatedAt = nowIso;
    task.lastActivityAt = Math.max(task.lastActivityAt || 0, meta.lastActivityAt || 0);
    if (options.engine === "llm") task.origin = task.origin === "manual" ? "manual" : "auto";
    truncateTask(task);
    state.scan.updatedTasks += 1;
    return task;
  }

  /* ------------------------------ commands ------------------------- */

  function requireTask(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task) throw notFound("task-not-found");
    return task;
  }

  function normalizedStatus(value, fallback) {
    return STATUSES.includes(value) ? value : fallback;
  }

  function normalizedPriority(value, fallback) {
    return PRIORITIES.includes(value) ? value : fallback;
  }

  function workspaceFromPayload(payload) {
    if (typeof payload.workspaceId !== "string" || !payload.workspaceId) return null;
    const workspace = workspaceById(payload.workspaceId);
    return workspace || null;
  }

  function metaForSessionId(sessionId) {
    if (!sessionId) return null;
    const known = sessionsById.get(sessionId);
    if (known) return known;
    const cached = cache.sessions[sessionId]?.meta;
    if (cached) return cached;
    return null;
  }

  function refreshSessionIndex() {
    try {
      const discovery = source.discover();
      parentToChildren = new Map();
      for (const [parentId, childId] of discovery.childToParent || []) {
        if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
        parentToChildren.get(parentId).push(childId);
      }
      for (const discovered of discovery.sessions) {
        if (!sessionsById.has(discovered.id)) sessionsById.set(discovered.id, hydrateMeta(discovered));
      }
      if (!state.workspaces.length) {
        state.workspaces = computeWorkspaces(discovery.workspaces, [...sessionsById.values()]);
      }
    } catch (error) {
      logWarn(`[super-kanban] refresh session index failed: ${String(error?.message || error)}`);
    }
  }

  const ops = {
    "task.create"(payload) {
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      if (!title) throw badRequest("title-required");
      const requestedSessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      // The session index may be empty before the first scan; look the session up
      // on demand so a manual card can still be bound to its source session.
      let sessionMeta = metaForSessionId(requestedSessionId);
      if (!sessionMeta && requestedSessionId) {
        refreshSessionIndex();
        sessionMeta = metaForSessionId(requestedSessionId);
      }
      const workspace = workspaceFromPayload(payload) || (sessionMeta ? workspaceById(sessionMeta.workspaceId) : null);
      const nowIso = new Date().toISOString();
      const task = {
        id: newManualTaskId(title),
        title: clipText(title, TITLE_TEXT_LIMIT),
        goal: {
          // Trim like task.update does; an empty goal must end up as status none.
          text: clipText((typeof payload.goal === "string" ? payload.goal : payload.goal?.text || "").trim(), GOAL_TEXT_LIMIT),
          status: "active",
          source: "task",
        },
        status: normalizedStatus(payload.status, "backlog"),
        progress:
          payload.progress === null || payload.progress === undefined
            ? null
            : Number.isFinite(Number(payload.progress))
              ? Math.max(0, Math.min(100, Math.round(Number(payload.progress))))
              : null,
        priority: normalizedPriority(payload.priority, "P2"),
        tags: isStringArray(payload.tags) ? payload.tags.slice(0, TAG_LIMIT).map((tag) => clipText(tag, TAG_TEXT_LIMIT)) : [],
        origin: "manual",
        workspaceId: workspace?.id || sessionMeta?.workspaceId || null,
        workspaceTitle: workspace?.title || sessionMeta?.workspaceTitle || null,
        workspacePath: workspace?.path || sessionMeta?.workspacePath || null,
        sessions: sessionMeta ? [sessionEntryFromMeta(sessionMeta, 0)] : [],
        primarySessionId: sessionMeta?.id || null,
        keyFacts: [],
        subtasks: [],
        artifacts: [],
        sessionContext: sessionMeta
          ? {
              sessionId: sessionMeta.id,
              title: sessionMeta.title || "",
              isLive: Boolean(sessionMeta.isLive),
              turnCount: sessionMeta.turnCount || 0,
              lastTurnEnd: mapTurnEndKind(sessionMeta.lastTurnEnd?.kind),
              lastActivityAt: sessionMeta.lastActivityAt || 0,
              todoTotal: sessionMeta.todoCounts?.total || 0,
              todoDone: sessionMeta.todoCounts?.completed || 0,
            }
          : null,
        issues: [],
        nextSteps: [],
        milestones: [],
        evidence: [],
        ai: null,
        lockedFields: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        lastActivityAt: sessionMeta?.lastActivityAt || Date.now(),
        archived: false,
        history: [],
      };
      // Same invariant as AI-created cards: goal.status follows task.status.
      syncGoalStatus(task);
      if (sessionMeta) {
        state.suppressedSessions = state.suppressedSessions.filter((id) => id !== sessionMeta.id);
      }
      pushHistory(task, { kind: "create", by: "user", note: "手动创建任务" });
      state.tasks.push(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.update"(payload) {
      const task = requireTask(payload);
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
      let otherChanged = false;
      for (const field of FIELD_NAMES) {
        // hasOwn: a patch with "__proto__"/"constructor" keys must not be read
        // through the prototype chain.
        if (!Object.hasOwn(patch, field)) continue;
        const value = patch[field];
        if (field === "status") {
          const next = normalizedStatus(value, task.status);
          if (next !== task.status) {
            const from = task.status;
            task.status = next;
            pushHistory(task, { kind: "status", from, to: next, by: "user", note: "用户编辑" });
          }
          continue;
        }
        if (field === "priority") {
          const next = normalizedPriority(value, task.priority);
          if (next !== task.priority) {
            task.priority = next;
            otherChanged = true;
          }
          continue;
        }
        if (field === "progress") {
          const next =
            value === null ? null : Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : task.progress;
          if (next !== task.progress) {
            pushHistory(task, { kind: "progress", from: task.progress, to: next, by: "user", note: "用户编辑" });
            task.progress = next;
          }
          continue;
        }
        if (field === "title") {
          if (typeof value === "string") {
            const next = clipText(value.trim(), TITLE_TEXT_LIMIT);
            if (next && next !== task.title) {
              task.title = next;
              otherChanged = true;
            }
          }
          continue;
        }
        if (field === "goal") {
          const goalText = typeof value === "string" ? value : value?.text;
          if (typeof goalText === "string") {
            const next = { ...(task.goal || {}), text: clipText(goalText.trim(), GOAL_TEXT_LIMIT), source: "task" };
            next.status = next.text ? (value?.status === "done" || task.status === "done" ? "done" : "active") : "none";
            if (JSON.stringify(next) !== JSON.stringify(task.goal)) {
              task.goal = next;
              otherChanged = true;
            }
          }
          continue;
        }
        if (field === "tags") {
          if (isStringArray(value)) {
            task.tags = value.slice(0, TAG_LIMIT).map((tag) => clipText(tag, TAG_TEXT_LIMIT));
            otherChanged = true;
          }
          continue;
        }
        if (field === "nextSteps") {
          if (Array.isArray(value)) {
            // Accept plain strings (normal UI payload) and {text} records; other
            // shapes are dropped instead of being persisted unvalidated.
            task.nextSteps = value
              .slice(0, NEXTSTEP_LIMIT)
              .map((step) => clipText(typeof step === "string" ? step : step?.text, NEXTSTEP_TEXT_LIMIT))
              .filter(Boolean);
            otherChanged = true;
          }
          continue;
        }
        if (field === "issues" || field === "milestones") {
          if (Array.isArray(value)) {
            // truncateTask() below sanitizes items; cap the array shape here so
            // overlong payloads never reach the task object unbounded.
            task[field] = value.slice(0, field === "issues" ? ISSUE_LIMIT : MILESTONE_LIMIT);
            otherChanged = true;
          }
          continue;
        }
      }
      if (isStringArray(payload.lockFields) && payload.lockFields.length > 0) {
        const locks = new Set([...(task.lockedFields || []), ...payload.lockFields.filter((field) => LOCKABLE_FIELDS.includes(field))]);
        task.lockedFields = [...locks];
        otherChanged = true;
      }
      if (otherChanged) pushHistory(task, { kind: "edit", by: "user", note: "用户编辑任务" });
      if (task.origin === "auto") task.origin = "auto+edited";
      task.updatedAt = new Date().toISOString();
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.move"(payload) {
      const task = requireTask(payload);
      const nextStatus = normalizedStatus(payload.status, task.status);
      const index = Number.isFinite(Number(payload.index)) ? Number(payload.index) : null;
      const position = state.tasks.indexOf(task);
      if (position >= 0) state.tasks.splice(position, 1);
      if (nextStatus !== task.status) {
        pushHistory(task, { kind: "status", from: task.status, to: nextStatus, by: "user", note: "拖拽换列" });
        task.status = nextStatus;
      }
      const group = state.tasks
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter((entry) => entry.candidate.status === nextStatus);
      let insertAt;
      if (index !== null && index >= 0 && index < group.length) insertAt = group[index].candidateIndex;
      else insertAt = group.length > 0 ? group[group.length - 1].candidateIndex + 1 : state.tasks.length;
      state.tasks.splice(insertAt, 0, task);
      task.updatedAt = new Date().toISOString();
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.archive"(payload) {
      const task = requireTask(payload);
      const archived = payload.archived !== false;
      if (task.archived !== archived) {
        pushHistory(task, {
          kind: "archive",
          from: task.archived,
          to: archived,
          by: "user",
          note: archived ? "用户归档" : "用户恢复",
        });
        task.archived = archived;
        task.updatedAt = new Date().toISOString();
      }
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.delete"(payload) {
      const task = requireTask(payload);
      const sessionIds = (task.sessions || []).map((session) => session.id);
      state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
      state.deletedLog.push({
        id: task.id,
        title: task.title,
        origin: task.origin,
        deletedAt: new Date().toISOString(),
        sessionIds,
      });
      if (task.origin !== "manual") {
        state.suppressedSessions = [...new Set([...state.suppressedSessions, ...sessionIds])].slice(-500);
      }
      persistState();
      emitChanged("task", 1);
      return { id: task.id, deleted: true };
    },

    "task.relink"(payload) {
      const task = requireTask(payload);
      if (!isStringArray(payload.sessionIds)) throw badRequest("sessionIds-required");
      // Ids are opaque lookup keys persisted into state.json: reject path-ish or
      // absurdly long values instead of storing attacker-shaped strings.
      const sessionIds = payload.sessionIds
        .map((id) => (id.length <= 200 && !id.includes("\0") && !id.includes("/") && !id.includes("\\") ? id : null))
        .filter(Boolean);
      if (sessionIds.length === 0) throw badRequest("sessionIds-invalid");
      refreshSessionIndex();
      const sessions = [];
      for (const sessionId of sessionIds.slice(0, MAX_SESSIONS_PER_TASK)) {
        const meta = metaForSessionId(sessionId);
        sessions.push(meta ? sessionEntryFromMeta(meta, 0) : { id: sessionId, title: sessionId, seqEnd: 0, evidenceCount: 0 });
      }
      task.sessions = sessions;
      task.primarySessionId = sessions[0]?.id || null;
      const firstMeta = sessions[0] ? metaForSessionId(sessions[0].id) : null;
      if (firstMeta) {
        task.workspaceId = firstMeta.workspaceId || task.workspaceId;
        task.workspaceTitle = firstMeta.workspaceTitle || task.workspaceTitle;
        task.workspacePath = firstMeta.workspacePath || task.workspacePath;
      }
      state.suppressedSessions = state.suppressedSessions.filter((id) => !sessionIds.includes(id));
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `重新关联 ${sessions.length} 个来源会话` });
      if (task.origin === "auto") task.origin = "auto+edited";
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.unlock"(payload) {
      const task = requireTask(payload);
      const fields = isStringArray(payload.fields) && payload.fields.length > 0 ? payload.fields : null;
      task.lockedFields = fields ? task.lockedFields.filter((field) => !fields.includes(field)) : [];
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: fields ? `解锁字段：${fields.join("、")}` : "解锁全部字段" });
      persistState();
      emitChanged("task", 1);
      return task;
    },

    async "task.analyze"(payload) {
      const task = requireTask(payload);
      refreshSessionIndex();
      // Re-judge exactly one source session: the primary one (older/relinked cards
      // may only carry sessions[]). Re-judging every linked session used to
      // overwrite the same card once per session and spend one budget unit each.
      const targetSessionId = task.primarySessionId || task.sessions?.[0]?.id || "";
      if (!targetSessionId) throw badRequest("task-has-no-session");
      const meta = metaForSessionId(targetSessionId);
      if (!meta || !meta.file) throw badRequest("task-has-no-session");
      // Serialize with scans and other explicit AI commands (shared analyzer).
      acquireAiTask();
      try {
        // Same route resolver as the scan: an explicit selection or the live DSH
        // default; an unavailable route falls back to the rules engine.
        const route = await resolveAiRoute();
        const dailyRemaining = dailyAiRemaining();
        const budgetExhausted = state.settings.aiEnabled && dailyRemaining <= 0;
        const aiEnabled = state.settings.aiEnabled && route.ok && dailyRemaining > 0;
        // One click = at most one budget unit.
        analyzer.resetBudget(aiEnabled ? 1 : 0);
        let aiCalls = 0;
        let tokens = 0;
        let engine = "rules";
        let model = "";
        let provider = null;
        let budgetHit = false;
        let parsed;
        try {
          parsed = source.loadParsed(meta);
        } catch (error) {
          // Re-judging a broken log is a client-visible failure, not a silent
          // rules fallback (the session must be re-read before it can be judged).
          throw badRequest(`session-parse-failed: ${String(error?.message || error)}`);
        }
        parsed.evidence = source.collectEvidence(parsed);
        const rules = analyzeSessionRules(parsed, {
          workspaceTitle: meta.workspaceTitle,
          workspacePath: meta.workspacePath,
          maxTasks: state.settings.maxTasksPerSession || 3,
        });
        const context = buildV2Context(parsed, meta, meta.workspaceTitle);
        let analyses = rules.tasks;
        let jobEngine = "rules";
        let jobModel = "";
        let jobProvider = null;
        if (aiEnabled) {
          const digest = source.buildDigest(parsed, {
            workspaceTitle: meta.workspaceTitle,
            existingTasks: promptCandidateTasks(meta),
            baselineSeq: 0, // manual re-judge: give the model the full recent picture
          });
          const result = await analyzer.analyze({
            provider: route.provider,
            model: route.model,
            digest,
            existingTasks: promptCandidateTasks(meta),
          });
          if (result.ok) {
            // A successful analysis consumes one budget unit even when the model
            // says "no card needed" (ignore) — the tokens were still spent.
            aiCalls += 1;
            tokens += result.usage?.totalTokens || 0;
            const normalized = result.tasks
              .slice(0, Math.max(1, state.settings.maxTasksPerSession || 3))
              .map((raw) => normalizeAnalysis(raw, context, { engine: "llm", model: result.model || route.model }))
              .filter(Boolean)
              .map((analysis) => ({
                ...analysis,
                evidence: mergeTaskEvidence(analysis.evidence, rules.tasks?.[0]?.evidence || []),
                keyFacts: mergeKeyFacts(analysis.keyFacts, rules.tasks?.[0]?.keyFacts || []),
              }));
            if (normalized.length > 0 && !result.ignore) {
              analyses = normalized;
              jobEngine = "llm";
              jobModel = result.model || route.model;
              jobProvider = result.provider || route.provider;
              engine = "llm";
              model = jobModel;
              provider = jobProvider;
            }
            applyAiMeta(targetSessionId, meta, { digestBytes: Buffer.byteLength(digest, "utf8") });
          } else if (result.code === "budget") {
            budgetHit = true;
            logWarn("[super-kanban] task.analyze budget exhausted; rules fallback");
          } else if (result.code !== "aborted") {
            markAiError(meta, result.error);
            logWarn(`[super-kanban] task.analyze LLM degraded: ${result.code || "llm-failed"}`);
          }
        }
        // Explicit analyze updates exactly this task (scan owns auto splitting).
        const primary = analyses[0];
        if (primary) {
          updateTaskFromAnalysis(task, primary, meta, {
            engine: jobEngine,
            model: jobModel,
            provider: jobProvider,
            rules,
            context,
          });
        }
        task.origin = task.origin === "auto" ? "auto+edited" : task.origin;
        task.updatedAt = new Date().toISOString();
        truncateTask(task);
        if (aiCalls > 0) recordUsage({ calls: aiCalls, tokens });
        persistState();
        emitChanged("task", 1);
        let message;
        if (engine === "llm") message = "AI 研判完成";
        else if (aiCalls > 0) message = `AI 判断该会话无需建卡（已消耗 ${aiCalls} 次）`;
        else if (budgetHit || budgetExhausted) message = "今日 AI 预算已用完，已用规则引擎重判";
        else if (state.settings.aiEnabled && !route.ok) message = `${route.message}，已用规则引擎重判`;
        else message = "AI 不可用或未启用，已用规则引擎重判";
        return { task, engine, aiCalls, tokens, sessions: 1, message, model, provider };
      } finally {
        // Every return/throw path must free the shared AI mutex.
        releaseAiTask();
      }
    },

    /* ----------------------- v2 linkage ops ------------------------ */

    "task.continuePrompt"(payload) {
      const task = requireTask(payload);
      const target = payload.target === "newSession" ? "newSession" : "session";
      const meta = task.primarySessionId ? metaForSessionId(task.primarySessionId) : null;
      const sessionContext = task.sessionContext || (meta ? sessionContextFromMeta(meta) : null);
      const lines = [];
      lines.push("你将继续执行一个已有任务，请接手并把它推进到完成。", "");
      lines.push("## 任务");
      lines.push(`- 标题：${task.title}`);
      lines.push(`- 目标：${task.goal?.text || "未设置（请根据标题与会话判断）"}`);
      lines.push(`- 当前状态：${STATUS_LABELS[task.status] || task.status}${Number.isFinite(task.progress) ? `（进度 ${task.progress}%）` : ""}`);
      if (task.workspaceTitle) lines.push(`- 工作区：${task.workspaceTitle}`);
      const keyFacts = (task.keyFacts || []).slice(0, 5);
      if (keyFacts.length) {
        lines.push("", "## 关键事实");
        for (const fact of keyFacts) lines.push(`- ${fact.text}`);
      }
      const issues = (task.issues || []).slice(0, 3);
      if (issues.length) {
        lines.push("", "## 待解决问题");
        for (const issue of issues) lines.push(`- [${issue.severity || "medium"}] ${issue.text}`);
      }
      const nextSteps = (task.nextSteps || []).slice(0, 3);
      if (nextSteps.length) {
        lines.push("", "## 建议下一步");
        for (const step of nextSteps) lines.push(`- ${step}`);
      }
      const pendingSubtasks = (task.subtasks || []).filter((subtask) => !subtask.done).slice(0, 5);
      if (pendingSubtasks.length) {
        lines.push("", "## 未完成子任务");
        for (const subtask of pendingSubtasks) lines.push(`- ${subtask.text}`);
      }
      if (sessionContext) {
        lines.push("", "## 来源会话");
        lines.push(
          `- ${sessionContext.title || meta?.title || "?"}（sessionId: ${sessionContext.sessionId || task.primarySessionId}）`,
        );
        lines.push(
          `- 状态：${sessionContext.isLive ? "进行中" : "已结束"}；轮次：${sessionContext.turnCount || 0}；待办：${sessionContext.todoDone || 0}/${sessionContext.todoTotal || 0}`,
        );
      }
      lines.push(
        "",
        "## 要求",
        "1. 先简要复述你对任务目标与当前进展的理解，并给出 2-4 步执行计划；",
        "2. 然后直接开始执行，优先解决阻塞问题；",
        "3. 完成后汇报产出（文件路径/结果）与验证方式；",
        "4. 遇到阻塞明确说明原因与需要用户决策的点，不要假装完成。",
      );
      return {
        prompt: lines.join("\n"),
        target,
        sessionId: task.primarySessionId || (sessionContext?.sessionId ?? null),
        workspaceId: task.workspaceId || meta?.workspaceId || null,
        workspaceTitle: task.workspaceTitle || meta?.workspaceTitle || null,
        isLive: Boolean(sessionContext?.isLive ?? meta?.isLive),
      };
    },

    "task.importTodos"(payload) {
      const task = requireTask(payload);
      refreshSessionIndex();
      const meta = task.primarySessionId ? metaForSessionId(task.primarySessionId) : null;
      if (!meta || !meta.file) throw badRequest("task-has-no-session");
      let parsed;
      try {
        parsed = source.loadParsed(meta);
      } catch (error) {
        throw badRequest(`session-parse-failed: ${String(error?.message || error)}`);
      }
      const todoSubtasks = source.extractSubtasks(parsed, { forceAll: true });
      const merged = mergeSubtasks(todoSubtasks, task.subtasks || []);
      if (JSON.stringify(merged) === JSON.stringify(task.subtasks || [])) return task;
      task.subtasks = merged;
      syncProgressFromSubtasks(task);
      task.sessionContext = sessionContextFromMeta(meta, parsed);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `从会话导入待办 ${todoSubtasks.length} 项` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.toggleSubtask"(payload) {
      const task = requireTask(payload);
      const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
      const subtask = (task.subtasks || []).find((item) => item.id === subtaskId);
      if (!subtask) throw notFound("subtask-not-found");
      subtask.done = typeof payload.done === "boolean" ? payload.done : !subtask.done;
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `${subtask.done ? "完成" : "取消完成"}子任务：${clipText(subtask.text, 30)}` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.addSubtask"(payload) {
      const task = requireTask(payload);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw badRequest("text-required");
      task.subtasks = mergeSubtasks(
        task.subtasks || [],
        [
          {
            id: shortId("s", `manual:${task.id}:${Date.now()}:${text}`),
            text: clipText(text, SUBTASK_TEXT_LIMIT),
            done: false,
            source: "manual",
            seq: null,
          },
        ],
      );
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: `新增子任务：${clipText(text, 30)}` });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    "task.removeSubtask"(payload) {
      const task = requireTask(payload);
      const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
      const before = (task.subtasks || []).length;
      task.subtasks = (task.subtasks || []).filter((item) => item.id !== subtaskId);
      if (task.subtasks.length === before) throw notFound("subtask-not-found");
      reopenIfSubtasksUnfinished(task);
      syncProgressFromSubtasks(task);
      task.updatedAt = new Date().toISOString();
      pushHistory(task, { kind: "edit", by: "user", note: "删除子任务" });
      truncateTask(task);
      persistState();
      emitChanged("task", 1);
      return task;
    },

    async "task.polishPrompt"(payload) {
      const original = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!original) throw badRequest("prompt-required");
      if (original.length > 3000) throw badRequest("prompt-too-long");
      acquireAiTask();
      try {
        const route = await resolveAiRoute();
        const dailyRemaining = dailyAiRemaining();
        if (!state.settings.aiEnabled || !route.ok || dailyRemaining <= 0) {
          return { prompt: original, polished: false };
        }
        analyzer.resetBudget(Math.min(perScanAiLimit(), dailyRemaining, 1));
        const result = await analyzer.polish({ provider: route.provider, model: route.model, prompt: original });
        if (!result.ok) return { prompt: original, polished: false };
        recordUsage({ calls: 1, tokens: result.usage?.totalTokens || 0 });
        persistState();
        return { prompt: result.prompt || original, polished: Boolean(result.prompt) };
      } finally {
        releaseAiTask();
      }
    },

    "session.ignore"(payload) {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId) throw badRequest("sessionId-required");
      if (!state.ignoredSessions.includes(sessionId)) state.ignoredSessions.push(sessionId);
      state.suppressedSessions = state.suppressedSessions.filter((id) => id !== sessionId);
      persistState();
      emitChanged("settings", 0);
      return { sessionId, ignored: true };
    },

    "session.unignore"(payload) {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId) throw badRequest("sessionId-required");
      state.ignoredSessions = state.ignoredSessions.filter((id) => id !== sessionId);
      persistState();
      emitChanged("settings", 0);
      return { sessionId, ignored: false };
    },

    "settings.update"(payload) {
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : payload;
      const normalized = normalizeSettingsPatch(patch);
      // Old clients (pre-0.5) save the whole settings form without `aiBudgetMode`
      // (and without the new model-route fields), so a maxAiCallsPerScan value
      // alone does NOT prove the user touched the budget. Only a patch whose keys
      // are all budget fields proves that; then infer `fixed` for this update so
      // the legacy numeric control keeps working. Any other legacy save (e.g.
      // just autoScan) must leave the current mode untouched.
      const patchKeys = Object.keys(patch);
      const legacyBudgetOnly =
        normalized.maxAiCallsPerScan !== undefined &&
        patchKeys.every((key) => key === "maxAiCallsPerScan" || key === "dailyAiCallLimit");
      if (legacyBudgetOnly) normalized.aiBudgetMode = "fixed";
      const previous = state.settings;
      // normalizeSettingsPatch only returns contract settings keys, so a hostile
      // patch can never add __proto__/lastScanAt/unknown properties here.
      const merged = { ...state.settings, ...normalized };
      const halfRoute = Boolean(merged.aiProvider) !== Boolean(merged.aiModel);
      if (halfRoute) logWarn("[super-kanban] half-set AI model route normalized to follow-default");
      state.settings = normalizeAiRoutePair(merged);
      if (JSON.stringify(previous) !== JSON.stringify(state.settings)) {
        state.workspaces = state.workspaces.map((workspace) => ({
          ...workspace,
          included: !(state.settings.excludeWorkspaces || []).includes(workspace.id),
        }));
        persistState();
        emitChanged("settings", 0);
      }
      return state.settings;
    },

    "scan.start"(payload) {
      const result = startScan(payload.mode === "full" ? "full" : "incremental");
      if (!result.ok) throw Object.assign(new Error(result.message || "扫描进行中"), { code: result.error || "busy" });
      return result.data;
    },

    "scan.cancel"() {
      if (!scanPromise) return { cancelling: false };
      scanCancel = true;
      try {
        scanAbort?.abort();
      } catch {
        /* ignore */
      }
      state.scan.message = "正在取消扫描…";
      broadcastScan(true);
      return { cancelling: true };
    },
  };

  /* ------------------------------ routes --------------------------- */

  function handleSse(req, res) {
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      // Bound host memory: every open tab holds a socket + timer.
      json(res, 429, { ok: false, error: "too-many-clients", message: "too many event streams" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const client = { res, heartbeat: null };
    client.heartbeat = setInterval(() => {
      try {
        // Same backpressure rule as broadcast(): never queue heartbeats for a tab
        // that stopped reading.
        const accepted = res.write(": ping\n\n");
        if (accepted === false || (Number(res.writableLength) || 0) > SSE_MAX_BUFFER_BYTES) {
          removeSseClient(client);
        }
      } catch {
        removeSseClient(client);
      }
    }, SSE_HEARTBEAT_MS);
    if (typeof client.heartbeat.unref === "function") client.heartbeat.unref();
    sseClients.add(client);
    const cleanup = () => removeSseClient(client);
    // 'close' is the normal path; 'error' must be handled too, otherwise a
    // socket error surfaces as an unhandled EventEmitter error and can take the
    // host process down.
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    try {
      res.write(`event: scan\ndata: ${JSON.stringify(state.scan)}\n\n`);
      res.write(`event: changed\ndata: ${JSON.stringify({ reason: "init", tasksChanged: state.tasks.length })}\n\n`);
    } catch {
      removeSseClient(client);
    }
  }

  function findSessionMeta(sessionId) {
    if (sessionsById.has(sessionId)) return sessionsById.get(sessionId);
    if (cache.sessions[sessionId]?.meta) {
      const cachedMeta = cache.sessions[sessionId].meta;
      if (!cachedMeta.dir && cachedMeta.file) cachedMeta.dir = path.dirname(cachedMeta.file);
      return cachedMeta;
    }
    try {
      const discovery = source.discover();
      for (const discovered of discovery.sessions) {
        if (discovered.id !== sessionId) continue;
        const meta = hydrateMeta(discovered);
        sessionsById.set(sessionId, meta);
        return meta;
      }
    } catch (error) {
      logWarn(`[super-kanban] session lookup failed: ${String(error?.message || error)}`);
    }
    return null;
  }

  function sessionStatus(parsed) {
    if (parsed.isLive) return "active";
    const kind = parsed.lastTurnEnd?.kind;
    if (!kind) return "unknown";
    return kind;
  }

  function buildSessionResponse(sessionId, { after, limit }) {
    const meta = findSessionMeta(sessionId);
    // A hand-edited/corrupt cache entry may have no usable file path; treat it as
    // an unknown session instead of throwing a 500 from readFileSync(undefined).
    if (!meta || typeof meta.file !== "string" || !meta.file) return null;
    const parsed = source.loadParsed(meta);
    const events = source.readApiEvents(parsed, { after, limit });
    const workspace = meta.workspaceId ? workspaceById(meta.workspaceId) : null;
    const todos = source.latestTodos(parsed);
    const goalText = parsed.goal?.text || meta.goalText || null;
    const goalStatus = parsed.goal?.status || meta.goalStatus || null;
    return {
      ok: true,
      session: {
        id: parsed.id,
        title: parsed.title,
        goalText,
        goalStatus,
        todos: todos.todos,
        todoTotal: todos.todoTotal,
        todoDone: todos.todoDone,
        workspaceId: meta.workspaceId || null,
        workspaceTitle: meta.workspaceTitle || workspace?.title || null,
        createdAt: parsed.session.createdAt,
        lastActivityAt: parsed.lastActivityAt,
        turns: parsed.turnCount,
        eventCount: parsed.eventCount,
        status: sessionStatus(parsed),
        path: parsed.file,
        cwd: parsed.session.cwd,
        parentSession: parsed.parentSession,
        delegationDepth: parsed.delegationDepth,
        isLive: parsed.isLive,
      },
      events,
    };
  }

  function buildExport() {
    const sessions = Object.entries(cache.sessions).map(([id, entry]) => ({
      id,
      title: entry?.meta?.title || null,
      workspaceTitle: entry?.meta?.workspaceTitle || null,
      lastActivityAt: entry?.meta?.lastActivityAt || null,
      eventCount: entry?.meta?.eventCount || 0,
      isLive: Boolean(entry?.meta?.isLive),
      aiAt: entry?.meta?.aiAt || null,
    }));
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      state: {
        version: state.version,
        tasks: state.tasks,
        settings: state.settings,
        usage: state.usage,
        ignoredSessions: state.ignoredSessions,
        workspaces: state.workspaces,
        activity: state.activity,
        scan: state.scan,
        stats: computeStats(),
      },
      sessions,
    };
  }

  async function handle(req, res, { route = "/", url, method = "GET" } = {}) {
    if (stopped) {
      json(res, 503, { ok: false, error: "stopped", message: "service stopped" });
      return;
    }
    try {
      if (route === "/ping" && method === "GET") {
        json(res, 200, {
          ok: true,
          plugin: "dsh-super-kanban",
          dshHome,
          version: 2,
          time: new Date().toISOString(),
        });
        return;
      }
      if (route === "/state" && method === "GET") {
        json(res, 200, buildStatePayload());
        return;
      }
      if (route === "/ai/models" && method === "GET") {
        // Owner admission is enforced by the prefix handler in index.mjs. The
        // catalog is additive and never part of /state (4s polling stays small).
        json(res, 200, { ok: true, ...(await getAiCatalog()) });
        return;
      }
      if (route === "/command" && method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          json(res, 400, { ok: false, error: "invalid-input", message: "command body must be a JSON object" });
          return;
        }
        const op = typeof body.op === "string" ? body.op : "";
        // hasOwn: ops inherits Object.prototype, so "constructor"/"toString"
        // must be rejected as unknown ops instead of being called.
        if (!Object.hasOwn(ops, op)) {
          json(res, 400, { ok: false, error: "unknown-op", message: `unknown op: ${op}` });
          return;
        }
        const handler = ops[op];
        try {
          const data = await handler(body.payload && typeof body.payload === "object" ? body.payload : {});
          json(res, 200, { ok: true, data });
        } catch (error) {
          const status = classifyError(error);
          json(res, status, {
            ok: false,
            error: error?.code || "internal",
            message: String(error?.message || error),
          });
        }
        return;
      }
      if (route === "/export" && method === "GET") {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="super-kanban-${stamp}.json"`,
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(buildExport(), null, 2));
        return;
      }
      if (route === "/events" && method === "GET") {
        handleSse(req, res);
        return;
      }
      if (route.startsWith("/session/") && method === "GET") {
        // decodeId rejects malformed escapes and path separators: a session id is
        // an opaque lookup key, never a filesystem path.
        const sessionId = decodeId(route.slice("/session/".length));
        if (!sessionId) {
          json(res, 400, { ok: false, error: "invalid-input", message: "invalid session id" });
          return;
        }
        // Empty/absent params keep the documented defaults; only real numbers
        // are paging values (a non-numeric ?limit= must not disable the cap).
        const afterParam = url?.searchParams?.get("after");
        const limitParam = url?.searchParams?.get("limit");
        const afterRaw = afterParam === null || afterParam === "" ? Number.NaN : Number(afterParam);
        const limitRaw = limitParam === null || limitParam === "" ? Number.NaN : Number(limitParam);
        const payload = buildSessionResponse(sessionId, {
          after: Number.isFinite(afterRaw) ? afterRaw : null,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200,
        });
        if (!payload) {
          json(res, 404, { ok: false, error: "session-not-found", message: `session not found: ${sessionId}` });
          return;
        }
        json(res, 200, payload);
        return;
      }
      json(res, 404, { ok: false, error: "not-found", route });
    } catch (error) {
      logWarn(`[super-kanban] request failed ${method} ${route}: ${String(error?.message || error)}`);
      const status = classifyError(error);
      if (!res.headersSent) {
        try {
          json(res, status, { ok: false, error: error?.code || "internal", message: String(error?.message || error) });
        } catch {
          /* socket already closed */
        }
      } else {
        try {
          res.end();
        } catch {
          /* response already gone */
        }
      }
    }
  }

  /* ------------------------------ lifecycle ------------------------ */

  function maybeAutoScan() {
    if (stopped || scanPromise) return;
    if (aiBusy) {
      // Never queue a scan behind an explicit AI command: retry on a later tick
      // and log at most once a minute so a long re-judge cannot spam the host log.
      if (Date.now() - lastAiBusySkipLoggedAt > 60_000) {
        lastAiBusySkipLoggedAt = Date.now();
        logInfo("[super-kanban] auto scan skipped: an explicit AI task is running");
      }
      return;
    }
    if (!state.settings.autoScan) return;
    const last = Date.parse(state.settings.lastScanAt || "") || 0;
    const interval = (state.settings.scanIntervalSeconds || 120) * 1000;
    if (Date.now() - last >= interval) startScan("incremental");
  }

  function start() {
    if (stopped || autoTimer) return;
    subscribeAiCatalogEvents();
    // First scan should happen within ~8s of plugin boot.
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (stopped || scanPromise || aiBusy) return;
      if (state.settings.autoScan) startScan("incremental");
    }, 3000);
    if (typeof startupTimer.unref === "function") startupTimer.unref();
    autoTimer = setInterval(maybeAutoScan, 5000);
    if (typeof autoTimer.unref === "function") autoTimer.unref();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    scanCancel = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (scanBroadcastTimer) clearTimeout(scanBroadcastTimer);
    scanBroadcastTimer = null;
    for (const off of aiCatalogOffs.splice(0)) {
      try {
        off();
      } catch {
        /* disposer is host code */
      }
    }
    for (const client of [...sseClients]) removeSseClient(client);
    // Flush any state the running scan already produced; the scan itself stops at
    // its next checkpoint and its finalizer is exception-isolated.
    persistState();
    persistCache();
    logInfo("[super-kanban] host service stopped");
  }

  // The plugin entry never calls start() today; boot autonomously but keep the
  // documented start()/stop() surface for the host lifetime hooks.
  start();

  return { handle, start, stop };
}

export { DEFAULT_SETTINGS, EVIDENCE_LIMIT };
