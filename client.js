/**
 * Super Kanban — browser half (v1, Lead build).
 *
 * Hand-written DSH client plugin bundle: a full-page "task command deck" that
 * turns workspace sessions into a maintainable kanban. Talks to the host half
 * through /super-kanban/api/* and DSH's native client services. No build step or third-party deps.
 */
window.__ModuleLoader__.load({
  id: "dsh-super-kanban",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "super-kanban";
    const NS = "superKanban";
    const API = "super-kanban/api";
    const POLL_MS = 4000;
    const POLL_SCAN_MS = 1200;

    const SIDE_KIND = "super-kanban";
    const SIDE_ID = "dsh-super-kanban/panel";
    const PREFS_KEY = "dsh-super-kanban:prefs";
    const DEFAULT_PREFS = Object.freeze({ fullEntry: true, sideEntry: true });

    /* ---------------------- v0.5：AI 模型 / 预算常量 ---------------------- */

    // 与 Host 契约对齐（docs/CONTRACT.md「GET /ai/models」与 settings.aiBudgetMode）。
    const AI_CATALOG_TIMEOUT_MS = 15_000; // 客户端 15s；Host 侧 12s 先返回
    const AI_CATALOG_TTL_MS = 30_000; // 模块级内存缓存，不写 localStorage
    const AI_BUDGET_MODE_DEFAULT = "auto"; // "auto" | "fixed"，缺省按 auto
    const AI_MAX_CALLS_DEFAULT = 40; // 纯数字，仅 fixed 生效；Host 钳 5–150
    const AI_MAX_CALLS_MIN = 5;
    const AI_MAX_CALLS_MAX = 150;
    const MAX_AI_CALL_OPTIONS = [20, 40, 80, 150]; // 固定档；下拉首项另加「自动」
    const DAILY_AI_CALL_OPTIONS = [50, 150, 300, 500];
    const PROMPT_POLISH_LIMIT = 3000;

    /* ============================== constants ============================== */

    const STATUS_META = {
      backlog: { label: "待办", tone: "var(--dsw-alias-label-tertiary)", desc: "未开始或等待排期" },
      in_progress: { label: "进行中", tone: "var(--dsw-alias-brand-primary)", desc: "AI 判断正在推进" },
      blocked: { label: "受阻", tone: "var(--dsw-alias-state-warn-primary)", desc: "有未解决的问题" },
      done: { label: "已完成", tone: "var(--dsw-alias-state-success-primary)", desc: "已交付或已闭环" },
    };
    const STATUS_ORDER = ["backlog", "in_progress", "blocked", "done"];
    const COLUMN_PAGE_SIZE = 30;
    const TASK_DRAG_TYPE = "application/x-dsh-super-kanban-task";
    const VIEW_MODES = { attention: "待处理", board: "看板", list: "列表", hierarchy: "层级", artifacts: "产出", maintenance: "维护" };
    const RELATION_LABELS = { parent: "父任务", depends_on: "依赖任务", related: "相关任务" };
    const ATTENTION_LABELS = { waiting_user: "待你确认", review: "待确认进度", acceptance: "待验收", interrupted: "执行中断" };
    const INTERACTION_LABELS = { approval: "待审批", question: "待回答", "plan-review": "待审阅方案" };
    const COMPLETION_LABELS = { user: "人工确认", session_goal: "DSH 目标完成", session_todos: "本轮待办已完成" };
    let pendingHandoff = null;

    function withSessionStatus(task, statuses) {
      if (typeof statuses?.get !== "function") return task;
      const primaryId = task.primarySessionId;
      const sessions = new Map((task.sessions || []).filter((session) => session?.id).map((session) => [session.id, session.title]));
      if (primaryId && !sessions.has(primaryId)) sessions.set(primaryId, task.sessionContext?.title);
      const primary = primaryId ? statuses.get(primaryId) : null;
      const pendingSessions = [];
      let runningSessions = 0;
      for (const [id, title] of sessions) {
        const native = statuses.get(id);
        const pending = native?.pendingInteraction;
        if (pending) {
          const kind = typeof pending === "string" ? pending : pending.kind;
          const label = Object.hasOwn(INTERACTION_LABELS, kind) ? INTERACTION_LABELS[kind] : "待处理请求";
          pendingSessions.push({ id, title: title || "来源会话", label });
        } else if (native?.running ?? (id === primaryId && task.sessionContext?.isLive)) {
          runningSessions++;
        }
      }
      return {
        ...task,
        pendingSessions,
        runningSessions,
        sessionContext: typeof primary?.running === "boolean"
          ? { ...task.sessionContext, isLive: primary.running }
          : task.sessionContext,
      };
    }

    function taskSignal(task, index, now) {
      if (task.archived) return null;
      const pending = task.pendingSessions || [];
      if (pending.length === 1) return { label: pending[0].label, text: pending[0].title, rank: 0 };
      if (pending.length > 1) return { label: `${pending.length} 个会话待处理`, rank: 0 };
      if (task.writeOverlap) return { label: "可能同时修改", text: task.writeOverlap.path, rank: 1 };
      if (task.status === "done") return null;
      const dependency = task.relations?.find((link) => link.type === "depends_on" && index.get(link.taskId)?.status !== "done");
      if (dependency) return { label: "等待依赖", text: index.get(dependency.taskId)?.title || "关联任务不可用", taskId: dependency.taskId, rank: 1 };
      const issue = task.issues?.find((item) => item.severity === "high") || task.issues?.[0];
      if (!task.sessionContext?.isLive && task.sessionContext?.lastTurnEnd === "error") {
        const sessionId = task.sessionContext.sessionId || task.primarySessionId;
        const failure = task.issues?.find((item) => item.sessionId === sessionId) || (issue?.sessionId ? null : issue);
        return { label: "执行失败", text: failure?.text || task.ai?.reason, sessionId, rank: 1 };
      }
      if (task.status === "blocked" || issue) return { label: "待处理问题", text: issue?.text || task.nextSteps?.[0], rank: 1 };
      if (!task.sessionContext?.isLive && ["review", "acceptance"].includes(task.attention)) {
        const delivery = primaryArtifactOf(artifactsOf(task));
        const deliverable = delivery?.kind === "deliverable" ? delivery : null;
        const ready = deliverable || task.attention === "acceptance";
        return { label: ready ? "待验收" : ATTENTION_LABELS.review, text: deliverable?.name || task.ai?.reason, rank: 2 };
      }
      if (!task.sessionContext?.isLive && Object.hasOwn(ATTENTION_LABELS, task.attention)) {
        return { label: ATTENTION_LABELS[task.attention], text: task.nextSteps?.[0] || task.ai?.reason, rank: task.attention === "waiting_user" ? 1 : 2 };
      }
      if (!(task.runningSessions ?? task.sessionContext?.isLive) && task.status === "in_progress" && task.lastActivityAt > 0 && now - task.lastActivityAt > 7 * 86400000) {
        return { label: "久未更新", text: task.nextSteps?.[0], rank: 3 };
      }
      return null;
    }

    function taskProgressLabel(task) {
      if (task.lockedFields?.includes("progress") && pct(task.progress) !== null) return `手动 ${pct(task.progress)}%`;
      const items = subtasksOf(task);
      if (items.length) return `${items.filter((item) => item.done).length}/${items.length} 项`;
      if (task.status === "done") return COMPLETION_LABELS[task.completionBasis] || "已完成";
      const value = pct(task.progress);
      return value === null ? "进度未知" : task.ai?.engine === "llm" ? `估计 ${value}%` : `${value}%`;
    }

    function taskRunningLabel(task) {
      const running = task.runningSessions ?? (task.sessionContext?.isLive ? 1 : 0);
      return running > 1 ? `${running} 个会话运行中` : running ? "会话运行中" : "";
    }
    /** 用户可锁定、避免被 AI 研判覆盖的任务字段（与 Host task.update 的 lockFields 对齐）。 */
    const EDITABLE_FIELDS = Object.freeze(["title", "goal", "status", "priority", "progress"]);
    /**
     * 持久化文本上限，镜像 Host `server/store.mjs` 的 `TEXT_LIMITS`（导出常量，不在 client.js import）。
     * Host 已按这些上限截断；客户端表单 maxLength 必须一致，避免「输入被静默截断」。
     * title 80 / goal 280 / tag 12×4 / subtask 60 / issue·nextStep 160 / milestone 120 / keyFact 60
     * / evidence text 200 · quote 160。
     */
    const TEXT_LIMITS = Object.freeze({
      title: 80,
      goal: 280,
      acceptanceCriteria: 600,
      tagText: 12,
      tags: 4,
      subtaskText: 60,
      issueText: 160,
      nextStepText: 160,
      milestoneText: 120,
      keyFactText: 60,
      evidenceText: 200,
      evidenceQuote: 160,
    });

    const PRIORITY_META = {
      P0: { label: "P0", tone: "var(--dsw-alias-state-error-primary)" },
      P1: { label: "P1", tone: "var(--dsw-alias-state-warn-primary)" },
      P2: { label: "P2", tone: "var(--dsw-alias-brand-primary)" },
      P3: { label: "P3", tone: "var(--dsw-alias-label-tertiary)" },
    };
    const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"];

    const KIND_META = {
      user: { label: "用户", icon: "user" },
      assistant: { label: "助手", icon: "bot" },
      todo: { label: "待办", icon: "check" },
      tool: { label: "工具", icon: "tool" },
      artifact: { label: "产物", icon: "file" },
      error: { label: "错误", icon: "alert" },
      deliverable: { label: "交付", icon: "send" },
    };

    /* ============================== helpers ================================ */

    function cx(...names) {
      return names.filter(Boolean).join(" ");
    }

    async function apiRequest(path, options) {
      const url = new URL(`${API}${path}`, document.baseURI);
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok === false) {
        const message =
          (payload && (payload.message || payload.error)) || `请求失败（HTTP ${response.status}）`;
        const error = new Error(message);
        // Keep the HTTP status on the error so callers can distinguish an old
        // Host that lacks an endpoint (404 → graceful "unavailable") from a
        // genuine read failure.
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function command(op, payload) {
      return apiRequest(op === "backup.preview" || op === "backup.restore" ? "/backup" : "/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, payload: payload || {} }),
      });
    }

    /** 下载 /export 的 JSON（设置弹窗与页头菜单共用；失败由调用方 toast）。 */
    async function downloadExport() {
      const payload = await apiRequest("/export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `super-kanban-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function relTime(ms) {
      if (!ms) return "—";
      const delta = Date.now() - Number(ms);
      if (!Number.isFinite(delta)) return "—";
      if (delta < 60_000) return "刚刚";
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
      if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
      return new Date(Number(ms)).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    }

    /** 时间字段兼容 ISO 字符串 / epoch ms（Host 的 task.history[].at 是 ISO）；非法值交给 relTime 显示「—」。 */
    function relTimeValue(value) {
      if (typeof value === "number") return relTime(value);
      const parsed = Date.parse(value);
      return relTime(Number.isFinite(parsed) ? parsed : 0);
    }

    function shortTime(ms) {
      if (!ms) return "";
      const date = new Date(Number(ms));
      const today = new Date();
      const sameDay =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();
      if (sameDay) {
        return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      }
      return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    }

    function clip(text, max) {
      const value = String(text || "");
      if (value.length <= max) return value;
      return `${value.slice(0, max)}…`;
    }

    /** Host v2：无法在时间线上定位引用时 seq 为 null（永不为 0）。0/null 一律视为「无引用序号」。 */
    function seqOf(value) {
      if (value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
    }

    function pct(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
      return Math.max(0, Math.min(100, Math.round(Number(value))));
    }

    function progressOf(task) {
      if (task.lockedFields?.includes("progress") && pct(task.progress) !== null) return pct(task.progress);
      const subtasks = subtasksOf(task);
      if (subtasks.length) return Math.round((subtasks.filter((item) => item.done).length / subtasks.length) * 100);
      const value = pct(task.progress);
      if (value !== null) return value;
      if (task.status === "done") return 100;
      return 0;
    }

    /* ------------------------- v2 防御性字段访问 ------------------------- */

    const FACT_KINDS = {
      issue: { label: "问题", icon: "alert", tone: "var(--sk-red)", weight: 0 },
      decision: { label: "决策", icon: "check", tone: "var(--sk-accent)", weight: 1 },
      progress: { label: "进展", icon: "arrow", tone: "var(--sk-blue)", weight: 2 },
      status: { label: "状态", icon: "board", tone: "var(--sk-ink-3)", weight: 3 },
      artifact: { label: "产物", icon: "file", tone: "var(--sk-green)", weight: 4 },
      goal: { label: "目标", icon: "target", tone: "var(--sk-ink-3)", weight: 5 },
    };

    function factMeta(kind) {
      return FACT_KINDS[kind] || FACT_KINDS.status;
    }

    /** 关键事实：Host v2 keyFacts（≤6）；v1 缺省时为空，卡片回退到 goal 一行。 */
    function keyFactsOf(task) {
      const raw = Array.isArray(task.keyFacts) ? task.keyFacts : [];
      return raw
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .slice(0, 6)
        .map((item, index) => ({
          id: item.id || `kf_${index}`,
          text: clip(item.text.trim(), TEXT_LIMITS.keyFactText),
          kind: FACT_KINDS[item.kind] ? item.kind : "status",
          sessionId: item.sessionId || "",
          seq: seqOf(item.seq),
        }));
    }

    /** 子任务：Host v2 subtasks；v1 数据用 milestones 兜底。 */
    function subtasksOf(task) {
      const raw = Array.isArray(task.subtasks) ? task.subtasks : null;
      if (raw) {
        return raw
          .filter((item) => item && typeof item.text === "string" && item.text.trim())
          .map((item, index) => ({
            id: item.id || `st_${index}`,
            text: clip(item.text.trim(), TEXT_LIMITS.subtaskText),
            done: item.done === true,
            source: ["ai", "todo", "manual"].includes(item.source) ? item.source : "manual",
            seq: seqOf(item.seq),
          }));
      }
      return (Array.isArray(task.milestones) ? task.milestones : [])
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .slice(0, 12)
        .map((item, index) => ({
          id: item.id || `st_${index}`,
          text: clip(item.text.trim(), TEXT_LIMITS.milestoneText),
          done: item.done === true,
          source: "ai",
          seq: seqOf(item.seq),
        }));
    }

    function artifactsOf(task) {
      return (Array.isArray(task.artifacts) ? task.artifacts : [])
        .filter((item) => item && (item.name || item.path || item.absPath))
        .map((item, index) => ({
          id: item.id || `af_${index}`,
          name: String(item.name || fileNameOf(item.path || item.absPath) || "产物"),
          path: String(item.path || item.absPath || ""),
          absPath: String(item.absPath || ""),
          sessionId: String(item.sessionId || ""),
          seq: seqOf(item.seq),
          time: Number(item.time) || 0,
          kind: item.kind || "file",
          missing: item.missing === true,
        }));
    }

    function isHostAbsolutePath(value) {
      return /^(?:\/|[a-z]:[/\\]|\\\\)/i.test(value);
    }

    function fileNameOf(path) {
      const value = String(path || "");
      return value.split(value.startsWith("/") ? "/" : /[/\\]/).pop();
    }

    function primaryArtifactOf(artifacts) {
      return artifacts.filter((item) => item.path && !item.missing).sort((left, right) =>
        Number(right.kind === "deliverable") - Number(left.kind === "deliverable") || right.time - left.time,
      )[0];
    }

    function goalInfoOf(task) {
      if (task.goal && typeof task.goal === "object") {
        return {
          text: String(task.goal.text || "").trim(),
          status: ["active", "done", "none"].includes(task.goal.status) ? task.goal.status : "active",
          source: task.goal.source === "session" ? "session" : "task",
        };
      }
      const text = String(task.goal || "").trim();
      if (!text) return null;
      return { text, status: task.status === "done" ? "done" : "active", source: "task" };
    }

    /** task.ai 的防御性归一化：引擎、模型 / 提供方、置信度（0-100）、研判时间与理由。 */
    function aiInfoOf(task) {
      const raw = task && task.ai && typeof task.ai === "object" ? task.ai : null;
      if (!raw) return null;
      const analyzedAt = raw.analyzedAt ? Date.parse(raw.analyzedAt) : NaN;
      return {
        engine: raw.engine === "llm" ? "llm" : "rules",
        model: String(raw.model || "").trim(),
        // 旧任务没有 provider（老数据），保持空串即可，UI 降级为只显示 model。
        provider: String(raw.provider || "").trim(),
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.round(Math.max(0, Math.min(1, Number(raw.confidence))) * 100) : null,
        analyzedAt: Number.isFinite(analyzedAt) ? analyzedAt : null,
        reason: String(raw.reason || "").trim(),
      };
    }

    function sessionContextOf(task) {
      const ctx = task.sessionContext && typeof task.sessionContext === "object" ? task.sessionContext : null;
      const sessions = Array.isArray(task.sessions) ? task.sessions : [];
      const first = sessions.find((item) => item.id === task.primarySessionId) || sessions[0] || {};
      const base = {
        sessionId: String(task.primarySessionId || (ctx && ctx.sessionId) || first.id || ""),
        title: String((ctx && ctx.title) || first.title || "来源会话"),
        isLive: !!(ctx && ctx.isLive),
        turnCount: Number(ctx && ctx.turnCount) || 0,
        lastTurnEnd: (ctx && ctx.lastTurnEnd) || null,
        lastActivityAt: Number((ctx && ctx.lastActivityAt) || task.lastActivityAt || 0),
        todoTotal: Number(ctx && ctx.todoTotal) || 0,
        todoDone: Number(ctx && ctx.todoDone) || 0,
      };
      return base;
    }

    function usageOf(data) {
      const raw = data && data.usage;
      if (!raw || typeof raw !== "object") return null;
      const last = raw.lastScan && typeof raw.lastScan === "object" ? raw.lastScan : {};
      return {
        date: String(raw.date || ""),
        calls: Number(raw.calls) || 0,
        tokens: Number(raw.tokens) || 0,
        lastScan: {
          calls: Number(last.calls) || 0,
          tokens: Number(last.tokens) || 0,
          durationMs: Number(last.durationMs) || 0,
        },
      };
    }

    function fmtTokens(value) {
      const number = Number(value) || 0;
      if (number >= 10000) return (number / 1000).toFixed(1) + "k";
      return String(number);
    }

    function fmtDuration(ms) {
      const value = Number(ms) || 0;
      if (!value) return "—";
      if (value < 1000) return value + "ms";
      return (value / 1000).toFixed(1) + "s";
    }

    /* --------------------- v0.5：AI 模型 / 预算辅助函数 --------------------- */

    // /ai/models 的模块级缓存：设置弹窗打开时拉取，抽屉只读 provider 显示名映射。
    let aiCatalogCache = null; // { at, catalogAvailable, default, providers, models, groups, failures, fetchedAt }
    let aiCatalogProviders = []; // [{ id, name, modelCount }]

    function textOf(value) {
      return value === null || value === undefined ? "" : String(value).trim();
    }

    /** aiBudgetMode 归一化：只认 "fixed"，其余（缺失 / 脏值）一律按默认 auto；禁止用数字 0 表示自动。 */
    function aiBudgetModeOf(mode) {
      return mode === "fixed" ? "fixed" : AI_BUDGET_MODE_DEFAULT;
    }

    function isAutoBudgetMode(mode) {
      return aiBudgetModeOf(mode) === "auto";
    }

    /** settings.aiProvider + aiModel 成对读取；只有一半时视为「跟随 DSH 默认」。 */
    function aiModelRef(settings) {
      if (!settings || typeof settings !== "object") return null;
      const provider = textOf(settings.aiProvider);
      const model = textOf(settings.aiModel);
      return provider && model ? { provider, model } : null;
    }

    /** select 的 option value：""=跟随默认；具体模型用 JSON 数组编码，避免 id 里 : / @ 产生歧义。 */
    function aiModelValue(ref) {
      return ref && ref.provider && ref.model ? JSON.stringify([ref.provider, ref.model]) : "";
    }

    function parseAiModelValue(value) {
      if (typeof value !== "string" || !value) return null;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length !== 2) return null;
        const provider = textOf(parsed[0]);
        const model = textOf(parsed[1]);
        return provider && model ? { provider, model } : null;
      } catch {
        return null;
      }
    }

    /** 固定档兜底：当前值不在标准档位时补一项，旧 state / 手改值也能显示与回切。 */
    function withAiCallOptions(value) {
      const number = Number(value);
      const extra =
        Number.isFinite(number) && number >= AI_MAX_CALLS_MIN && number <= AI_MAX_CALLS_MAX ? Math.round(number) : null;
      const options = MAX_AI_CALL_OPTIONS.slice();
      if (extra !== null && !options.includes(extra)) {
        options.push(extra);
        options.sort((left, right) => left - right);
      }
      return options;
    }

    /** 每日上限兜底：Host 允许 10–500 任意值，当前值不在标准档位时补一项，避免被静默显示成 50。 */
    function withDailyAiCallOptions(value) {
      const number = Number(value);
      const extra = Number.isFinite(number) && number >= 10 && number <= 500 ? Math.round(number) : null;
      const options = DAILY_AI_CALL_OPTIONS.slice();
      if (extra !== null && !options.includes(extra)) {
        options.push(extra);
        options.sort((left, right) => left - right);
      }
      return options;
    }

    // DSH 官方 route 白名单（route id，见 @deepseek-ai/dsh-llm-deepseek-account / -api-key 两条通道）。
    // 不按 `deepseek` 前缀判断：用户自定义 provider 可能叫 `deepseek-custom`，按前缀会误判为官方、漏掉第三方隐私提示。
    const OFFICIAL_PROVIDERS = Object.freeze(["deepseek-account", "deepseek-official"]);

    /** 是否第三方 provider：只把官方 route 白名单视为官方，其余（含 deepseek-* 自定义命名）一律第三方。 */
    function isThirdPartyProvider(provider) {
      const id = textOf(provider).toLowerCase();
      return Boolean(id) && !OFFICIAL_PROVIDERS.includes(id);
    }

    /** provider 显示名：优先用本次会话已加载的模型目录，缺失回落 id（抽屉不额外发请求）。 */
    function providerLabel(id) {
      const providerId = textOf(id);
      if (!providerId) return "";
      const hit = aiCatalogProviders.find((provider) => provider.id === providerId);
      return (hit && hit.name) || providerId;
    }

    function modelNameOf(provider, model) {
      const providerId = textOf(provider);
      const modelId = textOf(model);
      const hit =
        aiCatalogCache && Array.isArray(aiCatalogCache.models)
          ? aiCatalogCache.models.find((item) => item.provider === providerId && item.id === modelId)
          : null;
      return (hit && hit.name) || modelId;
    }

    /** 「provider 显示名 / model 显示名」；provider 缺失时只给 model（旧任务样式）。 */
    function modelLabel(provider, model) {
      const providerId = textOf(provider);
      const modelText = modelNameOf(providerId, model);
      return providerId ? `${providerLabel(providerId)} / ${modelText}` : modelText;
    }

    /**
     * GET /ai/models 的容错归一化。契约是扁平包络（提案 §2.3-3）；
     * payload.data ?? payload 仅作为旧实现兜底，不作为契约。
     */
    function normalizeAiCatalog(payload) {
      const body = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
      const source = body && typeof body === "object" ? body : {};
      const providers = [];
      const providerById = new Map();
      for (const item of Array.isArray(source.providers) ? source.providers : []) {
        const raw = typeof item === "string" ? { id: item } : item;
        if (!raw || typeof raw !== "object") continue;
        const id = textOf(raw.id);
        if (!id || providerById.has(id)) continue;
        const provider = { id, name: textOf(raw.name) || id, modelCount: Number(raw.modelCount) || 0 };
        providerById.set(id, provider);
        providers.push(provider);
      }
      const models = [];
      const seenModels = new Set();
      for (const item of Array.isArray(source.models) ? source.models : []) {
        if (!item || typeof item !== "object") continue;
        const provider = textOf(item.provider);
        const id = textOf(item.id);
        if (!provider || !id || seenModels.has(provider + "\u0000" + id)) continue;
        seenModels.add(provider + "\u0000" + id);
        models.push({ provider, id, name: textOf(item.name) || id });
      }
      // models 里出现、但 providers 没列的 provider：补一个占位，保证 optgroup 有标题。
      for (const model of models) {
        if (providerById.has(model.provider)) continue;
        const provider = { id: model.provider, name: model.provider, modelCount: 0 };
        providerById.set(provider.id, provider);
        providers.push(provider);
      }
      const groups = providers
        .map((provider) => ({ provider, models: models.filter((model) => model.provider === provider.id) }))
        .filter((group) => group.models.length > 0);
      const failures = (Array.isArray(source.failures) ? source.failures : [])
        .slice(0, 8)
        .reduce((list, item) => {
          if (!item || typeof item !== "object") return list;
          const providerId = textOf(item.provider);
          const name = textOf(item.name) || providerId;
          if (!providerId && !name) return list;
          list.push({ provider: providerId, name, message: textOf(item.message) });
          return list;
        }, []);
      const rawDefault = source.default && typeof source.default === "object" ? source.default : null;
      const defaultRef =
        rawDefault && textOf(rawDefault.provider) && textOf(rawDefault.model)
          ? { provider: textOf(rawDefault.provider), model: textOf(rawDefault.model) }
          : null;
      return {
        catalogAvailable: source.catalogAvailable === true,
        default: defaultRef,
        providers,
        models,
        groups,
        failures,
        fetchedAt: textOf(source.fetchedAt),
      };
    }

    /**
     * 模型目录状态机：loading / refreshing / ready / empty / unavailable / error。
     * 打开弹窗时拉取；30s 内重开先用缓存渲染再后台刷新；失败不阻塞其它设置保存。
     */
    function useAiCatalog() {
      const initialStatus = () => {
        if (!aiCatalogCache) return { status: "loading", data: null, error: "", announce: "" };
        const base = aiCatalogCache.catalogAvailable ? (aiCatalogCache.models.length ? "ready" : "empty") : "unavailable";
        const fresh = Date.now() - (Number(aiCatalogCache.at) || 0) < AI_CATALOG_TTL_MS;
        // 30s 内命中缓存直接按终态渲染；过期缓存先展示旧目录并标记 refreshing（stale-while-revalidate）。
        return { status: fresh ? base : "refreshing", data: aiCatalogCache, error: "", announce: "" };
      };
      const [state, setState] = React.useState(initialStatus);
      const mountedRef = React.useRef(true);
      const busyRef = React.useRef(false);
      const abortRef = React.useRef(null);
      const requestRef = React.useRef(0);

      const load = React.useCallback(async (manual) => {
        if (busyRef.current) return;
        busyRef.current = true;
        const requestId = (requestRef.current += 1);
        const controller = new AbortController();
        abortRef.current = controller;
        const timer = setTimeout(() => controller.abort(), AI_CATALOG_TIMEOUT_MS);
        setState((prev) =>
          prev.data
            ? { ...prev, status: "refreshing", announce: "" }
            : { status: "loading", data: null, error: "", announce: "" },
        );
        try {
          const payload = await apiRequest("/ai/models", { signal: controller.signal });
          const catalog = normalizeAiCatalog(payload);
          aiCatalogCache = { ...catalog, at: Date.now() };
          aiCatalogProviders = catalog.providers;
          if (!mountedRef.current || requestRef.current !== requestId) return;
          const modelCount = catalog.models.length;
          const status = catalog.catalogAvailable ? (modelCount ? "ready" : "empty") : "unavailable";
          setState({
            status,
            data: catalog,
            error: "",
            announce: manual ? `模型目录已更新，共 ${modelCount} 个模型` : "",
          });
        } catch (cause) {
          // 卸载 / 过期请求（例如 StrictMode 重挂载）一律静默，避免脏状态覆盖新请求。
          if (!mountedRef.current || requestRef.current !== requestId) return;
          const aborted = Boolean(cause && cause.name === "AbortError");
          const message = aborted
            ? `读取超时（${AI_CATALOG_TIMEOUT_MS / 1000} 秒）`
            : String((cause && cause.message) || cause);
          // 旧 Host 没有该端点：按「目录不可用」降级，不弹错误。
          const status = cause?.status === 404 || /HTTP 404/.test(message) ? "unavailable" : "error";
          setState((prev) => ({
            status,
            data: prev.data,
            error: status === "unavailable" ? "" : message,
            announce: manual && status === "error" ? `模型目录读取失败：${message}` : "",
          }));
        } finally {
          clearTimeout(timer);
          // I6：只让「最新请求」清理共享 refs，旧请求（卸载/StrictMode/并发）不得覆盖新请求状态。
          if (requestRef.current === requestId) {
            busyRef.current = false;
            abortRef.current = null;
          }
        }
      }, []);

      React.useEffect(() => {
        mountedRef.current = true;
        load(false);
        return () => {
          mountedRef.current = false;
          requestRef.current += 1;
          const controller = abortRef.current;
          busyRef.current = false;
          if (controller) controller.abort();
        };
      }, [load]);

      const refresh = React.useCallback(() => load(true), [load]);
      return { status: state.status, data: state.data, error: state.error, announce: state.announce, refresh };
    }

    /**
     * 模型说明行文案：状态机各态的可见文案 + 是否用琥珀强调 + 可选操作。
     * 优先级（I4）：已保存模型找不到（目录不可用/为空/未包含）> 目录自身状态/引导 > 跟随默认说明。
     * 保存过的模型即使当前目录不可见，下一次研判仍会尝试，失败才降级规则——这条要先让用户看到。
     */
    function catalogNote(catalog, current) {
      const data = catalog.data;
      const models = (data && data.models) || [];
      const failures = (data && data.failures) || [];
      const defaultRef = (data && data.default) || null;
      const failText = failures.length
        ? ` ${failures.length} 个提供方读取失败，仅显示可用模型（${failures[0].name || failures[0].provider}${failures[0].message ? "：" + failures[0].message : ""}）。`
        : "";
      const savedFound = current
        ? models.some((item) => item.provider === current.provider && item.id === current.model)
        : false;
      const catalogUsable = catalog.status === "ready" || catalog.status === "refreshing";
      const savedOffline = Boolean(current) && catalog.status !== "loading" && (!catalogUsable || !savedFound);

      // I4：已保存模型不在当前目录（目录不可用 / 为空 / 未包含）时优先说明「仍会尝试、失败降级」。
      if (savedOffline) {
        const detail =
          catalog.status === "unavailable"
            ? "当前无法读取模型目录"
            : catalog.status === "error"
              ? `读取模型目录失败（${catalog.error || "未知错误"}）`
              : "当前目录中没有该模型";
        return {
          text: `已保存：${modelLabel(current.provider, current.model)}；${detail}。下一次研判仍会尝试该模型，失败则降级为规则推断。${
            catalog.status === "unavailable" ? "" : "可在「DSH 设置 → 模型」中检查后点右侧刷新，或改为跟随默认。"
          }${failText}`,
          warn: true,
          followDefault: true,
          retry: catalog.status === "error",
        };
      }
      if (catalog.status === "loading") return { text: "正在读取模型目录…", warn: false };
      if (catalog.status === "unavailable") {
        return {
          text: "当前 DSH 不支持原生模型，扫描将退回本地规则推断。可在「DSH 设置 → 模型」中配置模型提供方或自定义模型 API，或升级 DSH 后重试。",
          warn: false,
        };
      }
      if (catalog.status === "error") {
        return {
          text: `读取模型目录失败：${catalog.error || "未知错误"}`,
          warn: true,
          retry: true,
        };
      }
      if (catalog.status === "empty") {
        // 三种空态文案不同：读取失败 / 已配置提供方但无模型 / 完全没有提供方。
        if (failures.length) {
          return {
            text: `部分模型提供方读取失败（${failures.length} 个），暂无可用模型；可点右侧刷新重试，或稍后在「DSH 设置 → 模型」检查。`,
            warn: true,
          };
        }
        const hasProviders = Boolean(data && Array.isArray(data.providers) && data.providers.length > 0);
        return hasProviders
          ? {
              text: "已添加模型提供方，但目录中没有可用模型；请在「DSH 设置 → 模型」中检查凭证或添加模型，再点右侧刷新。",
              warn: false,
            }
          : {
              text: "DSH 模型目录中没有可用模型。请先在「DSH 设置 → 模型」中添加模型提供方并配置模型，再点右侧刷新。",
              warn: false,
            };
      }
      if (current) {
        // 到这里 current 一定已在目录中（离线分支已提前返回）。
        return { text: `使用 ${modelLabel(current.provider, current.model)}。${failText}`, warn: failures.length > 0 };
      }
      if (!defaultRef) {
        return {
          text: `未读取到 DSH 默认模型；扫描时会回退到模型目录中第一个有模型的 provider 的模型（没有可用模型时用规则推断）。${failText}`,
          warn: true,
        };
      }
      const defaultFound = models.some((item) => item.provider === defaultRef.provider && item.id === defaultRef.model);
      if (!defaultFound) {
        return {
          text: `当前 DSH 默认：${modelLabel(defaultRef.provider, defaultRef.model)}（当前目录中不可用，扫描可能降级为规则推断；不会自动切换模型）。${failText}`,
          warn: true,
        };
      }
      return {
        text: `当前 DSH 默认：${modelLabel(defaultRef.provider, defaultRef.model)}。${failText}`,
        warn: failures.length > 0,
      };
    }

    function statusOf(task) {
      return STATUS_META[task.status] ? task.status : "backlog";
    }

    function compareTasks(a, b) {
      const pinned = Number(b.pinned === true) - Number(a.pinned === true);
      if (pinned) return pinned;
      const pa = PRIORITY_ORDER.indexOf(a.priority || "P3");
      const pb = PRIORITY_ORDER.indexOf(b.priority || "P3");
      const p = (pa < 0 ? 9 : pa) - (pb < 0 ? 9 : pb);
      if (p !== 0) return p;
      return Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0);
    }

    function allTags(tasks) {
      const tags = new Map();
      for (const task of tasks) {
        for (const tag of task.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
      }
      return [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    }

    const WS_COLORS = ["#4176e6", "#22c55e", "#f59e0b", "#ec1313", "#8b5cf6", "#06b6d4", "#64748b"];

    /** 工作区识别色：同一 id 永远得到同一颜色。 */
    function workspaceColor(id) {
      const text = String(id || "");
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
      return WS_COLORS[hash % WS_COLORS.length];
    }

    /** 显示与入口偏好：{ fullEntry, sideEntry }，默认两者都开。 */
    function readPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(raw);
        return { fullEntry: parsed.fullEntry !== false, sideEntry: parsed.sideEntry !== false };
      } catch {
        return { ...DEFAULT_PREFS };
      }
    }

    function writePrefs(next) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ fullEntry: next.fullEntry !== false, sideEntry: next.sideEntry !== false }));
      } catch {
        /* localStorage may be unavailable */
      }
    }

    function prefsMode(prefs) {
      if (prefs.fullEntry && prefs.sideEntry) return "both";
      if (prefs.fullEntry) return "page";
      return "side";
    }

    function modePrefs(mode) {
      if (mode === "page") return { fullEntry: true, sideEntry: false };
      if (mode === "side") return { fullEntry: false, sideEntry: true };
      return { fullEntry: true, sideEntry: true };
    }

    /* ================================ icons =============================== */

    function Svg({ size = 16, children, ...props }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          ...props,
        },
        children,
      );
    }

    const ICONS = {
      chat: (p) => h(Svg, p, h("path", { d: "M20 5H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h5l4 3.5V17h7a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" })),
      board: (p) =>
        h(Svg, p, h("rect", { x: 3, y: 4, width: 5, height: 16, rx: 1.5 }), h("rect", { x: 9.5, y: 4, width: 5, height: 10, rx: 1.5 }), h("rect", { x: 16, y: 4, width: 5, height: 13, rx: 1.5 })),
      filter: (p) => h(Svg, p, h("path", { d: "M4 5.5h16l-6.2 7.2v5.6l-3.6 1.8v-7.4z" })),
      more: (p) => h(Svg, p, h("circle", { cx: 5, cy: 12, r: 1, fill: "currentColor", stroke: "none" }), h("circle", { cx: 12, cy: 12, r: 1, fill: "currentColor", stroke: "none" }), h("circle", { cx: 19, cy: 12, r: 1, fill: "currentColor", stroke: "none" })),
      back: (p) => h(Svg, p, h("path", { d: "m15 18-6-6 6-6" })),
      stop: (p) => h(Svg, p, h("rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 })),
      chevronDown: (p) => h(Svg, p, h("path", { d: "m6 9 6 6 6-6" })),
      copy: (p) => h(Svg, p, h("rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }), h("path", { d: "M5.5 14.5H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1v.5" })),
      play: (p) => h(Svg, p, h("path", { d: "M7 5.2 18 12 7 18.8z" })),
      target: (p) => h(Svg, p, h("circle", { cx: 12, cy: 12, r: 8.5 }), h("circle", { cx: 12, cy: 12, r: 4.4 }), h("circle", { cx: 12, cy: 12, r: 1.1 })),
      layout: (p) => h(Svg, p, h("rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }), h("path", { d: "M9.5 4.5v15" })),
      panelRight: (p) => h(Svg, p, h("rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }), h("path", { d: "M14.5 4.5v15" }), h("path", { d: "M14.5 8.5h6" })),
      refresh: (p) => h(Svg, p, h("path", { d: "M20 11a8 8 0 1 0-2.34 5.66" }), h("path", { d: "M20 4v7h-7" })),
      plus: (p) => h(Svg, p, h("path", { d: "M12 5v14M5 12h14" })),
      settings: (p) => h(Svg, p, h("circle", { cx: 12, cy: 12, r: 3.2 }), h("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" })),
      close: (p) => h(Svg, p, h("path", { d: "M18 6 6 18M6 6l12 12" })),
      edit: (p) => h(Svg, p, h("path", { d: "M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z" }), h("path", { d: "m13.5 6.5 4 4" })),
      search: (p) => h(Svg, p, h("circle", { cx: 11, cy: 11, r: 7 }), h("path", { d: "m20 20-3.5-3.5" })),
      user: (p) => h(Svg, p, h("circle", { cx: 12, cy: 8, r: 3.6 }), h("path", { d: "M4.5 20a7.5 7.5 0 0 1 15 0" })),
      bot: (p) => h(Svg, p, h("rect", { x: 4, y: 7, width: 16, height: 12, rx: 3 }), h("path", { d: "M12 3v4M8 13h.01M16 13h.01M9 17h6" })),
      tool: (p) => h(Svg, p, h("path", { d: "M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.2-2.2z" })),
      check: (p) => h(Svg, p, h("path", { d: "M20 6 9 17l-5-5" })),
      file: (p) => h(Svg, p, h("path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" }), h("path", { d: "M14 3v6h6" })),
      folder: (p) => h(Svg, p, h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" })),
      send: (p) => h(Svg, p, h("path", { d: "m22 2-7 20-4-9-9-4z" }), h("path", { d: "M22 2 11 13" })),
      alert: (p) => h(Svg, p, h("path", { d: "M12 9v4M12 17h.01" }), h("path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" })),
      lock: (p) => h(Svg, p, h("rect", { x: 4.5, y: 10, width: 15, height: 10, rx: 2 }), h("path", { d: "M8 10V7a4 4 0 0 1 8 0v3" })),
      unlock: (p) => h(Svg, p, h("rect", { x: 4.5, y: 10, width: 15, height: 10, rx: 2 }), h("path", { d: "M8 10V7a4 4 0 0 1 7.5-2" })),
      archive: (p) => h(Svg, p, h("rect", { x: 3, y: 4, width: 18, height: 4, rx: 1 }), h("path", { d: "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" })),
      trash: (p) => h(Svg, p, h("path", { d: "M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" })),
      spark: (p) => h(Svg, p, h("path", { d: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" })),
      chevron: (p) => h(Svg, p, h("path", { d: "m9 18 6-6-6-6" })),
      arrow: (p) => h(Svg, p, h("path", { d: "M5 12h14M13 6l6 6-6 6" })),
    };

    function Icon({ name, size = 16, style, className }) {
      const render = ICONS[name] || ICONS.spark;
      return render({ size, style, className });
    }

    /* ================================ styles ============================== */

    const CSS = `
/* ---------- tokens & page ---------- */
.sk-page{--sk-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));--sk-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.045));
  --sk-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.12));--sk-surface:var(--dsw-alias-bg-layer-1,#fff);
  --sk-surface-2:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#f5f6f7) 52%,var(--dsw-alias-bg-base,#fff));
  --sk-surface-3:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#f5f6f7) 82%,var(--dsw-alias-bg-base,#fff));
  --sk-col-bg:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#f5f6f7) 34%,var(--dsw-alias-bg-base,#fff));
  --sk-ink:var(--dsw-alias-label-primary,#0f1115);--sk-ink-2:var(--dsw-alias-label-secondary,#61666b);
  --sk-ink-3:var(--dsw-alias-label-tertiary,#81858c);--sk-ink-4:var(--dsw-alias-label-caption,#adb2b8);
  --sk-primary:var(--dsw-alias-button-primary-fill,#0f1115);--sk-primary-hover:var(--dsw-alias-button-primary-hover,#43454a);
  --sk-on-primary:var(--dsw-alias-label-primary-foreground,#fff);
  --sk-blue:var(--dsw-alias-state-business-primary,#4176e6);--sk-green:var(--dsw-alias-state-success-primary,#22c55e);
  --sk-amber:var(--dsw-alias-state-warn-primary,#f59e0b);--sk-red:var(--dsw-alias-state-error-primary,#ec1313);
  --sk-accent:var(--dsw-alias-state-business-primary,#4176e6);
  --sk-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));--sk-active:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.10));
  --sk-shadow-lift:0 0 0 .5px color-mix(in srgb,var(--sk-ink) 9%,transparent),0 6px 18px rgba(0,0,0,.07);
  --sk-mask:color-mix(in srgb,var(--dsw-alias-bg-mask-3,#0000007a) 46%,transparent);
  --sk-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));--sk-dur:var(--ds-transition-duration,.2s);
  box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;overflow:hidden;
  color:var(--sk-ink);background:var(--dsw-alias-bg-base,#fff);position:relative;
  padding:calc(var(--dsh-frame-top-clearance,0px) + 22px) 26px 16px;
  font-family:var(--dsh-font-family-text-default,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
  font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
.sk-page *,.sk-page *::before,.sk-page *::after{box-sizing:border-box}
.sk-page button,.sk-page input,.sk-page textarea,.sk-page select{font-family:inherit}
.sk-page ::selection{background:color-mix(in srgb,var(--sk-accent) 24%,transparent)}
.sk-page ::-webkit-scrollbar{width:6px;height:6px}
.sk-page ::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l1,#e5e5e5));border-radius:99px}
.sk-page ::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,var(--dsw-alias-scrollbar-hover-l1,#d4d4d4))}
.sk-page ::-webkit-scrollbar-track{background:transparent}
.sk-page :focus-visible{outline:2px solid color-mix(in srgb,var(--sk-accent) 55%,transparent);outline-offset:2px}
@keyframes skPulse{0%,100%{opacity:1}50%{opacity:.4}}
/* ---------- buttons ---------- */
.sk-btn{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;
  border:1px solid var(--sk-line);background:var(--sk-surface);color:var(--sk-ink);border-radius:9px;padding:0 12px;
  font-size:12px;font-weight:500;font-family:inherit;line-height:1;transition:background var(--sk-dur) var(--sk-ease),border-color var(--sk-dur) var(--sk-ease),color var(--sk-dur) var(--sk-ease),transform .12s;white-space:nowrap}
.sk-btn:hover{background:var(--sk-hover);border-color:var(--sk-line-strong)}
.sk-btn:active{transform:translateY(.5px)}
.sk-btn.primary{background:var(--sk-primary);border-color:transparent;color:var(--sk-on-primary);font-weight:560;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.sk-btn.primary:hover{background:var(--sk-primary-hover);border-color:transparent}
.sk-btn.ghost{background:transparent;border-color:transparent;color:var(--sk-ink-2)}
.sk-btn.ghost:hover{background:var(--sk-hover);border-color:transparent;color:var(--sk-ink)}
.sk-btn.icon{padding:0;width:28px;height:28px;border-radius:8px}
.sk-btn.danger{color:var(--sk-red);border-color:color-mix(in srgb,var(--sk-red) 28%,transparent)}
.sk-btn.danger:hover{background:color-mix(in srgb,var(--sk-red) 9%,transparent)}
.sk-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}

.sk-chip{cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--sk-line);
  background:var(--sk-surface);color:var(--sk-ink-2);border-radius:8px;font-size:11.5px;font-family:inherit;line-height:1;
  transition:background var(--sk-dur) var(--sk-ease),border-color var(--sk-dur),color var(--sk-dur);white-space:nowrap;flex:none}
.sk-chip:hover{background:var(--sk-hover);color:var(--sk-ink);border-color:var(--sk-line-strong)}
.sk-chip.on{background:var(--sk-ink);border-color:var(--sk-ink);color:var(--sk-on-primary);font-weight:520}
.sk-chip .n{opacity:.58;font-variant-numeric:tabular-nums;font-size:10.5px}
.sk-chip.on .n{opacity:.75}
.sk-select{appearance:none;cursor:pointer;height:28px;border:1px solid var(--sk-line);background:var(--sk-surface);
  color:var(--sk-ink-2);border-radius:8px;padding:0 22px 0 9px;font-size:11.5px;font-family:inherit;line-height:1;white-space:nowrap;
  background-image:linear-gradient(45deg,transparent 50%,var(--sk-ink-4) 50%),linear-gradient(135deg,var(--sk-ink-4) 50%,transparent 50%);
  background-position:calc(100% - 11px) 52%,calc(100% - 7px) 52%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.sk-select:hover{background-color:var(--sk-hover);border-color:var(--sk-line-strong);color:var(--sk-ink)}
.sk-count{font-size:11px;color:var(--sk-ink-4);white-space:nowrap;font-variant-numeric:tabular-nums;flex:none}
.sk-count b{color:var(--sk-ink-3);font-weight:600}
.sk-col{min-width:0;display:flex;flex-direction:column;border:1px solid var(--sk-line-soft);border-radius:14px;
  background:var(--sk-col-bg);overflow:hidden;position:relative;transition:border-color .18s,background .18s}
.sk-col::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;pointer-events:none;
  background:linear-gradient(90deg,color-mix(in srgb,var(--tone,var(--sk-ink-3)) 55%,transparent),transparent 62%);opacity:.7}
.sk-col.dragover{border-color:color-mix(in srgb,var(--sk-accent) 50%,var(--sk-line));
  background:color-mix(in srgb,var(--sk-accent) 6%,var(--sk-col-bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sk-accent) 22%,transparent)}
.sk-col-head{display:flex;align-items:center;gap:7px;padding:12px 10px 8px 14px;flex:none}
.sk-col-title{font-size:12px;font-weight:620;letter-spacing:.01em;color:var(--sk-ink)}
.sk-col-count{min-width:20px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:6px;
  background:var(--sk-surface-2);border:1px solid var(--sk-line-soft);color:var(--sk-ink-3);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums}
.sk-col-add{margin-left:auto;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--sk-ink-4);
  width:24px;height:24px;border-radius:7px;display:grid;place-items:center;transition:all .15s}
.sk-col-add:hover{background:var(--sk-surface);border-color:var(--sk-line);color:var(--sk-ink)}
.sk-col-body{flex:1;overflow-y:auto;padding:2px 8px 10px;display:flex;flex-direction:column;gap:8px;min-height:70px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1) transparent}
.sk-col-empty{margin:auto;text-align:center;font-size:11px;color:var(--sk-ink-4);padding:22px 12px;line-height:1.6;
  border:1px dashed color-mix(in srgb,var(--sk-ink-4) 38%,transparent);border-radius:10px;width:100%}
/* ---------- cards ---------- */
.sk-card{position:relative;border:1px solid var(--sk-line);border-radius:12px;background:var(--sk-surface);
  padding:9px 11px 8px;display:flex;flex-direction:column;gap:5px;cursor:grab;outline:none;
  transition:box-shadow .16s var(--sk-ease),transform .16s var(--sk-ease),border-color .16s var(--sk-ease),background .16s}
.sk-card:hover{transform:translateY(-1px);border-color:var(--sk-line-strong);box-shadow:var(--sk-shadow-lift)}
.sk-card:active{cursor:grabbing}
.sk-card.dragging{opacity:.42;transform:scale(.99);box-shadow:none}
.sk-card:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--sk-accent) 45%,transparent)}
.sk-card-ws{font-size:9.5px;color:var(--sk-ink-4);display:inline-flex;align-items:center;gap:3px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ---------- drawer ---------- */
.sk-mask{position:fixed;inset:0;background:var(--sk-mask);z-index:60;animation:skFade .18s var(--sk-ease);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px)}
@keyframes skFade{from{opacity:0}to{opacity:1}}
.sk-drawer{position:fixed;top:0;right:0;bottom:0;width:min(600px,94vw);z-index:61;display:flex;flex-direction:column;
  background:var(--sk-surface);border-left:1px solid var(--sk-line-strong);border-radius:14px 0 0 14px;
  box-shadow:-14px 0 48px rgba(0,0,0,.16);animation:skSlideIn .24s cubic-bezier(.22,.7,.3,1);overflow:hidden}
@keyframes skSlideIn{from{transform:translateX(32px);opacity:.55}to{transform:translateX(0);opacity:1}}
.sk-drawer-head{flex:none;padding:calc(var(--dsh-frame-top-clearance,0px) + 16px) 22px 13px;
  border-bottom:1px solid var(--sk-line-soft);display:flex;flex-direction:column;gap:8px;background:var(--sk-surface)}
.sk-drawer-title{display:flex;align-items:flex-start;gap:10px}
.sk-drawer-title h2{flex:1;margin:0;font-size:17px;font-weight:650;line-height:1.35;letter-spacing:-.01em;word-break:break-word;color:var(--sk-ink)}
.sk-drawer-body{flex:1;overflow-y:auto;padding:0 22px 26px;display:flex;flex-direction:column;scrollbar-width:thin}
.sk-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.sk-field label{font-size:10.5px;color:var(--sk-ink-3);letter-spacing:.01em}
.sk-input,.sk-textarea{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--sk-line);border-radius:8px;
  background:var(--sk-surface);color:var(--sk-ink);padding:0 10px;font:inherit;font-size:12.5px;outline:none;
  transition:border-color .15s,box-shadow .15s}
.sk-input:hover,.sk-textarea:hover{border-color:var(--sk-line-strong)}
.sk-input:focus,.sk-textarea:focus{border-color:color-mix(in srgb,var(--sk-accent) 55%,var(--sk-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--sk-accent) 11%,transparent)}
.sk-textarea{resize:vertical;min-height:64px;padding:8px 10px;line-height:1.55}
.sk-seg{display:flex;gap:5px;flex-wrap:wrap}
.sk-seg button{cursor:pointer;border:1px solid var(--sk-line);background:var(--sk-surface);color:var(--sk-ink-2);
  border-radius:7px;padding:0 10px;height:26px;font-size:11px;font-family:inherit;line-height:1;display:inline-flex;align-items:center;gap:4px;
  transition:background .15s,border-color .15s,color .15s}
.sk-seg button:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-seg button.on{border-color:color-mix(in srgb,var(--tone) 42%,transparent);background:color-mix(in srgb,var(--tone) 10%,transparent);color:var(--tone);font-weight:620}
.sk-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sk-slider{width:100%;accent-color:var(--sk-accent);height:20px}
.sk-ev{display:flex;gap:8px;padding:6px 0;border-top:1px dashed var(--sk-line-soft)}
.sk-ev:first-of-type{border-top:none;padding-top:2px}
.sk-ev-icon{flex:none;width:20px;height:20px;border-radius:6px;display:grid;place-items:center;background:var(--sk-surface-2);color:var(--sk-ink-3);margin-top:1px}
.sk-ev-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.sk-ev-meta{display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--sk-ink-4)}
.sk-ev-meta .kind{color:var(--sk-ink-3);font-weight:560}
.sk-ev-quote{margin:0;font-size:11px;line-height:1.6;color:var(--sk-ink-2);word-break:break-word;white-space:pre-wrap;
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.sk-ev-quote.open{-webkit-line-clamp:unset;display:block}
.sk-ev-more{cursor:pointer;background:none;border:none;color:var(--sk-accent);font-size:10px;font-family:inherit;padding:0;text-align:left}
.sk-ev-more:hover{text-decoration:underline}
.sk-hist{display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--sk-ink-4)}
.sk-hist div{display:flex;gap:6px;align-items:baseline}
.sk-hist .t{font-variant-numeric:tabular-nums;opacity:.85;flex:none}
.sk-drawer-foot{flex:none;border-top:1px solid var(--sk-line-soft);padding:11px 22px;display:flex;align-items:center;gap:8px;
  background:color-mix(in srgb,var(--sk-surface) 94%,var(--sk-surface-2))}
.sk-drawer-foot .grow{flex:1}
/* ---------- modals ---------- */
.sk-modal-mask{position:fixed;inset:0;background:var(--sk-mask);z-index:70;display:grid;place-items:center;padding:24px;
  animation:skFade .18s var(--sk-ease);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}
.sk-modal{width:min(540px,92vw);max-height:84vh;overflow:hidden;border-radius:16px;border:1px solid var(--sk-line-strong);
  background:var(--sk-surface);box-shadow:0 24px 72px rgba(0,0,0,.26);padding:22px;display:flex;flex-direction:column;gap:14px;
  animation:skPop .2s cubic-bezier(.2,.8,.3,1)}
@keyframes skPop{from{transform:scale(.98) translateY(6px);opacity:0}to{transform:none;opacity:1}}
/* I1：标题 + 可滚动 body + 吸底 footer，保证「保存设置」首屏可见（1680/1280/420 都不必先滚动） */
.sk-modal-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;
  scrollbar-width:thin;overscroll-behavior:contain;padding-right:2px}
.sk-modal-foot{display:flex;justify-content:flex-end;gap:8px;flex:none;padding-top:10px;
  border-top:0.5px solid var(--sk-line-soft);background:var(--sk-surface)}
.sk-modal h3{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px;letter-spacing:-.01em}
.sk-modal h3 svg{color:var(--sk-ink-3)}
.sk-modal .sub{margin:0;font-size:11px;color:var(--sk-ink-3);line-height:1.55}
.sk-settings-row{display:flex;align-items:center;gap:12px;border-top:1px solid var(--sk-line-soft);padding-top:12px}
.sk-settings-row:first-of-type{border-top:none;padding-top:0}
.sk-settings-row .label{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.sk-settings-row .label b{font-size:12px;font-weight:560}
.sk-settings-row .label span{font-size:10.5px;color:var(--sk-ink-3);line-height:1.45}
.sk-switch{position:relative;width:36px;height:20px;flex:none;border-radius:999px;border:none;cursor:pointer;
  background:var(--sk-surface-3);transition:background .18s var(--sk-ease)}
.sk-switch.on{background:var(--sk-accent)}
.sk-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb,#fff);transition:transform .18s var(--sk-ease);box-shadow:0 1px 3px rgba(0,0,0,.22)}
.sk-switch.on i{transform:translateX(16px)}
.sk-ws-pick{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow-y:auto;padding:1px}
/* ---------- toast / empty / loading / error ---------- */
.sk-toasts{position:fixed;right:22px;bottom:20px;z-index:90;display:flex;flex-direction:column;gap:7px;align-items:flex-end;pointer-events:none;max-width:min(420px,calc(100vw - 40px))}
.sk-toast{pointer-events:auto;display:flex;align-items:center;gap:7px;border-radius:10px;padding:9px 13px;font-size:11.5px;line-height:1.45;
  background:var(--dsw-alias-toast-bg,#353638);color:var(--dsw-alias-toast-label,#fff);box-shadow:0 10px 30px rgba(0,0,0,.22);
  animation:skToastIn .22s cubic-bezier(.2,.8,.3,1);max-width:100%}
.sk-toast.error{background:color-mix(in srgb,var(--sk-red) 88%,#000)}
.sk-toast.info{background:var(--dsw-alias-toast-bg,#353638)}
@keyframes skToastIn{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}
.sk-banner{flex:none;display:flex;align-items:center;gap:8px;border:1px solid color-mix(in srgb,var(--sk-red) 26%,transparent);
  background:color-mix(in srgb,var(--sk-red) 6%,transparent);color:var(--sk-red);border-radius:10px;padding:8px 12px;font-size:11.5px}
.sk-banner .grow{flex:1}
.sk-inline-actions{display:flex;gap:8px;flex-wrap:wrap}
/* ---------- responsive ---------- */
@media (max-width:1360px){
  .sk-page{padding-left:20px;padding-right:20px}
}
@media (max-width:1180px){
  .sk-page{gap:10px;padding-top:calc(var(--dsh-frame-top-clearance,0px) + 18px);padding-bottom:14px}
  .sk-card{padding:8px 10px 7px}
  .sk-drawer{width:min(560px,96vw)}
}
@media (max-height:900px){
  .sk-page{gap:9px;padding-top:calc(var(--dsh-frame-top-clearance,0px) + 16px);padding-bottom:12px}
  .sk-col-head{padding-top:10px;padding-bottom:6px}
  .sk-drawer-head{padding-top:calc(var(--dsh-frame-top-clearance,0px) + 12px)}
}
/* ---------- side pane / 双形态 ---------- */
.sk-header-btn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--sk-ink-2);cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.sk-header-btn:hover{background:var(--sk-hover);color:var(--sk-ink);border-color:var(--sk-line)}
.sk-page.is-side{position:relative;padding:10px 12px 10px;gap:8px;height:100%}
.sk-page.is-side.sk-tier-medium .sk-col-head{padding:10px 8px 6px 12px}
.sk-page.is-side .sk-drawer{position:absolute;top:0;right:0;bottom:0;width:100%;border-left:none;border-radius:0;box-shadow:none;z-index:61}
.sk-page.is-side .sk-mask{position:absolute;z-index:60}
.sk-page.is-side .sk-modal-mask{position:absolute;z-index:70;padding:10px}
.sk-page.is-side .sk-modal{width:100%;max-height:calc(100% - 4px);border-radius:12px;padding:16px;gap:11px}
.sk-page.is-side .sk-modal-body{gap:11px}
.sk-page.is-side .sk-toasts{position:absolute;left:10px;right:10px;bottom:10px;transform:none;align-items:flex-end;max-width:none;z-index:90}
.sk-page.is-side .sk-toast{font-size:11px;padding:8px 11px}
/* narrow：状态分段 + 单列 */
.sk-page.is-side.sk-tier-narrow{padding:8px 10px 8px;gap:7px}
.sk-page.is-side.sk-tier-narrow .sk-narrow-add{margin-top:1px}
.sk-status-tabs{display:flex;gap:3px;flex:none;padding:3px;border-radius:10px;background:var(--sk-surface-2);border:1px solid var(--sk-line-soft)}
.sk-status-tab{flex:1;min-width:0;height:28px;border:none;border-radius:7px;background:transparent;color:var(--sk-ink-2);font:inherit;font-size:10.5px;
  display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;white-space:nowrap;overflow:hidden;padding:0 4px;transition:background .15s,color .15s}
.sk-status-tab:hover{color:var(--sk-ink)}
.sk-status-tab.is-on{background:var(--sk-surface);color:var(--sk-ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.07)}
.sk-status-tab-count{font-size:9px;font-weight:600;color:var(--sk-ink-4);font-variant-numeric:tabular-nums;background:var(--sk-surface-3);border-radius:4px;padding:0 3px;min-width:14px;text-align:center}
.sk-status-tab.is-on .sk-status-tab-count{color:var(--sk-ink-3);background:var(--sk-surface-2)}
.sk-narrow-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:1px 1px 2px;scrollbar-width:thin}
.sk-narrow-empty{margin:auto;display:flex;flex-direction:column;align-items:center;gap:7px;padding:30px 12px;color:var(--sk-ink-4);font-size:11.5px;text-align:center}
.sk-narrow-add{flex:none;display:flex;align-items:center;justify-content:center;gap:6px;height:32px;border:1px dashed var(--sk-line);border-radius:9px;
  background:transparent;color:var(--sk-ink-3);font:inherit;font-size:11.5px;cursor:pointer;transition:background .15s,color .15s}
.sk-narrow-add:hover{background:var(--sk-hover);color:var(--sk-ink)}
/* 入口三选一 */
.sk-entry-options{display:flex;gap:6px;flex-wrap:wrap}
.sk-entry-option{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--sk-line);border-radius:9px;background:var(--sk-surface);
  color:var(--sk-ink-2);font:inherit;font-size:11.5px;line-height:1.35;text-align:left;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.sk-entry-option:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-entry-option.is-on{border-color:color-mix(in srgb,var(--sk-accent) 45%,transparent);background:color-mix(in srgb,var(--sk-accent) 8%,transparent);color:var(--sk-ink);font-weight:600}
.sk-entry-option small{display:block;font-size:9.5px;font-weight:400;color:var(--sk-ink-3);margin-top:2px;line-height:1.35}
/* 工具栏筛选弹层 */
.sk-filter-wrap{position:relative;display:flex;align-items:center;flex:none}
.sk-filter-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:45;width:288px;padding:12px;border-radius:12px;background:var(--sk-surface);border:1px solid var(--sk-line-strong);box-shadow:var(--sk-shadow-lift);display:flex;flex-direction:column;gap:10px;animation:skPop .16s cubic-bezier(.2,.8,.3,1)}
.sk-filter-row{display:flex;flex-direction:column;gap:5px}
.sk-filter-label{font-size:10px;color:var(--sk-ink-4);letter-spacing:.04em}
.sk-filter-chips{display:flex;flex-wrap:wrap;gap:5px}
.sk-filter-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--sk-line-soft);padding-top:8px}
.sk-facts{display:flex;flex-direction:column;gap:6px}
.sk-fact{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.5;color:var(--sk-ink-2);min-width:0}
.sk-fact-icon{flex:none;width:18px;height:18px;border-radius:5px;display:grid;place-items:center;background:color-mix(in srgb,var(--fact-tone,var(--sk-ink-3)) 12%,transparent);color:var(--fact-tone,var(--sk-ink-3));margin-top:1px}
.sk-fact-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.sk-subtasks{display:flex;flex-direction:column;gap:2px}
.sk-subtask{display:flex;align-items:flex-start;gap:8px;padding:5px 4px;border-radius:6px;width:100%;border:none;background:transparent;font:inherit;font-size:11.5px;line-height:1.45;color:var(--sk-ink-2);text-align:left;cursor:pointer;min-width:0}
.sk-subtask:hover{background:var(--sk-hover)}
.sk-subtask-box{flex:none;width:15px;height:15px;margin-top:1px;border-radius:4.5px;border:1.5px solid var(--sk-line-strong);display:grid;place-items:center;color:transparent;transition:background .15s,border-color .15s,color .15s}
.sk-subtask.done .sk-subtask-box{background:var(--sk-green);border-color:var(--sk-green);color:#fff}
.sk-subtask.done .sk-subtask-text{color:var(--sk-ink-3);text-decoration:line-through}
.sk-subtask-text{flex:1;min-width:0;overflow-wrap:anywhere}
.sk-subtask-del{flex:none;display:grid;place-items:center;width:18px;height:18px;border:none;border-radius:4px;background:transparent;color:var(--sk-ink-4);cursor:pointer;opacity:0}
.sk-subtask:hover .sk-subtask-del{opacity:1}
.sk-subtask-del:hover{color:var(--sk-red);background:var(--sk-hover)}
.sk-subtask-add{display:flex;gap:6px;align-items:center;margin-top:3px}
.sk-subtask-add .sk-input{height:30px;font-size:11.5px}
.sk-live-dot{width:5px;height:5px;border-radius:50%;background:var(--sk-green);flex:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--sk-green) 16%,transparent)}
.sk-live-dot.off{background:var(--sk-ink-4);box-shadow:none}
.sk-artifacts{display:flex;flex-direction:column;gap:4px}
.sk-artifact{display:flex;align-items:center;gap:8px;width:100%;padding:6px 7px;border-radius:7px;border:1px solid var(--sk-line-soft);background:var(--sk-surface);color:var(--sk-ink-2);font:inherit;font-size:11px;text-align:left;cursor:pointer;min-width:0}
.sk-artifact:hover{background:var(--sk-hover);border-color:var(--sk-line)}
.sk-artifact-icon{flex:none;color:var(--sk-green)}
.sk-artifact-text{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.sk-artifact-name{font-weight:550;color:var(--sk-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sk-artifact-path{font-size:9.5px;color:var(--sk-ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sk-fold{border-top:1px solid var(--sk-line-soft);padding-top:12px;display:flex;flex-direction:column;gap:8px}
.sk-fold-head{display:flex;align-items:center;gap:7px;width:100%;border:none;background:transparent;padding:0;font:inherit;font-size:11px;color:var(--sk-ink-2);cursor:pointer;text-align:left}
.sk-fold-head:hover{color:var(--sk-ink)}
.sk-fold-count{margin-left:auto;font-size:10px;color:var(--sk-ink-4)}
.sk-continue-target{display:flex;gap:6px}
.sk-continue-target button{flex:1;padding:8px 10px;border:1px solid var(--sk-line);border-radius:9px;background:var(--sk-surface);color:var(--sk-ink-2);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;line-height:1.35}
.sk-continue-target button.is-on{border-color:color-mix(in srgb,var(--sk-accent) 45%,transparent);background:color-mix(in srgb,var(--sk-accent) 8%,transparent);color:var(--sk-ink);font-weight:600}
.sk-continue-target small{display:block;font-size:9.5px;font-weight:400;color:var(--sk-ink-3);margin-top:2px}
.sk-continue-textarea{width:100%;min-height:190px;border:1px solid var(--sk-line);border-radius:10px;background:var(--sk-surface-2);color:var(--sk-ink);padding:10px;font:inherit;font-size:12px;line-height:1.6;resize:vertical;outline:none}
.sk-continue-textarea:focus{border-color:color-mix(in srgb,var(--sk-accent) 55%,var(--sk-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--sk-accent) 11%,transparent)}
.sk-note-tiny{font-size:10px;color:var(--sk-ink-4);line-height:1.5}
.sk-usage{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border-radius:9px;background:var(--sk-surface-2);border:1px solid var(--sk-line-soft);font-size:10.5px;color:var(--sk-ink-3)}
.sk-usage b{color:var(--sk-ink-2)}
.sk-usage-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.sk-usage-warn{color:var(--sk-amber)}
.sk-page.is-side .sk-continue-textarea{min-height:150px}

@media (prefers-reduced-motion:reduce){
  .sk-page *,.sk-page *::before,.sk-page *::after{animation-duration:.001ms!important;transition-duration:.001ms!important}
}

/* ======================= v3：DSH-native 单色重做 ======================= */
.sk-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 28px) 28px 24px;gap:0;background:var(--dsw-alias-bg-base)}
/* header */
.sk-header-v3{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-width:0;padding-bottom:6px}
.sk-header-main{min-width:0;display:flex;align-items:center;gap:12px}
.sk-title-v3{margin:0;font-size:20px;font-weight:500;line-height:1.25;color:var(--sk-ink);letter-spacing:normal;white-space:nowrap}
.sk-stats-v3{margin:0;font-size:12px;font-weight:400;line-height:1.4;color:var(--sk-ink-2);display:flex;align-items:center;gap:10px;white-space:nowrap;overflow:hidden;min-width:0}
.sk-stats-total{flex:none;font-variant-numeric:tabular-nums}
.sk-header-actions{display:flex;align-items:center;gap:8px;flex:none}
.sk-search-v3{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;border:0.5px solid var(--sk-line);background:transparent;width:200px;transition:border-color .15s,background .15s;flex:none}
.sk-search-v3:focus-within{border-color:var(--sk-line-strong);background:color-mix(in srgb,var(--sk-ink) 3%,transparent)}
.sk-search-v3 svg{color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-search-v3 input{border:none;outline:none;background:transparent;color:var(--sk-ink);font:inherit;font-size:12px;width:100%;min-width:0}
.sk-search-v3 input::placeholder{color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-iconbtn-v3{display:grid;place-items:center;width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);cursor:pointer;flex:none;transition:background .15s,color .15s}
.sk-iconbtn-v3:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink)}
.sk-iconbtn-v3.is-busy{color:var(--sk-ink)}
.sk-header-actions .sk-scan-button:is(.is-busy,.is-failed){display:inline-flex;align-items:center;gap:4px;width:auto;padding:0 5px;font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.sk-header-actions .sk-scan-button.is-failed{color:var(--sk-amber)}
.sk-btn-primary-v3{height:32px;padding:0 14px;border-radius:8px;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;font-weight:500;cursor:pointer;flex:none;white-space:nowrap}
.sk-btn-primary-v3:hover{background:var(--dsw-alias-button-primary-hover)}
.sk-btn-primary-v3:disabled{opacity:.45;cursor:not-allowed}
/* dropdown menu */
.sk-menu{position:fixed;inset:auto;z-index:99;margin:0;min-width:184px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:4px;border-radius:10px;background:var(--sk-surface);color:var(--sk-ink);border:0.5px solid var(--sk-line-strong);box-shadow:var(--dsw-elevation-panel);display:flex;flex-direction:column;animation:skFade .12s var(--sk-ease)}
.sk-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--sk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.sk-menu-item:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent)}
.sk-menu-item.is-danger{color:var(--sk-red)}
.sk-menu-sep{height:0.5px;margin:4px 6px;background:var(--sk-line-soft)}
/* view and filter toolbar */
.sk-slimbar{display:flex;align-items:center;gap:6px;flex:none;min-width:0;padding:0 0 7px;margin:0 0 6px;border-bottom:0.5px solid var(--sk-line-soft)}
.sk-slim-icon{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sk-slim-icon:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent);color:var(--sk-ink)}
.sk-slim-icon.is-on{color:var(--sk-ink);background:color-mix(in srgb,var(--sk-ink) 7%,transparent)}
.sk-slim-icon .sk-filter-count{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent)}
.sk-slimbar .sk-count{font-size:11px;color:var(--sk-ink-3);white-space:nowrap;font-variant-numeric:tabular-nums}
/* filter popover (DSH menu style) */
.sk-filter-popover{width:272px;padding:10px;gap:8px;border-radius:10px}
.sk-filter-row{gap:4px}
.sk-filter-label{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);letter-spacing:0}
.sk-filter-chips{gap:2px}
.sk-filter-chips .sk-chip{height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font-size:12px}
.sk-filter-chips .sk-chip:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink)}
.sk-filter-chips .sk-chip.on{background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink);font-weight:500}
.sk-filter-popover .sk-select{height:28px;border-color:var(--sk-line);font-size:12px}
.sk-filter-foot{border-top:0.5px solid var(--sk-line-soft);padding-top:6px;gap:4px}
.sk-filter-foot .sk-chip{height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font-size:12px}
.sk-filter-foot .sk-chip:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink)}
.sk-filter-foot .sk-chip.on{background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink);font-weight:500}
.sk-clear{font-size:12px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);background:none;border:none;padding:0;cursor:pointer}
.sk-clear:hover{color:var(--sk-ink);text-decoration:underline}
.sk-col{border:none;background:transparent;border-radius:0;min-width:0;display:flex;flex-direction:column;overflow:visible;transition:none}
.sk-col::before{display:none}
.sk-col.dragover{background:transparent}
.sk-col.dragover .sk-col-head{border-bottom-color:var(--sk-ink)}
.sk-col.dragover .sk-col-body{outline:1px solid var(--sk-line-strong);outline-offset:4px;border-radius:8px}
.sk-col-head{display:flex;align-items:center;gap:6px;padding:0 2px 8px;border-bottom:0.5px solid var(--sk-line-soft);margin-bottom:10px;flex:none}
.sk-col-title{font-size:12px;font-weight:600;color:var(--sk-ink);letter-spacing:normal}
.sk-col-count{display:inline;min-width:0;height:auto;padding:0;border:none;background:transparent;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.sk-col-head-spacer{flex:1}
.sk-col-add{width:22px;height:22px;border-radius:6px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);opacity:0;transition:opacity .15s,background .15s,color .15s}
.sk-col:hover .sk-col-add{opacity:1}
.sk-col-add:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink);border:none}
.sk-col-body{flex:1;min-height:0;overflow-y:auto;padding:0 2px 14px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}
.sk-col-empty{margin:26px 2px;padding:0;border:none;text-align:left;font-size:12px;color:color-mix(in srgb,var(--sk-ink) 40%,transparent);line-height:1.5}
/* cards v3 */
.sk-card{border:0.5px solid var(--sk-line);border-radius:12px;background:var(--sk-surface);padding:12px 14px 10px;display:flex;flex-direction:column;gap:6px;cursor:pointer;box-shadow:none;transform:none;transition:border-color .15s,background .15s;animation:none}
.sk-card:hover{border-color:var(--sk-line-strong);box-shadow:none;transform:none}
.sk-card.dragging{opacity:.4;transform:none;box-shadow:none}
.sk-card:focus-visible{box-shadow:none;outline:1px solid var(--sk-line-strong);outline-offset:2px}
.sk-card-v3.is-done{opacity:.62}
.sk-card-v3.is-done .sk-card-title-v3{color:color-mix(in srgb,var(--sk-ink) 70%,transparent)}
.sk-card-v3-head{display:flex;align-items:flex-start;gap:6px;min-width:0}
.sk-card-title-v3{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--sk-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;flex:1;min-width:0}
.sk-card-meta-v3{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;line-height:1.4;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-card-meta-v3 .sk-card-ws{font-size:11px;color:inherit;min-width:0;display:inline-flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sk-card-meta-v3 .sk-card-ws-sep{flex:none;color:color-mix(in srgb,var(--sk-ink) 30%,transparent)}
.sk-card-meta-v3 .sk-card-time{flex:none;white-space:nowrap}
.sk-card-metrics{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);white-space:nowrap}
.sk-card-metrics .sk-prio-text{color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-weight:500}
.sk-card-metrics .sk-prio-text.is-p0{color:var(--sk-red)}
.sk-card-progress-v3{height:2px;border-radius:1px;background:color-mix(in srgb,var(--sk-ink) 10%,transparent);overflow:hidden;margin-top:4px}
.sk-card-progress-v3 i{display:block;height:100%;border-radius:1px;background:color-mix(in srgb,var(--sk-ink) 45%,transparent);transition:width .3s var(--sk-ease)}
.sk-card-v3.is-done .sk-card-progress-v3{display:none}
/* side header (no brand) */
.sk-page.is-side .sk-header-v3{padding-bottom:0}
.sk-page.is-side .sk-stats-v3{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent)}
.sk-page.is-side .sk-header-actions{gap:4px}
.sk-page.is-side .sk-iconbtn-v3{width:28px;height:28px}
/* side status tabs: plain text + underline */
.sk-status-tabs{display:flex;gap:0;flex:none;padding:0;border-radius:0;background:transparent;border:none;border-bottom:0.5px solid var(--sk-line-soft)}
.sk-status-tab{flex:1;min-width:0;height:32px;border:none;border-radius:0;background:transparent;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font:inherit;font-size:12px;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;white-space:nowrap;overflow:hidden;padding:0 4px;border-bottom:1px solid transparent;margin-bottom:-0.5px;transition:color .15s,border-color .15s}
.sk-status-tab:hover{color:var(--sk-ink)}
.sk-status-tab.is-on{color:var(--sk-ink);font-weight:500;border-bottom-color:var(--sk-ink)}
.sk-status-tab-count{font-size:11px;color:inherit;opacity:.6;background:none;padding:0;min-width:0}
.sk-narrow-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:12px 0 8px;scrollbar-width:thin}
.sk-narrow-empty{margin:auto;padding:24px 12px;color:color-mix(in srgb,var(--sk-ink) 40%,transparent);font-size:12px;text-align:center;border:none}
.sk-narrow-add{border:none;border-radius:0;background:transparent;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);height:30px;font-size:12px;display:flex;align-items:center;justify-content:flex-start;gap:6px;padding:0 2px;cursor:pointer}
.sk-narrow-add:hover{color:var(--sk-ink)}
/* drawer v3 */
.sk-mask{position:fixed;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-mask-3,#0000007a) 24%,transparent);backdrop-filter:none;-webkit-backdrop-filter:none;z-index:60;animation:skFade .15s var(--sk-ease)}
.sk-drawer{position:fixed;top:0;right:0;bottom:0;width:min(540px,94vw);z-index:61;display:flex;flex-direction:column;background:var(--sk-surface);border-left:0.5px solid var(--sk-line-strong);border-radius:0;box-shadow:none;animation:skSlideIn .2s cubic-bezier(.22,.7,.3,1);overflow:hidden}
.sk-drawer-v3 .sk-drawer-body{flex:1;overflow-y:auto;padding:0 24px 20px;display:flex;flex-direction:column;scrollbar-width:thin}
.sk-drawer-head{flex:none;display:flex;align-items:flex-start;gap:8px;padding:12px 20px 12px 12px;min-height:48px;border-bottom:0.5px solid var(--sk-line-soft);background:var(--sk-surface)}
.sk-drawer-head .sk-drawer-back{flex:none;width:28px;height:28px;margin-top:1px}
.sk-drawer-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sk-drawer-kicker{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);line-height:1.3}
.sk-drawer-title-v3{margin:0;font-size:15px;font-weight:600;line-height:1.35;color:var(--sk-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sk-drawer-head .sk-iconbtn-v3{width:28px;height:28px}
.sk-drawer-sec{padding:16px 0;border-bottom:0.5px solid var(--sk-line-soft);display:flex;flex-direction:column;gap:8px;min-width:0}
.sk-drawer-sec:last-of-type{border-bottom:none}
.sk-drawer-sec-head{display:flex;align-items:center;gap:8px;min-height:18px}
.sk-drawer-sec-title{font-size:11px;font-weight:400;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);letter-spacing:0}
.sk-drawer-sec-head .sk-grow{flex:1}
.sk-text{background:none;border:none;padding:0;font:inherit;font-size:12px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);cursor:pointer;white-space:nowrap}
.sk-text:hover{color:var(--sk-ink);text-decoration:underline;text-underline-offset:2px}
.sk-summary-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--sk-ink);min-width:0}
.sk-summary-line .sk-sep{color:color-mix(in srgb,var(--sk-ink) 30%,transparent)}
.sk-summary-line .sk-muted{color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:12px}
.sk-edit-fields{display:flex;flex-direction:column;gap:10px;padding-top:4px}
.sk-edit-row{display:flex;align-items:center;gap:8px;min-width:0}
.sk-edit-label{flex:none;width:56px;font-size:12px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-edit-row .sk-input,.sk-edit-row .sk-select{height:32px;font-size:12px;border-color:var(--sk-line);background:var(--sk-surface);border-radius:8px}
.sk-edit-row .sk-textarea{min-height:56px;font-size:12px;border-radius:8px}
.sk-edit-fields .sk-slider{accent-color:var(--dsw-alias-label-primary);height:16px}
.sk-facts{display:flex;flex-direction:column;gap:6px}
.sk-fact{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.55;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);min-width:0}
.sk-fact-text{flex:1;min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sk-subtasks{display:flex;flex-direction:column;gap:0}
.sk-subtask{display:flex;align-items:flex-start;gap:8px;width:100%;min-height:30px;padding:4px 2px;border:none;border-radius:6px;background:transparent;font:inherit;font-size:13px;line-height:1.45;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);text-align:left;cursor:pointer}
.sk-subtask:hover{background:color-mix(in srgb,var(--sk-ink) 4%,transparent)}
.sk-subtask-box{flex:none;width:15px;height:15px;margin-top:2px;border-radius:4px;border:1px solid var(--sk-line-strong);display:grid;place-items:center;color:transparent;background:transparent}
.sk-subtask.done .sk-subtask-box{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.sk-subtask.done .sk-subtask-text{color:color-mix(in srgb,var(--sk-ink) 45%,transparent);text-decoration:line-through}
.sk-subtask-text{flex:1;min-width:0;overflow-wrap:anywhere}
.sk-subtask-del{flex:none;width:20px;height:20px;display:grid;place-items:center;border:none;border-radius:4px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 40%,transparent);cursor:pointer;opacity:0;padding:0}
.sk-subtask:hover .sk-subtask-del{opacity:1}
.sk-subtask-del:hover{color:var(--sk-ink);background:color-mix(in srgb,var(--sk-ink) 6%,transparent)}
.sk-subtask-add{display:flex;gap:6px;align-items:center;margin-top:2px}
.sk-subtask-add .sk-input{height:32px;font-size:12px;border-radius:8px}
.sk-session-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;color:var(--sk-ink)}
.sk-session-line .sk-live-dot{width:6px;height:6px;border-radius:50%;background:var(--sk-green);opacity:.6;flex:none}
.sk-session-line .sk-live-dot.off{background:color-mix(in srgb,var(--sk-ink) 35%,transparent);opacity:1}
.sk-session-line .sk-session-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sk-session-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);margin-top:2px}
.sk-artifacts{display:flex;flex-direction:column;gap:0}
.sk-artifact{display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 0;border:none;background:transparent;color:var(--sk-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer;min-width:0}
.sk-artifact:hover{color:var(--sk-ink)}
.sk-artifact:hover .sk-artifact-name{text-decoration:underline;text-underline-offset:2px}
.sk-artifact-icon{flex:none;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-artifact-text{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}
.sk-artifact-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:50%}
.sk-artifact-path{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sk-fold{border-top:0.5px solid var(--sk-line-soft);padding:14px 0;display:flex;flex-direction:column;gap:8px}
.sk-fold-head{display:flex;align-items:center;gap:6px;width:100%;border:none;background:transparent;padding:0;font:inherit;font-size:12px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);cursor:pointer;text-align:left}
.sk-fold-head:hover{color:var(--sk-ink)}
.sk-fold-count{margin-left:auto;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-drawer-foot{flex:none;display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:0.5px solid var(--sk-line-soft);background:var(--sk-surface)}
.sk-drawer-foot .sk-grow{flex:1}
.sk-btn{font-size:12px;height:32px;border-radius:8px;border:0.5px solid var(--sk-line);background:transparent;color:var(--sk-ink);padding:0 12px;box-shadow:none;transition:background .15s,border-color .15s}
.sk-btn:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent);border-color:var(--sk-line-strong)}
.sk-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.sk-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.sk-btn.ghost{border-color:transparent;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent)}
.sk-btn.ghost:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent);color:var(--sk-ink)}
.sk-btn.icon{width:28px;height:28px;padding:0}
.sk-btn.danger{color:var(--sk-red);border-color:color-mix(in srgb,var(--sk-red) 30%,transparent)}
.sk-btn.danger:hover{background:color-mix(in srgb,var(--sk-red) 8%,transparent)}
.sk-input,.sk-textarea,.sk-select{border-color:var(--sk-line);border-radius:8px;font-size:12px;background:var(--sk-surface)}
.sk-input{height:32px}
.sk-textarea{min-height:60px}
.sk-seg{gap:2px}
.sk-seg button{height:28px;border:none;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:12px;padding:0 8px}
.sk-seg button:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent);color:var(--sk-ink)}
.sk-seg button.on{background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink);font-weight:500}
/* evidence rows in v3 drawer */
.sk-evidence{display:flex;flex-direction:column;gap:0}
.sk-ev{display:flex;gap:8px;padding:8px 0;border-top:0.5px solid var(--sk-line-soft)}
.sk-ev:first-of-type{border-top:none}
.sk-ev-icon{flex:none;width:18px;height:18px;border-radius:4px;display:grid;place-items:center;background:transparent;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);margin-top:1px}
.sk-ev-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.sk-ev-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-ev-meta .kind{color:color-mix(in srgb,var(--sk-ink) 55%,transparent)}
.sk-ev-quote{margin:0;font-size:12px;line-height:1.55;color:color-mix(in srgb,var(--sk-ink) 72%,transparent);word-break:break-word;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sk-ev-quote.open{-webkit-line-clamp:unset;display:block}
.sk-ev-more{background:none;border:none;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:11px;padding:0;cursor:pointer;text-align:left}
.sk-ev-more:hover{color:var(--sk-ink);text-decoration:underline}
.sk-hist{display:flex;flex-direction:column;gap:6px;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-hist div{display:flex;gap:8px;align-items:baseline}
/* modals v3 */
.sk-modal-mask{background:color-mix(in srgb,var(--dsw-alias-bg-mask-3,#0000007a) 26%,transparent);backdrop-filter:none;-webkit-backdrop-filter:none}
.sk-modal{width:min(520px,92vw);border-radius:16px;border:0.5px solid var(--sk-line-strong);box-shadow:var(--dsw-elevation-panel);padding:20px;gap:14px;
  display:flex;flex-direction:column;overflow:hidden}
.sk-modal h3{font-size:15px;font-weight:600}
.sk-modal .sub{font-size:12px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-modal-foot{padding-top:8px;border-top:0.5px solid var(--sk-line-soft);background:var(--sk-surface)}
.sk-settings-row{border-top:0.5px solid var(--sk-line-soft);padding-top:12px}
.sk-settings-row .label b{font-size:13px;font-weight:500}
.sk-settings-row .label span{font-size:12px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-switch{background:color-mix(in srgb,var(--sk-ink) 18%,transparent)}
.sk-switch.on{background:color-mix(in srgb,var(--sk-ink) 78%,transparent)}
.sk-switch i{background:var(--dsw-alias-switch-thumb,#fff)}
.sk-entry-option{border-color:var(--sk-line);border-radius:8px;font-size:12px;padding:8px 10px}
.sk-entry-option.is-on{border-color:var(--sk-line-strong);background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink);font-weight:400}
.sk-entry-option small{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-usage{background:transparent;border:0.5px solid var(--sk-line-soft);border-radius:8px;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-ws-pick .sk-chip{border:none;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font-size:12px;height:28px;padding:0 8px;border-radius:6px}
.sk-ws-pick .sk-chip.on{background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink);font-weight:500}
/* continue modal v3 */
.sk-continue-modal{width:min(520px,92vw)}
.sk-continue-target{gap:0;flex-direction:column;border:0.5px solid var(--sk-line-soft);border-radius:8px;overflow:hidden}
.sk-continue-target button{flex:none;display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:none;border-radius:0;background:transparent;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);font-size:13px;text-align:left;cursor:pointer;line-height:1.4}
.sk-continue-target button+button{border-top:0.5px solid var(--sk-line-soft)}
.sk-continue-target button:hover{background:color-mix(in srgb,var(--sk-ink) 4%,transparent)}
.sk-continue-target button.is-on{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink);font-weight:500}
.sk-continue-target small{display:block;font-size:11px;font-weight:400;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);margin-top:0;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.sk-continue-textarea{min-height:180px;font-family:var(--sk-mono);font-size:12px;line-height:1.65;border:0.5px solid var(--sk-line);border-radius:8px;background:var(--sk-bg);padding:12px}
.sk-note-tiny{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-toast{border-radius:8px;padding:8px 12px;font-size:12px;box-shadow:var(--dsw-elevation-panel)}
.sk-toast.error{background:var(--sk-red)}
/* narrow side: cards only title + progress */
.sk-page.is-side.sk-tier-narrow .sk-card-v3{padding:10px 12px}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3{display:none}
.sk-page.is-side.sk-tier-narrow .sk-narrow-list{gap:8px}
.sk-page.is-side .sk-drawer{position:absolute;top:0;right:0;bottom:0;width:100%;border-left:none;border-radius:0;box-shadow:none;z-index:61}
.sk-page.is-side .sk-drawer-head{padding-left:8px}
.sk-page.is-side .sk-mask{position:absolute;z-index:60}
.sk-page.is-side .sk-modal-mask{position:absolute;z-index:80;padding:10px}
.sk-page.is-side .sk-modal{width:100%;max-height:calc(100% - 4px);border-radius:12px;padding:16px}
.sk-page.is-side .sk-toasts{position:absolute;left:10px;right:10px;bottom:10px;transform:none;align-items:flex-end;max-width:none;z-index:90}
/* board wrapper for v3 padding */
.sk-board-v3{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:minmax(0,1fr);gap:20px;padding-top:14px;position:relative}
.sk-empty-v3{grid-column:1/-1;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;padding:40px 8px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:13px;text-align:left}
.sk-empty-v3 .sk-text{font-size:13px;color:var(--sk-ink);text-decoration:underline;text-underline-offset:2px}
.sk-loading-v3{flex:1;display:flex;flex-direction:column;gap:10px;padding-top:14px}
.sk-loading-v3 .sk-loading-line{height:12px;border-radius:6px;background:color-mix(in srgb,var(--sk-ink) 6%,transparent);animation:skPulse 1.6s ease-in-out infinite}
.sk-loading-v3 .sk-loading-line:nth-child(2){width:70%}
.sk-loading-v3 .sk-loading-line:nth-child(3){width:45%}
.sk-banner{border:0.5px solid color-mix(in srgb,var(--sk-red) 30%,transparent);background:transparent;color:var(--sk-red);font-size:12px;border-radius:8px;padding:8px 10px;margin-bottom:12px}
/* responsive v3 */
@container (max-width:1180px){.sk-page{padding-left:20px;padding-right:20px}}
@media (max-width:1360px){.sk-page{padding-left:20px;padding-right:20px}.sk-page .sk-search-v3{width:170px}}
@media (max-width:1180px){.sk-page .sk-search-v3{width:150px}.sk-board-v3{gap:14px}}
@media (max-height:900px){.sk-page{padding-top:calc(var(--dsh-frame-top-clearance,0px) + 20px)}.sk-board-v3{padding-top:10px}}

/* v3 fixes */
.sk-drawer-head{flex-direction:row;align-items:flex-start}
.sk-page.is-side .sk-drawer-head{padding-left:12px}
.sk-drawer-head-text{gap:1px}
.sk-card-v3.is-done{opacity:.6}
.sk-card-v3.is-done .sk-card-metrics{display:none}
.sk-card-v3.is-done .sk-card-meta-v3{color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-ws-picker{position:relative;display:inline-flex;align-items:center;min-width:0;max-width:190px}
.sk-ws-picker .sk-ws-select{appearance:none;background-image:none;padding:0 22px 0 7px;border-color:transparent;background-color:transparent;color:var(--sk-ink-2);font-size:12px;height:30px;border-radius:6px;cursor:pointer;max-width:100%;min-width:0;text-overflow:ellipsis}
.sk-ws-picker:hover .sk-ws-select{background-color:color-mix(in srgb,var(--sk-ink) 5%,transparent);color:var(--sk-ink)}
.sk-ws-picker:hover .sk-ws-caret{color:var(--sk-ink)}
.sk-ws-picker .sk-ws-select:hover{background-color:color-mix(in srgb,var(--sk-ink) 5%,transparent);border-color:transparent;color:var(--sk-ink)}
.sk-ws-caret{position:absolute;right:5px;pointer-events:none;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
body[data-ds-dark-theme] .sk-btn.primary,
body[data-ds-dark-theme] .sk-btn-primary-v3{background:var(--dsw-alias-button-primary-fill)!important;color:var(--dsw-alias-label-primary-foreground)!important}
body[data-ds-dark-theme] .sk-btn.primary:hover,
body[data-ds-dark-theme] .sk-btn-primary-v3:hover{background:var(--dsw-alias-button-primary-hover)!important;color:var(--dsw-alias-label-primary-foreground)!important}
.sk-btn-primary-v3:active,.sk-btn.primary:active{opacity:.82}
.sk-btn-primary-v3:focus-visible,.sk-btn.primary:focus-visible{outline:2px solid color-mix(in srgb,var(--sk-ink) 45%,transparent);outline-offset:2px}
.sk-page.is-side.sk-tier-narrow .sk-status-tabs{margin-top:0}
.sk-page.is-side.sk-tier-narrow .sk-narrow-list{padding-top:10px}

/* ======================= v0.4：克制的强调色 ======================= */
.sk-page{--sk-brand-accent:var(--dsw-alias-state-business-primary,#4176e6)}
.sk-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block}
.sk-dot.is-total{background:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-dot.is-backlog{background:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-dot.is-in_progress{background:var(--sk-brand-accent)}
.sk-dot.is-blocked{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sk-dot.is-done{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 55%,transparent)}
.sk-stats-group{display:inline-flex;align-items:center;gap:5px}
.sk-stats-v3 .sk-status-dot{background:color-mix(in srgb,var(--sk-ink) 40%,transparent);box-shadow:none;width:6px;height:6px;opacity:1}
.sk-stats-v3 .sk-status-dot.is-running{background:var(--sk-brand-accent);animation:skPulse 1.6s ease-in-out infinite}
.sk-stats-v3 .sk-status-dot.is-error{background:var(--sk-red)}
.sk-header-actions .sk-iconbtn-v3{width:28px;height:28px;border-radius:8px;color:color-mix(in srgb,var(--sk-ink) 62%,transparent)}
.sk-header-actions .sk-iconbtn-v3:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink)}
.sk-header-actions .sk-iconbtn-v3.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:1px solid transparent}
.sk-header-actions .sk-iconbtn-v3.is-primary:hover{background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
.sk-card-v3{padding:11px 14px 10px}
.sk-card-v3.is-done{opacity:.7}
.sk-card-v3.is-done .sk-card-title-v3{font-weight:500}
.sk-card-v3-head{display:flex;align-items:flex-start;gap:7px;min-width:0}
.sk-card-v3-head .sk-dot{margin-top:6px}
.sk-card-v3-head .sk-card-title-v3{flex:1;min-width:0}
.sk-ai-mark{font-size:11px;line-height:1;font-weight:500;letter-spacing:.02em;flex:none;white-space:nowrap;margin-top:4px}
.sk-ai-mark.is-ai{color:color-mix(in srgb,var(--sk-brand-accent) 65%,transparent)}
.sk-ai-mark.is-rules{color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-card-meta-v3 .sk-card-metrics{gap:7px}
.sk-card-metric{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);font-size:11px}
.sk-card-metric.is-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sk-card-metric.is-error{color:var(--sk-red)}
.sk-card-metric.is-done{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 75%,transparent)}
.sk-card-metrics .sk-prio-text{font-size:11px;font-weight:500}
.sk-prio-text.is-p0{color:var(--sk-red)}
.sk-prio-text.is-p1{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sk-prio-text.is-rest{color:color-mix(in srgb,var(--sk-ink) 45%,transparent);font-weight:400}
.sk-card-progress-v3{height:3px;border-radius:1.5px;background:color-mix(in srgb,var(--sk-ink) 10%,transparent)}
.sk-card-progress-v3 i{background:color-mix(in srgb,var(--sk-ink) 20%,transparent);border-radius:1.5px}
.sk-card-v3.is-in_progress .sk-card-progress-v3 i{background:color-mix(in srgb,var(--sk-brand-accent) 75%,transparent)}
.sk-card-v3.is-blocked .sk-card-progress-v3 i{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 75%,transparent)}
.sk-card-v3.is-done .sk-card-progress-v3{display:block}
.sk-card-v3.is-done .sk-card-progress-v3 i{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 55%,transparent)}
.sk-col-head .sk-dot{margin-right:2px}
.sk-summary-status{font-weight:600}
.sk-summary-status.is-in_progress{color:var(--sk-brand-accent)}
.sk-summary-status.is-blocked{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sk-summary-status.is-done{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 72%,transparent)}
.sk-summary-prio{font-weight:500}
.sk-summary-prio.is-p0{color:var(--sk-red)}
.sk-summary-prio.is-p1{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sk-summary-prio.is-rest{color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-weight:400}
.sk-fact{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.5;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);min-width:0}
.sk-fact-icon{width:14px;height:14px;flex:none;display:grid;place-items:center;margin-top:2px;color:var(--fact-tone,color-mix(in srgb,var(--sk-ink) 45%,transparent))}
.sk-fact-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.sk-link-text{color:var(--sk-brand-accent)!important;text-decoration:none}
.sk-link-text:hover{color:var(--sk-brand-accent);text-decoration:underline;text-underline-offset:2px}
.sk-session-line .sk-session-icon{flex:none;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);margin-top:1px}
.sk-page.is-side.sk-tier-narrow .sk-card-v3-head .sk-dot{margin-top:5px}
.sk-page.is-side.sk-tier-narrow .sk-ai-mark{display:none}

/* ======================= 可用性 / 无障碍补充 ======================= */
/* 仅供读屏的隐藏文本（扫描状态、错误播报等） */
.sk-sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* 表单分组标题（替代无关联的 label 元素） */
.sk-field .sk-field-label{font-size:10.5px;color:var(--sk-ink-3);letter-spacing:.01em}
/* 首屏 / 断连的说明样式 */
.sk-error-title{display:flex;align-items:center;gap:6px;margin:0;font-size:13px;font-weight:600;color:var(--sk-ink)}
.sk-error-detail{margin:0;font-size:12px;line-height:1.5;color:var(--sk-ink-3);max-width:440px;overflow-wrap:anywhere;word-break:break-word}
/* 键盘焦点：卡片用强调色描边，保证在浅色 / 深色下都清晰可见 */
.sk-card:focus-visible{outline:2px solid color-mix(in srgb,var(--sk-brand-accent) 65%,transparent);outline-offset:2px;box-shadow:none}
/* 卡片元信息：空间不足时让指标整体换到第二行，工作区名不再被压成「dsh-…」 */
.sk-card-meta-v3{flex-wrap:wrap;row-gap:3px}
.sk-card-meta-v3 .sk-card-ws{flex:0 1 auto;max-width:100%}
.sk-col-body{container-type:inline-size}
@container (max-width:300px){
  .sk-card-v3{padding:9px 11px 7px;gap:4px}
  .sk-card-v3 .sk-card-meta-v3{row-gap:2px}
  .sk-card-v3 .sk-card-progress-v3{margin-top:1px}
}
/* 子任务行：外层行 + 独立勾选按钮 + 独立删除按钮（原先删除按钮嵌在按钮内，键盘不可达） */
.sk-subtask{display:flex;align-items:flex-start;gap:2px;width:100%;min-height:30px;padding:0;border-radius:6px;background:transparent;font-size:13px;line-height:1.45;color:color-mix(in srgb,var(--sk-ink) 78%,transparent)}
.sk-subtask:hover{background:color-mix(in srgb,var(--sk-ink) 4%,transparent)}
.sk-subtask-toggle{display:flex;align-items:flex-start;gap:8px;flex:1;min-width:0;min-height:30px;padding:4px 2px;border:none;border-radius:6px;background:transparent;font:inherit;font-size:inherit;line-height:inherit;color:inherit;text-align:left;cursor:pointer}
.sk-subtask-toggle:focus-visible{outline:2px solid color-mix(in srgb,var(--sk-brand-accent) 65%,transparent);outline-offset:0}
.sk-subtask-del{margin-top:4px;margin-right:2px}
.sk-subtask:hover .sk-subtask-del,.sk-subtask:focus-within .sk-subtask-del{opacity:1}
/* 列头「+」在键盘聚焦 / 无 hover 设备上也要可见 */
.sk-col-add:focus-visible{opacity:1}
@media (hover:none){.sk-col-add{opacity:1}}

/* ======================= wave 2：编辑安全 / AI 可读性 / 侧栏补全 ======================= */
/* 归档任务标记（仅「含归档」筛选下出现） */
.sk-archived-mark{font-size:10px;line-height:1;color:var(--sk-ink-3);background:var(--sk-surface-2);border-radius:4px;padding:3px 5px;flex:none;margin-top:4px;white-space:nowrap}
/* 后台覆盖提醒 / 重新研判错误提示：安静的琥珀文字，不做大色块 */
.sk-inline-note{font-size:11px;line-height:1.5;color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 80%,var(--sk-ink));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 6%,transparent);border-radius:6px;padding:6px 8px}
/* AI 研判：普通段落，不用彩色盒子 */
.sk-ai-review{display:flex;flex-direction:column;gap:4px;margin-top:8px;min-width:0}
.sk-ai-review-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);min-width:0}
.sk-ai-review-head svg{flex:none;color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-ai-review-title{font-weight:500;color:color-mix(in srgb,var(--sk-ink) 62%,transparent)}
.sk-ai-review-meta{font-variant-numeric:tabular-nums;white-space:nowrap}
.sk-ai-review-stale{color:var(--dsw-alias-state-warn-primary,#f59e0b);white-space:nowrap}
.sk-ai-review-reason{margin:0;font-size:12px;line-height:1.55;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.sk-ai-review-reason.is-open{-webkit-line-clamp:unset;display:block}
.sk-ai-review-reason.is-empty{color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
/* 完成卡：去掉整条彩色进度线，只保留状态点 */
.sk-card-v3.is-done .sk-card-progress-v3{display:none}
/* 窄侧栏：卡片保留「短工作区 · 时间 · 优先级」的紧凑巡检信息 */
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3{display:flex;flex-wrap:nowrap;gap:5px;font-size:10.5px;line-height:1.35;margin-top:1px}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-ws{max-width:96px;flex:0 1 auto}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-ws-sep{flex:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-time{flex:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-metrics{margin-left:auto;gap:4px}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-metric{display:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-prio-text{font-size:10.5px}
.sk-page.is-side.sk-tier-narrow .sk-archived-mark{display:none}

/* ======================= v0.5：AI 模型 / 预算 / 用量 ======================= */
/* 模型选择：全宽 block + 原生 select，420px 侧栏纵向堆叠；只用 token 与 color-mix，无彩色盒子 */
.sk-settings-block{display:flex;flex-direction:column;gap:8px;border-top:0.5px solid var(--sk-line-soft);padding-top:12px;min-width:0}
.sk-settings-block-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.sk-settings-block .label{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.sk-settings-block .label b{font-size:13px;font-weight:500}
.sk-settings-block .label span{font-size:12px;line-height:1.45;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-settings-controls{display:flex;align-items:center;gap:6px;min-width:0}
.sk-settings-controls .sk-select{flex:1;min-width:0;height:30px;font-size:12px;text-overflow:ellipsis}
.sk-model-refresh{width:28px;height:28px;border-radius:7px}
.sk-model-refresh:disabled{opacity:.4;cursor:not-allowed}
.sk-model-refresh.is-busy{opacity:.55;cursor:progress}
.sk-catalog-note{margin:0;font-size:11px;line-height:1.5;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);overflow-wrap:anywhere}
.sk-catalog-note.is-warn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 80%,var(--sk-ink))}
.sk-catalog-note .sk-text{font-size:11px;margin-left:2px}
.sk-catalog-note .sk-catalog-sep{color:color-mix(in srgb,var(--sk-ink) 30%,transparent)}
/* 用量行：安静文字 + 琥珀警告，不做色块 / 进度条 */
.sk-usage-rest{font-variant-numeric:tabular-nums;white-space:nowrap}
.sk-usage-note{margin:0;font-size:11px;line-height:1.5;color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
/* 运行中 AI 调用进度：统计行内小字，tabular-nums 避免数字跳动 */
/* 抽屉 AI 研判块：provider / model 过长时省略，避免挤掉置信度与时间 */
.sk-ai-review-model{max-width:min(280px,48vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

`;

    const WORKFLOW_CSS = `
.sk-view-switch,.sk-view-picker{margin-inline-end:auto;flex:none}
.sk-view-switch{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--sk-line);border-radius:8px;background:var(--sk-surface)}
.sk-view-switch button{border:0;background:none;color:var(--sk-ink-2);font:inherit;font-size:12px;min-height:28px;padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap}
.sk-view-switch button[aria-pressed=true]{background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink);font-weight:500}
.sk-view-count{margin-inline-start:4px;font-variant-numeric:tabular-nums}
.sk-view-switch button:hover,.sk-task-row-main:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent)}
.sk-view-picker .sk-ws-select{background:var(--sk-surface-2);color:var(--sk-ink)}
.sk-session-scope[aria-pressed=true]{background:var(--sk-surface-2);color:var(--sk-ink)}
.sk-filter-popover{width:min(272px,calc(100vw - 24px))}
.sk-filter-popover .sk-search-v3{width:100%}
.sk-board-v3.is-done-collapsed{grid-template-columns:repeat(3,minmax(0,1fr)) max-content}
.sk-col{min-height:0}
.sk-col.is-collapsed{border-inline-start:1px solid var(--sk-line-soft);padding-inline-start:7px}
.sk-col-toggle{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:0 4px;border:0;border-radius:5px;background:none;color:var(--sk-ink-2);font:inherit;cursor:pointer;white-space:nowrap}
.sk-col-toggle:hover,.sk-column-pager button:hover:not(:disabled){background:var(--sk-hover);color:var(--sk-ink)}
.sk-col-toggle[aria-expanded=true]>svg{transform:rotate(180deg)}
.sk-col-body,.sk-narrow-list{overscroll-behavior-y:contain}
.sk-col-body>.sk-card,.sk-narrow-list>.sk-card{flex:none}
.sk-column-pager{display:flex;flex:none;align-items:center;justify-content:center;gap:8px;min-height:28px;border-top:1px solid var(--sk-line-soft);color:var(--sk-ink-2);font-size:11px;font-variant-numeric:tabular-nums}
.sk-column-pager button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:none;color:inherit;cursor:pointer}
.sk-column-pager button:last-child>svg{transform:rotate(180deg)}
.sk-column-pager button:disabled{opacity:.35;cursor:default}
.sk-drawer-v3 .sk-drawer-body{min-height:0}
.sk-compact-header .sk-header-main{gap:8px}
.sk-tier-narrow .sk-title-v3{font-size:17px}
.sk-tier-narrow .sk-header-actions{gap:3px}
.sk-tier-narrow .sk-slimbar{gap:4px}
.sk-tier-narrow .sk-ws-picker:not(.sk-view-picker){max-width:132px}
.sk-tier-narrow .sk-slim-icon{padding-inline:5px}
.sk-board-notice{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;border:1px solid var(--sk-line);border-radius:8px;margin-bottom:10px;font-size:13px}
.sk-board-notice button:first-of-type{margin-inline-start:auto}
.sk-collection{min-height:0;flex:1;overflow:auto;padding:0 2px 16px}
.sk-task-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.sk-task-row{display:flex;align-items:center;gap:8px;padding:5px 8px 5px calc(8px + var(--sk-depth,0) * 13px);border:1px solid var(--sk-line);border-radius:8px;background:var(--sk-surface)}
.sk-task-row-main{flex:1;min-width:0;display:grid;gap:4px;padding:6px;text-align:start;background:none;border:0;border-radius:6px;color:var(--sk-ink);font:inherit}
button.sk-task-row-main{cursor:pointer}
.sk-task-row-title{display:flex;gap:7px;align-items:center;font-size:13px;font-weight:500;overflow-wrap:anywhere}
.sk-task-row-summary,.sk-task-row-meta{font-size:12px;color:var(--sk-ink-3);overflow-wrap:anywhere}
.sk-task-row-summary{color:var(--sk-ink-2)}
.sk-task-overview{display:grid;gap:10px}
.sk-overview-item{display:grid;gap:3px;min-width:0}
.sk-overview-item h3{margin:0;font-size:12px;font-weight:500;color:var(--sk-ink-2)}
.sk-overview-item p{margin:0;font-size:13px;line-height:1.5;color:var(--sk-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.sk-overview-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sk-overview-actions .sk-btn[aria-disabled=true]{color:var(--sk-ink-2);cursor:default}
.sk-overview-steps{margin:6px 0 0;padding-inline-start:18px;color:var(--sk-ink-2);font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.sk-ai-review summary{cursor:pointer}
.sk-ai-review[open] .sk-ai-review-chevron{transform:rotate(90deg)}
.sk-task-overview .sk-session-actions{margin:0}
.sk-artifact-entry{display:flex;align-items:center;gap:5px;flex:1;min-width:0}
.sk-artifact-entry .sk-artifact{width:auto;flex:1;padding:4px 6px;min-height:34px;border-radius:6px}
.sk-artifact-entry .sk-artifact-text{gap:1px}
.sk-artifact-entry .sk-artifact-name,.sk-artifact-entry .sk-artifact-path{max-width:100%}
.sk-artifact-entry .sk-artifact-path:empty{display:none}
.sk-artifact-entry .sk-artifact:disabled{cursor:default}
.sk-artifact-entry .sk-artifact:disabled .sk-artifact-name{text-decoration:none;color:var(--sk-ink-2)}
.sk-artifact-row .sk-btn{flex:none}
.sk-card-open{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:100%;border:0;background:none;color:inherit;font:inherit;padding:0;text-align:start;cursor:pointer;overflow-wrap:anywhere}
.sk-card-open:focus-visible{outline-offset:-2px;border-radius:3px}
.sk-page .sk-quick-trigger{width:26px;height:26px}
.sk-card .sk-quick-trigger{margin:-3px -5px -3px 0;color:var(--sk-ink-3)}
.sk-quick-trigger[aria-expanded=true]{background:var(--sk-hover);color:var(--sk-ink)}
.sk-quick-menu .sk-menu-item{flex:none}
.sk-quick-menu .sk-menu-item:focus-visible{outline-offset:-2px;background:var(--sk-hover)}
.sk-quick-menu .sk-menu-item:disabled{opacity:.45;cursor:default;background:transparent}
.sk-evidence .sk-select{max-width:100%}
.sk-ev-meta{flex-wrap:wrap}
.sk-drawer-foot{flex-wrap:wrap}
.sk-continue-modal{max-width:100%}
.sk-continue-modal .sk-modal-foot{flex-wrap:wrap}
.sk-task-row.has-session-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px}
.sk-task-row.has-session-actions .sk-session-actions{grid-column:1/-1}
.sk-session-actions{display:grid;gap:4px;list-style:none;margin:0 6px;padding:4px 0 0;border-top:1px solid var(--sk-line)}
.sk-session-actions li{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;min-width:0;font-size:12px}
.sk-session-actions li>span{flex:1 1 180px;color:var(--sk-ink-2);overflow-wrap:anywhere}
.sk-session-actions li>.sk-btn{flex:none}
.sk-batchbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}
.sk-workspace-group{margin-bottom:10px}
.sk-workspace-group summary{cursor:pointer;font-weight:600;font-size:13px;padding:8px 2px}
.sk-workspace-group summary span{font-size:12px;color:var(--sk-ink-3);margin-inline-start:8px}
.sk-maintenance{display:grid;align-content:start;gap:10px}
.sk-management-card{border:1px solid var(--sk-line);border-radius:10px;padding:12px;background:var(--sk-surface);min-width:0}
.sk-management-card h3{font-size:14px;margin:0 0 8px}
.sk-management-card p{color:var(--sk-ink-3);font-size:12px;margin:6px 0 10px}
.sk-management-row{display:flex;gap:8px;align-items:center;border-top:1px solid var(--sk-line);padding:6px 0;min-width:0;font-size:12px}
.sk-management-row>span:first-child{flex:1;overflow-wrap:anywhere}
.sk-relation-editor{display:grid;gap:8px;margin-top:5px}
.sk-relation-editor .sk-select,.sk-relation-editor .sk-input{max-width:100%;min-width:0}
.sk-relation-editor .sk-management-row{flex-wrap:wrap}
.sk-relation-editor .sk-management-row>span:first-child{flex:1 1 120px}
.sk-relation-editor summary{cursor:pointer;color:var(--sk-ink);font-size:13px}
.sk-card-summary{font-size:12px;line-height:1.35;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--sk-ink-2)}
.sk-card-v3.is-done{opacity:1}
.sk-card-v3.is-done .sk-card-title-v3{color:var(--sk-ink)}
.sk-card-meta-v3,.sk-card-metrics{color:var(--sk-ink-3)}
.sk-drawer-sec-title{font-weight:600;color:var(--sk-ink-3);font-size:12px}
.sk-col-add:focus-visible{opacity:1}
.sk-tier-narrow .sk-task-row{gap:5px}
.sk-tier-narrow .sk-task-row .sk-btn{white-space:normal}
`;

    function ensureStyle() {
      const tagId = "dsh-super-kanban/style.css";
      let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);
      if (!tag) {
        tag = document.createElement("style");
        tag.dataset.plugin = "dsh-super-kanban";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS + WORKFLOW_CSS;
        document.head.appendChild(tag);
      }
      return tag;
    }

    /* =============================== hooks ================================ */

    /* -------------------- 对话框基础：焦点 / Esc / 滚动锁定 -------------------- */

    // 所有打开中的对话框按挂载顺序入栈；只有栈顶对话框响应 Esc 和焦点逃逸，
    // 保证「抽屉 → 继续此任务」这类嵌套浮层的层级正确。
    const dialogStack = [];

    function hasOpenDialog() {
      return dialogStack.length > 0;
    }

    const FOCUSABLE_SELECTOR = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function focusableIn(node) {
      if (!node) return [];
      return [...node.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
        (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
    }

    /** 对话框：初始焦点 + Tab 焦点陷阱 + 关闭后焦点归还；Esc 交给最上层对话框。 */
    function useDialogFocus(rootRef, onEscape) {
      const escapeRef = React.useRef(onEscape);
      React.useEffect(() => {
        escapeRef.current = onEscape;
      });
      React.useEffect(() => {
        const token = Symbol("dialog");
        const node = rootRef.current;
        const previous = document.activeElement;
        dialogStack.push(token);
        const initial = focusableIn(node)[0];
        if (initial) {
          initial.focus({ preventScroll: true });
        } else if (node) {
          node.setAttribute("tabindex", "-1");
          node.focus({ preventScroll: true });
        }
        const onKeyDown = (event) => {
          if (dialogStack[dialogStack.length - 1] !== token) return;
          if (event.target?.closest?.(".sk-quick-menu")) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (escapeRef.current) escapeRef.current();
            return;
          }
          if (event.key !== "Tab") return;
          const items = focusableIn(node);
          if (!items.length) {
            event.preventDefault();
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === first || !node.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        };
        // 焦点若被脚本/鼠标拖出对话框，拉回第一个可聚焦元素。
        const onFocusIn = (event) => {
          if (dialogStack[dialogStack.length - 1] !== token) return;
          if (node && !node.contains(event.target)) {
            const items = focusableIn(node);
            if (items[0]) items[0].focus({ preventScroll: true });
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("focusin", onFocusIn, true);
        return () => {
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("focusin", onFocusIn, true);
          const index = dialogStack.indexOf(token);
          if (index >= 0) dialogStack.splice(index, 1);
          if (previous && previous.isConnected && typeof previous.focus === "function") {
            previous.focus({ preventScroll: true });
          }
        };
      }, [rootRef]);
    }

    // 抽屉 / 弹窗打开时锁住页面滚动（引用计数，嵌套浮层不会提前解锁）。
    let scrollLockCount = 0;
    let scrollLockPrevious = null;

    function useBodyScrollLock() {
      React.useEffect(() => {
        if (!document.body) return undefined;
        if (scrollLockCount === 0) {
          scrollLockPrevious = document.body.style.overflow;
          document.body.style.overflow = "hidden";
        }
        scrollLockCount += 1;
        return () => {
          scrollLockCount = Math.max(0, scrollLockCount - 1);
          if (scrollLockCount === 0 && document.body) {
            document.body.style.overflow = scrollLockPrevious || "";
          }
        };
      }, []);
    }

    function useToasts() {
      const [toasts, setToasts] = React.useState([]);
      const timers = React.useRef(new Set());
      React.useEffect(
        () => () => {
          for (const timer of timers.current) clearTimeout(timer);
          timers.current.clear();
        },
        [],
      );
      const push = React.useCallback((text, tone) => {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        setToasts((list) => [...list.slice(-3), { id, text, tone: tone || "info" }]);
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          setToasts((list) => list.filter((item) => item.id !== id));
        }, tone === "error" ? 5200 : 3200);
        timers.current.add(timer);
      }, []);
      return [toasts, push];
    }

    /**
     * /state 内容指纹：同一份数据返回同一签名；变化时 useBoardData 才替换 data 触发重渲染。
     * v0.5.1 轻量化（审计 S5）：不再 stringify 完整 payload —— tasks[].evidence / keyFacts / sessions
     * 等大字段每轮可达数十 KB，4s（扫描中 1.2s）轮询会持续占用主线程。签名覆盖所有会驱动 UI 的字段：
     *  - tasks：顺序 + id / updatedAt / status / archived。按 Host 契约，任何任务字段更新（title、goal、
     *    priority、progress、ai、subtasks…）都会同时刷新 updatedAt，新增/删除任务会改变列表；
     *  - scan：整体 stringify（全部为标量，很小；state/message/aiCalls/aiBudget/aiPending/error… 都用于页头与播报）；
     *  - settings / usage / stats / activity / workspaces：对象较小，整体 stringify（含嵌套字段）。
     * 不覆盖：tasks 的大数组「内容」（evidence 等）——按契约不会脱离 updatedAt 单独变化；
     * generatedAt 每轮都变，和旧实现一样不参与比较。
     */
    function stateSignature(payload) {
      if (!payload || typeof payload !== "object") return "";
      try {
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        return JSON.stringify({
          tasks: tasks.map((task) => (task ? [task.id, task.updatedAt, task.status, task.archived === true] : null)),
          scan: payload.scan || null,
          storage: payload.storage || null,
          maintenance: payload.maintenance || null,
          writeOverlaps: payload.writeOverlaps || null,
          settings: payload.settings || null,
          usage: payload.usage || null,
          stats: payload.stats || null,
          activity: payload.activity || null,
          workspaces: payload.workspaces || null,
        });
      } catch {
        return "";
      }
    }

    let sharedStateRequest = null;
    function requestBoardState() {
      if (!sharedStateRequest) {
        sharedStateRequest = apiRequest("/state").finally(() => { sharedStateRequest = null; });
      }
      return sharedStateRequest;
    }

    function useBoardData() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const inflight = React.useRef(null);
      const mounted = React.useRef(true);
      const signature = React.useRef("");

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const load = React.useCallback(async (silent) => {
        if (inflight.current) return inflight.current;
        if (!silent) setLoading(true);
        const task = requestBoardState()
          .then((payload) => {
            if (!mounted.current) return null;
            const next = stateSignature(payload);
            if (next !== signature.current) {
              signature.current = next;
              setData(payload);
            }
            setError(null);
            setLoading(false);
            return payload;
          })
          .catch((cause) => {
            if (!mounted.current) return null;
            setError(String(cause?.message || cause));
            setLoading(false);
            return null;
          })
          .finally(() => {
            inflight.current = null;
          });
        inflight.current = task;
        return task;
      }, []);

      React.useEffect(() => {
        load(false);
      }, [load]);

      // 轮询：空闲 4s，扫描中 1.2s；页面隐藏时停止请求并把节奏放慢，重新可见时立即补一次。
      React.useEffect(() => {
        let timer = null;
        let cancelled = false;
        const running = Boolean(data && data.scan && data.scan.state === "running");
        const nextDelay = () => {
          if (typeof document !== "undefined" && document.hidden) return 30_000;
          return running ? POLL_SCAN_MS : POLL_MS;
        };
        const tick = () => {
          if (cancelled) return;
          const hidden = typeof document !== "undefined" && document.hidden;
          if (!hidden) load(true);
          timer = setTimeout(tick, nextDelay());
        };
        const onVisibility = () => {
          if (cancelled) return;
          clearTimeout(timer);
          if (!document.hidden) load(true);
          timer = setTimeout(tick, nextDelay());
        };
        timer = setTimeout(tick, nextDelay());
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
          cancelled = true;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [data && data.scan && data.scan.state, load]);

      React.useEffect(() => {
        if (typeof EventSource !== "function") return undefined;
        const stream = new EventSource(new URL(`${API}/events`, document.baseURI));
        let timer;
        const invalidate = () => {
          if (document.hidden || timer) return;
          timer = setTimeout(() => { timer = null; load(true); }, 180);
        };
        stream.addEventListener("changed", invalidate);
        stream.addEventListener("scan", invalidate);
        return () => {
          clearTimeout(timer);
          stream.close();
        };
      }, [load]);

      return { data, error, loading, reload: load, setData };
    }

    /* ================================ cards =============================== */

    function TaskCard({ task, signal, onOpen, taskActions, onDragStart, onDragEnd, dragging }) {
      const progress = progressOf(task);
      const subtasks = subtasksOf(task);
      const issueList = Array.isArray(task.issues) ? task.issues : [];
      const issues = issueList.length;
      const artifacts = artifactsOf(task);
      const priority = task.priority || "P2";
      const taskStatus = statusOf(task);
      const done = taskStatus === "done";
      const highIssue = issueList.some((issue) => issue && issue.severity === "high");
      const subtaskDone = subtasks.filter((item) => item.done).length;
      const allSubtasksDone = subtasks.length > 0 && subtaskDone === subtasks.length;
      const engine = task.ai && task.ai.engine === "llm" ? "AI" : "规则";
      const showEngine = Boolean(task.ai) || task.origin === "auto" || task.origin === "auto+edited";
      const prioClass = priority === "P0" ? "is-p0" : priority === "P1" ? "is-p1" : "is-rest";
      const summary = signal
        ? [signal.label, signal.text].filter(Boolean).join(" · ")
        : [taskRunningLabel(task), !done ? task.nextSteps?.[0] : null].filter(Boolean).join(" · ");
      return h(
        "article",
        {
          className: cx("sk-card", "sk-card-v3", "is-" + taskStatus, done && "is-done", dragging && "dragging"),
          "data-task-id": task.id,
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
            onDragStart(task.id);
          },
          onDragEnd: () => onDragEnd(),
          onClick: (event) => {
            event.currentTarget.querySelector(".sk-card-open")?.focus({ preventScroll: true });
            onOpen(task.id);
          },
          ...taskActions.handlers(task),
          title: task.title,
        },
        h(
          "div",
          { className: "sk-card-v3-head" },
          h("span", { className: cx("sk-dot", "is-" + taskStatus), title: STATUS_META[taskStatus].label }),
          h("h3", { className: "sk-card-title-v3" }, h("button", {
            type: "button", className: "sk-card-open", "aria-haspopup": "dialog",
            "aria-label": `${task.title}（${[STATUS_META[taskStatus].label, signal?.label].filter(Boolean).join(" · ")}）`,
          }, task.title)),
          task.pinned ? h("span", { className: "sk-archived-mark" }, "置顶") : null,
          task.archived ? h("span", { className: "sk-archived-mark", title: "已归档任务（筛选「含归档」时显示）" }, "已归档") : null,
          showEngine
            ? h("span", { className: cx("sk-ai-mark", engine === "AI" ? "is-ai" : "is-rules"), title: engine === "AI" ? "AI 研判" : "规则推断" }, engine)
            : null,
          taskActions.button(task),
        ),
        h(
          "div",
          { className: "sk-card-meta-v3" },
          h("span", { className: "sk-card-ws", title: task.workspacePath || "" }, task.workspaceTitle || "未分组"),
          h("span", { className: "sk-card-ws-sep" }, "·"),
          h("span", { className: "sk-card-time" }, relTime(task.lastActivityAt)),
          h(
            "span",
            { className: "sk-card-metrics" },
            h("span", { className: cx("sk-prio-text", prioClass), title: "优先级" }, priority),
            issues > 0
              ? h("span", { className: cx("sk-card-metric", "is-warn", highIssue && "is-error"), title: `${issues} 个问题${highIssue ? "（含高优先级）" : ""}` }, h(Icon, { name: "alert", size: 10 }), issues)
              : null,
            artifacts.length > 0
              ? h("span", { className: "sk-card-metric", title: `${artifacts.length} 个产物` }, h(Icon, { name: "file", size: 10 }), artifacts.length)
              : null,
            subtasks.length > 0
              ? h("span", { className: cx("sk-card-metric", allSubtasksDone && "is-done"), title: `${subtaskDone}/${subtasks.length} 子任务` }, h(Icon, { name: "check", size: 10 }), `${subtaskDone}/${subtasks.length}`)
              : null,
          ),
        ),
        summary ? h("div", { className: "sk-card-summary", title: summary }, summary) : null,
        task.progress !== null || subtasks.length
          ? h("div", { className: "sk-card-progress-v3", title: taskProgressLabel(task) }, h("i", { style: { width: `${progress}%` } }))
          : null,
      );
    }

    function ColumnCards({ id, labelledBy, label, className, tasks, signals, onOpen, taskActions, draggingId, onDragStart, onDragEnd, emptyText }) {
      const [page, setPage] = React.useState(0);
      const scrollRef = React.useRef(null);
      const pageCount = Math.max(1, Math.ceil(tasks.length / COLUMN_PAGE_SIZE));
      const currentPage = Math.min(page, pageCount - 1);
      const start = currentPage * COLUMN_PAGE_SIZE;
      React.useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [currentPage]);
      React.useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
      return h(React.Fragment, null,
        h("div", { id, ref: scrollRef, className, role: labelledBy ? "tabpanel" : "region", "aria-labelledby": labelledBy, "aria-label": labelledBy ? undefined : label },
          tasks.length ? tasks.slice(start, start + COLUMN_PAGE_SIZE).map((task) => h(TaskCard, {
            key: task.id, task, signal: signals.get(task.id), onOpen, taskActions, onDragStart, onDragEnd, dragging: draggingId === task.id,
          })) : h("div", { className: labelledBy ? "sk-narrow-empty" : "sk-col-empty" }, emptyText)),
        pageCount > 1 ? h("nav", { className: "sk-column-pager", "aria-label": `${label}分页` },
          h("button", { type: "button", disabled: currentPage === 0, onClick: () => setPage(currentPage - 1), "aria-label": `${label}上一页` },
            h(Icon, { name: "back", size: 13 })),
          h("span", { "aria-live": "polite", title: `第 ${currentPage + 1} / ${pageCount} 页` }, `${start + 1}–${Math.min(start + COLUMN_PAGE_SIZE, tasks.length)} / ${tasks.length}`),
          h("button", { type: "button", disabled: currentPage === pageCount - 1, onClick: () => setPage(currentPage + 1), "aria-label": `${label}下一页` },
            h(Icon, { name: "back", size: 13 }))) : null);
    }

    function Column({ status, tasks, signals, onOpen, taskActions, onAdd, onDropTask, draggingId, onDragStart, onDragEnd, pageKey, collapsed, onToggle }) {
      const meta = STATUS_META[status];
      const [dragOver, setDragOver] = React.useState(false);
      const contentId = React.useId();
      const heading = h(React.Fragment, null,
        h("span", { className: cx("sk-dot", "is-" + status) }),
        h("span", { className: "sk-col-title" }, meta.label),
        h("span", { className: "sk-col-count" }, tasks.length));
      return h(
        "section",
        {
          className: cx("sk-col", dragOver && "dragover", collapsed && "is-collapsed"),
          onDragOver: (event) => {
            if (!draggingId || !event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOver(true);
          },
          onDragLeave: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
          },
          onDrop: (event) => {
            setDragOver(false);
            const id = event.dataTransfer.getData(TASK_DRAG_TYPE);
            if (!id || id !== draggingId) return;
            event.preventDefault();
            onDropTask(id, status);
          },
        },
        h(
          "header",
          { className: "sk-col-head" },
          onToggle ? h("button", { type: "button", className: "sk-col-toggle", "aria-expanded": !collapsed, "aria-controls": contentId,
            "aria-label": `${collapsed ? "展开" : "折叠"}已完成列，${tasks.length} 项`, onClick: onToggle },
            heading, h(Icon, { name: "chevronDown", size: 13 })) : heading,
          !collapsed ? h("span", { className: "sk-col-head-spacer" }) : null,
          !collapsed ? h(
            "button",
            {
              type: "button",
              className: "sk-col-add",
              title: `在「${meta.label}」新建`,
              "aria-label": `在「${meta.label}」新建任务`,
              onClick: () => onAdd(status),
            },
            h(Icon, { name: "plus", size: 14 }),
          ) : null,
        ),
        collapsed ? h("div", { id: contentId, hidden: true }) : h(ColumnCards, {
          key: pageKey, id: contentId, label: meta.label, className: "sk-col-body", tasks, signals, onOpen, taskActions, draggingId, onDragStart, onDragEnd,
          emptyText: status === "blocked" ? "暂无受阻任务" : "暂无任务，拖拽卡片到这里",
        }),
      );
    }

    /** 窄屏（右侧栏 <620px）：文字状态 tab + 单列卡片。 */
    function NarrowBoard({ status, setStatus, byStatus, signals, onOpen, taskActions, onAdd, draggingId, onDragStart, onDragEnd, pageKey }) {
      const list = byStatus[status] || [];
      // Each mounted surface owns its own tab and panel ids.
      const panelId = React.useId();
      const tabId = (item) => `${panelId}-${item}`;
      const changeTabByKey = (event) => {
        const current = STATUS_ORDER.indexOf(status);
        const last = STATUS_ORDER.length - 1;
        const index = { ArrowLeft: current === 0 ? last : current - 1, ArrowRight: current === last ? 0 : current + 1, Home: 0, End: last }[event.key];
        if (index === undefined) return;
        event.preventDefault();
        const next = STATUS_ORDER[index];
        setStatus(next);
        document.getElementById(tabId(next))?.focus();
      };
      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "sk-status-tabs", role: "tablist", "aria-label": "任务状态", onKeyDown: changeTabByKey },
          STATUS_ORDER.map((item) =>
            h(
              "button",
              {
                key: item,
                id: tabId(item),
                type: "button",
                role: "tab",
                tabIndex: status === item ? 0 : -1,
                "aria-selected": status === item,
                "aria-controls": panelId,
                className: cx("sk-status-tab", status === item && "is-on"),
                onClick: () => setStatus(item),
              },
              STATUS_META[item].label,
              h("span", { className: "sk-status-tab-count" }, (byStatus[item] || []).length),
            ),
          ),
        ),
        h(ColumnCards, { key: `${status}:${pageKey}`, id: panelId, labelledBy: tabId(status), label: STATUS_META[status].label,
          className: "sk-narrow-list", tasks: list, signals, onOpen, taskActions, draggingId, onDragStart, onDragEnd,
          emptyText: `「${STATUS_META[status].label}」暂无任务` }),
        h(
          "button",
          { type: "button", className: "sk-narrow-add", onClick: () => onAdd(status) },
          h(Icon, { name: "plus", size: 13 }),
          `新建任务`,
        ),
      );
    }

    /* ============================== drawer v2 ============================= */

    async function copyToClipboard(text) {
      const value = String(text || "");
      if (!value) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        /* fall through */
      }
      let area;
      const previous = document.activeElement;
      try {
        area = document.createElement("textarea");
        area.value = value;
        area.tabIndex = -1;
        area.style.position = "fixed";
        area.style.opacity = "0";
        (previous?.closest?.('[aria-modal="true"]') || document.body).appendChild(area);
        area.select();
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        area?.remove();
        previous?.focus?.({ preventScroll: true });
      }
    }

    const CONTINUE_PURPOSES = {
      continue: ["继续执行", "推进未完成项，验证变更并汇报结果。"],
      unblock: ["排查阻塞", "定位首要阻塞并验证修复。需要用户决定时列出具体选择。"],
      verify: ["验收产出", "按验收条件检查现有产物，逐项说明通过、失败或无法验证的依据。"],
      handoff: ["整理交接", "整理已完成工作、约束、剩余事项和可复用产物，供下一会话接手。"],
    };

    /** Host 未就绪时的本地模板（0 token），保证「继续任务」可用。 */
    function localContinuePrompt(task, purpose, sessionId) {
      const goal = goalInfoOf(task);
      const facts = keyFactsOf(task);
      const issues = Array.isArray(task.issues) ? task.issues : [];
      const nextSteps = Array.isArray(task.nextSteps) ? task.nextSteps : [];
      const session = sessionContextOf(task);
      const subtasks = subtasksOf(task);
      const done = subtasks.filter((item) => item.done).length;
      const lines = [CONTINUE_PURPOSES[purpose][1], ""];
      lines.push("继续任务：" + (task.title || "未命名任务"));
      if (goal && goal.text) lines.push("目标：" + goal.text);
      if (task.acceptanceCriteria) lines.push("", "## 验收条件", task.acceptanceCriteria);
      if (subtasks.length) lines.push("当前进度：" + done + "/" + subtasks.length + " 个子任务完成（" + progressOf(task) + "%）");
      else lines.push("当前进度：" + taskProgressLabel(task));
      if (facts.length) {
        lines.push("关键事实：");
        for (const fact of facts.slice(0, 5)) lines.push(`- ${fact.text}${fact.sessionId && fact.seq ? `（会话 ${fact.sessionId} #${fact.seq}）` : ""}`);
      }
      if (issues.length) {
        lines.push("待解决问题：");
        for (const issue of issues.slice(0, 3)) lines.push("- " + issue.text);
      }
      if (nextSteps.length) {
        lines.push("下一步：");
        for (const step of nextSteps.slice(0, 3)) lines.push("- " + step);
      }
      const pending = subtasks.filter((item) => !item.done);
      if (pending.length) {
        lines.push("", `## 未完成子任务（${pending.length} 项）`, ...pending.slice(0, 8).map((item) => `- ${item.text}`));
      }
      const artifacts = artifactsOf(task);
      const main = primaryArtifactOf(artifacts);
      const related = [main, ...artifacts.filter((item) => item !== main)].filter((item) => item?.path).slice(0, 4);
      if (related.length) {
        lines.push("", "## 交付物与修改记录");
        for (const item of related) lines.push(`- ${item.path}${item.missing ? "（当前不可用）" : ""}${item.sessionId ? ` · 会话 ${item.sessionId}${item.seq ? ` #${item.seq}` : ""}` : ""}`);
      }
      if (sessionId) lines.push("来源会话：" + (task.sessions?.find((item) => item.id === sessionId)?.title || session.title) + `（${sessionId}）`);
      lines.push("", "保留现有约束。完成后说明实际产出、验收结果和仍需处理的事项。");
      return lines.join("\n");
    }

    /** 「继续此任务」弹窗：模板提示词可编辑 → 放入会话 / 新会话 / 复制。 */
    function ContinueTaskModal({ task, initialTarget, initialPurpose, initialSessionId, ctxProps, workspaces, pushToast, onClose, onDone }) {
      const host = (ctxProps && ctxProps.host) || {};
      const session = sessionContextOf(task);
      const [target, setTarget] = React.useState(initialTarget === "newSession" || !session.sessionId ? "newSession" : "session");
      const [purpose, setPurpose] = React.useState(initialPurpose || "continue");
      const [selectedId, setSelectedId] = React.useState(initialSessionId || session.sessionId);
      const [workspaceId, setWorkspaceId] = React.useState(task.workspaceId || "");
      const [prompt, setPrompt] = React.useState("");
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState("");
      const [note, setNote] = React.useState("");
      const sessions = task.sessions?.length ? task.sessions : session.sessionId ? [{ id: session.sessionId, title: session.title }] : [];
      const sessionId = sessions.some((item) => item.id === selectedId) ? selectedId : session.sessionId;
      // 用户改过 textarea 后，切换「原会话 / 新会话」不能丢编辑内容；提示词模板本身与 target 无关。
      const dirtyRef = React.useRef(false);
      const promptKeyRef = React.useRef("");

      React.useEffect(() => {
        const key = `${task.id}:${task.updatedAt}:${target}:${purpose}:${sessionId}`;
        if (dirtyRef.current) {
          setLoading(false);
          setNote("已保留你编辑的提示词，请核对内容与当前任务及放入位置是否一致。");
          return undefined;
        }
        if (promptKeyRef.current === key) return undefined;
        let cancelled = false;
        setLoading(true);
        setNote("");
        command("task.continuePrompt", { id: task.id, target, purpose, sessionId })
          .then((res) => {
            if (cancelled) return;
            const data = (res && res.data) || res || {};
            const text = typeof data.prompt === "string" ? data.prompt : "";
            promptKeyRef.current = key;
            if (dirtyRef.current) return;
            setPrompt(text || localContinuePrompt(task, purpose, sessionId));
            if (!text) setNote("Host 模板接口未就绪，已使用本地模板");
          })
          .catch(() => {
            if (cancelled || dirtyRef.current) return;
            promptKeyRef.current = key;
            setPrompt(localContinuePrompt(task, purpose, sessionId));
            setNote("Host 模板接口不可用，已使用本地模板（仍然可用）");
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [target, purpose, task.id, task.updatedAt, sessionId]);

      const copy = async () => {
        const ok = await copyToClipboard(prompt);
        pushToast(ok ? "提示词已复制" : "浏览器拦截了剪贴板，请手动选择文本复制", ok ? "info" : "error");
        return ok;
      };
      const toastCopiedOrManual = async (text) => {
        const copied = await copyToClipboard(prompt);
        pushToast(copied ? text + "，提示词已复制" : text + "，请手动复制提示词", copied ? "info" : "error");
        return copied;
      };

      const polish = async () => {
        if (!prompt.trim()) return;
        setBusy("polish");
        try {
          const res = await command("task.polishPrompt", { id: task.id, prompt });
          const data = (res && res.data) || res || {};
          const text = typeof data.prompt === "string" ? data.prompt : "";
          // Host 在 AI 未启用 / 无凭证 / 预算耗尽时返回 polished:false + 原文，不能当成润色成功。
          if (data.polished === true && text) {
            setPrompt(text);
            dirtyRef.current = true;
            pushToast("AI 已润色提示词", "info");
          } else {
            pushToast("AI 未启用或不可用，已保留原文", "info");
          }
        } catch (cause) {
          pushToast("润色失败，保留原文：" + cause.message, "error");
        } finally {
          setBusy("");
        }
      };

      const place = async () => {
        if (!prompt.trim()) return;
        setBusy("place");
        try {
          if (target === "newSession") {
            const placement = await host.prepareSession?.(workspaceId, prompt);
            if (!placement?.sessionId || placement.result !== "applied") {
              await toastCopiedOrManual(placement?.result === "preserved" ? "新会话已有草稿" : "未能确认草稿放置");
              return;
            }
            try {
              await command("task.linkSession", { id: task.id, sessionId: placement.sessionId, continuation: true });
              pushToast("草稿已放入，续做会话已关联", "info");
            } catch (cause) {
              pendingHandoff = { id: task.id, title: task.title, targetId: placement.sessionId, expires: Date.now() + 15 * 60_000 };
              pushToast("草稿已放入。打开新会话的看板可重试关联：" + cause.message, "error");
            }
            onClose();
            onDone?.();
            return;
          }
          const result = host.placeDraft ? await host.placeDraft(sessionId, prompt) : { ok: false, reason: "missing" };
          if (result && result.ok) {
            const state = result.result;
            if (state === "applied") {
              pushToast("提示词已放入输入框，确认后发送", "info");
              onClose();
              if (onDone) onDone();
            } else if (state === "preserved") {
              await toastCopiedOrManual("输入框已有草稿，已保留原草稿");
            } else {
              await toastCopiedOrManual("会话输入框未就绪");
            }
            return;
          }
          await toastCopiedOrManual("会话联动不可用");
        } catch (cause) {
          pushToast("放入会话失败：" + cause.message, "error");
        } finally {
          setBusy("");
        }
      };

      const disabled = loading || !!busy || !prompt.trim() || (target === "newSession" ? !workspaceId : !sessionId);
      const polishTooLong = prompt.trim().length > PROMPT_POLISH_LIMIT;
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();

      return h(
        "div",
        { className: "sk-modal-mask", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          "div",
          {
            className: "sk-modal sk-continue-modal",
            ref: dialogRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "sk-continue-title",
          },
          h("h3", { id: "sk-continue-title" }, h(Icon, { name: "play", size: 15 }), "继续此任务"),
          h(
            "div",
            { className: "sk-modal-body" },
            h("p", { className: "sub" }, "检查草稿后由你发送。新会话草稿放入后会关联到当前任务。"),
            h("label", { className: "sk-field" }, "工作目的",
              h("select", { className: "sk-select", value: purpose, disabled: !!busy, onChange: (event) => setPurpose(event.target.value) },
                Object.entries(CONTINUE_PURPOSES).map(([value, [label]]) => h("option", { key: value, value }, label)))),
            target === "newSession" ? h("label", { className: "sk-field" }, "目标工作区",
              h("select", { className: "sk-select", value: workspaceId, disabled: !!busy, onChange: (event) => setWorkspaceId(event.target.value) },
                h("option", { value: "" }, "选择工作区"),
                (workspaces || []).filter((item) => !item.synthetic || item.id === task.workspaceId)
                  .map((item) => h("option", { key: item.id, value: item.id }, item.title)))) : sessions.length > 1
              ? h("label", { className: "sk-field" }, "目标会话",
                  h("select", { className: "sk-select", value: sessionId, disabled: !!busy, onChange: (event) => setSelectedId(event.target.value) },
                    sessions.map((item) => h("option", { key: item.id, value: item.id }, item.title || item.id)))) : null,
            h(
              "div",
              { className: "sk-continue-target", role: "group", "aria-label": "提示词放入位置" },
              h(
                "button",
                { type: "button", "aria-pressed": target === "session", disabled: !!busy || !sessionId, className: target === "session" ? "is-on" : "", onClick: () => setTarget("session") },
                "关联会话",
                h("small", null, sessions.find((item) => item.id === sessionId)?.title || "来源会话"),
              ),
              h(
                "button",
                { type: "button", "aria-pressed": target === "newSession", disabled: !!busy, className: target === "newSession" ? "is-on" : "", onClick: () => setTarget("newSession") },
                "新会话",
                h("small", null, workspaces?.find((item) => item.id === workspaceId)?.title || "选择工作区"),
              ),
            ),
            loading
              ? h("div", { className: "sk-note-tiny", role: "status", "aria-live": "polite" }, "正在生成提示词…")
              : h("textarea", {
                  className: "sk-continue-textarea",
                  "aria-label": "继续任务的提示词",
                  value: prompt,
                  spellCheck: false,
                  onChange: (event) => {
                    dirtyRef.current = true;
                    setPrompt(event.target.value);
                  },
                }),
            note ? h("div", { className: "sk-note-tiny", role: "status", "aria-live": "polite" }, note) : null,
            polishTooLong ? h("div", { className: "sk-note-tiny" }, "超过 3000 字的草稿可直接放入会话。精简后可使用 AI 润色。") : null,
          ),
          h(
            "div",
            { className: "sk-modal-foot" },
            h("button", { type: "button", className: "sk-btn ghost", onClick: onClose }, "取消"),
            h("button", { type: "button", className: "sk-btn", onClick: copy, disabled: !prompt.trim() }, "仅复制"),
            h(
              "button",
              { type: "button", className: "sk-btn", onClick: polish, disabled: loading || !!busy || !prompt.trim() || polishTooLong, title: "消耗 1 次 AI 调用" },
              busy === "polish" ? "润色中…" : "AI 润色",
            ),
            h(
              "button",
              { type: "button", className: "sk-btn primary", onClick: place, disabled },
              busy === "place" ? "放入中…" : target === "newSession" ? "新建并放入" : "放入会话",
            ),
          ),
        ),
      );
    }

    function TaskIssues({ task, run, openSourceSession }) {
      const [text, setText] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const severity = { high: 0, medium: 1, low: 2 };
      const issues = [...(task.issues || [])].sort((a, b) => (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9));
      const submit = async (value, resolve) => {
        if (!value.trim() || busy) return;
        setBusy(true);
        try {
          await run("更新问题", async () => {
            await command("task.issue", { id: task.id, text: value, resolve });
            if (!resolve) setText("");
          }, resolve ? "问题已解决" : "已记录问题");
        } finally {
          setBusy(false);
        }
      };
      return h("details", { className: "sk-drawer-sec sk-relation-editor" },
        h("summary", null, `问题管理 · ${issues.length} 待处理`),
        issues.map((issue, index) => h("div", { className: "sk-management-row", key: issue.id || index },
          h("span", null, issue.text),
          issue.sessionId ? h("button", { className: "sk-text", type: "button", onClick: () => openSourceSession(issue.sessionId) },
            issue.seq ? `来源 #${issue.seq}` : "打开来源") : null,
          h("button", { type: "button", className: "sk-btn", disabled: busy, onClick: () => submit(issue.text, true) }, "标记解决"))),
        h("form", { className: "sk-batchbar", onSubmit: (event) => { event.preventDefault(); submit(text, false); } },
          h("input", { className: "sk-input", "aria-label": "新增问题", placeholder: "记录需要处理的问题", maxLength: TEXT_LIMITS.issueText,
            value: text, onChange: (event) => setText(event.target.value) }),
          h("button", { type: "submit", className: "sk-btn", disabled: busy || !text.trim() }, "添加")),
        task.resolvedIssues?.length ? h("details", null, h("summary", null, `已解决 ${task.resolvedIssues.length} 项`),
          h("ul", null, task.resolvedIssues.map((issue) => h("li", { key: issue }, issue)))) : null);
    }

    function TaskLinks({ task, tasks, host, run, onOpenTask, pushToast }) {
      const [type, setType] = React.useState("parent");
      const [other, setOther] = React.useState("");
      const [query, setQuery] = React.useState("");
      const [catalog, setCatalog] = React.useState(null);
      const [candidates, setCandidates] = React.useState(null);
      const [mergeId, setMergeId] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const index = React.useMemo(() => new Map(tasks.map((item) => [item.id, item])), [tasks]);
      const incoming = tasks.flatMap((item) => (item.relations || [])
        .filter((link) => link.taskId === task.id)
        .map((link) => ({ taskId: item.id, type: link.type })));
      const call = async (op, payload, message) => {
        if (busy) return;
        setBusy(true);
        try { await run("更新关系", () => command(op, { id: task.id, ...payload }), message); }
        finally { setBusy(false); }
      };
      const lookup = async (filter) => {
        setBusy(true);
        try { setCatalog(await apiRequest("/sessions?q=" + encodeURIComponent(filter))); }
        catch (cause) { pushToast(cause.message, "error"); }
        finally { setBusy(false); }
      };
      const suggest = async () => {
        setBusy(true);
        try {
          const result = await apiRequest("/merge-candidates?id=" + encodeURIComponent(task.id));
          setCandidates(result.candidates);
        } catch (cause) { pushToast(cause.message, "error"); }
        finally { setBusy(false); }
      };
      return h("details", { className: "sk-drawer-sec sk-relation-editor" },
        h("summary", null, "会话与任务关系"),
        (task.sessions || []).map((entry) => h("div", { className: "sk-management-row", key: entry.id },
          h("span", null, entry.title || entry.id, entry.id === task.primarySessionId ? " · 主会话" : "", entry.continuedAt ? " · 续做" : ""),
          h("button", { className: "sk-btn", type: "button", onClick: () => {
            if (!host.openSession?.(entry.id)) pushToast("当前无法打开会话", "error");
          } }, "打开"),
          entry.id !== task.primarySessionId ? h("button", { className: "sk-btn", type: "button", disabled: busy,
            onClick: () => call("task.linkSession", { sessionId: entry.id, primary: true }, "主会话已更新") }, "设为主会话") : null,
          h("button", { className: "sk-btn", type: "button", disabled: busy,
            onClick: () => call("task.linkSession", { sessionId: entry.id, remove: true }, "已解除关联") }, "解绑"))),
        h("form", { className: "sk-batchbar", onSubmit: (event) => { event.preventDefault(); lookup(query); } },
          h("input", { className: "sk-input", value: query, placeholder: "搜索会话名称、工作区或 ID", maxLength: 100,
            "aria-label": "搜索会话", onChange: (event) => setQuery(event.target.value) }),
          h("button", { className: "sk-btn", type: "submit", disabled: busy }, "查找会话"),
          task.primarySessionId ? h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => lookup(task.primarySessionId) }, "查看子代理") : null),
        catalog ? h("div", { className: "sk-management-card" },
          h("p", null, catalog.total ? `显示 ${catalog.sessions.length} / ${catalog.total} 个会话` : "没有匹配的会话"),
          catalog.sessions.map((entry) => h("div", { className: "sk-management-row", key: entry.id },
            h("span", null, entry.title || entry.id, entry.parentId ? " · 子代理" : "", entry.isLive ? " · 运行中" : entry.lastTurnEnd === "error" ? " · 出错" : ""),
            h("button", { className: "sk-btn", type: "button", disabled: busy || task.sessions?.some((item) => item.id === entry.id),
              onClick: () => call("task.linkSession", { sessionId: entry.id }, "已关联会话") }, "关联"),
            h("button", { className: "sk-btn", type: "button", disabled: busy || entry.ignored, onClick: async () => {
              await call("session.ignore", { sessionId: entry.id }, "此会话将跳过自动建卡");
              await lookup(query);
            } }, entry.ignored ? "已忽略" : "忽略扫描")))) : null,
        (task.relations || []).map((link) => h("div", { className: "sk-management-row", key: link.type + link.taskId },
          h("span", null, RELATION_LABELS[link.type]),
          h("button", { className: "sk-text", type: "button", disabled: !index.has(link.taskId),
            onClick: () => onOpenTask(link.taskId) }, index.get(link.taskId)?.title || "关联任务不可用"),
          h("button", { className: "sk-btn", type: "button", disabled: busy,
            onClick: () => call("task.relate", { ...link, remove: true }, "已移除任务关系") }, "移除"))),
        incoming.map((link) => h("div", { className: "sk-management-row", key: "in:" + link.type + link.taskId },
          h("span", null, link.type === "parent" ? "子任务卡" : link.type === "depends_on" ? "依赖此任务" : "相关任务"),
          h("button", { className: "sk-text", type: "button", onClick: () => onOpenTask(link.taskId) }, index.get(link.taskId)?.title))),
        h("div", { className: "sk-batchbar" },
          h("select", { className: "sk-select", "aria-label": "任务关系类型", value: type, onChange: (event) => setType(event.target.value) },
            Object.entries(RELATION_LABELS).map(([value, label]) => h("option", { key: value, value }, label))),
          h("select", { className: "sk-select", "aria-label": "关系目标任务", value: other, onChange: (event) => setOther(event.target.value) },
            h("option", { value: "" }, "选择任务"),
            tasks.filter((item) => item.id !== task.id).map((item) => h("option", { key: item.id, value: item.id }, item.title))),
          h("button", { className: "sk-btn", type: "button", disabled: busy || !other,
            onClick: () => call("task.relate", { taskId: other, type }, "已更新任务关系") }, "添加关系")),
        h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: suggest }, "查找相似任务"),
        candidates ? candidates.length ? candidates.map((candidate) => h("div", { className: "sk-management-row", key: candidate.id },
          h("span", null, candidate.title),
          h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => {
            if (mergeId !== candidate.id) { setMergeId(candidate.id); return; }
            call("task.merge", { sourceId: candidate.id }, "已合并，可在维护中撤销");
            setCandidates(null);
            setMergeId("");
          } }, mergeId === candidate.id ? "确认合并到此任务" : "合并"),
          mergeId === candidate.id ? h("button", { className: "sk-text", type: "button", onClick: () => setMergeId("") }, "取消") : null))
          : h("p", { className: "sk-note-tiny" }, "没有发现相似任务") : null);
    }

    function renderSessionActions(sessions, openSession, label = "待处理会话") {
      if (!sessions.length) return null;
      return h("ul", { className: "sk-session-actions", "aria-label": label }, sessions.map(({ id, title, label }) =>
        h("li", { key: id }, h("span", null, `${label} · ${title}`),
          h("button", { className: "sk-btn", type: "button", "aria-label": `打开会话：${title}（${label}）`, onClick: () => openSession(id) }, "打开会话"))));
    }

    function TaskDrawer({ task, signal, tasks, workspaces, onOpenTask, ctxProps, settings, desktopFiles, onClose, onChanged, pushToast }) {
      const host = (ctxProps && ctxProps.host) || {};
      const goal = goalInfoOf(task);
      const session = sessionContextOf(task);
      const locked = Array.isArray(task.lockedFields) ? task.lockedFields : [];
      const [draft, setDraft] = React.useState(() => ({
        title: task.title || "",
        goal: (goal && goal.text) || "",
        acceptanceCriteria: task.acceptanceCriteria || "",
        status: task.status || "backlog",
        priority: task.priority || "P2",
        progress: pct(task.progress),
      }));
      const [editing, setEditing] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [factsExpanded, setFactsExpanded] = React.useState(false);
      const [subtasksExpanded, setSubtasksExpanded] = React.useState(false);
      const [evidenceOpen, setEvidenceOpen] = React.useState(false);
      const [evidenceSession, setEvidenceSession] = React.useState("");
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const [expandedEvidence, setExpandedEvidence] = React.useState({});
      const [moreAnchor, setMoreAnchor] = React.useState(null);
      const [footerAnchor, setFooterAnchor] = React.useState(null);
      const [continueOpen, setContinueOpen] = React.useState(false);
      const [continueTarget, setContinueTarget] = React.useState("session");
      const [continuePurpose, setContinuePurpose] = React.useState("continue");
      const [acceptBusy, setAcceptBusy] = React.useState(false);
      const [newSubtask, setNewSubtask] = React.useState("");
      const [subtaskBusy, setSubtaskBusy] = React.useState("");
      const [optimisticSubtasks, setOptimisticSubtasks] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [staleNotice, setStaleNotice] = React.useState(false);
      const editBase = React.useRef(null);
      const [analyzeBusy, setAnalyzeBusy] = React.useState(false);
      const dialogRef = React.useRef(null);
      const titleId = React.useId();

      const subtasks = optimisticSubtasks || subtasksOf(task);
      const subtaskDone = subtasks.filter((item) => item.done).length;
      const facts = keyFactsOf(task);
      const artifacts = artifactsOf(task);
      const primaryArtifact = primaryArtifactOf(artifacts);
      const otherArtifacts = artifacts.filter((item) => item !== primaryArtifact);
      const pending = task.pendingSessions || [];
      const ready = signal?.label === "待验收";
      const accepted = task.status === "done" && task.completionBasis === "user";
      const canAccept = !task.archived && (accepted || (!pending.length && !taskRunningLabel(task) &&
        (task.acceptanceCriteria || primaryArtifact?.kind === "deliverable" || task.status === "done")));
      const nextSteps = Array.isArray(task.nextSteps) ? task.nextSteps : [];
      const aiInfo = aiInfoOf(task);
      // 新旧兼容：有 provider 时显示「provider 显示名 / model」；旧任务只有 model 时保持单模型名样式。
      const aiModelText =
        aiInfo && aiInfo.engine === "llm"
          ? [aiInfo.provider ? providerLabel(aiInfo.provider) : "", aiInfo.model].filter(Boolean).join(" / ")
          : "";
      // 「可能已过期」只在会话在研判之后又产生了活动时提示：没有新活动时，
      // 旧研判仍然有效；按扫描间隔判断会让所有旧任务都误报过期。
      const lastActivityAt = Number((task.sessionContext && task.sessionContext.lastActivityAt) || task.lastActivityAt) || 0;
      const aiStale = Boolean(aiInfo && aiInfo.analyzedAt && lastActivityAt > aiInfo.analyzedAt);
      const evidence = (task.evidence || []).slice(0, 8).sort((a, b) => (b.time || 0) - (a.time || 0) || (b.seq || 0) - (a.seq || 0));
      const evidenceSources = new Map(evidence.filter((item) => item.sessionId).map((item) => [item.sessionId, item.sessionTitle || item.sessionId]));
      const evidenceScope = evidenceSources.has(evidenceSession) ? evidenceSession : "";
      const visibleEvidence = evidenceScope ? evidence.filter((item) => item.sessionId === evidenceScope) : evidence;
      const history = Array.isArray(task.history) ? task.history.slice().reverse().slice(0, 20) : [];

      const currentEditValues = () => ({
        title: task.title || "",
        goal: goalInfoOf(task)?.text || "",
        acceptanceCriteria: task.acceptanceCriteria || "",
        status: task.status || "backlog",
        priority: task.priority || "P2",
        progress: pct(task.progress),
      });

      const resetDraft = () => {
        const values = currentEditValues();
        editBase.current = { values, updatedAt: task.updatedAt };
        setDraft(values);
      };

      const changedFields = () => Object.keys(draft).filter((field) =>
        String(draft[field] ?? "") !== String(editBase.current?.values[field] ?? ""));
      const rebaseDraft = () => {
        const edited = Object.fromEntries(changedFields().map((field) => [field, draft[field]]));
        const values = currentEditValues();
        editBase.current = { values, updatedAt: task.updatedAt };
        setDraft({ ...values, ...edited });
        setStaleNotice(false);
      };

      // 只在切换到另一张任务卡时重置编辑态；轮询/扫描导致 updatedAt 变化不能吞掉用户草稿。
      React.useEffect(() => {
        resetDraft();
        setEditing(false);
        setOptimisticSubtasks(null);
        setStaleNotice(false);
      }, [task.id]);

      // 后台（轮询 / 扫描 / 重新研判）覆盖了任务时：保留草稿，只给一句安静的提示。
      React.useEffect(() => {
        setOptimisticSubtasks(null);
        if (editing && editBase.current?.updatedAt !== task.updatedAt) setStaleNotice(true);
      }, [task.updatedAt]);

      // S10：菜单关闭 / 点别处时复位「确认删除」，避免下次打开菜单直接显示「确认删除任务」。
      const closeMore = () => {
        setMoreAnchor(null);
        setConfirmDelete(false);
      };

      // Esc 分层：先收起抽屉内浮层 / 退出编辑，最后才关闭抽屉；「继续此任务」弹窗自己处理 Esc。
      const handleEscape = () => {
        if (continueOpen) return;
        if (moreAnchor) {
          closeMore();
          return;
        }
        if (footerAnchor) {
          setFooterAnchor(null);
          return;
        }
        if (editing) {
          resetDraft();
          setEditing(false);
          return;
        }
        if (confirmDelete) {
          setConfirmDelete(false);
          return;
        }
        onClose();
      };
      useDialogFocus(dialogRef, handleEscape);
      useBodyScrollLock();

      const update = (patch) => setDraft((value) => ({ ...value, ...patch }));

      const save = async () => {
        setSaving(true);
        try {
          const changed = changedFields();
          const patch = Object.fromEntries(changed.map((field) => [field, typeof draft[field] === "string" ? draft[field].trim() : draft[field]]));
          if (changed.length) await command("task.update", { id: task.id, patch, lockFields: changed, expectedUpdatedAt: editBase.current?.updatedAt });
          pushToast("已保存", "info");
          setEditing(false);
          setStaleNotice(false);
          resetDraft();
          await onChanged();
        } catch (cause) {
          pushToast("保存失败：" + cause.message, "error");
          if (cause.status === 409) await onChanged();
        } finally {
          setSaving(false);
        }
      };

      const run = async (label, fn, toastText) => {
        try {
          await fn();
          if (toastText) pushToast(toastText, "info");
          await onChanged();
        } catch (cause) {
          pushToast(label + "失败：" + cause.message, "error");
        }
      };

      const acceptTask = async () => {
        if (acceptBusy || accepted) return;
        setAcceptBusy(true);
        try {
          await command("task.accept", { id: task.id, expectedUpdatedAt: task.updatedAt });
          await onChanged();
          pushToast("已确认验收", "info");
        } catch (cause) {
          pushToast("验收失败：" + cause.message, "error");
          if (cause.status === 409) await onChanged();
        } finally {
          setAcceptBusy(false);
        }
      };

      const toggleLock = () => {
        if (locked.length > 0) {
          run("解锁", () => command("task.unlock", { id: task.id }), "已交还 AI 维护").then(() => {
            resetDraft();
            setStaleNotice(false);
          });
        } else {
          run("锁定", () => command("task.update", { id: task.id, patch: {}, lockFields: EDITABLE_FIELDS }), "已锁定字段");
        }
      };

      const importTodos = async () => {
        setSubtaskBusy("import");
        try {
          await command("task.importTodos", { id: task.id });
          pushToast("已从会话导入待办", "info");
          await onChanged();
        } catch (cause) {
          pushToast("导入待办失败：" + cause.message, "error");
        } finally {
          setSubtaskBusy("");
        }
      };

      const toggleSubtask = async (item) => {
        const nextDone = !item.done;
        const before = subtasks;
        setOptimisticSubtasks(subtasks.map((entry) => (entry.id === item.id ? { ...entry, done: nextDone } : entry)));
        try {
          await command("task.toggleSubtask", { id: task.id, subtaskId: item.id, done: nextDone });
          await onChanged();
        } catch (cause) {
          setOptimisticSubtasks(before);
          pushToast("子任务更新失败：" + cause.message, "error");
        }
      };

      const addSubtask = async () => {
        const text = newSubtask.trim();
        if (!text) return;
        setSubtaskBusy("add");
        try {
          await command("task.addSubtask", { id: task.id, text });
          setNewSubtask("");
          await onChanged();
        } catch (cause) {
          pushToast("新增子任务失败：" + cause.message, "error");
        } finally {
          setSubtaskBusy("");
        }
      };

      const removeSubtask = async (item) => {
        const before = subtasks;
        setOptimisticSubtasks(subtasks.filter((entry) => entry.id !== item.id));
        try {
          await command("task.removeSubtask", { id: task.id, subtaskId: item.id });
          await onChanged();
        } catch (cause) {
          setOptimisticSubtasks(before);
          pushToast("删除子任务失败：" + cause.message, "error");
        }
      };

      const openSourceSession = (id) => {
        const fn = ctxProps && ctxProps.openSession;
        if (typeof fn === "function" && fn(id)) {
          onClose();
          return;
        }
        pushToast("当前环境不支持跳转会话", "error");
      };
      const openSession = () => openSourceSession(session.sessionId);

      const artifactButton = (artifact) => h(ArtifactEntry, {
        key: artifact.id, artifact, task, host, desktopFiles, pushToast, onPreview: onClose,
      });

      const startContinue = (target, purpose) => {
        setContinueTarget(target);
        setContinuePurpose(purpose);
        setContinueOpen(true);
      };

      const openTerminal = () => {
        const ok = host.openTerminal ? host.openTerminal() : false;
        if (!ok) {
          pushToast("当前环境无法打开终端", "error");
          return;
        }
        onClose();
      };

      const copySessionId = async () => {
        const ok = await copyToClipboard(session.sessionId);
        pushToast(ok ? "会话 ID 已复制" : "浏览器拦截了剪贴板，请手动复制", ok ? "info" : "error");
      };

      const removeTask = async () => {
        if (!confirmDelete) {
          setConfirmDelete(true);
          pushToast("再次点击「删除任务」确认删除", "info");
          return;
        }
        try {
          await command("task.delete", { id: task.id });
          pushToast("任务已移到回收站", "info");
          onClose();
          await onChanged();
        } catch (cause) {
          setConfirmDelete(false);
          pushToast("删除失败：" + cause.message, "error");
        }
      };

      // 立即对来源会话重跑一次研判（Host 在扫描中会返回冲突错误；AI 不可用时自动降级规则）。
      const analyzeNow = async () => {
        if (analyzeBusy) return;
        setAnalyzeBusy(true);
        try {
          const res = await command("task.analyze", { id: task.id });
          const data = (res && res.data) || {};
          const details = [];
          if (data.engine) details.push(data.engine === "llm" ? "AI 引擎" : "规则引擎");
          if (Number(data.aiCalls) > 0) details.push(`${data.aiCalls} 次 AI 调用`);
          if (Number(data.tokens) > 0) details.push(`${fmtTokens(data.tokens)} tokens`);
          const message = String(data.message || "任务已重新研判");
          pushToast(details.length ? `${message} · ${details.join(" · ")}` : message, "info");
          await onChanged();
        } catch (cause) {
          const message = String((cause && cause.message) || cause);
          pushToast(/扫描/.test(message) ? "扫描进行中，暂时无法重新研判" : `重新研判失败：${message}`, "error");
        } finally {
          setAnalyzeBusy(false);
        }
      };

      const drawerMenuItems = [
        { label: task.pinned ? "取消置顶" : "置顶任务", icon: "arrow", run: () => run("置顶", () => command("task.pin", { id: task.id, pinned: !task.pinned }), task.pinned ? "已取消置顶" : "已置顶") },
        { label: "编辑任务", icon: "edit", run: () => { resetDraft(); setEditing(true); } },
        { label: analyzeBusy ? "重新研判中…" : "重新研判", icon: "spark", disabled: analyzeBusy, run: analyzeNow },
        { label: locked.length ? "解锁字段" : "锁定字段", icon: locked.length ? "unlock" : "lock", run: toggleLock },
        "divider",
        { label: task.archived ? "恢复任务" : "归档任务", icon: "archive", run: () => run(task.archived ? "恢复" : "归档", async () => {
          await command("task.archive", { id: task.id, archived: !task.archived });
          if (!task.archived) onClose();
        }, task.archived ? "已恢复" : "已归档") },
        // S10：删除二次确认在菜单内原位完成（keepOpen），菜单一关闭就复位，避免下次打开直接显示「确认删除任务」。
        { id: "delete-task", label: confirmDelete ? "确认删除任务" : "删除任务", icon: "trash", danger: true, keepOpen: true, run: removeTask },
      ];
      const footerMenuItems = [
        { label: "新会话继续", icon: "spark", run: () => startContinue("newSession", "continue") },
        { label: "打开终端", icon: "tool", run: openTerminal },
        { label: "复制会话 ID", icon: "copy", disabled: !session.sessionId, run: copySessionId },
      ];

      const subtaskRows = (subtasksExpanded ? subtasks : subtasks.slice(0, 8)).map((item) =>
        h(
          "div",
          { key: item.id, className: cx("sk-subtask", item.done && "done") },
          h(
            "button",
            {
              type: "button",
              className: "sk-subtask-toggle",
              "aria-pressed": item.done,
              "aria-label": `${item.done ? "标记未完成" : "标记完成"}：${item.text}`,
              onClick: () => toggleSubtask(item),
            },
            h("span", { className: "sk-subtask-box" }, item.done ? h(Icon, { name: "check", size: 10 }) : null),
            h("span", { className: "sk-subtask-text" }, item.text),
          ),
          h(
            "button",
            { type: "button", className: "sk-subtask-del", title: "删除子任务", "aria-label": `删除子任务：${item.text}`, onClick: () => removeSubtask(item) },
            h(Icon, { name: "close", size: 11 }),
          ),
        ),
      );

      return h(
        React.Fragment,
        null,
        h("div", { className: "sk-mask", onClick: onClose, "aria-hidden": "true" }),
        h(
          "aside",
          {
            className: "sk-drawer sk-drawer-v3",
            ref: dialogRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": titleId,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            "header",
            { className: "sk-drawer-head" },
            h(
              "button",
              { type: "button", className: "sk-iconbtn-v3 sk-drawer-back", title: "返回（Esc）", "aria-label": "关闭任务详情", onClick: onClose },
              h(Icon, { name: "back", size: 16 }),
            ),
            h("div", { className: "sk-drawer-head-text" }, h("div", { className: "sk-drawer-kicker" }, "任务"), h("h2", { className: "sk-drawer-title-v3", id: titleId }, task.title)),
            h(QuickMenuButton, { label: "更多任务操作", expanded: Boolean(moreAnchor), onOpen: (anchor) => anchor ? setMoreAnchor(anchor) : closeMore() }),
            moreAnchor ? h(QuickMenu, { anchor: moreAnchor, label: "更多任务操作", items: drawerMenuItems, onClose: closeMore }) : null,
          ),
          h(
            "div",
            { className: "sk-drawer-body" },
            h(
              "div",
              { className: "sk-drawer-sec" },
              h(
                "div",
                { className: "sk-drawer-sec-head" },
                h("span", { className: "sk-drawer-sec-title" }, "任务概览"),
                h("span", { className: "sk-grow" }),
                h(
                  "button",
                  {
                    type: "button",
                    className: "sk-text",
                    onClick: () => {
                      if (editing) {
                        resetDraft();
                        setEditing(false);
                      } else {
                        resetDraft();
                        setEditing(true);
                      }
                    },
                  },
                  editing ? "取消" : "编辑",
                ),
              ),
              editing
                ? h(
                    "div",
                    { className: "sk-edit-fields" },
                    h("div", { className: "sk-edit-row" }, h("span", { className: "sk-edit-label" }, "标题"), h("input", { className: "sk-input", "aria-label": "标题", value: draft.title, maxLength: TEXT_LIMITS.title, onChange: (event) => update({ title: event.target.value }) })),
                    h("div", { className: "sk-edit-row" }, h("span", { className: "sk-edit-label" }, "目标"), h("textarea", { className: "sk-textarea", "aria-label": "目标", value: draft.goal, maxLength: TEXT_LIMITS.goal, rows: 3, onChange: (event) => update({ goal: event.target.value }) })),
                    h("label", { className: "sk-field" }, "验收条件",
                      h("textarea", { className: "sk-textarea", value: draft.acceptanceCriteria, maxLength: TEXT_LIMITS.acceptanceCriteria,
                        rows: 3, placeholder: "写下可检查的结果或验证步骤", onChange: (event) => update({ acceptanceCriteria: event.target.value }) })),
                    h(
                      "div",
                      { className: "sk-edit-row" },
                      h("span", { className: "sk-edit-label" }, "状态"),
                      h("select", { className: "sk-select", "aria-label": "状态", value: draft.status, onChange: (event) => update({ status: event.target.value }) }, STATUS_ORDER.map((status) => h("option", { key: status, value: status }, STATUS_META[status].label))),
                      h("span", { className: "sk-edit-label", style: { width: 44, textAlign: "right" } }, "优先级"),
                      h("select", { className: "sk-select", "aria-label": "优先级", value: draft.priority, onChange: (event) => update({ priority: event.target.value }) }, PRIORITY_ORDER.map((priority) => h("option", { key: priority, value: priority }, priority))),
                    ),
                    h(
                      "div",
                      { className: "sk-edit-row" },
                      h("span", { className: "sk-edit-label" }, "进度"),
                      h("input", {
                        className: "sk-slider",
                        type: "range",
                        min: 0,
                        max: 100,
                        step: 5,
                        "aria-label": "进度",
                        value: draft.progress === null ? 0 : draft.progress,
                        onChange: (event) => update({ progress: Number(event.target.value) }),
                      }),
                      h("span", { className: "sk-note-tiny" }, draft.progress === null ? "—" : draft.progress + "%"),
                    ),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      "div",
                      { className: "sk-summary-line" },
                      h("span", { className: cx("sk-dot", "is-" + statusOf(task)) }),
                      h("span", { className: cx("sk-summary-status", "is-" + statusOf(task)) }, STATUS_META[statusOf(task)].label),
                      h("span", { className: "sk-sep" }, "·"),
                      h("span", { className: cx("sk-summary-prio", task.priority === "P0" ? "is-p0" : task.priority === "P1" ? "is-p1" : "is-rest") }, task.priority || "P2"),
                      h("span", { className: "sk-sep" }, "·"),
                      h("span", { className: "sk-muted" }, taskProgressLabel(task)),
                      task.completionBasis && task.status === "done" && subtasks.length ? h("span", { className: "sk-muted" }, COMPLETION_LABELS[task.completionBasis]) : null,
                    ),
                    h("div", { className: "sk-task-overview" },
                      h("div", { className: "sk-overview-item" }, h("h3", null, "目标"), h("p", null, goal?.text || "待补充")),
                      h("div", { className: "sk-overview-item" }, h("h3", null, "验收条件"), h("p", null, task.acceptanceCriteria || "待补充")),
                      pending.length ? renderSessionActions(pending, openSourceSession) :
                        !task.writeOverlap && (signal || nextSteps[0]) ? h("div", { className: "sk-overview-item" },
                          h("h3", null, signal?.label || "下一步"),
                          signal?.taskId && tasks.some((item) => item.id === signal.taskId)
                            ? h("div", null, h("button", { type: "button", className: "sk-text sk-link-text", onClick: () => onOpenTask(signal.taskId) }, signal.text))
                            : h("p", null, signal?.text || nextSteps[0] || "查看任务详情"),
                          signal?.sessionId ? h("div", null, h("button", { type: "button", className: "sk-text sk-link-text", onClick: () => openSourceSession(signal.sessionId) }, "打开失败会话")) : null) : null,
                      task.writeOverlap ? h("div", { className: "sk-overview-item" },
                        h("h3", null, "可能同时修改"), h("p", null, task.writeOverlap.path),
                        renderSessionActions(task.writeOverlap.sessions.map((item) => ({
                          ...item, label: `写入 ${relTime(item.at)}${item.seq ? ` · #${item.seq}` : ""}`,
                        })), openSourceSession, "近期写入的会话")) : null,
                      primaryArtifact ? h("div", { className: "sk-overview-item" },
                        h("h3", null, primaryArtifact.kind === "deliverable" ? "主交付物" : "最近修改文件"), artifactButton(primaryArtifact),
                        task.sessions?.some((item) => item.id === primaryArtifact.sessionId) ? h("span", { className: "sk-note-tiny" },
                          `来源 · ${task.sessions.find((item) => item.id === primaryArtifact.sessionId).title || "关联会话"}`) : null) : null,
                      canAccept ? h("div", { className: "sk-overview-actions" },
                        h("button", { type: "button", className: "sk-btn", onClick: acceptTask, "aria-disabled": accepted || acceptBusy,
                          "aria-busy": acceptBusy || undefined }, accepted ? "已人工验收" : acceptBusy ? "正在确认…" : "验收通过")) : null),
                    aiInfo
                      ? h(
                          "details",
                          { className: "sk-ai-review" },
                          h(
                            "summary",
                            { className: "sk-ai-review-head" },
                            h(Icon, { name: "chevron", size: 12, className: "sk-ai-review-chevron" }),
                            h("span", { className: "sk-ai-review-title" }, analyzeBusy ? "重新研判中…" : aiInfo.engine === "llm" ? "AI 研判" : "规则推断"),
                            aiModelText
                              ? h("span", { className: "sk-ai-review-meta sk-ai-review-model", title: aiModelText }, aiModelText)
                              : null,
                            aiInfo.engine === "llm" && aiInfo.confidence !== null ? h("span", { className: "sk-ai-review-meta" }, `${aiInfo.confidence}%`) : null,
                            aiInfo.analyzedAt ? h("span", { className: "sk-ai-review-meta" }, relTime(aiInfo.analyzedAt)) : null,
                            aiStale ? h("span", { className: "sk-ai-review-stale" }, "可能已过期") : null,
                          ),
                          h("p", { className: "sk-ai-review-reason is-open" }, aiInfo.reason || "本次未给出研判理由"),
                        )
                      : null,
                  ),
              staleNotice
                ? h("div", { className: "sk-inline-note", role: "status", "aria-live": "polite" }, "后台已更新，当前草稿已保留。", h("button", { type: "button", className: "sk-text", onClick: rebaseDraft }, "保留修改并同步"))
                : null,
            ),
            h(
              "div",
              { className: "sk-drawer-sec" },
              h(
                "div",
                { className: "sk-drawer-sec-head" },
                h("span", { className: "sk-drawer-sec-title" }, "关键事实"),
                h("span", { className: "sk-grow" }),
                facts.length > 3 ? h("button", { type: "button", className: "sk-text", onClick: () => setFactsExpanded((value) => !value) }, factsExpanded ? "收起" : `展开全部 ${facts.length} 条`) : null,
              ),
              facts.length
                ? h(
                    "div",
                    { className: "sk-facts" },
                    (factsExpanded ? facts : facts.slice(0, 3)).map((fact) => {
                      const meta = factMeta(fact.kind);
                      const tone =
                        fact.kind === "progress"
                          ? "var(--sk-brand-accent)"
                          : fact.kind === "issue"
                            ? "var(--dsw-alias-state-warn-primary,#f59e0b)"
                            : fact.kind === "artifact"
                              ? "color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 80%,transparent)"
                              : "color-mix(in srgb,var(--sk-ink) 45%,transparent)";
                      return h(
                        "div",
                        { key: fact.id, className: "sk-fact" },
                        h("span", { className: "sk-fact-icon", style: { "--fact-tone": tone } }, h(Icon, { name: meta.icon, size: 14 })),
                        h("span", { className: "sk-fact-text" }, fact.text),
                      );
                    }),
                  )
                : h("div", { className: "sk-note-tiny" }, "暂无关键事实"),
            ),
            h(TaskIssues, { task, run, openSourceSession }),
            h(
              "div",
              { className: "sk-drawer-sec" },
              h(
                "div",
                { className: "sk-drawer-sec-head" },
                h("span", { className: "sk-drawer-sec-title" }, "子任务"),
                subtasks.length ? h("span", { className: "sk-note-tiny" }, `${subtaskDone}/${subtasks.length}`) : null,
                h("span", { className: "sk-grow" }),
                h("button", { type: "button", className: "sk-text", onClick: importTodos, disabled: subtaskBusy === "import" || !session.sessionId }, subtaskBusy === "import" ? "导入中…" : "从会话导入待办"),
              ),
              subtasks.length
                ? h(
                    "div",
                    { className: "sk-subtasks" },
                    subtaskRows,
                    subtasks.length > 8
                      ? h("button", { type: "button", className: "sk-text", style: { alignSelf: "flex-start", paddingTop: 4 }, onClick: () => setSubtasksExpanded((value) => !value) }, subtasksExpanded ? "收起" : `展开全部 ${subtasks.length} 项`)
                      : null,
                  )
                : h("div", { className: "sk-note-tiny" }, "暂无子任务"),
              h(
                "div",
                { className: "sk-subtask-add" },
                h("input", {
                  className: "sk-input",
                  "aria-label": "新增子任务",
                  value: newSubtask,
                  maxLength: TEXT_LIMITS.subtaskText,
                  placeholder: "新增子任务…",
                  onChange: (event) => setNewSubtask(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" && !event.isComposing && subtaskBusy !== "add") addSubtask();
                  },
                }),
                h("button", { type: "button", className: "sk-text", onClick: addSubtask, disabled: !newSubtask.trim() || subtaskBusy === "add" }, "添加"),
              ),
            ),
            nextSteps.length
              ? h("details", { className: "sk-drawer-sec sk-relation-editor" },
                  h("summary", null, `建议下一步 · ${nextSteps.length} 项`),
                  h("ul", { className: "sk-overview-steps" },
                    nextSteps.map((step, index) => h("li", { key: index }, step))))
              : null,
            h(
              "div",
              { className: "sk-drawer-sec" },
              h(
                "div",
                { className: "sk-drawer-sec-head" },
                h("span", { className: "sk-drawer-sec-title" }, "会话"),
                h("span", { className: "sk-grow" }),
                h("button", { type: "button", className: "sk-text sk-link-text", onClick: openSession, disabled: !session.sessionId }, "打开"),
              ),
              h(
                "div",
                { className: "sk-session-line" },
                h(Icon, { name: "chat", size: 14, className: "sk-session-icon" }),
                h("span", { className: cx("sk-live-dot", !session.isLive && "off") }),
                h("span", { className: "sk-session-title", title: session.title }, session.title || "未关联会话"),
              ),
              h(
                "div",
                { className: "sk-session-meta" },
                h("span", null, session.isLive ? "会话运行中" : session.lastTurnEnd === "error" ? "会话出错" : session.lastTurnEnd === "interrupted" ? "会话中断" : session.sessionId ? "会话空闲" : "未关联"),
                session.turnCount ? h("span", null, `第 ${session.turnCount} 轮`) : null,
                session.todoTotal ? h("span", null, `待办 ${session.todoDone}/${session.todoTotal}`) : null,
                goal && goal.text ? h("span", null, "目标：" + clip(goal.text, 48)) : null,
              ),
            ),
            h(TaskLinks, { task, tasks, host, run, onOpenTask, pushToast }),
            otherArtifacts.length
              ? h(
                  "details",
                  { className: "sk-drawer-sec" },
                  h("summary", { className: "sk-drawer-sec-title" }, `${primaryArtifact ? "其他文件" : "产物记录"} · ${otherArtifacts.length} 项`),
                  h("div", { className: "sk-artifacts" }, otherArtifacts.map(artifactButton)),
                )
              : null,
            evidence.length
              ? h(
                  "div",
                  { className: "sk-fold" },
                  h("button", { type: "button", className: "sk-fold-head", "aria-expanded": evidenceOpen, onClick: () => setEvidenceOpen((value) => !value) }, h(Icon, { name: evidenceOpen ? "chevronDown" : "chevron", size: 12 }), "活动与证据", h("span", { className: "sk-fold-count" }, `${evidence.length} 条`)),
                  evidenceOpen
                    ? h(
                        "div",
                        { className: "sk-evidence" },
                        evidenceSources.size > 1 ? h("select", { className: "sk-select", "aria-label": "按来源会话筛选证据", value: evidenceScope, onChange: (event) => setEvidenceSession(event.target.value) },
                          h("option", { value: "" }, "全部来源"),
                          [...evidenceSources].map(([id, title]) => h("option", { key: id, value: id }, title))) : null,
                        visibleEvidence.map((item, index) => {
                          const key = item.id || String(index);
                          const meta = KIND_META[item.kind] || KIND_META.assistant;
                          const text = item.quote || item.text || "";
                          const open = !!expandedEvidence[key];
                          return h(
                            "div",
                            { key, className: "sk-ev" },
                            h("div", { className: "sk-ev-icon" }, h(Icon, { name: meta.icon, size: 12 })),
                            h(
                              "div",
                              { className: "sk-ev-body" },
                              h(
                                "div",
                                { className: "sk-ev-meta" },
                                h("span", { className: "kind" }, meta.label),
                                item.time ? h("span", null, shortTime(item.time)) : null,
                                seqOf(item.seq) ? h("span", null, "#" + seqOf(item.seq)) : null,
                                item.sessionId ? h("button", { className: "sk-text", type: "button", onClick: () => openSourceSession(item.sessionId) }, "打开来源会话") : null,
                              ),
                              h("p", { className: cx("sk-ev-quote", open && "open") }, text),
                              text.length > 140 ? h("button", { type: "button", className: "sk-ev-more", onClick: () => setExpandedEvidence((value) => ({ ...value, [key]: !open })) }, open ? "收起" : "展开全文") : null,
                            ),
                          );
                        }),
                      )
                    : null,
                )
              : null,
            history.length
              ? h(
                  "div",
                  { className: "sk-fold" },
                  h("button", { type: "button", className: "sk-fold-head", onClick: () => setHistoryOpen((value) => !value) }, h(Icon, { name: historyOpen ? "chevronDown" : "chevron", size: 12 }), "历史", h("span", { className: "sk-fold-count" }, `${history.length} 条`)),
                  historyOpen
                    ? h("div", { className: "sk-hist" }, history.map((entry, index) => h("div", { key: index }, h("span", null, relTimeValue(entry.at)), h("span", null, entry.by === "ai" ? "AI" : "手动", " · ", entry.note || entry.kind || ""))))
                    : null,
                )
              : null,
          ),
          h(
            "footer",
            { className: "sk-drawer-foot" },
            editing
              ? h(
                  React.Fragment,
                  null,
                  h("button", { type: "button", className: "sk-btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
                  h("button", { type: "button", className: "sk-btn ghost", onClick: () => { resetDraft(); setEditing(false); } }, "取消"),
                )
              : h(
                  React.Fragment,
                  null,
                  h("button", { type: "button", className: "sk-btn primary", onClick: () => startContinue("session", ready ? "verify" : task.status === "blocked" ? "unblock" : "continue") }, ready ? "验收产出" : "继续此任务"),
                  h("button", { type: "button", className: "sk-btn ghost", onClick: openSession, disabled: !session.sessionId }, "打开会话"),
                  h("span", { className: "sk-grow" }),
                  h(QuickMenuButton, { label: "更多继续操作", expanded: Boolean(footerAnchor), onOpen: setFooterAnchor }),
                  footerAnchor ? h(QuickMenu, { anchor: footerAnchor, label: "更多继续操作", items: footerMenuItems, onClose: () => setFooterAnchor(null) }) : null,
                ),
          ),
          continueOpen
            ? h(ContinueTaskModal, {
                task,
                initialTarget: continueTarget,
                initialPurpose: continuePurpose,
                initialSessionId: continuePurpose === "verify" ? primaryArtifact?.sessionId : undefined,
                ctxProps,
                workspaces,
                pushToast,
                onDone: onClose,
                onClose: () => setContinueOpen(false),
              })
            : null,
        ),
      );
    }
    /* ============================== overlays ============================== */

    function NewTaskModal({ defaultStatus, workspaces, sessionId, onClose, onCreate, pushToast }) {
      const [title, setTitle] = React.useState("");
      const [goal, setGoal] = React.useState("");
      const [acceptanceCriteria, setAcceptanceCriteria] = React.useState("");
      const [status, setStatus] = React.useState(defaultStatus || "backlog");
      const [priority, setPriority] = React.useState("P2");
      const [workspaceId, setWorkspaceId] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      const inputRef = React.useRef(null);
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();

      const create = async () => {
        if (!title.trim()) return;
        setSaving(true);
        try {
          await command("task.create", { title: title.trim(), goal: goal.trim(), acceptanceCriteria: acceptanceCriteria.trim(), status, priority, workspaceId: workspaceId || undefined, sessionId: sessionId || undefined });
          pushToast("任务已创建", "info");
          await onCreate();
        } catch (cause) {
          pushToast(`创建失败：${cause.message}`, "error");
        } finally {
          setSaving(false);
        }
      };

      return h(
        "div",
        { className: "sk-modal-mask", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          "div",
          {
            className: "sk-modal",
            ref: dialogRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "sk-newtask-title",
          },
          h("h3", { id: "sk-newtask-title" }, h(Icon, { name: "plus", size: 15 }), "新建任务"),
          h(
            "div",
            { className: "sk-modal-body" },
            h("p", { className: "sub" }, "手动任务不会被自动扫描修改，可稍后从来源会话补充上下文。"),
            h(
              "div",
              { className: "sk-field" },
              h("label", { htmlFor: "sk-newtask-title-input" }, "标题"),
              h("input", { ref: inputRef, id: "sk-newtask-title-input", className: "sk-input", value: title, maxLength: TEXT_LIMITS.title, placeholder: "要做什么？", onChange: (event) => setTitle(event.target.value), onKeyDown: (event) => event.key === "Enter" && !event.isComposing && !saving && create() }),
            ),
            h(
              "div",
              { className: "sk-field" },
              h("label", { htmlFor: "sk-newtask-goal-input" }, "目标 / 说明（可选）"),
              h("textarea", { id: "sk-newtask-goal-input", className: "sk-textarea", value: goal, maxLength: TEXT_LIMITS.goal, rows: 2, placeholder: "这项任务要实现什么？", onChange: (event) => setGoal(event.target.value) }),
            ),
            h("label", { className: "sk-field" }, "验收条件（可选）",
              h("textarea", { className: "sk-textarea", value: acceptanceCriteria, maxLength: TEXT_LIMITS.acceptanceCriteria, rows: 2,
                placeholder: "写下可检查的结果或验证步骤", onChange: (event) => setAcceptanceCriteria(event.target.value) })),
            h(
              "div",
              { className: "sk-field" },
              h("span", { className: "sk-field-label", id: "sk-newtask-status-label" }, "状态"),
              h(
                "div",
                { className: "sk-seg", role: "group", "aria-labelledby": "sk-newtask-status-label" },
                STATUS_ORDER.map((item) =>
                  h(
                    "button",
                    { key: item, type: "button", "aria-pressed": status === item, className: status === item ? "on" : "", style: { "--tone": STATUS_META[item].tone }, onClick: () => setStatus(item) },
                    STATUS_META[item].label,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "sk-row2" },
              h(
                "div",
                { className: "sk-field" },
                h("span", { className: "sk-field-label", id: "sk-newtask-priority-label" }, "优先级"),
                h(
                  "div",
                  { className: "sk-seg", role: "group", "aria-labelledby": "sk-newtask-priority-label" },
                  PRIORITY_ORDER.map((item) =>
                    h(
                      "button",
                      { key: item, type: "button", "aria-pressed": priority === item, className: priority === item ? "on" : "", style: { "--tone": PRIORITY_META[item].tone }, onClick: () => setPriority(item) },
                      item,
                    ),
                  ),
                ),
              ),
              h(
                "div",
                { className: "sk-field" },
                h("label", { htmlFor: "sk-newtask-workspace" }, "工作区（可选）"),
                h(
                  "select",
                  { id: "sk-newtask-workspace", className: "sk-select", style: { width: "100%", padding: "7px 10px" }, value: workspaceId, onChange: (event) => setWorkspaceId(event.target.value) },
                  h("option", { value: "" }, "不指定"),
                  (workspaces || []).map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)),
                ),
              ),
            ),
          ),
          h(
            "div",
            { className: "sk-modal-foot" },
            h("button", { type: "button", className: "sk-btn ghost", onClick: onClose }, "取消"),
            h("button", { type: "button", className: "sk-btn primary", onClick: create, disabled: !title.trim() || saving }, saving ? "创建中…" : "创建任务"),
          ),
        ),
      );
    }

    /**
     * 设置弹窗「AI 研判模型」全宽 block：原生 select + optgroup（零依赖、键盘/读屏/420px 原生可用）。
     * 模型目录只读 DSH；第三方模型与凭证在「DSH 设置 → 模型」配置，看板不保存凭证。
     */
    function AiModelBlock({ draft, set, catalog }) {
      const data = catalog.data;
      const models = (data && data.models) || [];
      const groups = (data && data.groups) || [];
      const current = aiModelRef(draft);
      const found = current
        ? models.some((item) => item.provider === current.provider && item.id === current.model)
        : true;
      const busy = catalog.status === "loading" || catalog.status === "refreshing";
      // 刷新期间不 disabled（disabled 会让焦点掉出弹窗），用 aria-busy + 内部去重防重复请求。
      const refreshDisabled = catalog.status === "loading";
      const disabled = catalog.status === "loading";
      const note = catalogNote(catalog, current);
      const effectiveProvider = current ? current.provider : data && data.default ? data.default.provider : "";
      const thirdParty = isThirdPartyProvider(effectiveProvider);
      const guideText = thirdParty
        ? `AI 请求会发给「${providerLabel(effectiveProvider)}」模型服务商。模型与凭证在「DSH 设置 → 模型」中管理。`
        : "第三方模型与 API Key 在「DSH 设置 → 模型」中配置；看板只读取已配置的模型，不保存凭证。";

      const options = [h("option", { key: "follow", value: "" }, "跟随 DSH 默认")];
      if (current && !found) {
        options.push(
          h(
            "optgroup",
            { key: "saved", label: "已保存" },
            h("option", { value: aiModelValue(current) }, `${modelLabel(current.provider, current.model)}（目录中未找到）`),
          ),
        );
      }
      for (const group of groups) {
        options.push(
          h(
            "optgroup",
            { key: group.provider.id, label: group.provider.name || group.provider.id },
            group.models.map((model) =>
              h(
                "option",
                { key: group.provider.id + "\u0000" + model.id, value: aiModelValue({ provider: group.provider.id, model: model.id }) },
                model.name || model.id,
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "sk-settings-block" },
        h(
          "div",
          { className: "sk-settings-block-head" },
          h(
            "div",
            { className: "label", id: "sk-ai-model-label" },
            h("b", null, "AI 研判模型"),
            h("span", null, "默认跟随 DSH 的默认模型；也可以指定一个已在 DSH 中配置的模型"),
          ),
          catalog.status === "unavailable"
            ? null
            : h(
                "button",
                {
                  type: "button",
                  className: cx("sk-iconbtn-v3 sk-model-refresh", catalog.status === "refreshing" && "is-busy"),
                  title: "刷新模型目录",
                  "aria-label": "刷新模型目录",
                  "aria-busy": busy ? "true" : undefined,
                  disabled: refreshDisabled,
                  onClick: catalog.refresh,
                },
                h(Icon, { name: "refresh", size: 14 }),
              ),
        ),
        h(
          "div",
          { className: "sk-settings-controls" },
          h(
            "select",
            {
              id: "sk-ai-model",
              className: "sk-select sk-model-select",
              "aria-labelledby": "sk-ai-model-label",
              "aria-describedby": "sk-ai-model-desc sk-ai-model-guide sk-ai-model-status",
              title: current ? modelLabel(current.provider, current.model) : "跟随 DSH 默认",
              value: aiModelValue(current),
              disabled,
              onChange: (event) => {
                const next = parseAiModelValue(event.target.value);
                // 一次 set 两个字段，避免出现「只有 provider / 只有 model」的混合态。
                set(next ? { aiProvider: next.provider, aiModel: next.model } : { aiProvider: "", aiModel: "" });
              },
            },
            options,
          ),
        ),
        h(
          "p",
          { id: "sk-ai-model-desc", className: cx("sk-catalog-note", note.warn && "is-warn") },
          note.text,
          // S2：文本按钮之间加可见分隔符，避免读屏/复制时连成「…改为跟随默认重试」。
          note.followDefault
            ? h(
                React.Fragment,
                null,
                h("span", { className: "sk-catalog-sep", "aria-hidden": "true" }, " · "),
                h("button", { type: "button", className: "sk-text", onClick: () => set({ aiProvider: "", aiModel: "" }) }, "改为跟随默认"),
              )
            : null,
          note.retry
            ? h(
                React.Fragment,
                null,
                h("span", { className: "sk-catalog-sep", "aria-hidden": "true" }, " · "),
                h("button", { type: "button", className: "sk-text", onClick: catalog.refresh }, "重试"),
              )
            : null,
        ),
        h("p", { id: "sk-ai-model-guide", className: cx("sk-catalog-note", thirdParty && "is-warn") }, guideText),
        h(
          "span",
          { id: "sk-ai-model-status", role: "status", "aria-live": "polite", className: "sk-sr-only" },
          catalog.announce || "",
        ),
      );
    }

    function SettingsModal({ settings, workspaces, prefs, usage, onPrefsChange, onClose, onSave, onScan, pushToast }) {
      const [draft, setDraft] = React.useState(() => {
        // aiProvider / aiModel 必须成对：任一为空都归一为「跟随 DSH 默认」。
        const savedModel = aiModelRef(settings);
        return {
          aiEnabled: settings.aiEnabled !== false,
          autoScan: settings.autoScan !== false,
          scanIntervalSeconds: settings.scanIntervalSeconds || 120,
          initialDays: settings.initialDays || 30,
          aiProvider: savedModel ? savedModel.provider : "",
          aiModel: savedModel ? savedModel.model : "",
          // 新字段一律用 ?? 初始化（禁止 || 回退，否则 0 / "auto" 会被误判）。
          aiBudgetMode: settings.aiBudgetMode ?? AI_BUDGET_MODE_DEFAULT,
          maxAiCallsPerScan: settings.maxAiCallsPerScan ?? AI_MAX_CALLS_DEFAULT,
          dailyAiCallLimit: settings.dailyAiCallLimit || 150,
          excludeWorkspaces: Array.isArray(settings.excludeWorkspaces) ? settings.excludeWorkspaces.slice() : [],
        };
      });
      const [saving, setSaving] = React.useState(false);
      // 入口偏好先暂存，取消不会写入；只有「保存设置」才真正落盘（需要刷新窗口生效）。
      const [entryDraft, setEntryDraft] = React.useState(() => prefsMode(prefs));
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();
      // 模型目录只在弹窗打开时拉取；30s 内重开先用缓存渲染再后台刷新。
      const catalog = useAiCatalog();
      const set = (patch) => setDraft((value) => ({ ...value, ...patch }));
      const dailyLimit = Number(draft.dailyAiCallLimit) || 150;
      const dailyRemaining = usage ? Math.max(0, dailyLimit - usage.calls) : 0;
      // S1：禁止 || 回退（0 / 空串会被误判）；Host 钳制 5–150，非法值才用默认。
      const fixedLimitValue = Number(draft.maxAiCallsPerScan);
      const fixedLimit = Number.isFinite(fixedLimitValue) ? fixedLimitValue : AI_MAX_CALLS_DEFAULT;
      const entryMode = entryDraft;
      const chooseEntry = (mode) => setEntryDraft(mode);
      const toggleWorkspace = (id) => {
        setDraft((value) => {
          const set = new Set(value.excludeWorkspaces);
          if (set.has(id)) set.delete(id);
          else set.add(id);
          return { ...value, excludeWorkspaces: [...set] };
        });
      };
      const save = async () => {
        setSaving(true);
        try {
          await command("settings.update", { patch: draft });
          const entryChanged = entryDraft !== prefsMode(prefs);
          if (entryChanged) onPrefsChange(modePrefs(entryDraft));
          pushToast(entryChanged ? "设置已保存；入口偏好需刷新窗口（Cmd+R）生效" : "设置已保存（模型与预算在下次扫描或重新研判时生效）", "info");
          await onSave();
        } catch (cause) {
          pushToast(`保存失败：${cause.message}`, "error");
        } finally {
          setSaving(false);
        }
      };
      const exportJson = async () => {
        try {
          await downloadExport();
          pushToast("已导出 JSON", "info");
        } catch (cause) {
          pushToast(`导出失败：${cause.message}`, "error");
        }
      };
      return h(
        "div",
        { className: "sk-modal-mask", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          "div",
          {
            className: "sk-modal",
            ref: dialogRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "sk-settings-title",
          },
          h("h3", { id: "sk-settings-title" }, h(Icon, { name: "settings", size: 15 }), "看板设置"),
          h(
            "div",
            { className: "sk-modal-body" },
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "AI 联网研判"), h("span", null, "使用 DSH 配置的模型（含第三方）分析会话摘要；关闭后仅用本地规则推断")),
              h("button", { type: "button", className: cx("sk-switch", draft.aiEnabled && "on"), onClick: () => set({ aiEnabled: !draft.aiEnabled }), "aria-label": "AI 联网研判", role: "switch", "aria-checked": draft.aiEnabled }, h("i")),
            ),
            h(AiModelBlock, { draft, set, catalog }),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "自动扫描"), h("span", null, "按间隔增量扫描有变化的会话")),
              h("button", { type: "button", className: cx("sk-switch", draft.autoScan && "on"), onClick: () => set({ autoScan: !draft.autoScan }), "aria-label": "自动扫描", role: "switch", "aria-checked": draft.autoScan }, h("i")),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "扫描间隔"), h("span", null, "没有新对话时开销极小")),
              h(
                "select",
                { className: "sk-select", "aria-label": "扫描间隔", value: draft.scanIntervalSeconds, onChange: (event) => set({ scanIntervalSeconds: Number(event.target.value) }) },
                [60, 120, 300, 600].map((seconds) => h("option", { key: seconds, value: seconds }, seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`)),
              ),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "初始扫描范围"), h("span", null, "首次纳入最近多少天的会话")),
              h(
                "select",
                { className: "sk-select", "aria-label": "初始扫描范围", value: draft.initialDays, onChange: (event) => set({ initialDays: Number(event.target.value) }) },
                [7, 14, 30, 90].map((days) => h("option", { key: days, value: days }, `最近 ${days} 天`)),
              ),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h(
                "div",
                { className: "label" },
                h("b", null, "AI 预算 · 单次扫描上限"),
                h(
                  "span",
                  null,
                  isAutoBudgetMode(draft.aiBudgetMode)
                    ? "自动使用当日剩余额度，单次最多约 10 分钟；超出后剩余会话下次扫描继续"
                    : "超出后本次其余会话用规则卡，下次扫描继续研判",
                ),
              ),
              h(
                "select",
                {
                  className: "sk-select",
                  "aria-label": "单次扫描 AI 调用上限",
                  // 单个下拉、内部两个字段：auto 只改 aiBudgetMode（保留数字），固定档同时写数字。
                  value: isAutoBudgetMode(draft.aiBudgetMode) ? "auto" : String(draft.maxAiCallsPerScan),
                  onChange: (event) => {
                    if (event.target.value === "auto") set({ aiBudgetMode: "auto" });
                    else set({ aiBudgetMode: "fixed", maxAiCallsPerScan: Number(event.target.value) });
                  },
                },
                h("option", { key: "auto", value: "auto" }, "自动（推荐）"),
                withAiCallOptions(draft.maxAiCallsPerScan).map((value) => h("option", { key: String(value), value: String(value) }, `固定 ${value} 次`)),
              ),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "AI 预算 · 每日上限"), h("span", null, "每日 AI 研判上限，用完后当日仅规则推断；按本机日历日 0 点重置")),
              h(
                "select",
                { className: "sk-select", "aria-label": "每日 AI 调用上限", value: draft.dailyAiCallLimit, onChange: (event) => set({ dailyAiCallLimit: Number(event.target.value) }) },
                // I3：当前值不在标准档位时补「N 次（当前值）」，避免自定义 10–500 被静默显示成 50。
                withDailyAiCallOptions(draft.dailyAiCallLimit).map((value) =>
                  h(
                    "option",
                    { key: value, value },
                    DAILY_AI_CALL_OPTIONS.includes(value) ? `${value} 次` : `${value} 次（当前值）`,
                  ),
                ),
              ),
            ),
            usage
              ? h(
                  "div",
                  { className: "sk-usage" },
                  h(
                    "div",
                    { className: "sk-usage-row" },
                    h("span", null, "今日 AI 调用 ", h("b", null, usage.calls), " / ", h("b", null, dailyLimit), " 次"),
                    h("span", { className: "sk-usage-rest" }, "剩余 ", h("b", null, dailyRemaining), " 次"),
                    h("span", null, "tokens ", h("b", null, fmtTokens(usage.tokens))),
                  ),
                  h(
                    "div",
                    { className: "sk-usage-row" },
                    h("span", null, "上次扫描：", h("b", null, usage.lastScan.calls), " 次调用 · ", h("b", null, fmtTokens(usage.lastScan.tokens)), " tokens · ", h("b", null, fmtDuration(usage.lastScan.durationMs))),
                  ),
                  // 用量不足 / 耗尽只用安静的琥珀文字，不做彩色盒子或进度条。
                  dailyRemaining === 0
                    ? h("div", { className: "sk-usage-warn" }, "已达今日 AI 上限，剩余会话明日继续；可调高每日上限或等待 0 点重置。")
                    : isAutoBudgetMode(draft.aiBudgetMode)
                      ? h("div", { className: "sk-usage-note" }, `单次上限：自动（本次最多 ${dailyRemaining} 次，AI 阶段最多 10 分钟）`)
                      : dailyRemaining < fixedLimit
                        ? h("div", { className: "sk-usage-warn" }, `今日剩余仅 ${dailyRemaining} 次，本次最多 ${dailyRemaining} 次`)
                        : null,
                  h(
                    "p",
                    { className: "sk-usage-note" },
                    `每日上限按本机日历日 0 点重置（今日 ${usage.date || "今天"}）。首次全量扫描会话较多时可能需要几分钟；可随时取消，已完成部分会保留。`,
                  ),
                )
              : h("div", { className: "sk-usage" }, h("div", { className: "sk-usage-row" }, "今日用量：Host v2 就绪后显示")),
            h(
              "div",
              { className: "sk-field" },
              h("span", { className: "sk-field-label", id: "sk-settings-entry-label" }, "显示与入口"),
              h(
                "div",
                { className: "sk-entry-options", role: "group", "aria-labelledby": "sk-settings-entry-label" },
                [
                  { id: "both", label: "两者", desc: "左侧栏全页 + 会话右侧栏" },
                  { id: "page", label: "仅全局面板", desc: "只注册左侧栏「任务看板」" },
                  { id: "side", label: "仅会话右侧栏", desc: "只注册会话头部入口" },
                ].map((option) =>
                  h(
                    "button",
                    {
                      key: option.id,
                      type: "button",
                      "aria-pressed": entryMode === option.id,
                      className: cx("sk-entry-option", entryMode === option.id && "is-on"),
                      onClick: () => chooseEntry(option.id),
                    },
                    option.label,
                    h("small", null, option.desc),
                  ),
                ),
              ),
              h("p", { className: "sub", style: { margin: 0 } }, "修改后需刷新窗口（Cmd+R）生效；当前已注册的入口在本页保持不变。"),
            ),
            h(
              "div",
              { className: "sk-field" },
              h("span", { className: "sk-field-label", id: "sk-settings-exclude-label" }, "排除工作区"),
              h(
                "div",
                { className: "sk-ws-pick", role: "group", "aria-labelledby": "sk-settings-exclude-label" },
                (workspaces || []).map((workspace) =>
                  h(
                    "button",
                    {
                      key: workspace.id,
                      type: "button",
                      "aria-pressed": draft.excludeWorkspaces.includes(workspace.id),
                      className: cx("sk-chip", draft.excludeWorkspaces.includes(workspace.id) && "on"),
                      onClick: () => toggleWorkspace(workspace.id),
                      title: workspace.path,
                    },
                    draft.excludeWorkspaces.includes(workspace.id) ? "已排除 · " : "",
                    workspace.title,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "sk-inline-actions", style: { borderTop: "0.5px solid var(--dsw-alias-border-l1)", paddingTop: 11 } },
              h(
                "button",
                { type: "button", className: "sk-btn", title: "将按当前 AI 预算研判全部会话", onClick: () => onScan("full") },
                h(Icon, { name: "refresh", size: 12 }),
                "立即全量重扫",
              ),
              h("button", { type: "button", className: "sk-btn", onClick: exportJson }, h(Icon, { name: "file", size: 12 }), "导出 JSON"),
            ),
            h(
              "p",
              { className: "sub" },
              "看板数据保存在本机，模型和凭证由 DSH 管理。AI 研判发送压缩摘要及少量相关任务信息。点击「AI 润色」时会发送当前草稿。",
            ),
          ),
          h(
            "div",
            { className: "sk-modal-foot" },
            h("button", { type: "button", className: "sk-btn ghost", onClick: onClose }, "取消"),
            h("button", { type: "button", className: "sk-btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存设置"),
          ),
        ),
      );
    }

    /* ================================ page ================================ */

    const FILTERS_KEY = "dsh-super-kanban:filters";
    const EMPTY_FILTERS = { workspace: "", priority: "", source: "", tag: "", query: "", showArchived: false };

    function readFilters(surface) {
      try {
        const raw = localStorage.getItem(surface === "side" ? FILTERS_KEY + ":side" : FILTERS_KEY);
        if (!raw) return { ...EMPTY_FILTERS };
        const parsed = JSON.parse(raw);
        return {
          workspace: String(parsed.workspace || ""),
          priority: ["P0", "P1", "P2", "P3"].includes(parsed.priority) ? parsed.priority : "",
          source: ["ai", "manual"].includes(parsed.source) ? parsed.source : "",
          tag: String(parsed.tag || ""),
          query: String(parsed.query || ""),
          showArchived: parsed.showArchived === true,
        };
      } catch {
        return { ...EMPTY_FILTERS };
      }
    }

    function writeFilters(filters, surface) {
      try {
        localStorage.setItem(surface === "side" ? FILTERS_KEY + ":side" : FILTERS_KEY, JSON.stringify(filters));
      } catch {
        /* storage unavailable */
      }
    }

    function quickMenuAnchor(event, kind, trigger = event.currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      const rect = trigger.getBoundingClientRect();
      return kind === "context" && (event.clientX || event.clientY)
        ? { trigger, x: event.clientX, y: event.clientY, right: event.clientX, above: event.clientY }
        : { trigger, x: rect.left, y: rect.bottom + 4, right: rect.right, above: rect.top - 4 };
    }

    function quickMenuHandlers(open, findTrigger) {
      return {
        onContextMenu: (event) => open(quickMenuAnchor(event, "context", findTrigger(event))),
        onKeyDown: (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            open(quickMenuAnchor(event, "keyboard", findTrigger(event)));
          }
        },
      };
    }

    function QuickMenuButton({ label, expanded, onOpen }) {
      return h("button", {
        type: "button", className: "sk-iconbtn-v3 sk-quick-trigger", title: label, "aria-label": label,
        "aria-haspopup": "menu", "aria-expanded": expanded,
        onClick: (event) => {
          if (expanded) {
            event.stopPropagation();
            onOpen(null);
          } else onOpen(quickMenuAnchor(event, "button"));
        },
      }, h(Icon, { name: "more", size: 15 }));
    }

    function QuickMenu({ anchor, items, label, onClose }) {
      const menuRef = React.useRef(null);
      const dismiss = (returnFocus = false) => {
        if (returnFocus && anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true });
        onClose();
      };
      React.useLayoutEffect(() => {
        const node = menuRef.current;
        if (!node) return undefined;
        node.showPopover?.();
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        const scope = anchor.trigger.closest(".sk-drawer, .sk-page")?.getBoundingClientRect();
        const scopeLeft = Math.max(8, (scope?.left ?? 0) + 8);
        const scopeRight = Math.min(window.innerWidth, scope?.right ?? window.innerWidth) - width - 8;
        const right = scopeRight >= scopeLeft ? scopeRight : window.innerWidth - width - 8;
        const bottom = window.innerHeight - height - 8;
        const left = anchor.x > right ? Math.min(anchor.right - width, right) : anchor.x;
        const top = anchor.y > bottom ? Math.min(anchor.above - height, bottom) : anchor.y;
        node.style.left = `${Math.max(scopeRight >= scopeLeft ? scopeLeft : 8, left)}px`;
        node.style.top = `${Math.max(8, top)}px`;
        node.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
        return () => node.hidePopover?.();
      }, [anchor]);
      React.useEffect(() => {
        const outside = (event) => {
          if (!menuRef.current?.contains(event.target) && !anchor.trigger.contains(event.target)) dismiss();
        };
        const scroll = (event) => {
          if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) dismiss();
        };
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("scroll", scroll, true);
        window.addEventListener("resize", onClose);
        return () => {
          document.removeEventListener("pointerdown", outside, true);
          window.removeEventListener("scroll", scroll, true);
          window.removeEventListener("resize", onClose);
        };
      }, [anchor, onClose]);

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
          return;
        }
        if (event.key === "Tab") {
          event.stopPropagation();
          const dialog = anchor.trigger.closest('[aria-modal="true"]');
          if (!dialog) {
            dismiss(true);
            return;
          }
          event.preventDefault();
          const items = focusableIn(dialog);
          const index = items.indexOf(anchor.trigger);
          const direction = event.shiftKey ? -1 : 1;
          items[(index + direction + items.length) % items.length]?.focus();
          dismiss();
          return;
        }
        const buttons = [...menuRef.current.querySelectorAll("button:not([disabled])")];
        const current = buttons.indexOf(event.target);
        const target = {
          ArrowDown: (current + 1) % buttons.length,
          ArrowUp: (current + buttons.length - 1) % buttons.length,
          Home: 0,
          End: buttons.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        buttons[target]?.focus();
      };

      return h("div", { ref: menuRef, popover: "manual", className: "sk-menu sk-quick-menu", role: "menu", "aria-label": label, onKeyDown,
        onContextMenu: (event) => { event.preventDefault(); event.stopPropagation(); } },
        items.filter(Boolean).map((item, index) => item === "divider"
          ? h("div", { key: `divider${index}`, className: "sk-menu-sep", role: "separator" })
          : h("button", { key: item.id || item.label, type: "button", role: "menuitem", tabIndex: -1, disabled: item.disabled,
              className: cx("sk-menu-item", item.danger && "is-danger"), onClick: () => {
                if (!item.keepOpen) dismiss(true);
                item.run();
              } },
              item.icon ? h(Icon, { name: item.icon, size: 14 }) : null, item.label)));
    }

    async function copyWithToast(value, label, pushToast) {
      const ok = await copyToClipboard(value);
      pushToast(ok ? `${label}已复制` : "浏览器拦截了剪贴板，请手动复制", ok ? "info" : "error");
    }

    function taskHierarchy(tasks) {
      const present = new Set(tasks.map((task) => task.id));
      const children = new Map();
      const roots = [];
      for (const task of tasks) {
        const parentId = task.relations?.find((link) => link.type === "parent")?.taskId;
        if (present.has(parentId)) {
          if (!children.has(parentId)) children.set(parentId, []);
          children.get(parentId).push(task);
        } else {
          roots.push(task);
        }
      }
      const groups = new Map();
      const seen = new Set();
      for (const root of [...roots, ...tasks]) {
        if (seen.has(root.id)) continue;
        const workspaceId = root.workspaceId || "";
        if (!groups.has(workspaceId)) groups.set(workspaceId, { title: root.workspaceTitle || "未分组", rows: [] });
        const stack = [[root, 0]];
        while (stack.length) {
          const [task, depth] = stack.pop();
          if (seen.has(task.id)) continue;
          seen.add(task.id);
          groups.get(workspaceId).rows.push({ task, depth });
          for (const child of (children.get(task.id) || []).slice().reverse()) stack.push([child, depth + 1]);
        }
      }
      return groups;
    }

    function TaskCollection({ mode, tasks, signals, onOpen, taskActions, openSession, reload, pushToast, emptyText, onClear, clearLabel }) {
      const [checked, setChecked] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [priority, setPriority] = React.useState("");
      const sorted = React.useMemo(() => {
        if (mode !== "attention") return tasks.slice().sort(compareTasks);
        return tasks.filter((task) => signals.has(task.id))
          .sort((a, b) => signals.get(a.id).rank - signals.get(b.id).rank || compareTasks(a, b));
      }, [tasks, mode, signals]);
      const active = sorted.filter((task) => checked.includes(task.id)).map((task) => task.id);
      const batch = async (patch) => {
        setBusy(true);
        try {
          const result = await command("task.batch", { ids: active, ...patch });
          pushToast(`已更新 ${result.data.count} 项任务`, "info");
          setChecked([]);
          setPriority("");
          await reload(true);
        } catch (cause) {
          pushToast(cause.message, "error");
        } finally {
          setBusy(false);
        }
      };

      const row = (task, depth = 0) => {
        const signal = signals.get(task.id);
        const pending = mode === "attention" ? task.pendingSessions || [] : [];
        const summary = pending.length ? null : signal
          ? [signal.label, signal.text].filter(Boolean).join(" · ")
          : task.nextSteps?.[0] || goalInfoOf(task)?.text;
        return h("li", { key: task.id, className: cx("sk-task-row", pending.length > 0 && "has-session-actions"),
          style: { "--sk-depth": Math.min(depth, 5) }, ...taskActions.handlers(task) },
          mode === "list" ? h("input", {
            type: "checkbox", "aria-label": `选择 ${task.title}`, checked: checked.includes(task.id),
            disabled: busy || (active.length >= 200 && !checked.includes(task.id)),
            onChange: (event) => setChecked(event.target.checked ? [...checked, task.id] : checked.filter((id) => id !== task.id)),
          }) : null,
          h("button", { className: "sk-task-row-main", type: "button", "aria-haspopup": "dialog", onClick: () => onOpen(task.id) },
            h("span", { className: "sk-task-row-title" }, h("span", { className: cx("sk-dot", "is-" + statusOf(task)) }), task.title),
            summary ? h("span", { className: "sk-task-row-summary" }, summary) : null,
            h("span", { className: "sk-task-row-meta" },
              [mode === "hierarchy" ? "" : task.workspaceTitle, task.archived ? "已归档" : STATUS_META[statusOf(task)].label,
                taskRunningLabel(task), taskProgressLabel(task), task.priority,
                artifactsOf(task).length ? `${artifactsOf(task).length} 项产出` : ""].filter(Boolean).join(" · "))),
          taskActions.button(task),
          renderSessionActions(pending, openSession));
      };

      if (!sorted.length) return h("div", { className: "sk-empty-v3" },
        mode === "attention" && tasks.length ? "当前没有待处理事项" : emptyText,
        mode !== "attention" || !tasks.length ? h("button", { className: "sk-text", type: "button", onClick: onClear }, clearLabel) : null);
      if (mode === "hierarchy") {
        return h("div", { className: "sk-collection" }, [...taskHierarchy(sorted)].map(([workspaceId, { title, rows }]) =>
          h("details", { key: workspaceId, className: "sk-workspace-group", open: true },
            h("summary", null, title, h("span", null, rows.length)),
            h("ul", { className: "sk-task-list" }, rows.map(({ task, depth }) => row(task, depth))))));
      }
      return h("div", { className: "sk-collection" },
        mode === "list" ? h("div", { className: "sk-batchbar" },
          h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => setChecked(active.length ? [] : sorted.slice(0, 200).map((task) => task.id)) },
            active.length ? `取消选择 ${active.length} 项` : sorted.length > 200 ? "选择前 200 项" : "全选"),
          active.length ? h(React.Fragment, null,
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => batch({ archived: true }) }, "归档"),
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => batch({ archived: false }) }, "恢复"),
            h("select", { className: "sk-select", "aria-label": "批量优先级", value: priority, onChange: (event) => setPriority(event.target.value) },
              h("option", { value: "" }, "优先级"), PRIORITY_ORDER.map((value) => h("option", { key: value }, value))),
            h("button", { className: "sk-btn", type: "button", disabled: busy || !priority, onClick: () => batch({ priority }) }, "应用")) : null) : null,
        h("ul", { className: "sk-task-list" }, sorted.map((task) => row(task))));
    }

    function ArtifactEntry({ artifact, task, host, desktopFiles, pushToast, onPreview, details }) {
      const [anchor, setAnchor] = React.useState(null);
      const triggerRef = React.useRef(null);
      const fullPath = [artifact.absPath, artifact.path].find(isHostAbsolutePath);
      const primarySession = sessionContextOf(task).sessionId;
      const sessionId = artifact.sessionId || primarySession;
      const canPreview = !artifact.missing && Boolean(artifact.path && sessionId);
      const fileName = fileNameOf(fullPath || artifact.path) || artifact.name;
      const location = fullPath || artifact.path;
      const source = artifact.sessionId && artifact.sessionId !== primarySession
        ? task.sessions?.find((session) => session.id === artifact.sessionId)?.title : task.workspaceTitle;
      const tooltip = [source, location || fileName, artifact.missing ? "文件不可用" : ""].filter(Boolean).join("\n");
      const copy = (value, label) => () => copyWithToast(value, label, pushToast);
      const preview = async () => {
        if (await host.openResource?.(sessionId, artifact.path)) onPreview?.();
        else pushToast("当前环境无法打开文件预览", "error");
      };
      const native = async (action) => {
        if (!(await host.openNativeFile?.(fullPath || artifact.path, action, sessionId))) {
          pushToast(action === "reveal" ? "无法在文件管理器中定位该文件" : "无法用默认应用打开该文件", "error");
        }
      };
      const items = [
        { label: "在 DSH 中预览", icon: "file", disabled: !canPreview, run: preview },
        desktopFiles && (fullPath || canPreview) && { label: "用默认应用打开", icon: "arrow", disabled: artifact.missing, run: () => native("open") },
        desktopFiles && (fullPath || canPreview) && { label: "在文件管理器中显示", icon: "folder", disabled: artifact.missing, run: () => native("reveal") },
        "divider",
        { label: "复制文件名", icon: "copy", run: copy(fileName, "文件名") },
        location && { label: fullPath ? "复制完整路径" : "复制相对路径", icon: "copy", run: copy(location, "路径") },
      ];
      const pathLabel = artifact.path !== fileName ? artifact.path : "";
      const type = artifact.kind === "deliverable" ? "交付物" : artifact.kind === "modified" ? "修改文件" : "文件";
      return h("div", { className: "sk-artifact-entry", title: tooltip,
        ...quickMenuHandlers(setAnchor, (event) => event.target.closest?.("button:not([disabled])") || triggerRef.current.querySelector(".sk-quick-trigger")),
        ref: triggerRef },
        h("button", { type: "button", className: "sk-artifact", disabled: !canPreview, onClick: preview },
          h(Icon, { name: "file", size: 15, className: "sk-artifact-icon" }),
          h("span", { className: "sk-artifact-text" },
            h("span", { className: "sk-artifact-name" }, artifact.name),
            h("span", { className: "sk-artifact-path" }, [artifact.missing ? "文件不可用" : details ? type : "", pathLabel,
              details && artifact.time ? relTime(artifact.time) : ""].filter(Boolean).join(" · ")))),
        h(QuickMenuButton, { label: `文件操作：${artifact.name}`, expanded: Boolean(anchor), onOpen: setAnchor }),
        anchor ? h(QuickMenu, { anchor, items, label: `文件操作：${artifact.name}`, onClose: () => setAnchor(null) }) : null);
    }

    function ArtifactsView({ tasks, host, desktopFiles, pushToast, onOpen }) {
      const items = tasks.flatMap((task) => artifactsOf(task).map((artifact) => ({ task, artifact })))
        .sort((a, b) => Number(b.artifact.kind === "deliverable") - Number(a.artifact.kind === "deliverable") || b.artifact.time - a.artifact.time);
      if (!items.length) return h("div", { className: "sk-empty-v3" }, "当前范围没有产出");
      return h("div", { className: "sk-collection" }, h("ul", { className: "sk-task-list" }, items.map(({ task, artifact }) =>
        h("li", { className: "sk-task-row sk-artifact-row", key: `${task.id}:${artifact.id}` },
          h(ArtifactEntry, { artifact, task, host, desktopFiles, pushToast, details: true }),
          h("button", { className: "sk-btn", type: "button", onClick: () => onOpen(task.id) }, "来源任务")))));
    }

    function MaintenanceView({ data, reload, pushToast, startScan }) {
      const maintenance = data.maintenance || {};
      const [busy, setBusy] = React.useState(false);
      const [backup, setBackup] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const run = async (action, message) => {
        setBusy(true);
        try {
          await action();
          if (message) pushToast(message, "info");
          await reload(true);
        } catch (cause) {
          pushToast(cause.message, "error");
        } finally {
          setBusy(false);
        }
      };
      const previewBackup = async (file) => {
        setBackup(null);
        setPreview(null);
        if (!file) return;
        await run(async () => {
          if (file.size > 15 * 1024 * 1024) throw new Error("备份文件超过 15 MiB，请先缩小备份范围");
          const parsed = JSON.parse(await file.text());
          const result = await command("backup.preview", { backup: parsed });
          setBackup(parsed);
          setPreview({ ...result.data, filename: file.name });
        });
      };

      return h("div", { className: "sk-collection sk-maintenance" },
        h("section", { className: "sk-management-card" },
          h("h3", null, "扫描与存储"),
          h("p", null, data.scan?.message || "尚未扫描", maintenance.parseFailures ? ` · ${maintenance.parseFailures} 个会话读取失败` : ""),
          h("p", null, data.storage?.writable === false ? "存储暂不可写" : "存储可用",
            data.storage?.savedAt ? ` · 最近保存 ${relTimeValue(data.storage.savedAt)}` : ""),
          h("div", { className: "sk-batchbar" },
            h("button", { className: "sk-btn", type: "button", onClick: () => startScan("full"), disabled: data.scan?.state === "running" }, "全量重扫"),
            data.storage?.writable === false ? h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(() => command("storage.retry"), "看板已保存") }, "重试保存") : null,
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(downloadExport, "已导出看板备份") }, "导出备份")),
          h("label", { className: "sk-field" }, "选择备份以预览",
            h("input", { type: "file", accept: ".json,application/json", disabled: busy,
              onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ""; previewBackup(file); } })),
          preview ? h("div", { className: "sk-board-notice" },
            h("span", null, `${preview.filename} · 将以 ${preview.incoming} 项替换当前 ${preview.current} 项`),
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(async () => {
              await command("backup.restore", { backup, expectedSavedAt: preview.expectedSavedAt, backupHash: preview.backupHash });
              setBackup(null);
              setPreview(null);
            }, "备份已恢复，已保留恢复前的快照") }, "确认恢复"),
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => { setBackup(null); setPreview(null); } }, "取消")) : null),
        h("section", { className: "sk-management-card" },
          h("h3", null, "回收站与合并记录"),
          (maintenance.recovery || []).length ? maintenance.recovery.slice().reverse().map((entry) =>
            h("div", { className: "sk-management-row", key: entry.id },
              h("span", null, entry.title),
              h("button", { type: "button", className: "sk-btn", disabled: busy,
                onClick: () => run(() => command("task.restore", { id: entry.id }), "任务已恢复"),
              }, entry.kind === "merge" ? "撤销合并" : "恢复"))) : h("p", null, "暂无可恢复任务")),
        h("section", { className: "sk-management-card" },
          h("h3", null, "忽略的会话"),
          (maintenance.ignoredSessions || []).length ? maintenance.ignoredSessions.map((entry) =>
            h("div", { className: "sk-management-row", key: entry.id },
              h("span", null, entry.title),
              h("button", { className: "sk-btn", type: "button", disabled: busy,
                onClick: () => run(() => command("session.unignore", { sessionId: entry.id }), "已恢复扫描"),
              }, "恢复扫描"))) : h("p", null, "暂无忽略会话")));
    }

    function BoardPage(props) {
      const ctxProps = props || {};
      const surface = ctxProps.surface === "side" ? "side" : "page";
      const host = ctxProps.host || {};
      const [prefs, setPrefs] = React.useState(readPrefs);
      const rootRef = React.useRef(null);
      const observerRef = React.useRef(null);
      const [rootWidth, setRootWidth] = React.useState(0);
      const [sideStatus, setSideStatus] = React.useState("in_progress");

      // Measure the pane itself, including sidebar drags that do not resize the window.
      React.useEffect(() => {
        if (typeof ResizeObserver === "function") return undefined;
        const measure = () => {
          const node = rootRef.current;
          if (!node) return;
          const width = node.clientWidth || 0;
          setRootWidth((current) => (current === width ? current : width));
        };
        measure();
        window.addEventListener("resize", measure);
        return () => {
          window.removeEventListener("resize", measure);
        };
      }, []);

      const attachRoot = React.useCallback((node) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        rootRef.current = node;
        if (!node) return;
        const measure = () => setRootWidth(node.clientWidth || 0);
        measure();
        if (typeof ResizeObserver === "function") {
          observerRef.current = new ResizeObserver(measure);
          observerRef.current.observe(node);
        }
      }, []);

      const tier = surface === "side" ? (rootWidth >= 980 ? "wide" : rootWidth >= 620 ? "medium" : "narrow")
        : rootWidth > 0 && rootWidth < 620 ? "narrow" : "wide";
      const isNarrow = tier === "narrow";
      const compactHeader = isNarrow || (rootWidth > 0 && rootWidth < 850);
      const pageClass = cx("sk-page", surface === "side" && "is-side", "sk-tier-" + tier, compactHeader && "sk-compact-header");

      const [toasts, pushToast] = useToasts();
      const { data, error, loading, reload, setData } = useBoardData();
      const sessionId = surface === "side" ? ctxProps.sessionId : null;
      const [currentOnly, setCurrentOnly] = React.useState(true);
      const [mode, setMode] = React.useState(() => {
        try {
          const saved = localStorage.getItem(`dsh-super-kanban:view:${surface}`);
          if (Object.hasOwn(VIEW_MODES, saved)) return saved;
        } catch { /* optional preference */ }
        return surface === "side" ? "list" : "board";
      });
      const [filters, setFilters] = React.useState(() => readFilters(surface));
      const collapseKey = `dsh-super-kanban:done-collapsed:${surface}`;
      const [doneCollapsed, setDoneCollapsed] = React.useState(() => {
        try { return localStorage.getItem(collapseKey) === "true"; } catch { return false; }
      });
      const pageKey = JSON.stringify([filters, sessionId, currentOnly]);
      const [, setHandoffTick] = React.useState(0);
      const searchRef = React.useRef(null);
      const [drawerId, setDrawerId] = React.useState(null);
      const [newTaskStatus, setNewTaskStatus] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [draggingId, setDraggingId] = React.useState(null);
      const [scanBusy, setScanBusy] = React.useState(false);
      const [nowTick, setNowTick] = React.useState(0);
      const [filterOpen, setFilterOpen] = React.useState(false);
      const [moreAnchor, setMoreAnchor] = React.useState(null);
      const [quickTask, setQuickTask] = React.useState(null);
      const [desktopFiles, setDesktopFiles] = React.useState(false);
      const filterRef = React.useRef(null);
      const movingTasks = React.useRef(new Set());

      React.useEffect(() => {
        let current = true;
        host.canOpenNativeFile?.().then((available) => { if (current) setDesktopFiles(available); });
        return () => { current = false; };
      }, [host]);

      React.useEffect(() => {
        try { localStorage.setItem(`dsh-super-kanban:view:${surface}`, mode); } catch { /* optional preference */ }
      }, [mode, surface]);

      React.useEffect(() => {
        try { localStorage.setItem(collapseKey, String(doneCollapsed)); } catch { /* optional preference */ }
      }, [collapseKey, doneCollapsed]);

      React.useEffect(() => { setQuickTask(null); }, [mode, sideStatus, filters, currentOnly]);

      React.useEffect(() => {
        const timer = setInterval(() => setNowTick((value) => value + 1), 30_000);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.defaultPrevented) return;
          const target = event.target;
          const root = rootRef.current;
          const activeSurface = target?.closest?.(".sk-page");
          if (!root || (activeSurface && activeSurface !== root) || (!activeSurface && surface === "side")) return;
          const typing = Boolean(
            target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
          );
          if (event.key === "Escape") {
            if (settingsOpen) setSettingsOpen(false);
            else if (newTaskStatus !== null) setNewTaskStatus(null);
            else if (drawerId) setDrawerId(null);
            else if (moreAnchor) setMoreAnchor(null);
            else if (filterOpen) {
              filterRef.current?.querySelector("button")?.focus({ preventScroll: true });
              setFilterOpen(false);
            }
            return;
          }
          if (typing || event.isComposing || hasOpenDialog()) return;
          if (event.key === "/") {
            event.preventDefault();
            if (searchRef.current) searchRef.current.focus();
            else if (isNarrow) {
              setFilterOpen(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }
          } else if ((event.key === "n" || event.key === "N") && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            setNewTaskStatus("backlog");
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [settingsOpen, newTaskStatus, drawerId, moreAnchor, filterOpen, surface, isNarrow]);

      React.useEffect(() => {
        writeFilters(filters, surface);
      }, [filters, surface]);
      React.useEffect(() => {
        if (!filterOpen) return undefined;
        const onMouseDown = (event) => {
          if (filterRef.current?.contains(event.target)) return;
          setFilterOpen(false);
        };
        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
      }, [filterOpen]);

      const tasks = React.useMemo(() => {
        const list = data?.tasks || [];
        const statuses = ctxProps.sessionStatuses;
        const bySession = new Map();
        if (typeof statuses?.get === "function" && data?.writeOverlaps?.length) {
          const titles = new Map(list.flatMap((task) => (task.sessions || []).map((session) => [session.id, session.title])));
          for (const group of data.writeOverlaps) {
            const running = group.sessions.filter(({ id }) => {
              const status = statuses.get(id);
              return status?.running === true && !status.pendingInteraction;
            });
            if (running.length < 2) continue;
            const overlap = { path: group.path, sessions: running.map((item) => ({ ...item, title: titles.get(item.id) || "来源会话" })) };
            for (const { id } of running) if (!bySession.has(id)) bySession.set(id, overlap);
          }
        }
        return list.map((task) => {
          const projected = withSessionStatus(task, statuses);
          const overlap = bySession.get(task.primarySessionId) || task.sessions?.map((session) => bySession.get(session.id)).find(Boolean);
          return overlap && !task.archived ? { ...projected, writeOverlap: overlap } : projected;
        });
      }, [data?.tasks, data?.writeOverlaps, ctxProps.sessionStatuses]);
      const settings = (data && data.settings) || {};
      const scan = (data && data.scan) || { state: "idle" };
      const workspaces = (data && data.workspaces) || [];
      const stats = (data && data.stats) || { byStatus: {}, doneRate: 0, total: 0 };
      const usage = usageOf(data);
      const activeFilterCount = [filters.priority, filters.source, filters.tag, filters.showArchived, isNarrow && filters.query.trim()].filter(Boolean).length;
      const clearFilters = () => setFilters({ workspace: "", priority: "", source: "", tag: "", query: "", showArchived: false });
      const tags = React.useMemo(() => allTags(tasks.filter((task) => !task.archived)), [tasks]);
      // I5：筛选下拉的「有效值」范围（与渲染的选项一致）：工作区按「未排除」、标签按当前任务集合。
      const workspaceFilterIds = React.useMemo(
        () => new Set(workspaces.filter((workspace) => workspace.included !== false).map((workspace) => workspace.id)),
        [workspaces],
      );
      // I5：持久化的筛选值可能因工作区被排除 / 工作区或标签消失而失效；数据到达后自愈回退，
      // 避免出现「下拉显示全部工作区、看板却 0 条」且用户无法直接点回全量的状态。
      React.useEffect(() => {
        // 列表为空时无法判断「值不存在」还是「尚未加载」，只在拿到非空集合后校验，避免误清用户筛选。
        if (!data) return;
        const workspaceKnown = workspaces.length > 0;
        const tagsKnown = tasks.length > 0;
        setFilters((current) => {
          const workspaceGone = Boolean(current.workspace) && workspaceKnown && !workspaceFilterIds.has(current.workspace);
          const tagGone = Boolean(current.tag) && tagsKnown && !tags.includes(current.tag);
          if (!workspaceGone && !tagGone) return current;
          return { ...current, workspace: workspaceGone ? "" : current.workspace, tag: tagGone ? "" : current.tag };
        });
      }, [data, workspaceFilterIds, tags, workspaces.length, tasks.length]);

      const visible = React.useMemo(() => {
        const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return tasks.filter((task) => {
          if (!filters.showArchived && task.archived) return false;
          if (sessionId && currentOnly && task.primarySessionId !== sessionId && !task.sessions?.some((item) => item.id === sessionId)) return false;
          if (filters.workspace && task.workspaceId !== filters.workspace) return false;
          if (filters.priority && task.priority !== filters.priority) return false;
          if (filters.tag && !(task.tags || []).includes(filters.tag)) return false;
          if (filters.source === "ai" && task.origin === "manual") return false;
          if (filters.source === "manual" && task.origin !== "manual") return false;
          if (terms.length) {
            // v2 的 goal 是对象，直接拼接会变成 "[object Object]"；搜索覆盖目标/关键事实/问题/下一步。
            const goal = goalInfoOf(task);
            const parts = [
              task.title,
              goal && goal.text,
              task.acceptanceCriteria,
              task.writeOverlap?.path,
              task.workspaceTitle,
              ...(task.tags || []),
              ...keyFactsOf(task).map((fact) => fact.text),
              ...(Array.isArray(task.issues) ? task.issues.map((issue) => issue && issue.text) : []),
              ...(Array.isArray(task.nextSteps) ? task.nextSteps : []),
              ...artifactsOf(task).flatMap((item) => [item.name, item.path, item.absPath]),
              ...(Array.isArray(task.sessions) ? task.sessions.flatMap((session) => [session?.title, session?.id]) : []),
              ...(Array.isArray(task.evidence) ? task.evidence.map((item) => item?.text) : []),
            ];
            const haystack = parts.filter(Boolean).join(" ").toLowerCase();
            if (!terms.every((term) => haystack.includes(term))) return false;
          }
          return true;
        });
      }, [tasks, filters, sessionId, currentOnly]);

      const byStatus = React.useMemo(() => {
        const map = { backlog: [], in_progress: [], blocked: [], done: [] };
        for (const task of visible) {
          const status = statusOf(task);
          (map[status] || map.backlog).push(task);
        }
        for (const key of STATUS_ORDER) map[key].sort(compareTasks);
        return map;
      }, [visible]);

      const taskIndex = React.useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
      const signals = React.useMemo(() => {
        const result = new Map();
        const now = Date.now();
        for (const task of tasks) {
          const signal = taskSignal(task, taskIndex, now);
          if (signal) result.set(task.id, signal);
        }
        return result;
      }, [tasks, taskIndex, nowTick]);
      const attentionCount = visible.filter((task) => signals.has(task.id)).length;
      const openAttentionSession = (id) => {
        if (!host.openSession?.(id)) pushToast("无法打开来源会话", "error");
      };
      const drawerTask = drawerId ? taskIndex.get(drawerId) : null;
      const liveHandoff = pendingHandoff?.expires > Date.now() ? pendingHandoff : null;
      const attachHandoff = async () => {
        if (!liveHandoff || !sessionId) return;
        try {
          await command("task.linkSession", { id: liveHandoff.id, sessionId, continuation: true });
          pendingHandoff = null;
          setHandoffTick((value) => value + 1);
          pushToast("已关联续做会话", "info");
          await reload(true);
        } catch (cause) {
          pushToast(cause.message, "error");
        }
      };
      // S9：任务被删除后 drawerId 残留在 state 里；清理掉，避免后续意外重开或状态陈旧。
      React.useEffect(() => {
        if (drawerId && !drawerTask) setDrawerId(null);
      }, [drawerId, drawerTask]);

      const scanRunning = scan.state === "running";
      // 运行中 AI 进度：Host 已把 aiBudgetMode 解析成 scan.aiBudget；旧 Host 无该字段时只显示已用次数。
      const scanAiCalls = Number(scan.aiCalls) || 0;
      const scanAiBudget = Number(scan.aiBudget) > 0 ? Math.round(Number(scan.aiBudget)) : null;
      const scanAiSegment =
        scanRunning && settings.aiEnabled !== false && scanAiCalls > 0
          ? ` · AI ${scanAiCalls}${scanAiBudget ? "/" + scanAiBudget : " 次"}`
          : "";
      // 完成播报补「剩余 N 个下次继续」：scan.aiPending 含失败待重试（Host 可选字段）。
      const scanPending = Number(scan.aiPending) > 0 ? Math.round(Number(scan.aiPending)) : 0;
      // 读屏播报扫描状态（可见区已有文字，这里不重复显示）。
      const scanAnnounce = scanRunning
        ? `扫描中 ${scan.processed || 0}/${scan.total || 0}${scanAiCalls > 0 ? `，AI ${scanAiCalls} 次` : ""}`
        : scan.state === "error"
          ? `扫描失败：${scan.error || scan.message || "未知错误"}`
          : scan.state === "done"
            ? `扫描完成：新增 ${scan.newTasks || 0}，更新 ${scan.updatedTasks || 0}${
                scanPending > 0 ? `，剩余 ${scanPending} 个会话下次扫描继续` : ""
              }`
            : "";

      // 扫描从 running 结束时给一次结论 toast（轮询里状态会先 running 后 done/error）。
      const prevScanState = React.useRef(null);
      React.useEffect(() => {
        const previous = prevScanState.current;
        prevScanState.current = scan.state;
        if (previous !== "running") return;
        if (scan.state === "done") {
          pushToast(`扫描完成：新增 ${scan.newTasks || 0} · 更新 ${scan.updatedTasks || 0}`, "info");
        } else if (scan.state === "error") {
          pushToast(`扫描失败：${scan.error || scan.message || "未知错误"}`, "error");
        }
      }, [scan.state]);

      const startScan = async (mode) => {
        setScanBusy(true);
        try {
          await command("scan.start", { mode: mode || "incremental" });
          pushToast("扫描已开始", "info");
          await reload(true);
        } catch (cause) {
          pushToast(`扫描失败：${cause.message}`, "error");
        } finally {
          setScanBusy(false);
        }
      };

      const cancelScan = async () => {
        try {
          await command("scan.cancel", {});
          await reload(true);
        } catch (cause) {
          pushToast(`取消失败：${cause.message}`, "error");
        }
      };

      const patchTaskLocal = (id, patch) => {
        setData((current) =>
          current
            ? { ...current, tasks: current.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }
            : current,
        );
      };

      const moveTask = async (id, status) => {
        const before = tasks.find((task) => task.id === id);
        if (!before || before.status === status || movingTasks.current.has(id)) return;
        movingTasks.current.add(id);
        // 乐观更新：先落到本地，失败再回滚，避免"松手后卡片跳回去再刷新"的闪烁。
        patchTaskLocal(id, { status });
        try {
          await command("task.move", { id, status });
          pushToast(`已移动到「${STATUS_META[status].label}」`, "info");
          await reload(true);
        } catch (cause) {
          patchTaskLocal(id, { status: before.status });
          pushToast(`移动失败：${cause.message}`, "error");
        } finally {
          movingTasks.current.delete(id);
        }
      };

      const openTaskMenu = (id, anchor) => {
        setMoreAnchor(null);
        setFilterOpen(false);
        setQuickTask(anchor ? { id, anchor } : null);
      };
      const taskActions = {
        handlers: (task) => quickMenuHandlers((anchor) => openTaskMenu(task.id, anchor), (event) =>
          event.target.closest?.(".sk-card-open,.sk-task-row-main,.sk-quick-trigger") || event.currentTarget.querySelector(".sk-quick-trigger")),
        button: (task) => h(QuickMenuButton, {
          label: `任务操作：${task.title}`, expanded: quickTask?.id === task.id, onOpen: (anchor) => openTaskMenu(task.id, anchor),
        }),
      };
      const menuTask = quickTask && visible.find((task) => task.id === quickTask.id);
      const taskMenuItems = (task) => {
        const source = sessionContextOf(task).sessionId;
        const changeFlag = async (flag, message) => {
          try {
            await command(flag === "pinned" ? "task.pin" : "task.archive", { id: task.id, [flag]: !task[flag] });
            pushToast(message, "info");
            await reload(true);
          } catch (cause) {
            pushToast(cause.message, "error");
          }
        };
        return [
          { label: "查看任务详情", icon: "board", run: () => setDrawerId(task.id) },
          source && { label: "打开来源会话", icon: "chat", run: () => openAttentionSession(source) },
          { label: "复制任务标题", icon: "copy", run: () => copyWithToast(task.title, "任务标题", pushToast) },
          "divider",
          { label: task.pinned ? "取消置顶" : "置顶任务", icon: "arrow", run: () => changeFlag("pinned", task.pinned ? "已取消置顶" : "已置顶") },
          { label: task.archived ? "恢复任务" : "归档任务", icon: "archive", run: () => changeFlag("archived", task.archived ? "已恢复" : "已归档") },
          ...(!task.archived ? ["divider", ...STATUS_ORDER.filter((status) => status !== statusOf(task)).map((status) => ({
            label: `移至${STATUS_META[status].label}`, icon: "arrow", run: () => moveTask(task.id, status),
          }))] : []),
        ];
      };

      if (loading && !data) {
        return h(
          "div",
          {
            className: cx("sk-page", surface === "side" && "is-side", "sk-tier-" + tier),
            "data-super-kanban": "page",
            "data-surface": surface,
            "aria-busy": "true",
          },
          h(
            "header",
            { className: "sk-header-v3" },
            h("div", { className: "sk-header-main" }, h("h1", { className: "sk-title-v3" }, "任务看板"), h("p", { className: "sk-stats-v3", role: "status", "aria-live": "polite" }, "正在加载…")),
          ),
          h(
            "div",
            { className: "sk-loading-v3" },
            h("div", { className: "sk-loading-line" }),
            h("div", { className: "sk-loading-line" }),
            h("div", { className: "sk-loading-line" }),
          ),
        );
      }

      if (error && !data) {
        return h(
          "div",
          { className: cx("sk-page", surface === "side" && "is-side", "sk-tier-" + tier), "data-super-kanban": "page", "data-surface": surface },
          h(
            "header",
            { className: "sk-header-v3" },
            h("div", { className: "sk-header-main" }, h("h1", { className: "sk-title-v3" }, "任务看板")),
          ),
          h(
            "div",
            { className: "sk-empty-v3", role: "alert" },
            h("p", { className: "sk-error-title" }, h(Icon, { name: "alert", size: 14 }), "看板加载失败"),
            h("p", { className: "sk-error-detail" }, error),
            h(
              "div",
              { className: "sk-inline-actions" },
              h("button", { type: "button", className: "sk-btn", onClick: () => reload(false) }, h(Icon, { name: "refresh", size: 12 }), "重试"),
            ),
            h("p", { className: "sk-note-tiny" }, "后台会自动重连，也可以稍等几秒。"),
          ),
        );
      }

      const statusCounts = (stats && stats.byStatus) || {};
      const scanLastAt = settings.lastScanAt ? Date.parse(settings.lastScanAt) : scan.finishedAt ? Date.parse(scan.finishedAt) : null;
      // Host 的 scan.message 已是完整结论（含 AI 调用 / 跳过 / 合并等信息），客户端不再拼接。
      const scanOutcomeText =
        scan.state === "done" ? String(scan.message || `扫描完成：${scan.processed || 0}/${scan.total || 0} 个会话`) : "";
      const scanErrorText = scan.state === "error" ? String(scan.error || scan.message || "未知错误") : "";
      const scanTitleText =
        scan.state === "done" && Number(scan.aiCalls) > 0 && !/tokens/.test(scanOutcomeText)
          ? `${scanOutcomeText} · ${fmtTokens(scan.tokens)} tokens`
          : scanOutcomeText || scanErrorText;
      const statusSummary = [...STATUS_ORDER.map((status) => [status, STATUS_META[status].label, Number(statusCounts[status]) || 0]),
        ["total", "已归档", Number(stats.archived) || 0]].filter(([, , count]) => count > 0);
      const totalLabel = `${stats.total || tasks.length} 项`;
      const statsLine = h("p", { className: "sk-stats-v3", title: [totalLabel, ...statusSummary.map(([, label, count]) => `${count} ${label}`)].join(" · ") },
        h("span", { className: "sk-stats-total" }, totalLabel),
        !compactHeader && statusSummary.map(([status, label, count]) => h("span", { className: "sk-stats-group", key: status },
          h("span", { className: cx("sk-dot", "is-" + status) }), `${count} ${label}`)));

      const exportJson = async () => {
        try {
          await downloadExport();
          pushToast("已导出 JSON", "info");
        } catch (cause) {
          pushToast("导出失败：" + cause.message, "error");
        }
      };

      const openSideFromPage = () => {
        const ok = host.openSide ? host.openSide() : false;
        if (!ok) pushToast("请先在会话中打开右侧栏，再回到这里", "error");
      };
      const openPageFromSide = () => {
        const ok = host.openPage ? host.openPage() : false;
        if (!ok) pushToast("当前环境无法切换到全页面板", "error");
      };
      const boardMenuItems = [
        mode !== "maintenance" && { label: "查看扫描详情", icon: "refresh", run: () => setMode("maintenance") },
        { label: "导出 JSON", icon: "file", run: exportJson },
      ];

      const scanFailed = scan.state === "error";
      const scanProgress = `${scan.processed || 0}/${scan.total || 0}`;
      const scanLabel = scanRunning ? "取消扫描" : scanFailed ? "重试扫描" : settings.aiEnabled === false ? "扫描（仅规则）" : "扫描会话";
      const scanTooltip = scanRunning ? `扫描中 ${scanProgress}${scanAiSegment} · 点击取消`
        : scanFailed ? `上次扫描失败：${scanErrorText} · 点击重试`
        : [settings.aiEnabled === false ? scanLabel : "AI 扫描", scanLastAt ? `上次扫描 ${relTime(scanLastAt)}` : "", scanTitleText].filter(Boolean).join(" · ");
      const scanButton = h(
        "button",
        {
          type: "button",
          className: cx("sk-iconbtn-v3", "sk-scan-button", scanRunning && "is-busy", scanFailed && "is-failed"),
          title: scanTooltip,
          "aria-label": scanLabel,
          "aria-busy": scanRunning ? "true" : undefined,
          onClick: scanRunning ? cancelScan : () => startScan("incremental"),
          disabled: !scanRunning && scanBusy,
        },
        h(Icon, { name: scanRunning ? "stop" : scanFailed ? "alert" : "refresh", size: 15 }),
        scanRunning ? h("span", null, scanProgress) : scanFailed ? h("span", null, "重试") : null,
      );
      const actionIcon = (name, title, onClick, extraClass) =>
        h(
          "button",
          { type: "button", className: cx("sk-iconbtn-v3", extraClass), title, "aria-label": title, onClick },
          h(Icon, { name, size: 15 }),
        );
      const settingsButton = actionIcon("settings", "设置", () => setSettingsOpen(true));
      const newTextButton = h(
        "button",
        { type: "button", className: "sk-btn-primary-v3", onClick: () => setNewTaskStatus("backlog"), title: "新建任务（n）", "aria-label": "新建任务" },
        "新建",
      );

      const searchField = h("div", { className: "sk-search-v3" },
        h(Icon, { name: "search", size: 14 }),
        h("input", { ref: searchRef, "aria-label": "搜索任务、会话或标签", value: filters.query,
          placeholder: "搜索任务 / 会话 / 标签", onChange: (event) => setFilters((value) => ({ ...value, query: event.target.value })) }));
      const headerNode = h("header", { className: "sk-header-v3" },
        h("div", { className: "sk-header-main" },
          surface === "page" ? h("h1", { className: "sk-title-v3" }, "任务看板") : null,
          statsLine),
        h("div", { className: "sk-header-actions" },
          !isNarrow ? searchField : null,
          scanButton, settingsButton,
          surface === "side"
            ? prefs.fullEntry && actionIcon("layout", "在全页面板打开", openPageFromSide)
            : prefs.sideEntry && actionIcon("panelRight", "在右侧栏打开", openSideFromPage),
          surface === "side" || isNarrow
            ? actionIcon("plus", "新建任务", () => setNewTaskStatus("backlog"), "is-primary")
            : newTextButton,
          h(QuickMenuButton, { label: "更多看板操作", expanded: Boolean(moreAnchor), onOpen: setMoreAnchor }),
          moreAnchor ? h(QuickMenu, { anchor: moreAnchor, items: boardMenuItems, label: "更多看板操作", onClose: () => setMoreAnchor(null) }) : null));

      const viewSwitch = isNarrow
        ? h("span", { className: "sk-ws-picker sk-view-picker" },
            h("select", { className: "sk-select sk-ws-select", "aria-label": "任务视图", value: mode,
              onChange: (event) => setMode(event.target.value) },
              Object.entries(VIEW_MODES).map(([key, label]) => h("option", { key, value: key }, key === "attention" && attentionCount ? label + " " + attentionCount : label))),
            h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }))
        : h("div", { className: "sk-view-switch", role: "group", "aria-label": "任务视图" },
            Object.entries(VIEW_MODES).map(([key, label]) => h("button", {
              key, type: "button", "aria-pressed": mode === key, onClick: () => setMode(key),
            }, label, key === "attention" && attentionCount > 0 ? h("span", { className: "sk-view-count" }, " " + attentionCount) : null)));

      return h(
        "div",
        { ref: attachRoot, className: pageClass, "data-super-kanban": "page", "data-surface": surface, "data-tier": tier, "data-root-width": rootWidth, "data-tick": nowTick },
        headerNode,
        h("div", { className: "sk-sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" }, scanAnnounce),
        error
          ? h(
              "div",
              { className: "sk-banner", role: "alert" },
              h(Icon, { name: "alert", size: 13 }),
              h("span", { className: "grow" }, `连接异常：${error}（看板显示上一次数据）`),
              h("button", { type: "button", className: "sk-btn ghost", style: { padding: "2px 8px" }, onClick: () => reload(false) }, "重试"),
            )
          : null,
        h(
          "div",
          { className: "sk-slimbar" },
          viewSwitch,
          h(
            "span",
            { className: "sk-ws-picker" },
            h(
              "select",
              {
                className: "sk-select sk-ws-select",
                "aria-label": "按工作区筛选",
                value: filters.workspace,
                title: workspaces.find((workspace) => workspace.id === filters.workspace)?.title || "全部工作区",
                onChange: (event) => setFilters((value) => ({ ...value, workspace: event.target.value })),
              },
              h("option", { value: "" }, "全部工作区"),
              workspaces
                .filter((workspace) => workspace.included !== false)
                .map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)),
            ),
            h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }),
          ),
          sessionId ? h("button", { type: "button", className: "sk-slim-icon sk-session-scope", "aria-pressed": currentOnly,
            title: currentOnly ? "当前会话，点击查看全部会话" : "全部会话，点击仅看当前会话",
            onClick: () => setCurrentOnly((value) => !value),
          }, currentOnly ? "当前会话" : "全部会话") : null,
          mode !== "maintenance" && visible.length !== tasks.length
            ? h("span", { className: "sk-count", title: `筛选范围内 ${visible.length} 项，共 ${tasks.length} 项` }, `${visible.length} / ${tasks.length}`)
            : null,
          h(
            "div",
            { className: "sk-filter-wrap", ref: filterRef },
            h(
              "button",
              {
                type: "button",
                className: cx("sk-slim-icon", activeFilterCount > 0 && "is-on"),
                "aria-expanded": filterOpen,
                "aria-label": isNarrow ? "搜索与筛选任务" : "筛选任务",
                onClick: () => setFilterOpen((value) => !value),
                title: isNarrow ? "搜索与筛选任务" : "筛选任务",
              },
              h(Icon, { name: "filter", size: 14 }),
              "筛选",
              activeFilterCount > 0 ? h("span", { className: "sk-filter-count" }, activeFilterCount) : null,
            ),
            filterOpen
              ? h(
                  "div",
                  { className: "sk-filter-popover", role: "group", "aria-label": "筛选条件" },
                  isNarrow ? searchField : null,
                  h(
                    "div",
                    { className: "sk-filter-row" },
                    h("div", { className: "sk-filter-label" }, "优先级"),
                    h(
                      "div",
                      { className: "sk-filter-chips" },
                      h("button", { type: "button", "aria-pressed": !filters.priority, className: cx("sk-chip", !filters.priority && "on"), onClick: () => setFilters((value) => ({ ...value, priority: "" })) }, "全部"),
                      PRIORITY_ORDER.map((priority) =>
                        h(
                          "button",
                          { key: priority, type: "button", "aria-pressed": filters.priority === priority, className: cx("sk-chip", filters.priority === priority && "on"), onClick: () => setFilters((value) => ({ ...value, priority: value.priority === priority ? "" : priority })) },
                          priority,
                        ),
                      ),
                    ),
                  ),
                  h(
                    "div",
                    { className: "sk-filter-row" },
                    h("div", { className: "sk-filter-label" }, "来源"),
                    h(
                      "div",
                      { className: "sk-filter-chips" },
                      h("button", { type: "button", "aria-pressed": !filters.source, className: cx("sk-chip", !filters.source && "on"), onClick: () => setFilters((value) => ({ ...value, source: "" })) }, "全部"),
                      h("button", { type: "button", "aria-pressed": filters.source === "ai", className: cx("sk-chip", filters.source === "ai" && "on"), onClick: () => setFilters((value) => ({ ...value, source: value.source === "ai" ? "" : "ai" })) }, "AI 自动"),
                      h("button", { type: "button", "aria-pressed": filters.source === "manual", className: cx("sk-chip", filters.source === "manual" && "on"), onClick: () => setFilters((value) => ({ ...value, source: value.source === "manual" ? "" : "manual" })) }, "手动"),
                    ),
                  ),
                  tags.length
                    ? h(
                        "div",
                        { className: "sk-filter-row" },
                        h("div", { className: "sk-filter-label" }, "标签"),
                        h(
                          "select",
                          { className: "sk-select", "aria-label": "按标签筛选", style: { width: "100%" }, value: filters.tag, onChange: (event) => setFilters((value) => ({ ...value, tag: event.target.value })) },
                          h("option", { value: "" }, "全部标签"),
                          // I5：已保存标签若是有效值但不在前 24 个里，也要出现在选项里，避免「显示全部却已过滤」。
                          (filters.tag && tags.includes(filters.tag) && !tags.slice(0, 24).includes(filters.tag)
                            ? [filters.tag, ...tags.slice(0, 24)]
                            : tags.slice(0, 24)
                          ).map((tag) => h("option", { key: tag, value: tag }, tag)),
                        ),
                      )
                    : null,
                  h(
                    "div",
                    { className: "sk-filter-foot" },
                    h(
                      "button",
                      { type: "button", "aria-pressed": filters.showArchived, className: cx("sk-chip", filters.showArchived && "on"), onClick: () => setFilters((value) => ({ ...value, showArchived: !value.showArchived })) },
                      "含归档",
                    ),
                    h("button", { type: "button", className: "sk-clear", onClick: clearFilters }, "清空筛选"),
                  ),
                )
              : null,
          ),
        ),
        data.storage?.writable === false
          ? h("div", { className: "sk-board-notice", role: "alert" }, "看板存储暂不可写",
              h("button", { type: "button", className: "sk-btn", onClick: () => setMode("maintenance") }, "查看维护"))
          : null,
        sessionId && liveHandoff?.targetId === sessionId
          ? h("div", { className: "sk-board-notice" }, `继续任务 · ${liveHandoff.title}`,
              h("button", { type: "button", className: "sk-btn", onClick: attachHandoff }, "关联当前会话"),
              h("button", { type: "button", className: "sk-text", onClick: () => { pendingHandoff = null; setHandoffTick((value) => value + 1); } }, "关闭"))
          : null,
        mode === "maintenance"
          ? h(MaintenanceView, { data, reload, pushToast, startScan })
          : mode === "artifacts"
            ? h(ArtifactsView, { tasks: visible, host, desktopFiles, pushToast, onOpen: setDrawerId })
            : mode !== "board"
              ? h(TaskCollection, { key: mode, mode, tasks: visible, signals, onOpen: setDrawerId, taskActions, openSession: openAttentionSession, reload, pushToast,
                  emptyText: sessionId && currentOnly ? "当前会话还没有关联任务" : "没有匹配的任务",
                  onClear: sessionId && currentOnly ? () => setCurrentOnly(false) : clearFilters,
                  clearLabel: sessionId && currentOnly ? "查看全部会话" : "清空筛选" })
        : visible.length === 0 && tasks.length > 0
          ? h(
              "div",
              { className: "sk-board-v3" },
              h(
                "div",
                { className: "sk-empty-v3" },
                sessionId && currentOnly ? "当前会话还没有关联任务" : "没有匹配的任务",
                h("button", { type: "button", className: "sk-text", onClick: sessionId && currentOnly ? () => setCurrentOnly(false) : clearFilters }, sessionId && currentOnly ? "查看全部会话" : "清空筛选"),
              ),
            )
          : tasks.length === 0
            ? h(
                "div",
                { className: "sk-board-v3" },
                h(
                  "div",
                  { className: "sk-empty-v3" },
                  "看板还是空的，扫描会话后会自动建卡。",
                  h("button", { type: "button", className: "sk-text", onClick: () => startScan("full") }, "立即扫描"),
                ),
              )
            : isNarrow
              ? h(NarrowBoard, {
                  status: sideStatus,
                  setStatus: setSideStatus,
                  byStatus,
                  signals,
                  pageKey,
                  onOpen: (id) => setDrawerId(id),
                  taskActions,
                  onAdd: (targetStatus) => setNewTaskStatus(targetStatus),
                  draggingId,
                  onDragStart: setDraggingId,
                  onDragEnd: () => setDraggingId(null),
                })
              : h(
                  "div",
                  { className: cx("sk-board-v3", doneCollapsed && "is-done-collapsed") },
                  STATUS_ORDER.map((status) =>
                    h(Column, {
                      key: status,
                      status,
                      tasks: byStatus[status] || [],
                      signals,
                      onOpen: (id) => setDrawerId(id),
                      taskActions,
                      pageKey,
                      collapsed: status === "done" && doneCollapsed,
                      onToggle: status === "done" ? () => setDoneCollapsed((value) => !value) : null,
                      onAdd: (targetStatus) => setNewTaskStatus(targetStatus),
                      onDropTask: (id, targetStatus) => moveTask(id, targetStatus),
                      draggingId,
                      onDragStart: setDraggingId,
                      onDragEnd: () => setDraggingId(null),
                    }),
                  ),
                ),
        menuTask ? h(QuickMenu, { anchor: quickTask.anchor, items: taskMenuItems(menuTask), label: `任务操作：${menuTask.title}`, onClose: () => setQuickTask(null) }) : null,
        drawerTask
          ? h(TaskDrawer, { key: drawerTask.id, task: drawerTask, signal: signals.get(drawerTask.id), tasks, workspaces, onOpenTask: setDrawerId, ctxProps, settings, desktopFiles,
              onClose: () => setDrawerId((id) => id === drawerTask.id ? null : id), onChanged: () => reload(true), pushToast })
          : null,
        newTaskStatus !== null
          ? h(NewTaskModal, { defaultStatus: newTaskStatus, workspaces, sessionId: currentOnly ? sessionId : null, onClose: () => setNewTaskStatus(null), onCreate: async () => { setNewTaskStatus(null); await reload(true); }, pushToast })
          : null,
        settingsOpen
          ? h(SettingsModal, {
              settings,
              workspaces,
              prefs,
              usage,
              onPrefsChange: (next) => {
                writePrefs(next);
                setPrefs(next);
              },
              onClose: () => setSettingsOpen(false),
              onSave: async () => { setSettingsOpen(false); await reload(true); },
              onScan: async (mode) => { setSettingsOpen(false); await startScan(mode); },
              pushToast,
            })
          : null,
        h(
          "div",
          { className: "sk-toasts", role: "status", "aria-live": "polite", "aria-atomic": "false" },
          toasts.map((toast) => h("div", { key: toast.id, className: cx("sk-toast", toast.tone === "error" && "error") }, toast.text)),
        ),
      );
    }

    /* ============================= error boundary ========================= */

    /**
     * 极简错误边界：插件面板任一 render 抛错时只坏这一块，不白屏整个 DSH。
     * fallback 复用页面 token / 空态样式；「重新加载」走整页刷新（无额外依赖）。
     */
    class BoardErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (!this.state.error) return this.props.children;
        const message = String((this.state.error && this.state.error.message) || this.state.error || "未知错误");
        return h(
          "div",
          { className: "sk-page", role: "alert", "data-super-kanban": "error" },
          h(
            "div",
            { className: "sk-empty-v3", style: { marginTop: "18vh" } },
            h("p", { className: "sk-error-title" }, h(Icon, { name: "alert", size: 14 }), "看板加载出错"),
            h("p", { className: "sk-error-detail" }, message),
            h(
              "div",
              { className: "sk-inline-actions" },
              h(
                "button",
                { type: "button", className: "sk-btn", onClick: () => window.location.reload() },
                h(Icon, { name: "refresh", size: 12 }),
                "重新加载",
              ),
            ),
          ),
        );
      }
    }

    /* ================================ apply =============================== */

    function apply(ctx) {
      ctx.effect(() => {
        const tag = ensureStyle();
        return () => tag.remove();
      }, "super-kanban: styles");

      let resourceRequest = 0;
      const hostApi = {
        openSession(sessionId) {
          try {
            const workspace = ctx.get("uiWorkspace");
            if (workspace && typeof workspace.openSession === "function") {
              workspace.openSession(sessionId);
              return true;
            }
          } catch {
            /* navigation service unavailable */
          }
          return false;
        },
        openSide() {
          let service = null;
          try {
            service = ctx.get("sidebarRight");
          } catch {
            service = null;
          }
          if (!service || typeof service.openTab !== "function") return false;
          try {
            const layout = ctx.get("layout");
            if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
          } catch {
            /* layout service unavailable */
          }
          const attempt = () => {
            try {
              const sidebarRight = ctx.get("sidebarRight");
              if (sidebarRight && typeof sidebarRight.openTab === "function") {
                sidebarRight.openTab(SIDE_KIND);
                return true;
              }
            } catch {
              /* sidebar service unavailable */
            }
            return false;
          };
          const ok = attempt();
          // 回到会话后右栏挂载可能晚一拍，补一次尝试。
          if (!ok) setTimeout(attempt, 280);
          return true;
        },
        openSideTab(sessionId) {
          try {
            const sidebarRight = ctx.get("sidebarRight");
            if (sidebarRight && typeof sidebarRight.openTab === "function") {
              sidebarRight.openTab(SIDE_KIND, { params: { sessionId } });
              return true;
            }
          } catch {
            /* sidebar service unavailable */
          }
          return false;
        },
        openPage() {
          try {
            const layout = ctx.get("layout");
            if (layout && typeof layout.selectPanel === "function") {
              layout.selectPanel(PANEL_ID);
              return true;
            }
          } catch {
            /* layout service unavailable */
          }
          return false;
        },
        async prepareSession(workspaceId, prompt) {
          const ui = ctx.get("uiWorkspace");
          const sessions = ctx.get("sessions");
          const input = ctx.get("conversation")?.input;
          if (!workspaceId || typeof ui?.openWorkspace !== "function" || typeof sessions?.binding !== "function" ||
              typeof input?.requestDraftInitialization !== "function") return null;
          let placement = null;
          await ui.openWorkspace(workspaceId, (sessionId) => {
            const binding = sessions.binding(sessionId);
            if (!binding) throw new Error("新会话输入框尚未就绪");
            const result = input.requestDraftInitialization(binding, { prompt, whenDraftExists: "keep" });
            if (result === "blocked") throw new Error("新会话输入框暂不可写");
            placement = { sessionId, result };
          });
          return placement;
        },
        async openResource(sessionId, path) {
          const sid = String(sessionId || "");
          const raw = String(path || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
          if (!sid || !raw.replace(/^\/+/, "")) return false;
          const encodedPath = raw
            .split("/")
            .map((segment, index) => index === 0 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment))
            .join("/");
          const address = "dsh-resource://file/session/" + encodeURIComponent(sid) + "/" + encodedPath;
          const request = ++resourceRequest;
          try {
            const sidebarRight = ctx.get("sidebarRight");
            if (typeof sidebarRight?.openResource !== "function") return false;
            const tryOpen = () => {
              const mountedId = sidebarRight.screen?.()?.sessionId;
              if (mountedId && mountedId !== sid) return false;
              try {
                sidebarRight.openResource(address);
                return true;
              } catch (error) {
                if (/no session surface is mounted/i.test(error?.message)) return false;
                throw error;
              }
            };
            if (tryOpen()) return true;
            if (!hostApi.openSession(sid)) return false;
            // Wait for DSH to mount the source Session instead of reusing another Session's pane.
            for (let attempt = 0; attempt < 20; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              if (request !== resourceRequest) return false;
              if (tryOpen()) return true;
            }
          } catch {
            /* sidebar service unavailable */
          }
          return false;
        },
        async canOpenNativeFile() {
          try {
            const session = ctx.get("remote")?.session;
            if (typeof session?.openWorkspacePath !== "function") return false;
            const result = await session.canOpenWorkspacePath();
            return result?.ok === true && result.value === true;
          } catch {
            return false;
          }
        },
        async openNativeFile(path, action, sessionId) {
          if (!path || !["open", "reveal"].includes(action)) return false;
          try {
            const remote = ctx.get("remote");
            const signal = AbortSignal.timeout(10_000);
            // DSH requires the canonical Host path. Resolve symlink aliases using the exact source Session.
            let resolved = path;
            if (sessionId && typeof remote?.workspaceFiles?.stat === "function") {
              const file = await remote.workspaceFiles.stat(sessionId, path, signal);
              if (!file?.ok) return false;
              resolved = file.value?.absolutePath;
            }
            if (!isHostAbsolutePath(resolved)) return false;
            const request = action === "reveal" ? { path: resolved, action } : { path: resolved };
            const result = await remote?.session?.openWorkspacePath(request, signal);
            return result?.ok === true && result.value?.opened === true;
          } catch {
            return false;
          }
        },
        openTerminal() {
          try {
            const sidebarRight = ctx.get("sidebarRight");
            if (sidebarRight && typeof sidebarRight.openTab === "function") {
              sidebarRight.openTab("terminal", { params: {} });
              return true;
            }
          } catch {
            /* sidebar service unavailable */
          }
          return false;
        },
        async placeDraft(sessionId, prompt) {
          const sid = String(sessionId || "");
          if (!sid) return { ok: false, reason: "missing-session" };
          let ui = null;
          let sessions = null;
          let conversation = null;
          try {
            ui = ctx.get("uiWorkspace");
            sessions = ctx.get("sessions");
            conversation = ctx.get("conversation");
          } catch {
            /* services unavailable */
          }
          if (!ui || typeof ui.openSession !== "function") return { ok: false, reason: "missing-workspace" };
          if (!conversation || !conversation.input || typeof conversation.input.requestDraftInitialization !== "function") {
            return { ok: false, reason: "missing-conversation" };
          }
          try {
            ui.openSession(sid);
          } catch {
            return { ok: false, reason: "open-failed" };
          }
          const startedAt = Date.now();
          let binding = null;
          while (Date.now() - startedAt < 3000) {
            try {
              binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sid) : null;
            } catch {
              binding = null;
            }
            if (binding) break;
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          if (!binding) return { ok: false, reason: "no-binding" };
          try {
            const result = conversation.input.requestDraftInitialization(binding, {
              prompt: String(prompt || ""),
              whenDraftExists: "keep",
            });
            return { ok: true, result: result };
          } catch (cause) {
            return { ok: false, reason: "init-failed", error: String((cause && cause.message) || cause) };
          }
        },
      };

      const baseProps = Object.freeze({
        host: hostApi,
        openSession: (sessionId) => hostApi.openSession(sessionId),
      });
      const prefs = readPrefs();

      // S3：任何 render 异常都被错误边界接住，只坏插件面板。
      const WithSessionStatus = (props) => {
        const sessionStatuses = props.useSessionStatus((snapshot) => snapshot);
        return h(BoardPage, { ...props, sessionStatuses });
      };
      const board = (props) => h(BoardErrorBoundary, null,
        h(typeof props.useSessionStatus === "function" ? WithSessionStatus : BoardPage, props));

      const PageKanbanBody = (slotProps) => board({ ...(slotProps || {}), ...baseProps, surface: "page" });
      const SideKanbanBody = (slotProps) => {
        const info = slotProps?.useTabInfo?.();
        const sessionId = slotProps?.sessionId || info?.tab?.navigation?.params?.sessionId || null;
        return board({ ...(slotProps || {}), ...baseProps, sessionId, surface: "side" });
      };

      function KanbanSidebarIcon({ size }) {
        return h(Icon, { name: "board", size: size || 18 });
      }

      const HeaderKanbanButton = ({ sessionId }) =>
        h(
          "button",
          {
            type: "button",
            className: "sk-header-btn",
            title: "打开任务看板",
            "aria-label": "打开任务看板",
            onClick: () => hostApi.openSideTab(sessionId),
          },
          h(Icon, { name: "board", size: 16 }),
        );

      if (prefs.fullEntry) {
        ctx.slots.inject("main", function* () {
          yield ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, PageKanbanBody);
        });
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 2,
              label: () => "任务看板",
              locale: NS,
            },
            KanbanSidebarIcon,
          ),
        );
      }

      if (prefs.sideEntry) {
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: SIDE_ID,
              kind: SIDE_KIND,
              priority: "extension",
              title: () => "任务看板",
              guide: [
                {
                  id: "kanban",
                  order: 20,
                  title: () => "任务看板",
                  description: () => "各工作区会话的智能任务看板",
                },
              ],
            }),
          "super-kanban: side tab type",
        );
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register({ name: "sidebar.right.pane.tab", key: SIDE_ID }, SideKanbanBody),
        );
        ctx.slots.inject("conversation.session.header.utilities", () =>
          ctx.slots.register(
            { name: "conversation.session.header.utilities", id: "super-kanban-open", order: -4 },
            HeaderKanbanButton,
          ),
        );
      }
    }

    return { apply, inject: [
      "slots", "locale", "sidebarRightTabs", "sidebarRight", "layout", "sessions", "conversation", "uiWorkspace",
      "remote", "remote.session", "remote.workspaceFiles",
    ] };
  },
});
