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
    // 同一块看板的三种形态，任一时刻只显示其中一种。
    const SURFACES = { page: "全局看板", side: "右侧看板", float: "悬浮看板" };
    const SURFACE_ICONS = { page: "surfacePage", side: "panelRight", float: "surfaceFloat" };
    const SURFACE_HINTS = {
      page: "占满主区域，适合规划、整理与回顾",
      side: "停靠在会话右侧，边执行边跟进",
      float: "悬浮在会话之上，随手查看、验收与快聊",
    };
    const FLOAT_STYLES = { badge: "圆形图标", pill: "紧凑胶囊", bar: "状态条" };
    const FLOAT_SUMMARIES = { acceptance: "待验收", attention: "待处理", running: "运行中" };
    const FLOAT_TABS = { ...FLOAT_SUMMARIES, recent: "最近" };
    // 悬浮入口上方的待审批条：只收刚结束、还没点头的会话。
    const REVIEW_STRIP_LIMIT = 3;
    // 文件夹圆标的固定调色板：按工作区 id 稳定取色，超出后循环。
    const FOLDER_COLORS = ["#2563EB", "#7C3AED", "#0F766E", "#B45309", "#BE123C", "#4338CA", "#0369A1", "#15803D"];

    function folderGlyph(name) {
      const first = Array.from(String(name || "").trim())[0];
      return first ? first.toUpperCase() : "任";
    }

    function folderColor(seed) {
      // FNV-1a + 终混：短 id、相似前缀也能落到不同色位。
      let hash = 0x811c9dc5;
      for (const char of String(seed || "")) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hash ^= hash >>> 16;
      hash = Math.imul(hash, 0x85ebca6b);
      hash ^= hash >>> 13;
      hash = Math.imul(hash, 0xc2b2ae35);
      hash ^= hash >>> 16;
      return FOLDER_COLORS[(hash >>> 0) % FOLDER_COLORS.length];
    }
    const ACTIVITY_RANGES = { recent: "近期", history: "历史", all: "全部时间" };
    const PREFS_VERSION = 2;
    const DEFAULT_PREFS = Object.freeze({
      version: PREFS_VERSION, surface: "side", floatEnabled: true, floatStyle: "badge", floatPosition: "right", floatOffset: 0,
      floatSummaries: ["acceptance", "attention", "running"], floatHideEmpty: false, floatSize: "normal", floatPinned: false,
    });

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
    const VIEW_MODES = { attention: "待处理", board: "看板", projects: "项目", timeline: "时间线", schedule: "日程", list: "列表", hierarchy: "层级", artifacts: "产出", maintenance: "维护" };
    const RELATION_LABELS = { parent: "父任务", depends_on: "依赖任务", related: "相关任务" };
    const ATTENTION_LABELS = { waiting_user: "待你确认", review: "待确认进度", acceptance: "待验收", interrupted: "执行中断" };
    const INTERACTION_LABELS = { approval: "待审批", question: "待回答", "plan-review": "待审阅方案" };
    const COMPLETION_LABELS = { user: "人工确认", session_goal: "DSH 目标完成", session_todos: "本轮待办已完成" };
    let pendingHandoff = null;

    function localDateKey(now) {
      const date = new Date(now);
      return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
    }

    function dueLabel(task, today = localDateKey(Date.now())) {
      if (!task.dueDate) return "";
      if (task.status === "done" || task.archived) return `到期 ${task.dueDate}`;
      if (task.dueDate < today) return `已逾期 · ${task.dueDate}`;
      return task.dueDate === today ? "今天到期" : `到期 ${task.dueDate}`;
    }

    function taskSchedule(tasks, now) {
      const today = localDateKey(now);
      const boundary = new Date(now);
      boundary.setDate(boundary.getDate() + 7);
      const nextWeek = localDateKey(boundary);
      const groups = { overdue: [], today: [], week: [], later: [], undated: [] };
      for (const task of tasks) {
        if (task.archived || task.status === "done") continue;
        const due = task.dueDate;
        const group = !due ? "undated" : due < today ? "overdue" : due === today ? "today" : due <= nextWeek ? "week" : "later";
        groups[group].push(task);
      }
      for (const list of Object.values(groups)) {
        list.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || "") || compareTasks(a, b));
      }
      return groups;
    }

    function withSessionStatus(task, statuses, now) {
      if (typeof statuses?.get !== "function") {
        const session = task.sessionContext;
        return session?.isLive
          ? { ...task, sessionContext: { ...session, isLive: now - session.lastActivityAt < 30 * 60_000, estimated: true } }
          : task;
      }
      const sessions = new Map((task.sessions || []).filter((session) => session?.id).map((session) => [session.id, session.title]));
      const primaryId = task.primarySessionId || task.sessionContext?.sessionId || sessions.keys().next().value;
      const context = task.sessionContext?.sessionId && task.sessionContext.sessionId !== primaryId ? null : task.sessionContext;
      if (primaryId && !sessions.has(primaryId)) sessions.set(primaryId, task.sessionContext?.title);
      const primary = primaryId ? statuses.get(primaryId) : null;
      const pendingSessions = [];
      const runningSessionIds = [];
      for (const [id, title] of sessions) {
        const native = statuses.get(id);
        const pending = native?.pendingInteraction;
        if (pending) {
          const kind = typeof pending === "string" ? pending : pending.kind;
          const label = Object.hasOwn(INTERACTION_LABELS, kind) ? INTERACTION_LABELS[kind] : "待处理请求";
          pendingSessions.push({ id, title: title || "来源会话", label });
        } else if (native?.running === true) {
          runningSessionIds.push(id);
        }
      }
      return {
        ...task,
        pendingSessions,
        runningSessions: runningSessionIds.length,
        runningSessionIds,
        sessionContext: primaryId
          ? { ...context, sessionId: primaryId, title: context?.title || sessions.get(primaryId),
              isLive: primary?.running === true && !primary?.pendingInteraction }
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
      const running = task.runningSessions ?? Number(Boolean(task.sessionContext?.isLive));
      const dependency = task.relations?.find((link) => link.type === "depends_on" && index.get(link.taskId)?.status !== "done");
      if (dependency) return { label: "等待依赖", text: index.get(dependency.taskId)?.title || "关联任务不可用", taskId: dependency.taskId, rank: 1 };
      const issue = task.issues?.find((item) => item.severity === "high") || task.issues?.[0];
      if (!task.sessionContext?.isLive && task.sessionContext?.lastTurnEnd === "error") {
        const sessionId = task.sessionContext.sessionId || task.primarySessionId;
        const failure = task.issues?.find((item) => item.sessionId === sessionId) || (issue?.sessionId ? null : issue);
        return { label: "执行失败", text: failure?.text || task.ai?.reason, sessionId, rank: 1 };
      }
      if (task.status === "blocked" || issue) return { label: "待处理问题", text: issue?.text || task.nextSteps?.[0], rank: 1 };
      if (!running && ["review", "acceptance"].includes(task.attention)) {
        const delivery = primaryArtifactOf(artifactsOf(task));
        const deliverable = delivery?.kind === "deliverable" ? delivery : null;
        const ready = deliverable || task.attention === "acceptance";
        return { label: ready ? "待验收" : ATTENTION_LABELS.review, text: deliverable?.name || task.ai?.reason, rank: 2 };
      }
      if (!running && Object.hasOwn(ATTENTION_LABELS, task.attention)) {
        return { label: ATTENTION_LABELS[task.attention], text: task.nextSteps?.[0] || task.ai?.reason, rank: task.attention === "waiting_user" ? 1 : 2 };
      }
      const today = localDateKey(now);
      if (task.dueDate && task.dueDate <= today) {
        return { kind: "due", label: task.dueDate < today ? "已逾期" : "今天到期", text: task.dueDate, rank: 2 };
      }
      if (!running && task.status === "in_progress" && task.lastActivityAt > 0 && now - task.lastActivityAt > 7 * 86400000) {
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
      if (task.sessionContext?.isLive && task.sessionContext.estimated) return "可能运行中";
      const running = task.runningSessions ?? (task.sessionContext?.isLive ? 1 : 0);
      return running > 1 ? `${running} 个会话运行中` : running ? "会话运行中" : "";
    }

    function isAccepted(task) {
      return task.status === "done" && task.completionBasis === "user";
    }

    /** 任务归属：工作区 › 自建项目。两者都有时一起显示，避免只见项目、不见工作区。 */
    function taskScopeLabel(task) {
      return [task.workspaceTitle, task.projectName].filter(Boolean).join(" › ");
    }

    function canAcceptTask(task, artifact = primaryArtifactOf(artifactsOf(task))) {
      if (task.archived) return false;
      if (isAccepted(task)) return true;
      if (task.pendingSessions?.length) return false;
      // 待审批卡代表已经结束的那一轮：会话又跑起来也不妨碍点头，点进会话才不会白等。
      if (task.review?.sessionId) return true;
      return !taskRunningLabel(task) &&
        Boolean(task.acceptanceCriteria || artifact?.kind === "deliverable" || task.status === "done");
    }

    function taskActivityAt(task) {
      const sessionActivity = timeValue(task.lastActivityAt) || timeValue(task.createdAt);
      return Math.max(sessionActivity,
        ...(task.history || []).filter((entry) => entry?.by === "user").map((entry) => timeValue(entry.at)));
    }

    function activityCutoff(days, now = Date.now()) {
      return now - (Number(days) || 30) * 86_400_000;
    }

    function isHistoricalTask(task, cutoff) {
      const at = taskActivityAt(task);
      return at > 0 && at < cutoff && task.origin !== "manual" && !task.pinned &&
        !(task.dueDate && task.status !== "done" && !task.archived) &&
        !taskRunningLabel(task) && !task.pendingSessions?.length;
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
      notes: 4000,
      projectName: 60,
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

    /** 输入法正在组词时的按键。React 合成事件不带 isComposing，要读原生事件；keyCode 229 兜底。 */
    function isComposingKey(event) {
      return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
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
        error.code = payload?.error;
        throw error;
      }
      return payload;
    }

    async function command(op, payload) {
      try {
        const result = await apiRequest(op.startsWith("backup.") ? "/backup" : "/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, payload: payload || {} }),
        });
        if (!["backup.preview", "task.continuePrompt"].includes(op)) invalidateBoardState();
        return result;
      } catch (error) {
        if (error.code === "revision-conflict") invalidateBoardState();
        throw error;
      }
    }

    function draftChanges(base, draft, latest) {
      const patch = {};
      const conflicts = [];
      for (const [field, value] of Object.entries(draft)) {
        if (Object.is(base[field], value) || Object.is(latest[field], value)) continue;
        patch[field] = value;
        if (!Object.is(base[field], latest[field])) conflicts.push(field);
      }
      return { patch, conflicts };
    }

    const EDIT_FIELD_LABELS = {
      name: "项目名称", title: "标题", goal: "目标", acceptanceCriteria: "验收条件",
      projectId: "项目", notes: "备注", dueDate: "到期日", status: "状态", priority: "优先级",
      progress: "进度", archived: "归档", workspaceId: "自动归入的工作区",
    };

    function DraftConflict({ fields, onResolve }) {
      return h("div", { className: "sk-edit-conflict", role: "status" },
        h("span", null, `这些字段在编辑期间也有更新：${fields.map((field) => EDIT_FIELD_LABELS[field]).join("、")}`),
        h("div", { className: "sk-inline-actions" },
          h("button", { type: "button", className: "sk-btn", onClick: () => onResolve(true) }, "保留我的修改"),
          h("button", { type: "button", className: "sk-btn", onClick: () => onResolve(false) }, "采用这些字段的最新值")));
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
    function timeValue(value) {
      return (typeof value === "number" && Number.isFinite(value) ? value : Date.parse(value)) || 0;
    }

    function relTimeValue(value) {
      return relTime(timeValue(value));
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
        budgetUsed: Math.max(Number(raw.budgetUsed) || 0, Number(raw.calls) || 0),
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

    function selectedModelLabel(route) {
      if (!route?.model) return route?.ok === false ? "未配置模型" : "DSH 默认";
      return modelNameOf(route.provider, route.model);
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
          const payload = await apiRequest(manual ? "/ai/models?refresh=1" : "/ai/models", { signal: controller.signal });
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
          text: `已保存：${modelLabel(current.provider, current.model)}；${detail}。如果提供方仍可用，系统会继续尝试此模型。${
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
          text: `DSH 尚未设置默认模型。请选择目录中的模型，或先在 DSH 设置中设定默认模型。${failText}`,
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

    function normalizePrefs(value = {}) {
      // 0.9 及更早的偏好没有 version：悬浮入口改为默认常驻；只有主动开启过的用户保留其样式与摘要选择。
      const legacy = value.version !== PREFS_VERSION;
      const configured = !legacy || value.floatEnabled === true;
      const selected = Array.isArray(value.floatSummaries) ? value.floatSummaries : [];
      const floatSummaries = Object.keys(FLOAT_SUMMARIES).filter((id) => selected.includes(id));
      const offset = Number(value.floatOffset);
      return {
        version: PREFS_VERSION,
        surface: Object.hasOwn(SURFACES, value.surface) ? value.surface : value.sideEntry === false ? "page" : DEFAULT_PREFS.surface,
        floatEnabled: legacy ? true : value.floatEnabled !== false,
        floatStyle: configured && Object.hasOwn(FLOAT_STYLES, value.floatStyle) ? value.floatStyle : DEFAULT_PREFS.floatStyle,
        floatPosition: value.floatPosition === "left" ? "left" : "right",
        floatOffset: Number.isFinite(offset) ? Math.max(0, Math.min(4000, Math.round(offset))) : 0,
        floatSummaries: configured && floatSummaries.length ? floatSummaries : [...DEFAULT_PREFS.floatSummaries],
        floatHideEmpty: !legacy && value.floatHideEmpty === true,
        floatSize: value.floatSize === "large" ? "large" : "normal",
        floatPinned: value.floatPinned === true,
      };
    }

    /** 极小的外部状态容器：跨形态（全局 / 右侧 / 悬浮）共享的界面状态都放在这里。 */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        get: () => value,
        set(next) {
          const resolved = typeof next === "function" ? next(value) : next;
          if (resolved === value) return;
          value = resolved;
          for (const listener of [...listeners]) listener(value);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function useStore(store) {
      const [value, setValue] = React.useState(() => store.get());
      React.useEffect(() => {
        setValue(store.get());
        return store.subscribe(setValue);
      }, [store]);
      return value;
    }

    function readPrefs() {
      try {
        return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY)) || {});
      } catch {
        return { ...DEFAULT_PREFS };
      }
    }

    const prefsStore = createStore(readPrefs());
    /** 悬浮看板面板是否展开（悬浮入口本身由偏好 floatEnabled 控制）。 */
    const floatStore = createStore(false);
    /** 由浮层承载的快聊：null 为关闭；对象为打开，可带 { reference, mode, input }。 */
    const overlayChatStore = createStore(null);
    /** 悬浮入口被隐藏后的一次性提示（带撤销）。 */
    const floatNoticeStore = createStore(null);
    /** 已挂载的浮层快聊宿主数量；为 0 说明当前 DSH 没有提供 shell.overlay 插槽。 */
    let overlayHosts = 0;
    /** 当前打开的看板对话框数量：有对话框时悬浮入口让位，避免盖住底部按钮。 */
    const dialogCountStore = createStore(0);
    /** 已挂载的右侧看板登记自己的关闭动作；切到悬浮形态时逐个调用，保证两种形态不同时出现。 */
    const sideClosers = new Set();
    const sideCountStore = createStore(0);
    const pageTaskListeners = new Set();
    let requestedPageTask = null;

    function updatePrefs(patch) {
      const next = normalizePrefs({ ...prefsStore.get(), ...patch });
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* localStorage may be unavailable */
      }
      prefsStore.set(next);
    }

    function useUiPrefs() {
      return useStore(prefsStore);
    }

    function setFloatingOpen(open) {
      floatStore.set(Boolean(open));
    }

    function SurfacePicker({ value, onChange, className, label = "看板形态" }) {
      return h("select", { className, value, title: label, "aria-label": label, onChange: (event) => onChange(event.target.value) },
        Object.entries(SURFACES).map(([id, text]) => h("option", { key: id, value: id }, text)));
    }

    /** 看板工具栏里的形态切换：三个图标按钮，当前形态高亮。 */
    function SurfaceSwitch({ value, onChange }) {
      return h("div", { className: "sk-surface-switch", role: "group", "aria-label": "看板形态" },
        Object.entries(SURFACES).map(([id, text]) => h("button", {
          key: id, type: "button", "aria-pressed": value === id, "aria-label": text, title: `${text} · ${SURFACE_HINTS[id]}`,
          onClick: () => { if (value !== id) onChange(id); },
        }, h(Icon, { name: SURFACE_ICONS[id], size: 15 }))));
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
      surfacePage: (p) => h(Svg, p, h("rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }), h("path", { d: "M3.5 9h17" })),
      surfaceFloat: (p) => h(Svg, p, h("path", { d: "M20.5 10V6.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9" }), h("rect", { x: 12, y: 12.5, width: 8.5, height: 7, rx: 1.5 })),
      pin: (p) => h(Svg, p, h("path", { d: "M9 4h6l-1 6 3.5 3.5h-11L10 10z" }), h("path", { d: "M12 13.5V20" })),
      expand: (p) => h(Svg, p, h("path", { d: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" })),
      shrink: (p) => h(Svg, p, h("path", { d: "M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6" })),
      eyeOff: (p) => h(Svg, p, h("path", { d: "M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4M6.5 7.6A13.5 13.5 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.3 9.3 0 0 0 4-.9M9.9 10a3 3 0 0 0 4.1 4.1" })),
      eye: (p) => h(Svg, p, h("path", { d: "M2.5 12c1-2 4.5-6 9.5-6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" }), h("circle", { cx: 12, cy: 12, r: 3 })),
      sideLeft: (p) => h(Svg, p, h("path", { d: "M11 6 5 12l6 6M5 12h14" })),
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
.sk-page,.sk-floating,.sk-overlay-host,.sk-host-header{--sk-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));--sk-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.045));
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
  --sk-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));--sk-dur:var(--ds-transition-duration,.2s);}
.sk-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;overflow:hidden;
  color:var(--sk-ink);background:var(--dsw-alias-bg-base,#fff);position:relative;
  padding:calc(var(--dsh-frame-top-clearance,0px) + 22px) 26px 16px;
  font-family:var(--dsh-font-family-text-default,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
  font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
.sk-page *,.sk-page *::before,.sk-page *::after{box-sizing:border-box}
.sk-page button,.sk-page input,.sk-page textarea,.sk-page select{font-family:inherit}
.sk-page ::selection{background:color-mix(in srgb,var(--sk-accent) 24%,transparent)}
.sk-page ::-webkit-scrollbar,.sk-floating ::-webkit-scrollbar,.sk-overlay-host ::-webkit-scrollbar{width:6px;height:6px}
.sk-page ::-webkit-scrollbar-thumb,.sk-floating ::-webkit-scrollbar-thumb,.sk-overlay-host ::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l1,#e5e5e5));border-radius:99px}
.sk-page ::-webkit-scrollbar-thumb:hover,.sk-floating ::-webkit-scrollbar-thumb:hover,.sk-overlay-host ::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,var(--dsw-alias-scrollbar-hover-l1,#d4d4d4))}
.sk-page ::-webkit-scrollbar-track,.sk-floating ::-webkit-scrollbar-track,.sk-overlay-host ::-webkit-scrollbar-track{background:transparent}
.sk-page ::-webkit-scrollbar-button,.sk-floating ::-webkit-scrollbar-button,.sk-overlay-host ::-webkit-scrollbar-button{display:none}
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
.sk-page,.sk-floating,.sk-overlay-host{--sk-brand-accent:var(--dsw-alias-state-business-primary,#4176e6)}
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
.sk-slimbar.is-project-view>:not(.sk-view-switch,.sk-view-picker){display:none}
.sk-slimbar .sk-ws-picker{min-width:0}
.sk-running-filter{white-space:nowrap}
.sk-run-label{display:inline-flex;align-items:center;gap:5px;color:var(--sk-ink-2);font-size:11px;white-space:nowrap}
.sk-run-label::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:var(--sk-green)}
.sk-run-label:not(.is-estimated)::before,.sk-session-line .sk-live-dot.is-live{animation:skPulse 1.8s ease-in-out infinite}
.sk-run-label.is-estimated::before{background:var(--sk-ink-4)}
.sk-card-planning,.sk-task-plan-line{display:flex;align-items:center;flex-wrap:wrap;gap:5px 10px;color:var(--sk-ink-2);font-size:11px}
.sk-task-row-meta>.sk-run-label{margin-inline-end:8px}
.sk-planning-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.sk-planning-fields :is(input,select){width:100%;min-width:0}
.sk-new-planning{border-top:1px solid var(--sk-line);padding-top:8px}
.sk-new-planning summary,.sk-project-archive summary{cursor:pointer;font-size:13px;color:var(--sk-ink-2)}
.sk-new-planning[open]>:not(summary){margin-top:10px}
.sk-preserve-lines{white-space:pre-wrap;overflow-wrap:anywhere}
.sk-projects{padding:12px 2px 18px}
.sk-projects-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.sk-projects-head h2{font-size:16px;margin:0 auto 0 0}
.sk-project-grid{display:grid;align-items:start;grid-template-columns:repeat(auto-fill,minmax(min(100%,264px),1fr));gap:10px}
.sk-project-card{display:grid;gap:9px;border:1px solid var(--sk-line);border-radius:10px;padding:13px;background:var(--sk-surface);min-width:0}
.sk-project-card h3,.sk-project-card p{margin:0;overflow-wrap:anywhere}
.sk-project-card h3{font-size:15px}
.sk-project-metrics,.sk-chat-status{font-size:12px;color:var(--sk-ink-2)}
.sk-project-card progress{width:100%;height:6px;accent-color:var(--sk-green)}
.sk-project-note{font-size:13px;line-height:1.5;max-height:8em;overflow:auto}
.sk-project-archive{margin-top:16px}
.sk-project-archive .sk-project-grid{margin-top:10px}
.sk-edit-conflict{display:grid;gap:8px;color:var(--sk-ink-2);font-size:12px;line-height:1.5;padding:9px 0}
.sk-schedule-group{margin-bottom:14px}
.sk-schedule-group h2{font-size:14px;margin:8px 0}
.sk-schedule-group h2 span{font-weight:400;color:var(--sk-ink-3);margin-inline-start:8px}
/* ---------- model button (shared by toolbar, quick chat and settings) ---------- */
.sk-model-controls{position:relative}
.sk-model-controls .sk-select{padding-inline-end:25px}
.sk-model-controls .sk-ws-caret{inset-inline-end:8px}
.sk-model-button{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:55%}
.sk-model-button svg,.sk-model-trigger svg{flex:none}
.sk-model-button span,.sk-model-trigger span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sk-header-actions .sk-model-trigger.is-warn{color:var(--sk-amber)}
.sk-page:not(.sk-compact-header) .sk-header-actions .sk-model-trigger{display:inline-flex;align-items:center;gap:5px;width:auto;max-width:148px;padding:0 7px;font-size:12px}
.sk-iconbtn-v3.sk-chat-trigger{display:inline-flex;align-items:center;justify-content:center;width:auto;gap:5px;padding:0 7px;white-space:nowrap;font-size:12px}
.sk-tier-narrow .sk-slimbar .sk-count{display:none}
.sk-tier-narrow .sk-slimbar{flex-wrap:wrap}
.sk-activity-picker{max-width:110px;font-size:12px}
/* ---------- quick chat ---------- */
.sk-modal.sk-chat-modal{width:min(720px,calc(100vw - 32px));height:min(780px,calc(100dvh - 48px));max-height:none;padding:16px 18px 12px;gap:10px}
.sk-page.is-side .sk-modal.sk-chat-modal{width:100%;height:100%}
.sk-chat-head{display:flex;align-items:center;gap:8px;min-width:0}
.sk-chat-head h3{margin-inline-end:auto}
.sk-chat-head .sk-model-button{max-width:40%}
.sk-chat-modes,.sk-chat-starters{display:flex;flex-wrap:wrap;gap:6px}
.sk-chat-modes .sk-chip,.sk-chat-starters .sk-chip{height:26px;padding:0 10px;border-radius:999px;font-size:12px;background:transparent;color:var(--sk-ink-2)}
.sk-chat-modes .sk-chip:hover:not(:disabled):not([aria-pressed=true]),.sk-chat-starters .sk-chip:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-chat-modes .sk-chip[aria-pressed=true]{border-color:transparent;background:var(--sk-primary);color:var(--sk-on-primary);font-weight:500}
.sk-chat-modes .sk-chip:disabled{opacity:.5;cursor:default}
.sk-chat-thread{flex:1 1 0;min-height:120px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:16px;
  border:1px solid var(--sk-line);border-radius:12px;padding:14px;background:var(--sk-surface-2);font-size:13px;line-height:1.6}
.sk-chat-empty{margin:auto;max-width:420px;display:grid;gap:8px;justify-items:center;text-align:center;color:var(--sk-ink-3);font-size:12px}
.sk-chat-empty p{margin:0}
.sk-chat-empty-title{font-size:13px;color:var(--sk-ink-2)}
.sk-chat-starters{justify-content:center;margin-top:6px}
.sk-chat-turn{display:grid;gap:8px;min-width:0}
.sk-chat-question{justify-self:end;max-width:88%;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;border-radius:12px 12px 4px 12px;padding:7px 11px;
  background:color-mix(in srgb,var(--sk-accent) 12%,var(--sk-surface))}
.sk-chat-question p{margin:0;min-width:0;max-height:9.6em;overflow:auto}
.sk-chat-tag{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--sk-ink) 8%,transparent);color:var(--sk-ink-2)}
.sk-chat-answer{min-width:0;border-radius:4px 12px 12px 12px;padding:9px 12px;background:var(--sk-surface);border:1px solid var(--sk-line-soft)}
.sk-chat-turn-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;font-size:11px;color:var(--sk-ink-3)}
.sk-chat-turn-meta>span:first-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sk-chat-actions{display:flex;flex:none;gap:12px}
.sk-chat-actions .sk-text:hover:not(:disabled){color:var(--sk-ink)}
.sk-chat-actions .sk-text:disabled{opacity:.45;cursor:default}
.sk-chat-reference{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 9px;border:1px dashed var(--sk-line-strong);border-radius:8px;font-size:12px;color:var(--sk-ink-2)}
.sk-chat-reference>span:first-of-type{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--sk-ink)}
.sk-chat-reference-note{flex:none;margin-inline-end:auto;color:var(--sk-ink-3)}
.sk-chat-composer{display:flex;align-items:flex-end;gap:8px}
.sk-chat-composer .sk-textarea{flex:1;min-width:0;min-height:52px;max-height:190px;resize:none;font-size:13px;line-height:1.5}
.sk-chat-composer .sk-btn{flex:none;height:34px}
.sk-chat-foot{margin:0;font-size:11px;color:var(--sk-ink-3)}
/* ---------- markdown (model answers) ---------- */
.sk-md{display:grid;gap:8px;min-width:0;overflow-wrap:anywhere}
.sk-md p,.sk-md blockquote,.sk-md ul{margin:0}
.sk-md p{white-space:pre-wrap}
.sk-md-heading{font-weight:650;font-size:13.5px}
.sk-md blockquote{padding:2px 0 2px 10px;border-inline-start:3px solid var(--sk-line-strong);color:var(--sk-ink-2);white-space:pre-wrap}
.sk-md-list{list-style:none;padding:0;display:grid;gap:3px}
.sk-md-list li{display:flex;gap:7px;min-width:0}
.sk-md-list li>span:last-child{min-width:0;white-space:pre-wrap}
.sk-md-marker{flex:none;min-width:1.1em;color:var(--sk-ink-3);font-variant-numeric:tabular-nums}
.sk-md code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.92em}
.sk-md :not(pre)>code{padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--sk-ink) 7%,transparent)}
.sk-md a{color:var(--sk-accent);text-decoration:underline;text-underline-offset:2px}
.sk-md-code{border:1px solid var(--sk-line);border-radius:8px;overflow:hidden;background:var(--sk-surface-2)}
.sk-md-code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 10px;font-size:11px;color:var(--sk-ink-3);border-bottom:1px solid var(--sk-line-soft)}
.sk-md-code pre{margin:0;padding:9px 10px;overflow:auto;max-height:320px;line-height:1.5;tab-size:2}
/* ---------- surface switch & conversation header entry ---------- */
.sk-surface-switch{display:inline-flex;flex:none;gap:1px;padding:2px;border:1px solid var(--sk-line);border-radius:8px;background:var(--sk-surface)}
.sk-surface-switch button{display:grid;place-items:center;width:26px;height:24px;padding:0;border:0;border-radius:5px;background:none;color:var(--sk-ink-3);cursor:pointer}
.sk-surface-switch button:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-surface-switch button[aria-pressed=true]{background:color-mix(in srgb,var(--sk-ink) 9%,transparent);color:var(--sk-ink);cursor:default}
.sk-host-header{display:inline-flex;align-items:center;font:13px/1.45 var(--dsh-font-family-text-default,system-ui,sans-serif)}
.sk-host-header .sk-header-btn{color:var(--sk-ink-2)}
.sk-host-header .sk-header-caret{width:16px;margin-inline-start:-3px;border-radius:5px}
/* ---------- floating board ---------- */
.sk-floating{position:fixed;inset:auto;right:16px;display:grid;justify-items:end;gap:8px;
  bottom:min(calc(max(16px,env(safe-area-inset-bottom)) + var(--sk-float-offset,0px)),calc(100dvh - 64px));
  margin:0;padding:0;border:0;background:transparent;overflow:visible;
  max-width:calc(100vw - 32px);z-index:50;pointer-events:auto;color:var(--sk-ink);font:13px/1.45 var(--dsh-font-family-text-default,system-ui,sans-serif)}
.sk-floating[popover]:not(:popover-open),.sk-overlay-host[popover]:not(:popover-open){display:none}
[inert] .sk-floating{visibility:hidden}
.sk-floating.is-left{right:auto;left:16px;justify-items:start}
.sk-floating *,.sk-overlay-host *{box-sizing:border-box}
.sk-floating button,.sk-floating input,.sk-overlay-host button,.sk-overlay-host textarea,.sk-overlay-host select{font-family:inherit}
.sk-floating :focus-visible,.sk-overlay-host :focus-visible{outline:2px solid color-mix(in srgb,var(--sk-accent) 60%,transparent);outline-offset:2px}
.sk-overlay-host .sk-input:focus-visible,.sk-overlay-host .sk-textarea:focus-visible,.sk-floating .sk-input:focus-visible,.sk-floating .sk-textarea:focus-visible{outline:0}
.sk-overlay-host{position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;
  color:var(--sk-ink);font:13px/1.45 var(--dsh-font-family-text-default,system-ui,sans-serif)}
.sk-overlay-host>*{pointer-events:auto}
.sk-overlay-host .sk-toasts{pointer-events:none}
.sk-float-trigger{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;max-width:100%;min-height:38px;padding:6px 13px;
  border:1px solid var(--sk-line);border-radius:999px;background:var(--sk-surface);color:var(--sk-ink);
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.14);cursor:pointer;font-size:12px;font-variant-numeric:tabular-nums;
  touch-action:none;user-select:none;-webkit-user-select:none;transition:transform .16s var(--sk-ease),box-shadow .16s var(--sk-ease),background .16s var(--sk-ease)}
.sk-float-trigger:hover{background:var(--sk-surface-2);transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.08),0 12px 28px rgba(0,0,0,.18)}
.sk-float-trigger.is-dragging{cursor:grabbing;transform:scale(1.05);transition:none}
.sk-float-trigger.is-behind{visibility:hidden}
.sk-float-trigger.is-badge{width:46px;height:46px;min-height:0;padding:0}
.sk-float-trigger.is-bar{border-radius:12px;gap:10px;flex-wrap:wrap}
.sk-float-trigger b{font-weight:650;color:var(--sk-accent)}
.sk-float-mark{display:flex;color:var(--sk-ink-2)}
.sk-float-count{position:absolute;top:-4px;inset-inline-end:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;
  background:var(--sk-accent);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;box-shadow:0 0 0 2px var(--sk-surface)}
.sk-float-live{position:absolute;bottom:3px;inset-inline-end:3px;width:8px;height:8px;border-radius:50%;background:var(--sk-green);box-shadow:0 0 0 2px var(--sk-surface)}
@media (prefers-reduced-motion:no-preference){
  .sk-float-mark.is-new{animation:sk-float-arrival .46s ease-out}
  .sk-float-live{animation:skPulse 1.8s ease-in-out infinite}
  .sk-float-panel{animation:sk-float-in .16s var(--sk-ease)}
  @keyframes sk-float-arrival{0%,100%{transform:scale(1)}45%{transform:scale(1.22);color:var(--sk-accent)}}
  @keyframes sk-float-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
}
.sk-float-panel{width:min(540px,calc(100vw - 32px));height:min(720px,calc(100dvh - 32px - max(16px,env(safe-area-inset-bottom))));
  display:flex;flex-direction:column;border:1px solid var(--sk-line);border-radius:16px;background:var(--sk-surface);
  box-shadow:0 2px 6px rgba(0,0,0,.06),0 18px 54px rgba(0,0,0,.22);overflow:hidden}
.sk-float-panel.is-large{width:min(860px,calc(100vw - 32px));height:calc(100dvh - 32px - max(16px,env(safe-area-inset-bottom)))}
.sk-float-panel>header{flex:none;padding:10px 10px 8px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.sk-float-panel h2{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:600;margin:0;border-radius:6px}
.sk-float-panel h2 svg{color:var(--sk-ink-3)}
.sk-float-tools{display:flex;align-items:center;gap:2px}
.sk-float-icon{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;color:var(--sk-ink-3);cursor:pointer}
.sk-float-icon:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-float-icon[aria-pressed=true]{background:color-mix(in srgb,var(--sk-accent) 12%,transparent);color:var(--sk-accent)}
.sk-float-metrics{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 14px 10px;border-bottom:1px solid var(--sk-line)}
.sk-float-metrics .sk-btn{height:28px;padding:0 10px;border-radius:999px;color:var(--sk-ink-2)}
.sk-float-metrics .sk-btn b{font-weight:600;font-variant-numeric:tabular-nums}
.sk-float-metrics [aria-pressed=true]{border-color:transparent;background:var(--sk-primary);color:var(--sk-on-primary)}
.sk-float-search{display:flex;align-items:center;gap:5px;flex:1 1 120px;min-width:100px;height:28px;margin-inline-start:auto;padding:0 9px;
  border:1px solid var(--sk-line);border-radius:999px;color:var(--sk-ink-3)}
.sk-float-search:focus-within{border-color:color-mix(in srgb,var(--sk-accent) 55%,transparent)}
.sk-float-search input,.sk-float-add input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--sk-ink);font-size:12px}
.sk-floating .sk-float-search input:focus-visible,.sk-floating .sk-float-add input:focus-visible{outline:0}
.sk-float-search input::-webkit-search-cancel-button{cursor:pointer}
.sk-float-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 14px 10px}
.sk-float-content p{margin:4px 0;color:var(--sk-ink-2);font-size:12px;overflow-wrap:anywhere}
.sk-float-empty{padding:28px 8px;text-align:center}
.sk-float-criteria{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
.sk-float-row{padding:10px 0;border-bottom:1px solid var(--sk-line-soft)}
.sk-float-row:last-of-type{border-bottom:0}
.sk-float-row-head{display:flex;align-items:baseline;gap:7px;min-width:0}
.sk-float-row-head .sk-dot{flex:none;transform:translateY(-2px)}
.sk-float-task{font-size:13px;font-weight:600;color:var(--sk-ink);text-align:start;white-space:normal;overflow-wrap:anywhere}
.sk-float-task:hover{text-decoration:underline;text-underline-offset:2px}
.sk-float-row .sk-inline-actions{gap:6px;margin-top:6px}
.sk-float-row .sk-btn{height:28px;padding:0 10px}
.sk-float-row .sk-btn.ghost{border-color:var(--sk-line);color:var(--sk-ink-2)}
.sk-float-more{width:100%;margin-top:8px}
.sk-float-add{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 14px;border-top:1px solid var(--sk-line);color:var(--sk-ink-3)}
.sk-float-add:focus-within{color:var(--sk-ink)}
.sk-float-add input{font-size:13px;height:30px}
.sk-float-add .sk-btn{height:28px}
.sk-float-panel>footer{flex:none;padding:6px 14px 8px;border-top:1px solid var(--sk-line-soft);color:var(--sk-ink-2);font-size:12px}
.sk-float-notice{display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));padding:9px 12px;border-radius:10px;
  background:var(--dsw-alias-toast-bg,#353638);color:var(--dsw-alias-toast-label,#fff);font-size:12px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.22)}
.sk-float-notice .sk-text{flex:none;color:inherit;text-decoration:underline;text-underline-offset:2px}
.sk-floating .sk-modal-mask{padding:12px}
/* ---------- review strip: finished turns pinned above the launcher ---------- */
.sk-pin-stack{display:grid;gap:6px;justify-self:end;width:min(240px,calc(100vw - 32px))}
.sk-floating.is-left .sk-pin-stack{justify-self:start}
.sk-pin-card{position:relative;display:flex;align-items:center;gap:8px;min-height:52px;padding:7px 8px 7px 9px;
  cursor:pointer;user-select:none;-webkit-user-select:none;
  border:1px solid var(--sk-line);border-radius:12px;background:color-mix(in srgb,var(--sk-surface) 94%,transparent);
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 18px rgba(0,0,0,.10);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  transition:border-color .16s var(--sk-ease),box-shadow .16s var(--sk-ease),transform .16s var(--sk-ease);overflow:hidden}
.sk-pin-card:hover{border-color:var(--sk-line-strong);transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.06),0 14px 30px rgba(0,0,0,.17)}
.sk-pin-card:focus-visible{outline:2px solid color-mix(in srgb,var(--sk-green) 65%,transparent);outline-offset:2px}
.sk-pin-avatar{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;
  background:var(--sk-folder,#64748B);color:#fff;font-size:10.5px;font-weight:700;line-height:1;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.sk-pin-open{flex:1;min-width:0;display:grid;gap:1px;padding:0;text-align:start}
.sk-pin-marquee{display:block;min-width:0;overflow:hidden}
.sk-pin-title{display:block;font-size:12.5px;font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 只有真的放不下时才在悬停时切成跑马灯；静止状态保持干净的省略号。 */
.sk-pin-card:hover .sk-pin-marquee.is-overflow{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 14px),transparent 100%);
  mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 14px),transparent 100%)}
.sk-pin-card:hover .sk-pin-marquee.is-overflow .sk-pin-title{display:inline-block;max-width:none;overflow:visible;text-overflow:clip;
  animation:sk-pin-marquee var(--sk-marquee-duration,3s) linear infinite alternate}
@keyframes sk-pin-marquee{from{transform:translateX(0)}to{transform:translateX(var(--sk-marquee-shift,0))}}
.sk-pin-meta{font-size:10.5px;line-height:1.35;color:var(--sk-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.sk-pin-check{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid transparent;
  border-radius:50%;background:var(--sk-green);color:#fff;cursor:pointer;box-shadow:0 2px 6px color-mix(in srgb,var(--sk-green) 34%,transparent);
  opacity:0;transform:translateX(3px);pointer-events:none;transition:opacity .14s var(--sk-ease),transform .14s var(--sk-ease),filter .14s}
.sk-pin-card:hover .sk-pin-check,.sk-pin-card:focus-within .sk-pin-check{opacity:1;transform:none;pointer-events:auto}
.sk-pin-check:hover{filter:brightness(1.07)}
.sk-pin-check:disabled{opacity:.5;cursor:progress;filter:none}
.sk-pin-spin{width:10px;height:10px;border-radius:50%;border:1.6px solid color-mix(in srgb,currentColor 28%,transparent);border-top-color:currentColor;
  animation:sk-pin-spin .9s linear infinite}
.sk-pin-more{justify-self:end;height:26px;padding:0 10px;border:1px solid var(--sk-line);border-radius:999px;background:var(--sk-surface);
  color:var(--sk-ink-2);font-size:11px;cursor:pointer;font-variant-numeric:tabular-nums}
.sk-pin-more:hover{background:var(--sk-hover);color:var(--sk-ink)}
.sk-pin-status{margin:0;padding:0 6px;font-size:11px;line-height:1.4;color:var(--sk-ink-3);text-align:end;overflow-wrap:anywhere}
@keyframes sk-pin-spin{to{transform:rotate(360deg)}}
@media (hover:none){.sk-pin-check{opacity:1;transform:none;pointer-events:auto}}
@media (prefers-reduced-motion:reduce){
  .sk-pin-spin{animation:none;border-color:currentColor}
  .sk-pin-card{transition:none}
  .sk-pin-card:hover .sk-pin-marquee.is-overflow .sk-pin-title{animation:none}
}
@media (prefers-reduced-motion:no-preference){
  .sk-pin-card{animation:sk-pin-in .18s var(--sk-ease)}
  @keyframes sk-pin-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
}
/* ---------- settings: display section ---------- */
.sk-float-options{min-width:0;display:flex;flex-wrap:wrap;gap:8px 16px;margin:0;padding:8px 10px;border:1px solid var(--sk-line);border-radius:8px}
.sk-float-options label{display:flex;gap:5px;align-items:center}
.sk-settings-hint{margin:0;font-size:12px;line-height:1.5;color:var(--sk-ink-3)}
.sk-settings-heading{margin:8px 0 -4px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--sk-ink-3)}
.sk-settings-heading:first-child{margin-top:0}
.sk-settings-heading+.sk-settings-row{border-top:none;padding-top:0}
.sk-settings-row>.sk-select,.sk-settings-row>.sk-settings-controls{flex:none}
.sk-settings-row{flex-wrap:wrap}
.sk-settings-row .label{flex:1 1 200px}
.sk-settings-row>.sk-settings-controls{display:flex;align-items:center;gap:8px;max-width:100%}
.sk-settings-row>.sk-settings-controls .sk-select{flex:none;min-width:96px}
.sk-settings-row>.sk-float-options{flex:none;border:0;padding:0;gap:6px 12px;font-size:12px}
.sk-settings-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap}
/* ---------- workspace › project scope ---------- */
.sk-task-scope{display:inline-flex;align-items:center;gap:5px;min-width:0;color:var(--sk-ink-2)}
.sk-task-scope svg{flex:none;color:var(--sk-ink-3)}
.sk-projects-guide{margin:0 0 14px;max-width:720px;font-size:12px;line-height:1.6;color:var(--sk-ink-3)}
.sk-project-section>h3 span{margin-inline-start:8px;font-weight:400;font-size:12px;color:var(--sk-ink-3)}
.sk-project-section{margin:14px 0 20px}
.sk-project-section>h3{font-size:13px;margin:0 0 9px;color:var(--sk-ink-2)}
.sk-timeline h2{font-size:17px;margin:8px 0 16px}
.sk-timeline-day{margin-bottom:18px}
.sk-timeline-day h3{font-size:12px;color:var(--sk-ink-2);margin:0 0 6px}
.sk-timeline-day ol{list-style:none;margin:0;padding:0 0 0 13px;border-inline-start:1px solid var(--sk-line)}
.sk-timeline-day li{position:relative;display:grid;justify-items:start;gap:4px;padding:7px 0 11px;min-width:0}
.sk-timeline-links{display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap;min-width:0}
.sk-timeline-day li::before{content:"";position:absolute;inset-inline-start:-17px;top:13px;width:7px;height:7px;border-radius:50%;background:var(--sk-accent)}
.sk-timeline-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--sk-ink-2);font-size:11px}
.sk-timeline-meta time{font-variant-numeric:tabular-nums}
.sk-timeline-task,.sk-float-task{font-weight:650;text-align:start;overflow-wrap:anywhere}
.sk-timeline-day p{margin:0;color:var(--sk-ink-2);white-space:pre-line;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){
  .sk-run-label::before,.sk-session-line .sk-live-dot.is-live{animation:none!important}
}
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
    function useDialogFocus(rootRef, onEscape, returnFocus) {
      const escapeRef = React.useRef(onEscape);
      React.useEffect(() => {
        escapeRef.current = onEscape;
      });
      React.useEffect(() => {
        const token = Symbol("dialog");
        const node = rootRef.current;
        const previous = returnFocus?.current || document.activeElement;
        dialogStack.push(token);
        dialogCountStore.set(dialogStack.length);
        const initial = node?.querySelector("[data-sk-initial-focus]") || focusableIn(node)[0];
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
          dialogCountStore.set(dialogStack.length);
          if (previous && previous.isConnected && typeof previous.focus === "function") {
            previous.focus({ preventScroll: true });
          }
        };
      }, [rootRef, returnFocus]);
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
          aiRoute: payload.aiRoute || null,
          usage: payload.usage || null,
          stats: payload.stats || null,
          activity: payload.activity || null,
          workspaces: payload.workspaces || null,
          projects: payload.projects || null,
        });
      } catch {
        return "";
      }
    }

    let sharedStateRequest = null;
    let stateGeneration = 0;

    function invalidateBoardState() {
      stateGeneration += 1;
      boardRefresh?.notify();
    }

    function requestBoardState() {
      if (sharedStateRequest?.generation !== stateGeneration) {
        const entry = { generation: stateGeneration };
        entry.promise = apiRequest("/state").finally(() => {
          if (sharedStateRequest === entry) sharedStateRequest = null;
        });
        sharedStateRequest = entry;
      }
      return sharedStateRequest;
    }

    const boardSubscribers = new Map();
    let boardRefresh = null;

    function subscribeBoardRefresh(load) {
      boardSubscribers.set(load, false);
      if (!boardRefresh) {
        let timer;
        let eventTimer;
        const refresh = () => {
          if (!document.hidden) for (const subscriber of boardSubscribers.keys()) subscriber(true);
        };
        const schedule = () => {
          clearTimeout(timer);
          if (document.hidden || !boardSubscribers.size) return;
          const delay = [...boardSubscribers.values()].some(Boolean) ? POLL_SCAN_MS : POLL_MS;
          timer = setTimeout(() => { refresh(); schedule(); }, delay);
        };
        const visible = () => { refresh(); schedule(); };
        const notify = () => {
          if (document.hidden || eventTimer) return;
          eventTimer = setTimeout(() => { eventTimer = null; refresh(); }, 180);
        };
        const stream = typeof EventSource === "function" ? new EventSource(new URL(`${API}/events`, document.baseURI)) : null;
        stream?.addEventListener("changed", invalidateBoardState);
        stream?.addEventListener("scan", notify);
        document.addEventListener("visibilitychange", visible);
        boardRefresh = {
          notify,
          schedule,
          dispose() {
            clearTimeout(timer);
            clearTimeout(eventTimer);
            stream?.close();
            document.removeEventListener("visibilitychange", visible);
          },
        };
      }
      boardRefresh.schedule();
      return () => {
        boardSubscribers.delete(load);
        if (boardSubscribers.size) boardRefresh.schedule();
        else {
          boardRefresh.dispose();
          boardRefresh = null;
        }
      };
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
        const entry = requestBoardState();
        if (inflight.current?.entry === entry) return inflight.current.task;
        if (!silent) setLoading(true);
        const isCurrent = () => mounted.current && inflight.current?.entry === entry && entry.generation === stateGeneration;
        const task = entry.promise
          .then((payload) => {
            if (!isCurrent()) return null;
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
            if (!isCurrent()) return null;
            setError(String(cause?.message || cause));
            setLoading(false);
            return null;
          })
          .finally(() => {
            if (inflight.current?.entry === entry) inflight.current = null;
          });
        inflight.current = { entry, task };
        return task;
      }, []);

      React.useEffect(() => {
        load(false);
      }, [load]);

      const scanning = data?.scan?.state === "running";
      React.useEffect(() => subscribeBoardRefresh(load), [load]);
      React.useEffect(() => {
        boardSubscribers.set(load, scanning);
        boardRefresh.schedule();
      }, [load, scanning]);

      const applyLocalState = React.useCallback((update) => {
        // The next server snapshot must reconcile any local change, even if it
        // matches the last snapshot (e.g. another window switched back).
        signature.current = "";
        setData(update);
      }, []);
      return { data, error, loading, reload: load, setData: applyLocalState };
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
      const summary = signal && signal.kind !== "due"
        ? [signal.label, signal.text].filter(Boolean).join(" · ")
        : (!done ? task.nextSteps?.[0] : null);
      const running = taskRunningLabel(task);
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
            "aria-label": `${task.title}（${[STATUS_META[taskStatus].label, running, signal?.label].filter(Boolean).join(" · ")}）`,
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
          h("span", { className: "sk-card-ws", title: [taskScopeLabel(task), task.workspacePath].filter(Boolean).join(" · ") }, taskScopeLabel(task) || "未分组"),
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
        running || task.dueDate ? h("div", { className: "sk-card-planning" },
          running && h("span", { className: cx("sk-run-label", task.sessionContext?.estimated && "is-estimated") }, running),
          task.dueDate && h("span", { title: task.dueDate }, dueLabel(task))) : null,
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
          !collapsed && onAdd ? h(
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
        onAdd ? h(
          "button",
          { type: "button", className: "sk-narrow-add", onClick: () => onAdd(status) },
          h(Icon, { name: "plus", size: 13 }),
          `新建任务`,
        ) : null,
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
    function ContinueTaskModal({ task, initialTarget, initialPurpose, initialSessionId, ctxProps, workspaces, pushToast, feedback, returnFocus, onClose, onDone }) {
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
      const titleId = React.useId();
      useDialogFocus(dialogRef, onClose, returnFocus);
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
            "aria-labelledby": titleId,
          },
          h("h3", { id: titleId }, h(Icon, { name: "play", size: 15 }), "继续此任务"),
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
            feedback ? h("div", { className: "sk-note-tiny", role: "status" }, feedback) : null,
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

    function TaskPlanningFields({ values, update, projects }) {
      return h(React.Fragment, null,
        h("div", { className: "sk-planning-fields" },
          h("label", { className: "sk-field" }, "项目",
            h("select", { className: "sk-select", value: values.projectId, onChange: (event) => update({ projectId: event.target.value }) },
              h("option", { value: "" }, "未归属"),
              projects.filter((project) => !project.archived || project.id === values.projectId)
                .map((project) => h("option", { key: project.id, value: project.id }, project.name + (project.archived ? "（已归档）" : ""))))),
          h("label", { className: "sk-field" }, "到期日",
            h("input", { type: "date", className: "sk-input", "data-planning-field": "dueDate", value: values.dueDate, onChange: (event) => update({ dueDate: event.target.value }) }))),
        h("label", { className: "sk-field" }, "备注",
          h("textarea", { className: "sk-textarea", "data-planning-field": "notes", rows: 3, maxLength: TEXT_LIMITS.notes, value: values.notes,
            placeholder: "记录决策、背景或提醒", onChange: (event) => update({ notes: event.target.value }) })));
    }

    function TaskDrawer({ task, signal, tasks, workspaces, projects = [], onOpenTask, ctxProps, settings, desktopFiles, onClose, onChanged, onAskChat, pushToast }) {
      const host = (ctxProps && ctxProps.host) || {};
      const goal = goalInfoOf(task);
      const session = sessionContextOf(task);
      const locked = Array.isArray(task.lockedFields) ? task.lockedFields : [];
      const currentEditValues = () => ({
        title: task.title || "",
        goal: (goal && goal.text) || "",
        acceptanceCriteria: task.acceptanceCriteria || "",
        projectId: task.projectId || "",
        notes: task.notes || "",
        dueDate: task.dueDate || "",
        status: task.status || "backlog",
        priority: task.priority || "P2",
        progress: pct(task.progress),
      });
      const [draft, setDraft] = React.useState(currentEditValues);
      const [editing, setEditing] = React.useState(false);
      const [planningFocus, setPlanningFocus] = React.useState(null);
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
      const accepted = isAccepted(task);
      const canAccept = canAcceptTask(task, primaryArtifact);
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

      const resetDraft = () => {
        const values = currentEditValues();
        editBase.current = { values, updatedAt: task.updatedAt };
        setDraft(values);
      };

      const editPlanning = (field) => {
        resetDraft();
        setPlanningFocus(field);
        setEditing(true);
      };

      React.useLayoutEffect(() => {
        if (!editing || !planningFocus) return;
        dialogRef.current?.querySelector(`[data-planning-field="${planningFocus}"]`)?.focus();
        setPlanningFocus(null);
      }, [editing, planningFocus]);

      const values = currentEditValues();
      const changes = draftChanges(editBase.current?.values || values, draft, values);
      const rebaseDraft = (preserveConflicts) => {
        const patch = Object.fromEntries(Object.entries(changes.patch)
          .filter(([field]) => preserveConflicts || !changes.conflicts.includes(field)));
        editBase.current = { values, updatedAt: task.updatedAt };
        setDraft({ ...values, ...patch });
      };

      // 只在切换到另一张任务卡时重置编辑态；轮询/扫描导致 updatedAt 变化不能吞掉用户草稿。
      React.useEffect(() => {
        resetDraft();
        setEditing(false);
        setOptimisticSubtasks(null);
      }, [task.id]);

      React.useEffect(() => {
        setOptimisticSubtasks(null);
      }, [task.updatedAt]);
      React.useEffect(() => {
        if (editing && !saving && editBase.current?.updatedAt !== task.updatedAt && !changes.conflicts.length) rebaseDraft(true);
      }, [task.updatedAt, draft, editing, saving]);

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
        if (saving || changes.conflicts.length) return;
        setSaving(true);
        try {
          const patch = Object.fromEntries(Object.entries(changes.patch).map(([field, value]) =>
            [field, typeof value === "string" ? value.trim() : value]));
          const changed = Object.keys(patch);
          if (changed.length) await command("task.update", { id: task.id, patch,
            lockFields: changed.filter((field) => EDITABLE_FIELDS.includes(field)), expectedUpdatedAt: task.updatedAt });
          pushToast("已保存", "info");
          setEditing(false);
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
          run("解锁", () => command("task.unlock", { id: task.id }), "已交还 AI 维护");
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
        onAskChat && { label: "就此任务快聊", icon: "chat", run: () => onAskChat(task) },
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
                    h(TaskPlanningFields, { values: draft, update, projects }),
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
                      h("div", { className: "sk-task-plan-line" },
                        taskScopeLabel(task) ? h("span", { className: "sk-task-scope", title: "所属工作区 › 自建项目" },
                          h(Icon, { name: "folder", size: 12 }), taskScopeLabel(task)) : null,
                        h("button", { type: "button", className: "sk-text sk-planning-action", onClick: () => editPlanning("dueDate"),
                          "aria-label": task.dueDate ? "修改到期日" : "设置到期日", title: task.dueDate ? `修改到期日 · ${task.dueDate}` : undefined },
                          dueLabel(task) || "设置到期日"),
                        h("button", { type: "button", className: "sk-text sk-planning-action", onClick: () => editPlanning("notes") }, task.notes ? "编辑备注" : "添加备注")),
                      task.notes ? h("div", { className: "sk-overview-item" }, h("h3", null, "备注"), h("p", { className: "sk-preserve-lines" }, task.notes)) : null,
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
                          "aria-busy": acceptBusy || undefined }, accepted ? "已人工验收" : acceptBusy ? "正在确认…" : "确认验收")) : null),
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
              editing && changes.conflicts.length
                ? h(DraftConflict, { fields: changes.conflicts, onResolve: rebaseDraft })
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
                    if (event.key === "Enter" && !isComposingKey(event) && subtaskBusy !== "add") addSubtask();
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
                h("span", { className: cx("sk-live-dot", !session.isLive && "off", session.isLive && !task.sessionContext?.estimated && "is-live") }),
                h("span", { className: "sk-session-title", title: session.title }, session.title || "未关联会话"),
              ),
              h(
                "div",
                { className: "sk-session-meta" },
                h("span", null, pending.find((item) => item.id === session.sessionId)?.label || (session.isLive
                  ? task.sessionContext?.estimated ? "可能运行中" : "会话运行中"
                  : session.lastTurnEnd === "error" ? "会话出错" : session.lastTurnEnd === "interrupted" ? "会话中断" : session.sessionId ? "会话空闲" : "未关联")),
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
                  h("button", { type: "button", className: "sk-btn primary", onClick: save, disabled: saving || changes.conflicts.length > 0 }, saving ? "保存中…" : "保存"),
                  h("button", { type: "button", className: "sk-btn ghost", onClick: () => { resetDraft(); setEditing(false); } }, "取消"),
                )
              : h(
                  React.Fragment,
                  null,
                  h("button", { type: "button", className: "sk-btn primary", onClick: () => startContinue("session", ready ? "verify" : task.status === "blocked" ? "unblock" : "continue") }, ready ? "生成核验草稿" : "继续此任务"),
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

    function NewTaskModal({ defaultStatus, workspaces, projects, defaultProjectId, defaultWorkspaceId, sessionId, onClose, onCreate, pushToast }) {
      const [title, setTitle] = React.useState("");
      const [goal, setGoal] = React.useState("");
      const [acceptanceCriteria, setAcceptanceCriteria] = React.useState("");
      const [status, setStatus] = React.useState(defaultStatus || "backlog");
      const [priority, setPriority] = React.useState("P2");
      const [workspaceId, setWorkspaceId] = React.useState(defaultWorkspaceId);
      const [planning, setPlanning] = React.useState({ projectId: defaultProjectId, dueDate: "", notes: "" });
      const [saving, setSaving] = React.useState(false);
      const inputRef = React.useRef(null);
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();

      const create = async () => {
        if (!title.trim() || saving) return;
        setSaving(true);
        try {
          const { data: task } = await command("task.create", { title: title.trim(), goal: goal.trim(), acceptanceCriteria: acceptanceCriteria.trim(), status, priority,
            workspaceId: workspaceId || undefined, sessionId: sessionId || undefined, ...planning });
          pushToast("任务已创建", "info");
          await onCreate(task);
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
              h("input", { ref: inputRef, id: "sk-newtask-title-input", className: "sk-input", value: title, maxLength: TEXT_LIMITS.title, placeholder: "要做什么？", onChange: (event) => setTitle(event.target.value), onKeyDown: (event) => event.key === "Enter" && !isComposingKey(event) && !saving && create() }),
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
            h("details", { className: "sk-new-planning", open: Boolean(defaultProjectId) || undefined },
              h("summary", null, "项目、到期日与备注"),
              h(TaskPlanningFields, { values: planning, update: (patch) => setPlanning((value) => ({ ...value, ...patch })), projects })),
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
     * DSH 模型选择，按提供方分组。
     * 模型目录只读 DSH；第三方模型与凭证在「DSH 设置 → 模型」配置，看板不保存凭证。
     */
    function AiModelBlock({ draft, set, catalog, saving }) {
      const selectId = React.useId();
      const data = catalog.data;
      const models = (data && data.models) || [];
      const groups = (data && data.groups) || [];
      const current = aiModelRef(draft);
      const found = current
        ? models.some((item) => item.provider === current.provider && item.id === current.model)
        : true;
      const busy = catalog.status === "loading" || catalog.status === "refreshing";
      // 刷新期间不 disabled（disabled 会让焦点掉出弹窗），用 aria-busy + 内部去重防重复请求。
      const refreshDisabled = saving || catalog.status === "loading";
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
            { className: "label" },
            h("label", { className: "sk-sr-only", htmlFor: selectId }, "模型"),
            h("span", null, "用于之后的扫描、重新研判、润色和快聊。"),
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
          { className: "sk-settings-controls sk-model-controls" },
          h(
            "select",
            {
              id: selectId,
              className: "sk-select sk-model-select",
              "aria-describedby": `${selectId}-desc ${selectId}-guide`,
              title: current ? modelLabel(current.provider, current.model) : "跟随 DSH 默认",
              value: aiModelValue(current),
              disabled: saving,
              "data-sk-initial-focus": true,
              onChange: (event) => {
                const next = parseAiModelValue(event.target.value);
                // 一次 set 两个字段，避免出现「只有 provider / 只有 model」的混合态。
                set(next ? { aiProvider: next.provider, aiModel: next.model } : { aiProvider: "", aiModel: "" });
              },
            },
            options,
          ),
          h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }),
        ),
        h(
          "p",
          { id: `${selectId}-desc`, className: cx("sk-catalog-note", note.warn && "is-warn") },
          note.text,
          // S2：文本按钮之间加可见分隔符，避免读屏/复制时连成「…改为跟随默认重试」。
          note.followDefault
            ? h(
                React.Fragment,
                null,
                h("span", { className: "sk-catalog-sep", "aria-hidden": "true" }, " · "),
                h("button", { type: "button", className: "sk-text", disabled: saving, onClick: () => set({ aiProvider: "", aiModel: "" }) }, "改为跟随默认"),
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
        h("p", { id: `${selectId}-guide`, className: cx("sk-catalog-note", thirdParty && "is-warn") }, guideText),
        h(
          "span",
          { role: "status", "aria-live": "polite", className: "sk-sr-only" },
          catalog.announce || "",
        ),
      );
    }

    function ModelModal({ settings, onClose, onSave, returnFocus }) {
      const [draft, setDraft] = React.useState(() => ({ aiProvider: settings.aiProvider || "", aiModel: settings.aiModel || "" }));
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");
      const dialogRef = React.useRef(null);
      const titleId = React.useId();
      const catalog = useAiCatalog();
      const close = () => { if (!saving) onClose(); };
      useDialogFocus(dialogRef, close, returnFocus);
      useBodyScrollLock();
      const changed = aiModelValue(aiModelRef(draft)) !== aiModelValue(aiModelRef(settings));
      const save = async (event) => {
        event.preventDefault();
        if (!changed || saving) return;
        setSaving(true);
        setError("");
        try {
          const { data } = await command("settings.model", { provider: draft.aiProvider, model: draft.aiModel });
          await onSave(data);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setSaving(false);
        }
      };
      return h("div", { className: "sk-modal-mask", onMouseDown: (event) => event.target === event.currentTarget && close() },
        h("form", { className: "sk-modal sk-model-modal", ref: dialogRef, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, onSubmit: save },
          h("h3", { id: titleId }, h(Icon, { name: "spark", size: 15 }), "选择模型"),
          h("div", { className: "sk-modal-body" },
            h(AiModelBlock, { draft, set: setDraft, catalog, saving }),
            error ? h("p", { role: "alert", className: "sk-error-detail" }, error) : null),
          h("div", { className: "sk-modal-foot" },
            h("button", { className: "sk-btn ghost", type: "button", disabled: saving, onClick: close }, "取消"),
            h("button", { className: "sk-btn primary", type: "submit", disabled: !changed || saving }, saving ? "保存中…" : "应用模型"))));
    }

    function SettingsModal({ settings, route, modelOpen, onModel, workspaces, prefs, usage, onPrefsChange, onClose, onSave, onScan, pushToast }) {
      const [draft, setDraft] = React.useState(() => {
        return {
          aiEnabled: settings.aiEnabled !== false,
          autoScan: settings.autoScan !== false,
          scanIntervalSeconds: settings.scanIntervalSeconds || 120,
          initialDays: settings.initialDays || 30,
          // 新字段一律用 ?? 初始化（禁止 || 回退，否则 0 / "auto" 会被误判）。
          aiBudgetMode: settings.aiBudgetMode ?? AI_BUDGET_MODE_DEFAULT,
          maxAiCallsPerScan: settings.maxAiCallsPerScan ?? AI_MAX_CALLS_DEFAULT,
          dailyAiCallLimit: settings.dailyAiCallLimit || 150,
          excludeWorkspaces: Array.isArray(settings.excludeWorkspaces) ? settings.excludeWorkspaces.slice() : [],
        };
      });
      const [saving, setSaving] = React.useState(false);
      const originalPrefs = React.useRef(prefs);
      const [entryDraft, setEntryDraft] = React.useState(() => prefs);
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();
      const set = (patch) => setDraft((value) => ({ ...value, ...patch }));
      const dailyLimit = Number(draft.dailyAiCallLimit) || 150;
      const dailyRemaining = usage ? Math.max(0, dailyLimit - usage.budgetUsed) : 0;
      // S1：禁止 || 回退（0 / 空串会被误判）；Host 钳制 5–150，非法值才用默认。
      const fixedLimitValue = Number(draft.maxAiCallsPerScan);
      const fixedLimit = Number.isFinite(fixedLimitValue) ? fixedLimitValue : AI_MAX_CALLS_DEFAULT;
      const changeEntry = (patch) => setEntryDraft((current) => ({ ...current, ...patch }));
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
          const changedPrefs = Object.fromEntries(Object.keys(entryDraft).filter((key) => entryDraft[key] !== originalPrefs.current[key])
            .map((key) => [key, entryDraft[key]]));
          if (Object.keys(changedPrefs).length) onPrefsChange(changedPrefs);
          pushToast("设置已保存", "info");
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
        { className: "sk-modal-mask", inert: modelOpen, onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          "div",
          {
            className: "sk-modal",
            ref: dialogRef,
            role: "dialog",
            "aria-modal": modelOpen ? undefined : "true",
            "aria-labelledby": "sk-settings-title",
          },
          h("h3", { id: "sk-settings-title" }, h(Icon, { name: "settings", size: 15 }), "看板设置"),
          h(
            "div",
            { className: "sk-modal-body" },
            h("h4", { className: "sk-settings-heading" }, "显示与入口"),
            h("div", { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "默认看板形态"), h("span", null, "点击会话页头的看板图标时打开。全局、右侧、悬浮三种形态同一时刻只显示一种")),
              h(SurfacePicker, { value: entryDraft.surface, className: "sk-select", label: "会话页头默认打开方式",
                onChange: (surface) => changeEntry({ surface }) })),
            h("div", { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "悬浮入口"), h("span", null, "在会话界面常驻，可拖动调整位置，右键可隐藏。进入全局看板时自动让位")),
              h("button", { type: "button", className: cx("sk-switch", entryDraft.floatEnabled && "on"), role: "switch", "aria-checked": entryDraft.floatEnabled,
                "aria-label": "常驻悬浮入口", onClick: () => changeEntry({ floatEnabled: !entryDraft.floatEnabled }) }, h("i"))),
            entryDraft.floatEnabled ? h(React.Fragment, null,
              h("div", { className: "sk-settings-row" },
                h("div", { className: "label" }, h("b", null, "入口样式与位置"), h("span", null, "圆形图标最不占地方，胶囊和状态条直接显示数量")),
                h("span", { className: "sk-settings-controls" },
                  h("select", { className: "sk-select", "aria-label": "悬浮样式", value: entryDraft.floatStyle, onChange: (event) => changeEntry({ floatStyle: event.target.value }) },
                    Object.entries(FLOAT_STYLES).map(([key, label]) => h("option", { key, value: key }, label))),
                  h("select", { className: "sk-select", "aria-label": "悬浮位置", value: entryDraft.floatPosition, onChange: (event) => changeEntry({ floatPosition: event.target.value }) },
                    h("option", { value: "right" }, "右侧"), h("option", { value: "left" }, "左侧")))),
              h("div", { className: "sk-settings-row" },
                h("div", { className: "label" }, h("b", null, "入口上的数量"), h("span", null, "选择入口提示哪些类别。展开后的面板始终包含全部类别")),
                h("fieldset", { className: "sk-float-options", "aria-label": "悬浮摘要" },
                  Object.entries(FLOAT_SUMMARIES).map(([id, label]) => {
                    const checked = entryDraft.floatSummaries.includes(id);
                    return h("label", { key: id }, h("input", { type: "checkbox", checked,
                      disabled: checked && entryDraft.floatSummaries.length === 1,
                      onChange: () => changeEntry({ floatSummaries: checked ? entryDraft.floatSummaries.filter((item) => item !== id) : [...entryDraft.floatSummaries, id] }) }), label);
                  }))),
              h("div", { className: "sk-settings-row" },
                h("div", { className: "label" }, h("b", null, "空闲时隐藏入口"), h("span", null, "所选类别的数量都为零时暂时隐藏，有新事项时再出现")),
                h("button", { type: "button", className: cx("sk-switch", entryDraft.floatHideEmpty && "on"), role: "switch", "aria-checked": entryDraft.floatHideEmpty,
                  "aria-label": "所选摘要都为零时隐藏入口", onClick: () => changeEntry({ floatHideEmpty: !entryDraft.floatHideEmpty }) }, h("i"))),
              h("div", { className: "sk-settings-row" },
                h("div", { className: "label" }, h("b", null, "悬浮面板"), h("span", null, "大面板适合宽屏。固定后点击面板外不会收起")),
                h("span", { className: "sk-settings-controls" },
                  h("select", { className: "sk-select", "aria-label": "悬浮面板大小", value: entryDraft.floatSize, onChange: (event) => changeEntry({ floatSize: event.target.value }) },
                    h("option", { value: "normal" }, "标准"), h("option", { value: "large" }, "大")),
                  h("label", { className: "sk-settings-check" }, h("input", { type: "checkbox", checked: entryDraft.floatPinned,
                    onChange: (event) => changeEntry({ floatPinned: event.target.checked }) }), "固定")))) : null,
            h("h4", { className: "sk-settings-heading" }, "AI 与扫描"),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "AI 联网研判"), h("span", null, "使用 DSH 配置的模型（含第三方）分析会话摘要；关闭后仅用本地规则推断")),
              h("button", { type: "button", className: cx("sk-switch", draft.aiEnabled && "on"), onClick: () => set({ aiEnabled: !draft.aiEnabled }), "aria-label": "AI 联网研判", role: "switch", "aria-checked": draft.aiEnabled }, h("i")),
            ),
            h("div", { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "模型"), h("span", null, selectedModelLabel(route))),
              h("button", { className: "sk-btn", type: "button", onClick: onModel }, "切换模型")),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "自动扫描"), h("span", null, "按间隔增量扫描有变化的会话")),
              h("button", { type: "button", className: cx("sk-switch", draft.autoScan && "on"), onClick: () => set({ autoScan: !draft.autoScan }), "aria-label": "自动扫描", role: "switch", "aria-checked": draft.autoScan }, h("i")),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "扫描间隔"), h("span", null, "会话轮次结束时可提前更新，定时扫描补齐遗漏")),
              h(
                "select",
                { className: "sk-select", "aria-label": "扫描间隔", value: draft.scanIntervalSeconds, onChange: (event) => set({ scanIntervalSeconds: Number(event.target.value) }) },
                [60, 120, 300, 600].map((seconds) => h("option", { key: seconds, value: seconds }, seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`)),
              ),
            ),
            h(
              "div",
              { className: "sk-settings-row" },
              h("div", { className: "label" }, h("b", null, "活跃周期"), h("span", null, "近期视图和增量扫描使用此周期。旧任务保留在历史，会话更新后重新纳入。")),
              h(
                "select",
                { className: "sk-select", "aria-label": "活跃周期", value: draft.initialDays, onChange: (event) => set({ initialDays: Number(event.target.value) }) },
                [...new Set([7, 14, 30, 90, 180, 365, draft.initialDays])].sort((a, b) => a - b)
                  .map((days) => h("option", { key: days, value: days }, `最近 ${days} 天`)),
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
                    h("span", null, "今日研判预算 ", h("b", null, usage.budgetUsed), " / ", h("b", null, dailyLimit), " 次"),
                    usage.calls !== usage.budgetUsed ? h("span", null, "成功 ", h("b", null, usage.calls), " 次") : null,
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
            h("h4", { className: "sk-settings-heading" }, "范围与数据"),
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
                "扫描全部历史",
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
    const EMPTY_FILTERS = { workspace: "", project: "", activity: "recent", running: false, priority: "", source: "", tag: "", query: "", showArchived: false };

    function readFilters(surface) {
      try {
        const raw = localStorage.getItem(surface === "side" ? FILTERS_KEY + ":side" : FILTERS_KEY);
        if (!raw) return { ...EMPTY_FILTERS };
        const parsed = JSON.parse(raw);
        return {
          workspace: String(parsed.workspace || ""),
          project: String(parsed.project || ""),
          activity: Object.hasOwn(ACTIVITY_RANGES, parsed.activity) ? parsed.activity : "recent",
          running: parsed.running === true,
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

    function TaskCollection({ mode, tasks, projects = [], signals, onOpen, taskActions, openSession, reload, pushToast, emptyText, onClear, clearLabel }) {
      const [checked, setChecked] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [priority, setPriority] = React.useState("");
      const [project, setProject] = React.useState("");
      const sorted = React.useMemo(() => {
        if (mode === "schedule") return tasks;
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
          setProject("");
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
              taskRunningLabel(task) ? h("span", { className: cx("sk-run-label", task.sessionContext?.estimated && "is-estimated") }, taskRunningLabel(task)) : null,
              [mode === "hierarchy" ? task.projectName : taskScopeLabel(task), task.archived ? "已归档" : STATUS_META[statusOf(task)].label,
                taskProgressLabel(task), task.priority, signal?.kind === "due" ? "" : dueLabel(task),
                artifactsOf(task).length ? `${artifactsOf(task).length} 项产出` : ""].filter(Boolean).join(" · "))),
          taskActions.button(task),
          renderSessionActions(pending, openSession));
      };

      if (mode === "schedule") {
        const groups = taskSchedule(sorted, Date.now());
        const labels = { overdue: "已逾期", today: "今天", week: "未来 7 天", later: "更晚", undated: "未设到期日" };
        const sections = Object.entries(groups).filter(([, list]) => list.length);
        if (!sections.length) return h("div", { className: "sk-empty-v3" }, tasks.length ? "当前范围没有未完成的任务" : emptyText,
          !tasks.length ? h("button", { className: "sk-text", type: "button", onClick: onClear }, clearLabel) : null);
        return h("div", { className: "sk-collection", "aria-label": "任务日程" }, sections.map(([group, list]) => {
          const rows = h("ul", { className: "sk-task-list" }, list.map((task) => row(task)));
          return group === "undated"
            ? h("details", { key: group, className: "sk-workspace-group" }, h("summary", null, labels[group], h("span", null, list.length)), rows)
            : h("section", { key: group, className: "sk-schedule-group" }, h("h2", null, labels[group], h("span", null, list.length)), rows);
        }));
      }

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
            h("button", { className: "sk-btn", type: "button", disabled: busy || !priority, onClick: () => batch({ priority }) }, "应用优先级"),
            projects.length ? h(React.Fragment, null,
              h("select", { className: "sk-select", "aria-label": "批量归属项目", value: project, onChange: (event) => setProject(event.target.value) },
                h("option", { value: "" }, "归属项目"),
                h("option", { value: "__none" }, "移出项目"),
                projects.filter((item) => !item.archived).map((item) => h("option", { key: item.id, value: item.id }, item.name))),
              h("button", { className: "sk-btn", type: "button", disabled: busy || !project,
                onClick: () => batch({ projectId: project === "__none" ? null : project }) }, "应用归属")) : null) : null) : null,
        h("ul", { className: "sk-task-list" }, sorted.map((task) => row(task))));
    }

    function ProjectsView({ projects, workspaces, tasks, historicalIds, signals, onOpen, onWorkspace, onEdit, onNew, today }) {
      const byWorkspace = new Map();
      const byProject = new Map();
      const add = (groups, id, task) => {
        if (!id) return;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(task);
      };
      for (const task of tasks) {
        if (task.archived) continue;
        add(byWorkspace, task.workspaceId, task);
        add(byProject, task.projectId, task);
      }
      const card = (project, isWorkspace = false) => {
        const group = (isWorkspace ? byWorkspace : byProject).get(project.id) || [];
        const members = group.filter((task) => !historicalIds.has(task.id));
        const historical = group.length - members.length;
        const completed = members.filter((task) => task.status === "done").length;
        const waiting = members.filter((task) => signals.has(task.id)).length;
        const running = members.filter(taskRunningLabel).length;
        const blocked = members.filter((task) => task.status === "blocked").length;
        const overdue = members.filter((task) => task.status !== "done" && task.dueDate && task.dueDate < today).length;
        const open = (mode, activity) => (isWorkspace ? onWorkspace : onOpen)(project.id, mode, activity);
        return h("article", { key: project.id, className: "sk-project-card" },
          h("h3", null, project.name),
          h("p", { className: "sk-project-metrics" },
            [members.length ? `近期 ${completed}/${members.length} 已完成` : "暂无近期任务", blocked ? `${blocked} 项受阻` : "",
              waiting ? `${waiting} 项待处理` : "", overdue ? `${overdue} 项逾期` : "", running ? `${running} 项运行中` : ""].filter(Boolean).join(" · ")),
          members.length ? h("progress", { value: completed, max: members.length, "aria-label": `${project.name} 完成进度` }) : null,
          project.dueDate ? h("p", { className: "sk-project-metrics" }, dueLabel({ ...project,
            status: members.length > 0 && completed === members.length ? "done" : "backlog" }, today)) : null,
          project.notes ? h("p", { className: "sk-project-note sk-preserve-lines" }, project.notes) : null,
          h("div", { className: "sk-inline-actions" },
            h("button", { type: "button", className: "sk-btn", "aria-label": `查看项目时间线 ${project.name}`, onClick: () => open("timeline") }, "时间线"),
            h("button", { type: "button", className: "sk-btn ghost", "aria-label": `查看项目看板 ${project.name}`, onClick: () => open("board") }, "看板"),
            h("button", { type: "button", className: "sk-btn ghost", "aria-label": `查看项目日程 ${project.name}`,
              onClick: () => open("schedule") }, "日程"),
            historical ? h("button", { type: "button", className: "sk-btn ghost", onClick: () => open("list", "history") }, `历史 ${historical}`) : null,
            !isWorkspace ? h("button", { type: "button", className: "sk-btn ghost", "aria-label": `编辑项目 ${project.name}`, onClick: () => onEdit(project.id) }, "编辑") : null));
      };
      const defaults = workspaces.filter((workspace) => workspace.included !== false);
      const custom = projects.filter((project) => !project.archived);
      const archived = projects.filter((project) => project.archived);
      return h("section", { className: "sk-collection sk-projects", "aria-label": "项目管理" },
        h("div", { className: "sk-projects-head" },
          h("h2", null, "项目"),
          h("button", { type: "button", className: "sk-btn primary", onClick: onNew }, "新建项目")),
        h("p", { className: "sk-projects-guide" },
          "工作区来自 DSH 的工作目录，自动出现；自建项目由你创建，可以把多个工作区的任务归到一起。任务在会话里执行，一张任务卡可以关联多个会话。"),
        defaults.length ? h("section", { className: "sk-project-section" }, h("h3", null, "工作区项目", h("span", null, "按 DSH 工作区自动生成")),
          h("div", { className: "sk-project-grid" }, defaults.map((workspace) => card({ id: workspace.id, name: workspace.title }, true)))) : null,
        h("section", { className: "sk-project-section" }, h("h3", null, "自建项目", h("span", null, "手动创建，可跨工作区")),
          custom.length ? h("div", { className: "sk-project-grid" }, custom.map((project) => card(project)))
            : h("p", { className: "sk-project-metrics" }, "把一个或多个工作区的任务归到同一个项目。")),
        archived.length ? h("details", { className: "sk-project-archive" },
          h("summary", null, `已归档项目（${archived.length}）`), h("div", { className: "sk-project-grid" }, archived.map((project) => card(project)))) : null);
    }

    const TIMELINE_HISTORY = { create: "新建任务", status: "状态变化", progress: "进度更新", archive: "归档变更", merge: "合并任务", edit: "任务更新" };
    const TIMELINE_EVIDENCE = { user: "需求与反馈", assistant: "会话进展", deliverable: "交付", artifact: "产物", error: "问题", todo: "事项进度" };

    function timelineEvents(tasks, range, cutoff) {
      const events = [];
      const seen = new Set();
      const inRange = (at) => at && (range === "all" || (range === "history" ? at < cutoff : at >= cutoff));
      for (const task of tasks) {
        const before = events.length;
        const historical = isHistoricalTask(task, cutoff);
        (task.history || []).forEach((item, index) => {
          const at = timeValue(item.at);
          const label = item.note === "确认验收" ? "已验收" : TIMELINE_HISTORY[item.kind];
          if (!label || !inRange(at) || (range === "recent" && historical && item.by === "ai")) return;
          const detail = item.kind === "status" && STATUS_META[item.to] ? STATUS_META[item.to].label :
            item.kind === "progress" && typeof item.to === "number" ? `${item.to}%` : item.note || "";
          events.push({ key: `${task.id}:history:${index}`, at, label, detail, task });
        });
        const evidence = task.evidence || [];
        const deliveries = new Set();
        let hasSourceEvent = false;
        for (const item of evidence) {
          const at = timeValue(item.time);
          const label = TIMELINE_EVIDENCE[item.kind];
          const sessionId = item.sessionId || task.primarySessionId;
          const key = JSON.stringify([sessionId || task.id, item.kind, item.seq || at, item.seq ? "" : item.text]);
          if (!label || !inRange(at)) continue;
          hasSourceEvent = true;
          if (item.kind === "deliverable" && item.seq) deliveries.add(JSON.stringify([sessionId, item.seq]));
          if (seen.has(key)) continue;
          seen.add(key);
          const detail = item.kind === "assistant" || item.kind === "user" ? item.quote || item.text : item.text;
          events.push({ key, at, label, detail, task, sessionId, sessionTitle: item.sessionTitle });
        }
        for (const artifact of artifactsOf(task)) {
          const at = timeValue(artifact.time);
          const sessionId = artifact.sessionId || task.primarySessionId;
          if (artifact.kind !== "deliverable" || !inRange(at)) continue;
          hasSourceEvent = true;
          if (deliveries.has(JSON.stringify([sessionId, artifact.seq]))) continue;
          const key = JSON.stringify([sessionId || task.id, "delivery-file", artifact.seq || at, artifact.path || artifact.name]);
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({ key, at, label: "交付", detail: artifact.name, task, sessionId });
        }
        const at = taskActivityAt(task);
        if (events.length === before && !hasSourceEvent && inRange(at)) {
          events.push({ key: `${task.id}:activity`, at, label: "最近活动", detail: "", task, sessionId: task.primarySessionId });
        }
      }
      return events.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
    }

    function TimelineView({ tasks, range, cutoff, title, onOpen, onSession }) {
      const [limit, setLimit] = React.useState(40);
      const events = React.useMemo(() => timelineEvents(tasks, range, cutoff), [tasks, range, cutoff]);
      const days = new Map();
      for (const item of events.slice(0, limit)) {
        const day = localDateKey(item.at);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(item);
      }
      return h("section", { className: "sk-collection sk-timeline", "aria-label": "项目时间线" },
        h("h2", null, title ? `${title} · 时间线` : "项目时间线"),
        !events.length ? h("p", { className: "sk-empty-v3" }, "这个范围内还没有可展示的进展。") : null,
        [...days].map(([day, entries]) => h("section", { key: day, className: "sk-timeline-day" },
          h("h3", null, day),
          h("ol", null, entries.map((item) => h("li", { key: item.key },
            h("div", { className: "sk-timeline-meta" },
              h("time", { dateTime: new Date(item.at).toISOString() }, new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })),
              h("span", null, item.label), item.task.workspaceTitle ? h("span", null, item.task.workspaceTitle) : null),
            h("div", { className: "sk-timeline-links" },
              h("button", { type: "button", className: "sk-text sk-timeline-task", onClick: () => onOpen(item.task.id) }, item.task.title),
              item.sessionId ? h("button", { type: "button", className: "sk-text",
                title: item.sessionTitle || undefined, "aria-label": item.sessionTitle ? `打开来源会话：${item.sessionTitle}` : undefined,
                onClick: () => onSession(item.sessionId) }, "打开来源会话") : null),
            item.detail ? h("p", null, item.detail) : null))))),
        events.length > limit ? h("button", { type: "button", className: "sk-btn", onClick: () => setLimit((current) => current + 40) }, "显示更多记录") : null);
    }

    function acceptanceEvidenceAt({ task, artifact }) {
      const deliveredAt = artifact?.kind === "deliverable" ? timeValue(artifact.time) : 0;
      return deliveredAt || timeValue(task.lastActivityAt) || timeValue(task.sessionContext?.lastActivityAt);
    }

    function floatingSummary(tasks, statuses, days, now = Date.now()) {
      const projected = tasks.filter((task) => !task.archived).map((task) => withSessionStatus(task, statuses, now));
      const index = new Map(projected.map((task) => [task.id, task]));
      const cutoff = activityCutoff(days, now);
      const rows = projected.filter((task) => !isHistoricalTask(task, cutoff)).map((task) => ({
        task, signal: taskSignal(task, index, now), artifact: primaryArtifactOf(artifactsOf(task)),
      }));
      rows.sort((a, b) => taskActivityAt(b.task) - taskActivityAt(a.task) || a.task.id.localeCompare(b.task.id));
      return {
        acceptance: rows.filter(({ task, signal, artifact }) => signal?.label === "待验收" && !isAccepted(task) && canAcceptTask(task, artifact))
          .sort((a, b) => acceptanceEvidenceAt(b) - acceptanceEvidenceAt(a)),
        attention: rows.filter(({ signal }) => signal),
        running: rows.filter(({ task }) => taskRunningLabel(task)),
        recent: rows,
      };
    }

    /**
     * 悬浮入口上方的待审批条。只收「刚结束、还没点头」的会话。卡片一旦出现就留到
     * 用户点对号：会话又跑起来也不会把它撤掉，否则点进会话就看不到它了。
     */
    function floatingReview(tasks, statuses, now = Date.now()) {
      const rows = [];
      for (const task of tasks || []) {
        if (!task || task.archived) continue;
        const review = task.review;
        if (!review?.sessionId || isAccepted(task)) continue;
        const projected = withSessionStatus(task, statuses, now);
        const folder = projected.workspaceTitle || projected.projectName || "";
        rows.push({ kind: "review", task: projected, scope: taskScopeLabel(projected), folder,
          folderSeed: projected.workspaceId || folder || projected.id,
          sessionId: review.sessionId, at: Number(review.at) || taskActivityAt(projected) });
      }
      rows.sort((a, b) => b.at - a.at || a.task.id.localeCompare(b.task.id));
      return rows;
    }

    /** 待审批条：一行一张卡，悬停出现对号；点卡片本体打开对应会话。 */
    function ReviewStrip({ rows, busyId, error, expanded, message, onOpen, onAccept, onExpand }) {
      const stack = React.useRef(null);
      // 标题只在真的放不下时才跑马灯：量一次内层宽度，把位移和时长写到 DOM 上。
      React.useEffect(() => {
        const root = stack.current;
        if (!root?.querySelectorAll) return undefined;
        const measure = () => {
          for (const box of root.querySelectorAll("[data-marquee]")) {
            const label = box.firstElementChild;
            if (!label) continue;
            const shift = Math.ceil(label.scrollWidth - box.clientWidth);
            box.classList.toggle("is-overflow", shift > 1);
            box.style.setProperty("--sk-marquee-shift", shift > 1 ? `-${shift}px` : "0px");
            box.style.setProperty("--sk-marquee-duration", `${Math.min(6, Math.max(1.8, shift / 34)).toFixed(2)}s`);
          }
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
      }, [rows]);
      const visible = expanded ? rows : rows.slice(0, REVIEW_STRIP_LIMIT);
      const hidden = rows.length - visible.length;
      return h("div", { ref: stack, className: "sk-pin-stack", role: "group", "aria-label": "待审批任务" },
        visible.map((row) => {
          const busy = busyId === row.task.id;
          // 整张卡就是打开会话的按钮；对号是卡内的独立控件，点它只验收。
          return h("article", {
            key: row.task.id, className: "sk-pin-card is-review", role: "button", tabIndex: 0,
            title: "打开对应会话", "aria-label": `打开会话：${row.task.title}`,
            onClick: (event) => {
              if (event?.target?.closest?.(".sk-pin-check")) return;
              onOpen(row);
            },
            onKeyDown: (event) => {
              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              onOpen(row);
            },
          },
            h("span", { className: "sk-pin-avatar", style: { "--sk-folder": folderColor(row.folderSeed) },
              "aria-hidden": "true" }, folderGlyph(row.folder)),
            h("span", { className: "sk-pin-open" },
              h("span", { className: "sk-pin-marquee", "data-marquee": "" },
                h("span", { className: "sk-pin-title" }, row.task.title)),
              h("span", { className: "sk-pin-meta" }, [row.scope, relTime(row.at)].filter(Boolean).join(" · "))),
            h("button", { type: "button", className: "sk-pin-check", disabled: Boolean(busyId || error || row.task.pendingSessions?.length),
              title: "确认完成", "aria-label": `确认完成：${row.task.title}`,
              onClick: (event) => { event.stopPropagation(); onAccept(row.task); } },
              busy ? h("span", { className: "sk-pin-spin" }) : h(Icon, { name: "check", size: 13 })));
        }),
        hidden > 0 || expanded
          ? h("button", { type: "button", className: "sk-pin-more", onClick: onExpand },
              hidden > 0 ? `还有 ${hidden} 项` : "收起")
          : null,
        message ? h("p", { className: "sk-pin-status", role: "status" }, message) : null);
    }

    /** 当前选中的 DSH 全局面板；用于在全局看板显示时隐藏悬浮入口。 */
    function useActivePanel(host) {
      const [panel, setPanel] = React.useState(() => host.activePanel?.());
      React.useEffect(() => {
        const read = () => setPanel(host.activePanel?.());
        read();
        return host.watchPanel?.(read);
      }, [host]);
      return panel;
    }

    const FLOAT_PAGE_SIZE = 8;

    /** 随手记的任务归到当前会话所在的工作区，但不绑定会话：随手记下的事项不一定属于这次对话。 */
    function quickCapturePayload(title, tasks, sessionId) {
      const owner = sessionId && tasks.find((task) => task.workspaceId &&
        (task.primarySessionId === sessionId || task.sessions?.some((item) => item.id === sessionId)));
      return { title, status: "backlog", ...(owner ? { workspaceId: owner.workspaceId } : {}) };
    }

    /**
     * 悬浮看板：常驻的悬浮入口 + 展开后的面板。
     * 入口可拖动、可右键隐藏；面板集中处理待验收、待处理、运行中与最近任务，并提供快聊和随手记。
     */
    function FloatingPanel({ host, prefs, open, sessionStatuses }) {
      const { data, loading, error, reload } = useBoardData();
      const [category, setCategory] = React.useState(() => "");
      const [limit, setLimit] = React.useState(0);
      const [continuation, setContinuation] = React.useState(() => null);
      const continuationTrigger = React.useRef(null);
      const [busyId, setBusyId] = React.useState("");
      const [message, setMessage] = React.useState("");
      const busy = React.useRef(false);
      const [pulse, setPulse] = React.useState(0);
      const [query, setQuery] = React.useState("");
      const [quickTitle, setQuickTitle] = React.useState("");
      const [menuAnchor, setMenuAnchor] = React.useState(false);
      const notice = useStore(floatNoticeStore);
      const setNotice = floatNoticeStore.set;
      const [dragPosition, setDragPosition] = React.useState(() => null);
      const drag = React.useRef(null);
      const suppressClick = React.useRef(false);
      const previousAcceptance = React.useRef(null);
      const root = React.useRef(null);
      const heading = React.useRef(null);
      const trigger = React.useRef(null);
      const wasOpen = React.useRef(false);
      const titleId = React.useId();
      const panelId = React.useId();
      const activePanel = useActivePanel(host);
      const dialogs = useStore(dialogCountStore);
      const sideBoards = useStore(sideCountStore);
      const [now, setNow] = React.useState(Date.now);
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
      }, []);
      const tasks = React.useMemo(() => {
        const names = new Map((data?.projects || []).map((project) => [project.id, project.name]));
        return (data?.tasks || []).map((task) => names.has(task.projectId) ? { ...task, projectName: names.get(task.projectId) } : task);
      }, [data?.tasks, data?.projects]);
      const summary = React.useMemo(() => floatingSummary(tasks, sessionStatuses, data?.settings?.initialDays, now),
        [tasks, sessionStatuses, data?.settings?.initialDays, now]);
      const reviews = React.useMemo(() => floatingReview(tasks, sessionStatuses, now), [tasks, sessionStatuses, now]);
      const [stripExpanded, setStripExpanded] = React.useState(false);
      React.useEffect(() => {
        if (!reviews.length) setStripExpanded(false);
      }, [reviews.length]);
      const metrics = prefs.floatSummaries.map((id) => ({ id, label: FLOAT_SUMMARIES[id], count: summary[id].length }));
      const tabs = Object.entries(FLOAT_TABS).map(([id, label]) => ({ id, label, count: summary[id].length }));
      React.useEffect(() => {
        if (!data) return;
        const pending = prefs.floatSummaries.includes("acceptance") ? summary.acceptance.map(({ task }) => task.id) : [];
        const current = new Set([...pending, ...reviews.map(({ task }) => task.id)]);
        const previous = previousAcceptance.current;
        if (previous && [...current].some((id) => !previous.has(id))) setPulse((value) => value + 1);
        previousAcceptance.current = current;
      }, [data, prefs.floatSummaries, summary.acceptance, reviews]);
      React.useEffect(() => {
        if (open) return;
        setLimit(0);
        setContinuation(null);
        setQuery("");
      }, [open]);
      // 全局看板显示时不保留悬浮面板：三种形态只显示一种。
      const onBoardPage = activePanel === PANEL_ID;
      React.useEffect(() => {
        if (onBoardPage && open) setFloatingOpen(false);
      }, [onBoardPage, open]);
      React.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 8000);
        return () => clearTimeout(timer);
      }, [notice]);
      React.useEffect(() => {
        if (!message) return undefined;
        const timer = setTimeout(() => setMessage(""), 6000);
        return () => clearTimeout(timer);
      }, [message]);
      const preferred = metrics.find(({ count }) => count > 0)?.id || metrics[0].id;
      const selected = Object.hasOwn(FLOAT_TABS, category) ? category : preferred;
      const continueTask = continuation && data?.tasks?.find((task) => task.id === continuation.id && !task.archived);
      React.useEffect(() => {
        if (continuation && !continueTask) setContinuation(null);
      }, [continuation, continueTask]);
      const visibleMetrics = metrics.filter(({ count }) => count > 0);
      const showPanel = open && !onBoardPage;
      // 全局或右侧看板正在显示时入口让位：同一时刻只出现一种看板形态。
      const showTrigger = !showPanel && !onBoardPage && sideBoards === 0 && prefs.floatEnabled &&
        (!prefs.floatHideEmpty || visibleMetrics.length > 0 || reviews.length > 0 || Boolean(error));
      const showRoot = showPanel || showTrigger || Boolean(notice);
      const topLayer = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
      React.useLayoutEffect(() => {
        const node = root.current;
        if (!topLayer || !showRoot || !node) return undefined;
        node.showPopover();
        return () => { if (node.matches(":popover-open")) node.hidePopover(); };
      }, [showRoot, topLayer]);
      React.useLayoutEffect(() => {
        if (!showPanel) {
          // 面板收起后把焦点还给重新出现的悬浮入口。
          if (wasOpen.current && root.current && (!document.activeElement || document.activeElement === document.body)) {
            trigger.current?.focus({ preventScroll: true });
          }
          wasOpen.current = false;
          return undefined;
        }
        // 只在展开的那一刻把焦点移到标题；固定状态变化引起的重新订阅不抢焦点。
        if (!wasOpen.current) heading.current?.focus({ preventScroll: true });
        wasOpen.current = true;
        const closeOutside = (event) => {
          if (prefs.floatPinned || root.current?.contains(event.target)) return;
          if (event.target?.closest?.(".sk-overlay-host,.sk-quick-menu")) return;
          setFloatingOpen(false);
        };
        const closeOnEscape = (event) => {
          if (event.target?.closest?.(".sk-continue-modal,.sk-quick-menu")) return;
          if (event.key === "Escape" && !event.defaultPrevented && root.current?.contains(document.activeElement)) {
            event.preventDefault();
            event.stopPropagation();
            setFloatingOpen(false);
          }
        };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeOnEscape, true);
        return () => {
          document.removeEventListener("pointerdown", closeOutside);
          document.removeEventListener("keydown", closeOnEscape, true);
        };
      }, [showPanel, prefs.floatPinned]);
      const accept = async (task, doneLabel = "已验收") => {
        if (busy.current || !canAcceptTask(task) || isAccepted(task)) return;
        busy.current = true;
        heading.current?.focus({ preventScroll: true });
        setBusyId(task.id);
        setMessage("");
        try {
          await command("task.accept", { id: task.id, expectedUpdatedAt: task.updatedAt });
          await reload(true);
          setMessage(`${doneLabel}「${task.title}」`);
        } catch (cause) {
          setMessage(cause.status === 409 ? "任务已更新，请查看最新状态后再确认。" : `验收失败：${cause.message}`);
          if (cause.status === 409) await reload(true);
        } finally {
          busy.current = false;
          setBusyId("");
        }
      };
      const navigate = (action, id) => {
        if (action?.(id)) setFloatingOpen(false);
        else setMessage("当前环境无法打开该入口。");
      };
      // remember=true 时把所选形态记为会话页头的默认形态；点悬浮入口本身不改默认值。
      const switchSurface = (surface, remember = true) => {
        const session = host.currentSession?.();
        if (host.openSurface?.(surface, session)) {
          if (remember) updatePrefs({ surface });
        } else if (surface === "side" && host.openSurface?.("page")) {
          if (remember) updatePrefs({ surface: "page" });
        } else setMessage("当前环境无法打开此看板形态。");
      };
      const openChat = () => host.openChat?.({ sessionId: host.currentSession?.() });
      const quickAdd = async (event) => {
        event.preventDefault();
        const title = quickTitle.trim();
        if (!title || busy.current) return;
        busy.current = true;
        setMessage("");
        try {
          await command("task.create", quickCapturePayload(title, data?.tasks || [], host.currentSession?.()));
          setQuickTitle("");
          setCategory("recent");
          await reload(true);
          setMessage(`已记入待办「${clip(title, 24)}」`);
        } catch (cause) {
          setMessage(`保存失败：${cause.message}`);
        } finally {
          busy.current = false;
        }
      };
      const hideEntry = () => {
        setFloatingOpen(false);
        updatePrefs({ floatEnabled: false });
        setNotice({ text: "已隐藏悬浮入口。可在会话页头的看板菜单或「看板设置 → 显示与入口」重新显示。", undo: () => updatePrefs({ floatEnabled: true }) });
      };
      const entryMenu = [
        { label: "展开悬浮看板", icon: SURFACE_ICONS.float, run: () => switchSurface("float", false) },
        { label: "打开右侧看板", icon: SURFACE_ICONS.side, run: () => switchSurface("side") },
        { label: "打开全局看板", icon: SURFACE_ICONS.page, run: () => switchSurface("page") },
        "divider",
        { label: "快聊", icon: "chat", run: openChat },
        "divider",
        { label: prefs.floatPosition === "left" ? "移到右侧" : "移到左侧", icon: prefs.floatPosition === "left" ? "arrow" : "sideLeft",
          run: () => updatePrefs({ floatPosition: prefs.floatPosition === "left" ? "right" : "left" }) },
        prefs.floatOffset > 0 && { label: "回到底部", icon: "chevronDown", run: () => updatePrefs({ floatOffset: 0 }) },
        { label: "隐藏悬浮入口", icon: "eyeOff", run: hideEntry },
      ];
      // 拖动悬浮入口：竖直方向调整高度，越过屏幕中线则换边；位移很小时仍视为点击。
      const dragHandlers = {
        onPointerDown: (event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, offset: prefs.floatOffset, moved: false };
          // 立即捕获指针：快速拖动时指针会先离开按钮，后续移动仍要交给它处理。
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove: (event) => {
          const state = drag.current;
          if (!state) return;
          if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6) return;
          state.moved = true;
          const height = event.currentTarget.offsetHeight || 44;
          const offset = Math.round(Math.max(0, Math.min(window.innerHeight - height - 28, state.offset - (event.clientY - state.y))));
          state.next = { offset, side: event.clientX < window.innerWidth / 2 ? "left" : "right" };
          setDragPosition(state.next);
        },
        onPointerUp: () => {
          const state = drag.current;
          drag.current = null;
          if (!state?.moved) return;
          suppressClick.current = true;
          if (state.next) updatePrefs({ floatOffset: state.next.offset, floatPosition: state.next.side });
          setDragPosition(null);
        },
        onPointerCancel: () => {
          drag.current = null;
          setDragPosition(null);
        },
      };
      if (!showRoot) return null;
      const reviewCount = reviews.length;
      const counts = [reviewCount ? `待审批 ${reviewCount}` : "",
        ...metrics.map(({ label, count }) => `${label} ${count}`)].filter(Boolean).join("，");
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const rows = summary[selected].filter(({ task }) => !terms.length ||
        terms.every((term) => [task.title, task.workspaceTitle, task.projectName, ...(task.tags || [])].filter(Boolean).join(" ").toLowerCase().includes(term)));
      const visibleLimit = limit || (selected === "running" ? 3 : FLOAT_PAGE_SIZE);
      const side = dragPosition?.side || prefs.floatPosition;
      const offset = dragPosition?.offset ?? prefs.floatOffset;
      const badge = reviewCount || (visibleMetrics[0] || metrics[0]).count;
      const iconButton = (icon, label, onClick, extra) => h("button", { type: "button", className: "sk-float-icon", title: label, "aria-label": label, onClick, ...extra },
        h(Icon, { name: icon, size: 15 }));
      const panel = showPanel ? h("section", { id: panelId, className: cx("sk-float-panel", "is-" + prefs.floatSize), role: "dialog", "aria-labelledby": titleId, inert: Boolean(continueTask) },
        h("header", null,
          h("h2", { ref: heading, tabIndex: -1, id: titleId }, h(Icon, { name: "board", size: 15 }), "任务看板"),
          h("span", { className: "sk-float-tools" },
            iconButton("chat", "快聊", openChat),
            iconButton("pin", prefs.floatPinned ? "取消固定（点击面板外会收起）" : "固定面板（点击面板外不收起）",
              () => updatePrefs({ floatPinned: !prefs.floatPinned }), { "aria-pressed": prefs.floatPinned }),
            iconButton(prefs.floatSize === "large" ? "shrink" : "expand", prefs.floatSize === "large" ? "还原面板大小" : "放大面板",
              () => updatePrefs({ floatSize: prefs.floatSize === "large" ? "normal" : "large" })),
            iconButton(SURFACE_ICONS.side, "停靠到会话右侧", () => switchSurface("side")),
            iconButton(SURFACE_ICONS.page, "打开全局看板", () => switchSurface("page")),
            iconButton("close", "收起悬浮看板", () => setFloatingOpen(false)))),
        h("div", { className: "sk-float-metrics", role: "group", "aria-label": "任务类别" },
          tabs.map(({ id, label, count }) => h("button", { key: id, type: "button", className: "sk-btn", "aria-pressed": selected === id,
            onClick: () => { setCategory(id); setLimit(0); } }, label, " ", h("b", null, count))),
          h("label", { className: "sk-float-search" }, h(Icon, { name: "search", size: 13 }),
            h("input", { type: "search", value: query, placeholder: "筛选任务", "aria-label": "筛选当前类别的任务",
              onChange: (event) => { setQuery(event.target.value); setLimit(0); } }))),
        h("div", { className: "sk-float-content" },
          error ? h("p", { role: "alert" }, "连接异常。", h("button", { type: "button", className: "sk-text", onClick: () => reload(false) }, "重试")) : null,
          !rows.length ? h("p", { className: "sk-float-empty" }, loading ? "正在加载任务…" : terms.length ? "没有匹配的任务。" :
            selected === "recent" ? "近期还没有任务。在下方随手记一条，或到会话里开始工作。" : `暂无${FLOAT_TABS[selected]}任务。`) : null,
          rows.slice(0, visibleLimit).map(({ task, signal, artifact }) => {
            const mainSession = task.primarySessionId || sessionContextOf(task).sessionId;
            const pending = task.pendingSessions || [];
            const source = selected === "running" ? task.runningSessionIds?.[0] || mainSession :
              signal?.sessionId || artifact?.sessionId || mainSession;
            const ready = signal?.label === "待验收" && !isAccepted(task) && canAcceptTask(task, artifact);
            const deliverable = artifact?.kind === "deliverable" ? artifact : null;
            const at = ready ? acceptanceEvidenceAt({ task, artifact: deliverable }) : 0;
            const status = statusOf(task);
            const running = taskRunningLabel(task);
            const progressLabel = taskProgressLabel(task);
            const detail = selected === "running" ? [running]
              : selected === "recent" ? [STATUS_META[status].label, running || signal?.label, progressLabel === "进度未知" ? "" : progressLabel, relTime(taskActivityAt(task))]
              : [signal?.label, deliverable?.name || signal?.text, at ? relTime(at) : ""];
            return h("article", { key: task.id, className: "sk-float-row" },
              h("div", { className: "sk-float-row-head" },
                h("span", { className: cx("sk-dot", "is-" + status), title: STATUS_META[status].label }),
                h("button", { type: "button", className: "sk-text sk-float-task", title: "查看任务详情（⌘/Alt + 点击打开主会话）", onClick: (event) =>
                  mainSession && (event.metaKey || event.altKey) ? navigate(host.openSession, mainSession) : navigate(host.openTask, task.id) }, task.title)),
              h("p", null, [taskScopeLabel(task), ...detail].filter(Boolean).join(" · ")),
              ready && task.acceptanceCriteria ? h("p", { className: "sk-float-criteria", title: task.acceptanceCriteria }, "验收条件 · ", task.acceptanceCriteria) : null,
              h("div", { className: "sk-inline-actions" },
                source && (selected === "running" || !pending.length) ? h("button", { type: "button", className: "sk-btn ghost",
                  onClick: () => navigate(host.openSession, source) },
                  selected === "running" ? "打开运行会话" : selected === "recent" ? "打开会话" : "打开来源") : null,
                ready && deliverable?.path && (deliverable.sessionId || mainSession) && host.openResource
                  ? h("button", { type: "button", className: "sk-btn ghost", onClick: async () => {
                      if (await host.openResource(deliverable.sessionId || mainSession, deliverable.path)) setFloatingOpen(false);
                      else setMessage("无法预览交付物，请打开来源会话。");
                    } }, "查看交付物") : null,
                ready || (selected === "recent" && status !== "done") ? h("button", { type: "button", className: "sk-btn ghost", disabled: Boolean(busyId || error),
                  onClick: (event) => {
                    continuationTrigger.current = event.currentTarget;
                    setMessage("");
                    setContinuation({ id: task.id, sessionId: deliverable?.sessionId || mainSession, purpose: ready ? "verify" : status === "blocked" ? "unblock" : "continue" });
                  } }, "继续") : null,
                ready
                  ? h("button", { type: "button", className: "sk-btn", disabled: Boolean(busyId || error),
                      onClick: () => accept(task) }, busyId === task.id ? "正在验收…" : "确认验收") : null),
              renderSessionActions(pending, (id) => navigate(host.openSession, id)));
          }),
          rows.length > visibleLimit ? h("button", { type: "button", className: "sk-btn sk-float-more",
            onClick: () => setLimit(selected === "running" ? rows.length : visibleLimit + FLOAT_PAGE_SIZE) },
            selected === "running" ? `查看全部 ${rows.length} 项` : `显示更多（还有 ${rows.length - visibleLimit} 项）`) : null),
        h("form", { className: "sk-float-add", onSubmit: quickAdd },
          h(Icon, { name: "plus", size: 14 }),
          h("input", { value: quickTitle, maxLength: 120, placeholder: "随手记一条待办，回车保存", "aria-label": "随手记一条待办任务",
            onChange: (event) => setQuickTitle(event.target.value) }),
          quickTitle.trim() ? h("button", { type: "submit", className: "sk-btn" }, "保存") : null),
        message ? h("footer", null, h("span", { role: "status" }, message)) : h("span", { className: "sk-sr-only", role: "status" })) : null;
      const strip = showTrigger && dialogs === 0 && reviews.length
        ? h(ReviewStrip, {
            rows: reviews, busyId, error: Boolean(error), expanded: stripExpanded, message,
            onOpen: (row) => navigate(host.openSession, row.sessionId),
            onAccept: (task) => accept(task, "已确认完成"),
            onExpand: () => setStripExpanded((value) => !value),
          })
        : null;
      const entry = showTrigger ? h("button", { ref: trigger, type: "button",
        className: cx("sk-float-trigger", "is-" + prefs.floatStyle, dragPosition && "is-dragging", dialogs > 0 && "is-behind"),
        title: `任务看板 · ${counts}\n点击展开 · 拖动调整位置 · 右键更多`, "aria-label": `任务看板，${counts}`, "aria-haspopup": "dialog", "aria-expanded": false,
        ...dragHandlers,
        ...quickMenuHandlers(setMenuAnchor, (event) => event.currentTarget),
        onClick: () => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          switchSurface("float", false);
        } },
        h("span", { key: pulse, className: cx("sk-float-mark", pulse > 0 && "is-new") }, h(Icon, { name: "board", size: 18 })),
        prefs.floatStyle === "badge"
          ? [badge > 0 ? h("span", { key: "count", className: "sk-float-count" }, badge > 99 ? "99+" : badge) : null,
              summary.running.length ? h("span", { key: "run", className: "sk-float-live", title: `${summary.running.length} 个任务运行中` }) : null]
          : prefs.floatStyle === "pill"
            ? h("span", null, [reviewCount ? `待审批 ${reviewCount}` : "",
                ...visibleMetrics.map(({ label, count }) => `${label} ${count}`)].filter(Boolean).join(" · ") || "任务看板")
            : [reviewCount ? h("span", { key: "review" }, "待审批 ", h("b", null, reviewCount)) : null,
                ...metrics.map(({ id, label, count }) => h("span", { key: id }, label, " ", h("b", null, count)))]) : null;
      return h("div", { ref: root, className: cx("sk-floating", "is-" + side, showPanel && "is-open"), popover: topLayer ? "manual" : undefined,
        style: { "--sk-float-offset": `${showPanel ? 0 : offset}px` } },
        panel,
        strip,
        entry,
        notice ? h("div", { className: "sk-float-notice", role: "status" }, h("span", null, notice.text),
          h("button", { type: "button", className: "sk-text", onClick: () => { notice.undo(); setNotice(null); } }, "撤销"),
          h("button", { type: "button", className: "sk-text", "aria-label": "关闭提示", onClick: () => setNotice(null) }, "知道了")) : null,
        menuAnchor ? h(QuickMenu, { anchor: menuAnchor, items: entryMenu, label: "悬浮入口操作", onClose: () => setMenuAnchor(false) }) : null,
        showPanel && continueTask ? h(ContinueTaskModal, {
          task: continueTask, initialTarget: "session", initialPurpose: continuation.purpose || "verify", initialSessionId: continuation.sessionId,
          ctxProps: { host }, workspaces: data?.workspaces, pushToast: setMessage, feedback: message,
          returnFocus: continuationTrigger,
          onClose: () => setContinuation(null), onDone: () => { setFloatingOpen(false); void reload(true); },
        }) : null);
    }

    function FloatingEntry({ host, useSessionStatus }) {
      const prefs = useUiPrefs();
      const open = useStore(floatStore);
      const notice = useStore(floatNoticeStore);
      // 入口已隐藏且面板未展开时不挂载面板，也就不会为它轮询看板数据。
      if (!prefs.floatEnabled && !open && !notice) return null;
      const props = { host, prefs, open };
      return typeof useSessionStatus === "function" ? h(FloatingWithStatus, { ...props, useSessionStatus }) : h(FloatingPanel, props);
    }

    function FloatingWithStatus({ useSessionStatus, ...props }) {
      const sessionStatuses = useSessionStatus((snapshot) => snapshot);
      return h(FloatingPanel, { ...props, sessionStatuses });
    }

    /** 会话页头入口：左键按默认形态打开看板，右侧小箭头选择形态、快聊与悬浮入口开关。 */
    function HeaderEntry({ host, sessionId }) {
      const prefs = useUiPrefs();
      const [anchor, setAnchor] = React.useState(false);
      const open = (surface) => {
        if (host.openSurface(surface, sessionId)) return true;
        return surface !== "page" && host.openPage();
      };
      const choose = (surface) => {
        updatePrefs({ surface });
        open(surface);
      };
      const items = [
        ...Object.entries(SURFACES).map(([id, label]) => ({
          id, label: prefs.surface === id ? `${label}（默认）` : label, icon: SURFACE_ICONS[id], run: () => choose(id),
        })),
        "divider",
        { id: "chat", label: "快聊", icon: "chat", run: () => host.openChat({ sessionId }) },
        { id: "entry", label: prefs.floatEnabled ? "隐藏悬浮入口" : "显示悬浮入口", icon: prefs.floatEnabled ? "eyeOff" : "eye",
          run: () => updatePrefs({ floatEnabled: !prefs.floatEnabled }) },
      ];
      return h("div", { className: "sk-host-header" },
        h("button", { type: "button", className: "sk-header-btn", title: `打开${SURFACES[prefs.surface]}`,
          "aria-label": `打开${SURFACES[prefs.surface]}`, onClick: () => open(prefs.surface) },
          h(Icon, { name: "board", size: 16 })),
        h("button", { type: "button", className: "sk-header-btn sk-header-caret", title: "切换看板形态", "aria-label": "切换看板形态",
          "aria-haspopup": "menu", "aria-expanded": Boolean(anchor),
          onClick: (event) => setAnchor(anchor ? false : quickMenuAnchor(event, "button")) },
          h(Icon, { name: "chevronDown", size: 12 })),
        anchor ? h(QuickMenu, { anchor, items, label: "看板形态与快捷操作", onClose: () => setAnchor(false) }) : null);
    }

    function ProjectModal({ project, workspaces, onClose, onSave, onChanged }) {
      const values = {
        name: project?.name || "", notes: project?.notes || "", dueDate: project?.dueDate || "",
        workspaceId: project?.workspaceId || "", archived: project?.archived === true,
      };
      const base = React.useRef({ values, revision: project?.updatedAt });
      const [draft, setDraft] = React.useState(values);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const dialogRef = React.useRef(null);
      const titleId = React.useId();
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();
      const set = (key) => (event) => setDraft((value) => ({ ...value, [key]: event.target.value }));
      const changes = draftChanges(base.current.values, draft, values);
      const reconcile = (preserveConflicts) => {
        const patch = Object.fromEntries(Object.entries(changes.patch)
          .filter(([field]) => preserveConflicts || !changes.conflicts.includes(field)));
        base.current = { values, revision: project?.updatedAt };
        setDraft({ ...values, ...patch });
        setError("");
      };
      React.useEffect(() => {
        if (project && !busy && base.current.revision !== project.updatedAt && !changes.conflicts.length) reconcile(true);
      }, [project?.updatedAt, draft, busy]);
      const save = async (event) => {
        event.preventDefault();
        if (busy || changes.conflicts.length || !draft.name.trim()) return;
        setBusy(true);
        setError("");
        try {
          if (!project) await command("project.create", draft);
          else if (Object.keys(changes.patch).length) await command("project.update", {
            id: project.id, patch: changes.patch, expectedUpdatedAt: project.updatedAt,
          });
          await onSave();
        } catch (cause) {
          setError(cause.message);
          if (cause.code === "revision-conflict") await onChanged();
        } finally {
          setBusy(false);
        }
      };
      return h("div", { className: "sk-modal-mask", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h("form", { className: "sk-modal", ref: dialogRef, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, onSubmit: save },
          h("h3", { id: titleId }, project ? "编辑项目" : "新建项目"),
          h("div", { className: "sk-modal-body" },
            h("label", { className: "sk-field" }, "项目名称", h("input", { className: "sk-input", required: true,
              value: draft.name, maxLength: TEXT_LIMITS.projectName, onChange: set("name") })),
            h("div", { className: "sk-planning-fields" },
              h("label", { className: "sk-field" }, "到期日", h("input", { className: "sk-input", type: "date", value: draft.dueDate, onChange: set("dueDate") })),
              h("label", { className: "sk-field" }, "自动归入来源（可选）",
                h("select", { className: "sk-select", value: draft.workspaceId, onChange: set("workspaceId") },
                  h("option", { value: "" }, "不自动归入"),
                  draft.workspaceId && !workspaces.some((workspace) => workspace.id === draft.workspaceId)
                    ? h("option", { value: draft.workspaceId }, "原工作区（不可用）") : null,
                  workspaces.map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title))))),
            h("p", { className: "sub" }, "自建项目可以组织不同工作区的任务。选定来源后，该工作区未来自动建卡时也会归入此项目。"),
            h("label", { className: "sk-field" }, "项目备注", h("textarea", { className: "sk-textarea", rows: 4,
              maxLength: TEXT_LIMITS.notes, value: draft.notes, onChange: set("notes") })),
            project ? h("label", { className: "sk-inline-actions" }, h("input", { type: "checkbox", checked: draft.archived,
              onChange: (event) => setDraft((value) => ({ ...value, archived: event.target.checked })) }), "归档项目（保留任务）") : null,
            changes.conflicts.length ? h(DraftConflict, { fields: changes.conflicts, onResolve: reconcile }) : null,
            error ? h("p", { role: "alert", className: "sk-error-detail" }, error) : null),
          h("div", { className: "sk-modal-foot" },
            h("button", { className: "sk-btn ghost", type: "button", onClick: onClose }, "取消"),
            h("button", { className: "sk-btn primary", type: "submit", disabled: busy || changes.conflicts.length > 0 || !draft.name.trim() }, busy ? "保存中…" : "保存项目"))));
    }

    async function readChatReply({ mode, input, context, reference, signal, onEvent }) {
      const response = await fetch(new URL(`${API}/chat`, document.baseURI), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, input, context, reference }), signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || (response.status === 404 ? "当前看板版本不支持快聊" : "快聊连接失败"));
      }
      if (!response.body || !/^application\/x-ndjson(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")) {
        throw new Error("快聊响应格式无效，请检查连接后重试");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) throw new Error("回答连接已断开，请重试");
          bytes += value.byteLength;
          if (bytes > 512_000) throw new Error("回答超过接收上限");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              throw new Error("快聊响应格式无效，请重试");
            }
            if (event?.type === "done") return;
            if (event?.type === "error" && typeof event.message === "string") throw new Error(event.message);
            if ((event?.type === "start" && typeof event.model === "string") ||
                (event?.type === "delta" && typeof event.text === "string")) onEvent(event);
            else throw new Error("快聊响应格式无效，请重试");
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }

    function chatContext(turns, route) {
      const recent = [];
      let size = 0;
      for (const turn of turns.slice().reverse()) {
        // 翻译、润色等一次性模式以及未完成的回答不进入追问上下文。
        if ((turn.mode && turn.mode !== "ask") || turn.stopped) continue;
        if (!route?.ok || turn.provider !== route.provider || turn.model !== route.model) break;
        size += turn.input.length + turn.answer.length;
        if (size > 24_000 || recent.length >= 4) break;
        recent.unshift({ input: turn.input, answer: turn.answer });
      }
      return recent.length ? { provider: route.provider, model: route.model, turns: recent } : undefined;
    }

    // 与 Host 的 server/quick-chat.mjs 保持一致：问答可连续追问，其余模式每次只处理当前输入。
    const CHAT_MODES = {
      ask: { label: "问答", placeholder: "问点什么…（Enter 发送）", hint: "可连续追问，最近几轮问答会作为上下文。" },
      prompt: { label: "写提示词", placeholder: "用一两句话描述想让 AI 完成的事", hint: "把想法整理成可直接发给会话的任务提示词。" },
      explain: { label: "解释", placeholder: "粘贴报错、代码或术语", hint: "解释含义，并给出可能原因和下一步。" },
      summarize: { label: "总结", placeholder: "粘贴要总结的内容", hint: "先给结论，再列要点。" },
      polish: { label: "润色", placeholder: "粘贴要润色的文字", hint: "保持原意，让表达更清晰简洁。" },
      "translate-zh": { label: "译成中文", placeholder: "粘贴要翻译的原文", hint: "只翻译当前原文。" },
      "translate-en": { label: "译成英文", placeholder: "粘贴要翻译的原文", hint: "只翻译当前原文。" },
    };
    const CHAT_INPUT_LIMIT = 4000;
    const CHAT_REFERENCE_LIMIT = 6000;
    const CHAT_TURN_LIMIT = 30;

    /** 快聊记录只放在当前窗口的内存里：关闭弹窗不丢，刷新窗口或点「新对话」即清空，不写入磁盘。 */
    const chatStore = createStore({ turns: [], mode: "ask", input: "", reference: null });

    function patchChat(patch) {
      chatStore.set((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
    }

    /** 把任务整理成快聊的参考资料（只在用户主动选择「就此任务快聊」时生成）。 */
    function taskChatReference(task) {
      const goal = goalInfoOf(task);
      const list = (title, items) => items.length ? `${title}：\n${items.map((item) => `- ${item}`).join("\n")}` : "";
      const subtasks = subtasksOf(task);
      const text = [
        `任务：${task.title}`,
        `状态：${STATUS_META[statusOf(task)].label} · ${taskProgressLabel(task)} · 优先级 ${task.priority || "P2"}`,
        task.workspaceTitle ? `工作区：${task.workspaceTitle}` : "",
        task.projectName ? `项目：${task.projectName}` : "",
        task.dueDate ? `到期日：${task.dueDate}` : "",
        goal?.text ? `目标：${goal.text}` : "",
        task.acceptanceCriteria ? `验收条件：${task.acceptanceCriteria}` : "",
        list("关键事实", keyFactsOf(task).map((fact) => fact.text).filter(Boolean).slice(0, 8)),
        list("未解决的问题", (task.issues || []).map((issue) => issue?.text).filter(Boolean).slice(0, 6)),
        list("下一步", (task.nextSteps || []).filter(Boolean).slice(0, 6)),
        list("子任务", subtasks.slice(0, 12).map((item) => `${item.done ? "[x]" : "[ ]"} ${item.title || item.text || ""}`)),
        list("交付物", artifactsOf(task).slice(0, 6).map((item) => item.path || item.name).filter(Boolean)),
        task.notes ? `备注：${task.notes}` : "",
      ].filter(Boolean).join("\n");
      return { title: clip(task.title, 80), text: text.slice(0, CHAT_REFERENCE_LIMIT) };
    }

    /* --------------------------- Markdown（精简） --------------------------- */

    /** 行内标记：`code`、**加粗**、*强调* 与 http(s) 链接。只生成 React 节点，不拼接 HTML。 */
    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(\*[^*\s][^*\n]*\*)/g;
      let last = 0;
      let index = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyPrefix}:${index++}`;
        if (match[1]) nodes.push(h("code", { key }, token.slice(1, -1)));
        else if (match[2]) nodes.push(h("strong", { key }, token.slice(2, -2)));
        else if (match[3]) nodes.push(h("a", { key, href: match[4], target: "_blank", rel: "noopener noreferrer" }, token.slice(1, token.indexOf("](") )));
        else nodes.push(h("em", { key }, token.slice(1, -1)));
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    const MD_FENCE = /^\s*```+\s*([\w+#.-]*)\s*$/;
    const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
    const MD_QUOTE = /^\s{0,3}>\s?/;
    const MD_LIST = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

    /** 模型回答的块级渲染：代码块、标题、引用、列表和段落；流式输出中未闭合的代码块同样可读。 */
    function markdownBlocks(source) {
      const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        const fence = line.match(MD_FENCE);
        if (fence) {
          const code = [];
          index += 1;
          while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) code.push(lines[index++]);
          index += 1;
          blocks.push({ type: "code", lang: fence[1], text: code.join("\n") });
        } else if (!line.trim()) {
          index += 1;
        } else if (MD_HEADING.test(line)) {
          const heading = line.match(MD_HEADING);
          blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
          index += 1;
        } else if (MD_QUOTE.test(line)) {
          const quote = [];
          while (index < lines.length && MD_QUOTE.test(lines[index])) quote.push(lines[index++].replace(MD_QUOTE, ""));
          blocks.push({ type: "quote", text: quote.join("\n") });
        } else if (MD_LIST.test(line)) {
          const items = [];
          while (index < lines.length) {
            const item = lines[index].match(MD_LIST);
            if (item) items.push({ marker: item[3] ? `${item[3]}.` : "•", depth: Math.min(3, Math.floor(item[1].length / 2)), text: item[4] });
            else if (items.length && /^\s{2,}\S/.test(lines[index]) && !MD_FENCE.test(lines[index])) items.at(-1).text += "\n" + lines[index].trim();
            else break;
            index += 1;
          }
          blocks.push({ type: "list", items });
        } else {
          const paragraph = [];
          while (index < lines.length && lines[index].trim() && ![MD_FENCE, MD_HEADING, MD_QUOTE, MD_LIST].some((rule) => rule.test(lines[index]))) {
            paragraph.push(lines[index++]);
          }
          blocks.push({ type: "paragraph", text: paragraph.join("\n") });
        }
      }
      return blocks;
    }

    function MarkdownLite({ text, onCopyCode }) {
      return h("div", { className: "sk-md" }, markdownBlocks(text).map((block, key) => {
        if (block.type === "code") {
          return h("div", { key, className: "sk-md-code" },
            h("div", { className: "sk-md-code-head" }, h("span", null, block.lang || "代码"),
              onCopyCode ? h("button", { type: "button", className: "sk-text", onClick: () => onCopyCode(block.text) }, "复制代码") : null),
            h("pre", { tabIndex: 0 }, h("code", null, block.text)));
        }
        if (block.type === "heading") {
          return h("p", { key, className: "sk-md-heading", role: "heading", "aria-level": Math.min(6, block.level + 3) }, renderInline(block.text, key));
        }
        if (block.type === "quote") return h("blockquote", { key }, renderInline(block.text, key));
        if (block.type === "list") {
          return h("ul", { key, className: "sk-md-list" }, block.items.map((item, index) =>
            h("li", { key: index, style: item.depth ? { marginInlineStart: item.depth * 16 } : undefined },
              h("span", { className: "sk-md-marker", "aria-hidden": "true" }, item.marker), h("span", null, renderInline(item.text, `${key}:${index}`)))));
        }
        return h("p", { key }, renderInline(block.text, key));
      }));
    }

    /* ------------------------------- 快聊弹窗 ------------------------------- */

    function QuickChat({ route, modelOpen, onModel, onClose, pushToast, host, sessionId, workspaceId, seed }) {
      const session = useStore(chatStore);
      const { turns, mode, input, reference } = session;
      const [attempt, setAttempt] = React.useState(() => null);
      const [busy, setBusy] = React.useState(false);
      const [saving, setSaving] = React.useState("");
      const request = React.useRef(null);
      const dialogRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const outputRef = React.useRef(null);
      const followOutput = React.useRef(true);
      const titleId = React.useId();
      const meta = CHAT_MODES[mode] || CHAT_MODES.ask;
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();
      React.useEffect(() => {
        if (seed?.reference || seed?.mode || seed?.input) {
          patchChat({
            ...(seed.reference ? { reference: seed.reference, mode: "ask" } : {}),
            ...(Object.hasOwn(CHAT_MODES, seed.mode || "") ? { mode: seed.mode } : {}),
            ...(seed.input ? { input: String(seed.input).slice(0, CHAT_INPUT_LIMIT) } : {}),
          });
        }
        return () => {
          request.current?.abort();
          request.current = null;
        };
      }, []);
      React.useLayoutEffect(() => {
        const node = outputRef.current;
        if (node && followOutput.current) node.scrollTop = node.scrollHeight;
      }, [turns, attempt]);

      const focusInput = () => inputRef.current?.focus({ preventScroll: true });
      const changeMode = (next) => {
        patchChat({ mode: next });
        focusInput();
      };
      const reset = () => {
        // 先解除当前请求的归属，迟到的回调才不会把已清空的记录写回来。
        const active = request.current;
        request.current = null;
        active?.abort();
        setBusy(false);
        patchChat({ turns: [], reference: null });
        setAttempt(null);
        focusInput();
      };
      const send = async (event, retry) => {
        event?.preventDefault();
        const text = (retry ? retry.input : input).trim();
        const useMode = retry ? retry.mode || "ask" : mode;
        if (request.current || !text || route?.ok === false) return;
        const controller = new AbortController();
        request.current = controller;
        followOutput.current = true;
        // 重新生成：旧回答不进入上下文，但要等新回答成功后才被替换，失败或停止时原回答保留。
        const replaces = retry?.index;
        const history = replaces === undefined ? turns : turns.slice(0, replaces);
        const context = useMode === "ask" ? chatContext(history, route) : undefined;
        const attached = useMode === "ask" ? reference : null;
        const again = { input: text, mode: useMode, index: replaces };
        let current = { mode: useMode, input: text, answer: "", status: "正在连接模型…", reference: attached?.title, replaces };
        const update = (patch) => {
          current = { ...current, ...patch };
          setAttempt(current);
        };
        const record = (extra) => {
          const { status: _status, error: _error, retry: _retry, replaces: _replaces, ...turn } = current;
          patchChat((state) => {
            const next = { ...turn, ...extra };
            const list = replaces === undefined || replaces >= state.turns.length ? [...state.turns, next]
              : [...state.turns.slice(0, replaces), next, ...state.turns.slice(replaces + 1)];
            // 输入框里仍是刚发出的这段文字时清空，其余情况保留用户正在写的草稿。
            return { turns: list.slice(-CHAT_TURN_LIMIT), input: !retry || state.input.trim() === text ? "" : state.input };
          });
          setAttempt(null);
        };
        const stopped = () => {
          if (replaces !== undefined) setAttempt(null);
          else if (current.answer) record({ stopped: true });
          else update({ status: "已停止", retry: again });
        };
        setAttempt(current);
        setBusy(true);
        focusInput();
        try {
          await readChatReply({ mode: useMode, input: text, context, reference: attached || undefined, signal: controller.signal, onEvent: (chunk) => {
            if (request.current !== controller || controller.signal.aborted) return;
            if (chunk.type === "start") update({ model: chunk.model, provider: chunk.provider, status: "正在回答…" });
            if (chunk.type === "delta") update({ answer: current.answer + chunk.text, status: "正在回答…" });
          } });
          if (request.current !== controller) return;
          if (controller.signal.aborted) stopped();
          else record(null);
        } catch (cause) {
          if (request.current !== controller) return;
          if (controller.signal.aborted) stopped();
          else update({ status: "", error: cause.message, retry: again });
        } finally {
          if (request.current === controller) {
            request.current = null;
            setBusy(false);
          }
        }
      };
      const stop = (event) => {
        event.preventDefault();
        request.current?.abort();
        focusInput();
      };
      const toSession = async (text) => {
        const target = sessionId || host?.currentSession?.();
        if (!target || !host?.placeDraft) {
          pushToast("请先打开一个会话，再把内容放入输入框", "error");
          return;
        }
        setSaving("draft");
        try {
          const result = await host.placeDraft(target, text);
          if (result?.ok && result.result === "applied") {
            pushToast("已放入会话输入框，确认后发送", "info");
            onClose();
          } else {
            const copied = await copyToClipboard(text);
            pushToast((result?.result === "preserved" ? "输入框已有草稿" : "会话输入框未就绪") + (copied ? "，内容已复制" : "，请手动复制"), copied ? "info" : "error");
          }
        } finally {
          setSaving("");
        }
      };
      const toTask = async (turn) => {
        setSaving("task");
        try {
          const title = clip(turn.input.split("\n").find((line) => line.trim())?.trim() || "快聊记录", 80);
          await command("task.create", { title, status: "backlog", notes: turn.answer.slice(0, 4000), ...(workspaceId ? { workspaceId } : {}) });
          pushToast(`已存为待办任务「${title}」`, "info");
        } catch (cause) {
          pushToast(`保存失败：${cause.message}`, "error");
        } finally {
          setSaving("");
        }
      };

      const currentModel = selectedModelLabel(route);
      const lastModelTurn = turns.findLast?.((turn) => turn.model);
      const newModel = mode === "ask" && lastModelTurn && route?.ok &&
        (lastModelTurn.provider !== route.provider || lastModelTurn.model !== route.model);
      const copyCode = (code) => copyWithToast(code, "代码", pushToast);
      const question = (turn) => h("div", { className: "sk-chat-question" },
        turn.mode && turn.mode !== "ask" ? h("span", { className: "sk-chat-tag" }, CHAT_MODES[turn.mode]?.label) : null,
        turn.reference ? h("span", { className: "sk-chat-tag", title: `参考：${turn.reference}` }, "带参考") : null,
        h("p", { className: "sk-preserve-lines" }, turn.input));
      const turnNode = (turn, index) => busy && attempt?.replaces === index ? null : h("article", { className: "sk-chat-turn", key: index },
        question(turn),
        h("div", { className: "sk-chat-answer", "aria-label": "模型回答" }, h(MarkdownLite, { text: turn.answer, onCopyCode: copyCode })),
        h("div", { className: "sk-chat-turn-meta" },
          h("span", { title: modelLabel(turn.provider, turn.model) }, [modelNameOf(turn.provider, turn.model), turn.stopped ? "已停止" : ""].filter(Boolean).join(" · ")),
          h("span", { className: "sk-chat-actions" },
            h("button", { className: "sk-text", type: "button", onClick: () => copyWithToast(turn.answer, "回答", pushToast) }, "复制"),
            host?.placeDraft ? h("button", { className: "sk-text", type: "button", disabled: Boolean(saving),
              title: "把这段内容放入当前会话的输入框，由你确认后发送", onClick: () => toSession(turn.answer) }, "放入会话") : null,
            h("button", { className: "sk-text", type: "button", disabled: Boolean(saving), title: "新建一张待办任务，问题作标题，回答存入备注",
              onClick: () => toTask(turn) }, "存为任务"),
            index === turns.length - 1 && !busy ? h("button", { className: "sk-text", type: "button",
              onClick: () => send(null, { input: turn.input, mode: turn.mode, index }) }, "重新生成") : null)));
      const empty = !turns.length && !attempt;
      return h("div", { className: "sk-modal-mask", inert: modelOpen, onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h("form", { className: "sk-modal sk-chat-modal", ref: dialogRef, role: "dialog", "aria-modal": modelOpen ? undefined : "true", "aria-labelledby": titleId, onSubmit: send },
          h("header", { className: "sk-chat-head" },
            h("h3", { id: titleId }, h(Icon, { name: "chat", size: 15 }), "快聊"),
            h("button", { className: "sk-btn sk-model-button", type: "button", onClick: onModel, "aria-label": "切换模型",
              title: route?.message || modelLabel(route?.provider, route?.model) || currentModel },
              h(Icon, { name: "spark", size: 14 }), h("span", null, currentModel)),
            turns.length || attempt ? h("button", { className: "sk-btn ghost", type: "button", onClick: reset, title: "清空当前记录，开始新对话" }, "新对话") : null,
            h("button", { className: "sk-btn ghost icon", type: "button", "aria-label": "关闭快聊", title: "关闭（Esc）· 记录保留到刷新窗口", onClick: onClose },
              h(Icon, { name: "close", size: 14 }))),
          h("div", { className: "sk-chat-modes", role: "group", "aria-label": "快聊模式" },
            Object.entries(CHAT_MODES).map(([id, item]) => h("button", { key: id, type: "button", className: "sk-chip", "aria-pressed": mode === id,
              disabled: busy, title: item.hint, onClick: () => changeMode(id) }, item.label))),
          route?.ok === false ? h("p", { className: "sk-error-detail", role: "alert" }, route.message) : null,
          h("div", { className: "sk-chat-thread", tabIndex: 0, ref: outputRef, "aria-label": "快聊记录",
            onScroll: (event) => {
              const node = event.currentTarget;
              followOutput.current = node.scrollHeight - node.clientHeight - node.scrollTop < 32;
            } },
            empty ? h("div", { className: "sk-chat-empty" },
              h("p", { className: "sk-chat-empty-title" }, meta.hint),
              h("p", null, "内容会发送给当前模型；记录只保存在本窗口内存中，刷新或点「新对话」即清空。"),
              h("div", { className: "sk-chat-starters" },
                h("button", { type: "button", className: "sk-chip", onClick: () => changeMode("prompt") }, "把想法写成任务提示词"),
                h("button", { type: "button", className: "sk-chip", onClick: () => changeMode("explain") }, "解释一段报错"),
                h("button", { type: "button", className: "sk-chip", onClick: () => changeMode("summarize") }, "总结一段内容"),
                h("button", { type: "button", className: "sk-chip", onClick: () => changeMode("translate-zh") }, "翻译成中文"))) : null,
            turns.map(turnNode),
            attempt ? h("article", { className: "sk-chat-turn is-live" },
              question(attempt),
              attempt.answer ? h("div", { className: "sk-chat-answer", "aria-label": "模型回答" }, h(MarkdownLite, { text: attempt.answer, onCopyCode: copyCode })) : null,
              attempt.status ? h("div", { className: "sk-chat-status", role: "status" },
                [attempt.status, modelNameOf(attempt.provider, attempt.model)].filter(Boolean).join(" · ")) : null,
              attempt.error ? h("p", { role: "alert", className: "sk-error-detail" }, attempt.error) : null,
              attempt.retry && !busy ? h("div", { className: "sk-chat-turn-meta" }, h("span", null, "输入已保留"),
                h("button", { className: "sk-text", type: "button", onClick: () => send(null, attempt.retry) }, "重试")) : null) : null),
          newModel ? h("p", { className: "sub" }, "已换模型：新问题从新一轮开始，之前的回答仍可查看。") : null,
          reference ? h("div", { className: "sk-chat-reference" },
            h(Icon, { name: "file", size: 12 }),
            h("span", { title: reference.text }, `参考任务：${reference.title}`),
            mode === "ask" ? h("span", { className: "sk-chat-reference-note" }, "随问题发送给模型") : h("span", { className: "sk-chat-reference-note" }, "仅问答模式使用"),
            h("button", { type: "button", className: "sk-text", "aria-label": "移除参考任务", onClick: () => patchChat({ reference: null }) }, "移除")) : null,
          h("div", { className: "sk-chat-composer" },
            h("textarea", { className: "sk-textarea", ref: inputRef, "data-sk-initial-focus": true, "aria-label": meta.label + "输入",
              rows: Math.min(8, Math.max(2, input.split("\n").length)), maxLength: CHAT_INPUT_LIMIT,
              placeholder: mode === "ask" && turns.length ? "继续追问…（Enter 发送）" : meta.placeholder, value: input, readOnly: busy,
              onChange: (event) => patchChat({ input: event.target.value }),
              onKeyDown: (event) => {
                if (event.key !== "Enter" || isComposingKey(event) || event.shiftKey || event.altKey) return;
                send(event);
              } }),
            busy
              ? h("button", { key: "stop", className: "sk-btn", type: "button", onClick: stop }, h(Icon, { name: "stop", size: 13 }), "停止")
              : h("button", { key: "send", className: "sk-btn primary", type: "submit", disabled: !input.trim() || route?.ok === false,
                  title: "发送（Enter）" }, h(Icon, { name: "send", size: 13 }), "发送")),
          h("p", { className: "sk-chat-foot" }, "Enter 发送 · Shift + Enter 换行 · Esc 关闭",
            input.length > CHAT_INPUT_LIMIT * 0.8 ? h("span", null, ` · ${input.length}/${CHAT_INPUT_LIMIT}`) : null)));
    }

    /** 由浮层承载的快聊：会话页头菜单与悬浮看板不依赖任何一块已打开的看板即可使用。 */
    function OverlayChat({ host }) {
      const request = useStore(overlayChatStore);
      React.useEffect(() => {
        overlayHosts += 1;
        return () => { overlayHosts -= 1; };
      }, []);
      return request ? h(OverlayChatHost, { key: request.token, host, request }) : null;
    }

    function OverlayChatHost({ host, request }) {
      const { data, reload, setData } = useBoardData();
      const [toasts, pushToast] = useToasts();
      const [modelOpen, setModelOpen] = React.useState(false);
      const modelTrigger = React.useRef(null);
      const root = React.useRef(null);
      const topLayer = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
      React.useLayoutEffect(() => {
        const node = root.current;
        if (!topLayer || !node) return undefined;
        node.showPopover();
        return () => { if (node.matches(":popover-open")) node.hidePopover(); };
      }, [topLayer]);
      const sessionId = request.sessionId || host.currentSession?.() || null;
      return h("div", { ref: root, className: "sk-overlay-host", popover: topLayer ? "manual" : undefined },
        h(QuickChat, { route: data?.aiRoute, modelOpen, host, sessionId, seed: request, pushToast,
          workspaceId: quickCapturePayload("", data?.tasks || [], sessionId).workspaceId,
          onModel: (event) => { modelTrigger.current = event.currentTarget; setModelOpen(true); },
          onClose: () => overlayChatStore.set(null) }),
        modelOpen && data ? h(ModelModal, { settings: data.settings || {}, returnFocus: modelTrigger, onClose: () => setModelOpen(false),
          onSave: ({ settings, aiRoute }) => {
            setData((current) => current ? { ...current, settings, aiRoute } : current);
            setModelOpen(false);
            pushToast("已切换模型", "info");
            void reload(true);
          } }) : null,
        h("div", { className: "sk-toasts", role: "status", "aria-live": "polite", "aria-atomic": "false" },
          toasts.map((toast) => h("div", { key: toast.id, className: cx("sk-toast", toast.tone === "error" && "error") }, toast.text))));
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
            h("button", { className: "sk-btn", type: "button", onClick: () => startScan("full"), disabled: data.scan?.state === "running" }, "扫描全部历史"),
            data.storage?.writable === false ? h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(() => command("storage.retry"), "看板已保存") }, "重试保存") : null,
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(downloadExport, "已导出看板备份") }, "导出备份")),
          h("label", { className: "sk-field" }, "选择备份以预览",
            h("input", { type: "file", accept: ".json,application/json", disabled: busy,
              onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ""; previewBackup(file); } })),
          preview ? h("div", { className: "sk-board-notice" },
            h("span", null, `${preview.filename} · 将以 ${preview.incoming} 项任务替换当前 ${preview.current} 项`,
              Number.isInteger(preview.incomingProjects) ? ` · 项目 ${preview.currentProjects} → ${preview.incomingProjects}` : null),
            h("button", { className: "sk-btn", type: "button", disabled: busy, onClick: () => run(async () => {
              try {
                await command("backup.restore", { backup, expectedSavedAt: preview.expectedSavedAt, backupHash: preview.backupHash });
              } catch (cause) {
                if (cause.code !== "revision-conflict") throw cause;
                const refreshed = await command("backup.preview", { backup });
                setPreview({ ...refreshed.data, filename: preview.filename });
                pushToast("看板已变化，已刷新预览，请再次确认", "info");
                return;
              }
              setBackup(null);
              setPreview(null);
              pushToast("备份已恢复，已保留恢复前的快照", "info");
            }) }, "确认恢复"),
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
      const prefs = useUiPrefs();
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
      const selectedProject = data?.projects?.find((project) => project.id === filters.project);
      const collapseKey = `dsh-super-kanban:done-collapsed:${surface}`;
      const [doneCollapsed, setDoneCollapsed] = React.useState(() => {
        try { return localStorage.getItem(collapseKey) === "true"; } catch { return false; }
      });
      const pageKey = JSON.stringify([filters, sessionId, currentOnly]);
      const [, setHandoffTick] = React.useState(0);
      const searchRef = React.useRef(null);
      const [drawerId, setDrawerId] = React.useState(null);
      const [newTaskStatus, setNewTaskStatus] = React.useState(null);
      const [projectEditor, setProjectEditor] = React.useState(null);
      const [chatOpen, setChatOpen] = React.useState(false);
      const [chatSeed, setChatSeed] = React.useState(() => null);
      const [modelOpen, setModelOpen] = React.useState(false);
      const modelTriggerRef = React.useRef(null);
      const openModel = (event) => {
        modelTriggerRef.current = event.currentTarget;
        setModelOpen(true);
      };
      // 快聊优先由浮层承载（三种形态共用同一个全窗口弹窗）；旧版 DSH 没有浮层插槽时退回本面板内的弹窗。
      const openChat = (seed) => {
        if (overlayHosts > 0 && host.openChat) host.openChat({ ...(seed || {}), sessionId });
        else {
          setChatSeed(seed || null);
          setChatOpen(true);
        }
      };
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [draggingId, setDraggingId] = React.useState(null);
      const [scanBusy, setScanBusy] = React.useState(false);
      const [nowTick, setNowTick] = React.useState(Date.now);
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

      // 右侧看板登记自己的关闭动作：切到悬浮形态时由 host.closeSide() 调用，两种形态不同时出现。
      const closeTab = React.useRef(ctxProps.closeTab);
      closeTab.current = ctxProps.closeTab;
      // DSH 收起右侧栏时标签页内容仍然挂载，所以按「是否可见」而不是「是否挂载」登记。
      const sideVisible = surface === "side" && ctxProps.visible !== false;
      React.useEffect(() => {
        if (!sideVisible) return undefined;
        const close = () => {
          if (typeof closeTab.current !== "function") return false;
          closeTab.current();
          return true;
        };
        sideClosers.add(close);
        sideCountStore.set(sideClosers.size);
        // 右侧看板出现（包括从 DSH 右栏直接打开）时收起悬浮面板。
        setFloatingOpen(false);
        return () => {
          sideClosers.delete(close);
          sideCountStore.set(sideClosers.size);
        };
      }, [sideVisible]);

      React.useEffect(() => {
        try { localStorage.setItem(`dsh-super-kanban:view:${surface}`, mode); } catch { /* optional preference */ }
      }, [mode, surface]);

      React.useEffect(() => {
        try { localStorage.setItem(collapseKey, String(doneCollapsed)); } catch { /* optional preference */ }
      }, [collapseKey, doneCollapsed]);

      React.useEffect(() => { setQuickTask(null); }, [mode, sideStatus, filters, currentOnly]);

      React.useEffect(() => {
        const timer = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.defaultPrevented) return;
          const target = event.target;
          if (target?.closest?.(".sk-floating,.sk-overlay-host")) return;
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
          if (event.key === "/" && mode !== "projects") {
            event.preventDefault();
            if (searchRef.current) searchRef.current.focus();
            else if (isNarrow) {
              setFilterOpen(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }
          } else if ((event.key === "n" || event.key === "N") && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            if (mode === "projects") setProjectEditor("new");
            else if (!selectedProject?.archived) setNewTaskStatus("backlog");
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [settingsOpen, newTaskStatus, drawerId, moreAnchor, filterOpen, surface, isNarrow, mode, selectedProject?.archived]);

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

      const projects = React.useMemo(() => data?.projects || [], [data?.projects]);
      const tasks = React.useMemo(() => {
        const list = data?.tasks || [];
        const statuses = ctxProps.sessionStatuses;
        const bySession = new Map();
        const byProject = new Map(projects.map((project) => [project.id, project]));
        const now = Date.now();
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
          const project = byProject.get(task.projectId);
          const projected = withSessionStatus(project ? { ...task, projectName: project.name } : task, statuses, now);
          const overlap = bySession.get(task.primarySessionId) || task.sessions?.map((session) => bySession.get(session.id)).find(Boolean);
          return overlap && !task.archived ? { ...projected, writeOverlap: overlap } : projected;
        });
      }, [data?.tasks, data?.writeOverlaps, ctxProps.sessionStatuses, projects, nowTick]);
      const settings = (data && data.settings) || {};
      const aiRoute = data?.aiRoute;
      const scan = (data && data.scan) || { state: "idle" };
      const workspaces = (data && data.workspaces) || [];
      const selectedWorkspace = workspaces.find((workspace) => workspace.id === filters.workspace);
      const stats = (data && data.stats) || { byStatus: {}, doneRate: 0, total: 0 };
      const usage = usageOf(data);
      const activeFilterCount = [filters.priority, filters.source, filters.tag, filters.showArchived, filters.running, projects.length && filters.workspace, isNarrow && filters.query.trim()].filter(Boolean).length;
      const clearFilters = () => setFilters({ ...EMPTY_FILTERS });
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
          const projectGone = current.project && current.project !== "__none" && !projects.some((project) => project.id === current.project);
          if (!workspaceGone && !tagGone && !projectGone) return current;
          return { ...current, workspace: workspaceGone ? "" : current.workspace, tag: tagGone ? "" : current.tag, project: projectGone ? "" : current.project };
        });
      }, [data, workspaceFilterIds, tags, workspaces.length, tasks.length, projects]);

      const cutoff = activityCutoff(settings.initialDays, nowTick);
      const historicalIds = React.useMemo(() => new Set(tasks.filter((task) => isHistoricalTask(task, cutoff)).map((task) => task.id)), [tasks, cutoff]);
      const filteredTasks = React.useMemo(() => {
        const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return tasks.filter((task) => {
          if (!filters.showArchived && task.archived) return false;
          if (sessionId && currentOnly && task.primarySessionId !== sessionId && !task.sessions?.some((item) => item.id === sessionId)) return false;
          if (filters.workspace && task.workspaceId !== filters.workspace) return false;
          if (filters.project && (task.projectId || "__none") !== filters.project) return false;
          if (filters.running && !taskRunningLabel(task)) return false;
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
              task.projectName,
              task.notes,
              task.dueDate,
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
      const visible = React.useMemo(() => filteredTasks.filter((task) => filters.activity === "all" ||
        historicalIds.has(task.id) === (filters.activity === "history")), [filteredTasks, filters.activity, historicalIds]);

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
      const runningCount = visible.filter(taskRunningLabel).length;
      const emptyProject = selectedProject && !selectedProject.archived &&
        !tasks.some((task) => task.projectId === selectedProject.id && !task.archived);
      const openScope = (scope, nextMode, activity) => {
        setFilters({ ...EMPTY_FILTERS, ...scope, activity });
        setCurrentOnly(false);
        const statuses = new Set(tasks.filter((task) => !task.archived &&
          (activity === "all" || historicalIds.has(task.id) === (activity === "history")) &&
          (scope.workspace ? task.workspaceId === scope.workspace : (task.projectId || "__none") === scope.project)).map(statusOf));
        setSideStatus(statuses.has("in_progress") ? "in_progress" : STATUS_ORDER.find((status) => statuses.has(status)) || "backlog");
        setMode(nextMode);
      };
      const openProject = (id, mode = "board", activity = "recent") => openScope({ project: id }, mode, activity);
      const openWorkspaceProject = (id, mode = "timeline", activity = "recent") => openScope({ workspace: id }, mode, activity);
      const openAttentionSession = (id) => {
        if (!host.openSession?.(id)) pushToast("无法打开来源会话", "error");
      };
      const drawerTask = drawerId ? taskIndex.get(drawerId) : null;
      React.useEffect(() => {
        if (surface !== "page" || !data) return undefined;
        const open = () => {
          if (!requestedPageTask) return;
          setDrawerId(requestedPageTask);
          requestedPageTask = null;
        };
        pageTaskListeners.add(open);
        open();
        return () => pageTaskListeners.delete(open);
      }, [surface, Boolean(data)]);
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
        if (data && drawerId && !drawerTask) setDrawerId(null);
      }, [data, drawerId, drawerTask]);

      const scanRunning = scan.state === "running";
      // 运行中 AI 进度：Host 已把 aiBudgetMode 解析成 scan.aiBudget；旧 Host 无该字段时只显示已用次数。
      const scanAiCalls = Number(scan.aiBudgetUsed ?? scan.aiCalls) || 0;
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

      const scopedStats = !["projects", "maintenance"].includes(mode);
      const summaryTasks = mode === "schedule" ? visible.filter((task) => !task.archived && task.status !== "done") : visible;
      const statusCounts = scopedStats
        ? summaryTasks.reduce((counts, task) => {
            const status = statusOf(task);
            counts[status] = (counts[status] || 0) + 1;
            return counts;
          }, {})
        : stats.byStatus || {};
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
        ["total", "已归档", scopedStats ? summaryTasks.filter((task) => task.archived).length : Number(stats.archived) || 0]].filter(([, , count]) => count > 0);
      const totalLabel = `${scopedStats ? summaryTasks.length : stats.total || tasks.length} 项`;
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

      const switchSurface = (next) => {
        if (host.openSurface?.(next, sessionId, surface)) updatePrefs({ surface: next });
        else pushToast("当前环境无法打开此看板形态", "error");
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
      const currentModel = selectedModelLabel(aiRoute);
      const modelButton = h("button", { type: "button", className: cx("sk-iconbtn-v3 sk-model-trigger", aiRoute?.ok === false && "is-warn"),
        "aria-label": "选择模型", title: aiRoute?.message || modelLabel(aiRoute?.provider, aiRoute?.model) || currentModel, onClick: openModel },
        h(Icon, { name: "spark", size: 15 }), compactHeader ? null : h("span", null, currentModel));
      const chatButton = compactHeader ? actionIcon("chat", "快聊", () => openChat()) :
        h("button", { type: "button", className: "sk-iconbtn-v3 sk-chat-trigger", "aria-label": "快聊", onClick: () => openChat() },
          h(Icon, { name: "chat", size: 15 }), "快聊");
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
          !isNarrow && mode !== "projects" ? searchField : null,
          scanButton, modelButton, chatButton, settingsButton,
          h(SurfaceSwitch, { value: surface, onChange: switchSurface }),
          mode === "projects" || selectedProject?.archived ? null : surface === "side" || isNarrow
            ? actionIcon("plus", "新建任务", () => setNewTaskStatus("backlog"), "is-primary")
            : newTextButton,
          h(QuickMenuButton, { label: "更多看板操作", expanded: Boolean(moreAnchor), onOpen: setMoreAnchor }),
          moreAnchor ? h(QuickMenu, { anchor: moreAnchor, items: boardMenuItems, label: "更多看板操作", onClose: () => setMoreAnchor(null) }) : null));

      const viewSwitch = compactHeader
        ? h("span", { className: "sk-ws-picker sk-view-picker" },
            h("select", { className: "sk-select sk-ws-select", "aria-label": "任务视图", value: mode,
              onChange: (event) => setMode(event.target.value) },
              Object.entries(VIEW_MODES).map(([key, label]) => h("option", { key, value: key }, key === "attention" && attentionCount ? label + " " + attentionCount : label))),
            h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }))
        : h("div", { className: "sk-view-switch", role: "group", "aria-label": "任务视图" },
            Object.entries(VIEW_MODES).map(([key, label]) => h("button", {
              key, type: "button", "aria-pressed": mode === key, onClick: () => setMode(key),
            }, label, key === "attention" && attentionCount > 0 ? h("span", { className: "sk-view-count" }, " " + attentionCount) : null)));
      const workspaceSelect = (className) => h("select", {
        className, "aria-label": "按工作区筛选", value: filters.workspace,
        title: workspaces.find((workspace) => workspace.id === filters.workspace)?.title || "全部工作区",
        onChange: (event) => setFilters((value) => ({ ...value, workspace: event.target.value })),
      }, h("option", { value: "" }, "全部工作区"),
      workspaces.filter((workspace) => workspace.included !== false)
        .map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)));
      const showProjectFilter = projects.length > 0 || filters.project === "__none";
      const scopeValue = filters.project || (filters.workspace ? `ws:${filters.workspace}` : "");

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
          { className: cx("sk-slimbar", mode === "projects" && "is-project-view") },
          viewSwitch,
          h(
            "span",
            { className: "sk-ws-picker" },
            h("select", { className: "sk-select sk-ws-select", "aria-label": "按项目筛选", title: "按工作区或自建项目筛选", value: scopeValue,
              onChange: (event) => {
                const scope = event.target.value;
                setFilters((value) => ({ ...value, project: scope.startsWith("ws:") ? "" : scope, workspace: scope.startsWith("ws:") ? scope.slice(3) : "" }));
                setCurrentOnly(false);
              } },
              h("option", { value: "" }, "全部范围"),
              workspaces.length ? h("optgroup", { label: "工作区" }, workspaces.filter((workspace) => workspace.included !== false)
                .map((workspace) => h("option", { key: workspace.id, value: `ws:${workspace.id}` }, workspace.title))) : null,
              showProjectFilter ? h("optgroup", { label: "自建项目" },
                projects.map((project) => h("option", { key: project.id, value: project.id }, project.name + (project.archived ? "（已归档）" : ""))),
                h("option", { value: "__none" }, "未归入自建项目")) : null),
            h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }),
          ),
          !["projects", "maintenance"].includes(mode) ? h("select", { className: "sk-select sk-activity-picker", "aria-label": "任务时间范围",
            value: filters.activity, title: `近期：最近 ${settings.initialDays || 30} 天`,
            onChange: (event) => setFilters((value) => ({ ...value, activity: event.target.value })) },
            Object.entries(ACTIVITY_RANGES).map(([id, label]) => h("option", { key: id, value: id }, label))) : null,
          sessionId ? h("button", { type: "button", className: "sk-slim-icon sk-session-scope", "aria-pressed": currentOnly,
            title: currentOnly ? "当前会话，点击查看全部会话" : "全部会话，点击仅看当前会话",
            onClick: () => setCurrentOnly((value) => !value),
          }, currentOnly ? "当前会话" : "全部会话") : null,
          mode !== "maintenance" && visible.length !== tasks.length
            ? h("span", { className: "sk-count", title: `筛选范围内 ${visible.length} 项，共 ${tasks.length} 项` }, `${visible.length} / ${tasks.length}`)
            : null,
          runningCount || filters.running ? h("button", { type: "button", className: cx("sk-slim-icon", "sk-running-filter", filters.running && "is-on"),
            "aria-pressed": filters.running, "aria-label": `仅看运行中的任务（${runningCount} 项）`,
            onClick: () => {
              setFilters((value) => ({ ...value, running: !value.running }));
              if (!filters.running && !["board", "list"].includes(mode)) setMode("list");
            } }, h("span", { className: "sk-run-label" }, `${runningCount} 运行中`)) : null,
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
                  showProjectFilter ? h("label", { className: "sk-field" }, "工作区", workspaceSelect("sk-select")) : null,
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
        selectedProject?.archived && mode !== "projects"
          ? h("div", { className: "sk-board-notice" }, "此项目已归档",
              h("button", { type: "button", className: "sk-btn", onClick: () => setProjectEditor(selectedProject.id) }, "编辑项目"))
          : null,
        sessionId && liveHandoff?.targetId === sessionId
          ? h("div", { className: "sk-board-notice" }, `继续任务 · ${liveHandoff.title}`,
              h("button", { type: "button", className: "sk-btn", onClick: attachHandoff }, "关联当前会话"),
              h("button", { type: "button", className: "sk-text", onClick: () => { pendingHandoff = null; setHandoffTick((value) => value + 1); } }, "关闭"))
          : null,
        mode === "projects"
          ? h(ProjectsView, { projects, workspaces, tasks, historicalIds, signals, onOpen: openProject, onWorkspace: openWorkspaceProject, onNew: () => setProjectEditor("new"),
              onEdit: setProjectEditor, today: localDateKey(Date.now()) })
          : mode === "maintenance"
          ? h(MaintenanceView, { data, reload, pushToast, startScan })
          : mode === "timeline"
            ? h(TimelineView, { key: `${scopeValue}:${filters.activity}`, tasks: filteredTasks, range: filters.activity, cutoff,
                title: selectedProject?.name || selectedWorkspace?.title, onOpen: setDrawerId, onSession: openAttentionSession })
          : mode === "artifacts"
            ? h(ArtifactsView, { tasks: visible, host, desktopFiles, pushToast, onOpen: setDrawerId })
            : mode !== "board"
              ? h(TaskCollection, { key: mode, mode, tasks: visible, projects, signals, onOpen: setDrawerId, taskActions, openSession: openAttentionSession, reload, pushToast,
                  emptyText: sessionId && currentOnly ? "当前会话还没有关联任务" : "没有匹配的任务",
                  onClear: sessionId && currentOnly ? () => setCurrentOnly(false) : clearFilters,
                  clearLabel: sessionId && currentOnly ? "查看全部会话" : "清空筛选" })
        : emptyProject && visible.length === 0
          ? h("div", { className: "sk-empty-v3" }, "项目还没有任务。",
              h("button", { type: "button", className: "sk-btn", onClick: () => setNewTaskStatus("backlog") }, "新建项目任务"),
              tasks.some((task) => !task.projectId && !task.archived) ?
                h("button", { type: "button", className: "sk-text", onClick: () => openProject("__none", "list") }, "查看未归属任务") : null)
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
                  h("button", { type: "button", className: "sk-text", onClick: () => startScan("incremental") }, "扫描近期会话"),
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
                  onAdd: selectedProject?.archived ? null : setNewTaskStatus,
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
                      onAdd: selectedProject?.archived ? null : setNewTaskStatus,
                      onDropTask: (id, targetStatus) => moveTask(id, targetStatus),
                      draggingId,
                      onDragStart: setDraggingId,
                      onDragEnd: () => setDraggingId(null),
                    }),
                  ),
                ),
        menuTask ? h(QuickMenu, { anchor: quickTask.anchor, items: taskMenuItems(menuTask), label: `任务操作：${menuTask.title}`, onClose: () => setQuickTask(null) }) : null,
        drawerTask
          ? h(TaskDrawer, { key: drawerTask.id, task: drawerTask, signal: signals.get(drawerTask.id), tasks, workspaces, projects, onOpenTask: setDrawerId, ctxProps, settings, desktopFiles,
              onClose: () => setDrawerId((id) => id === drawerTask.id ? null : id), onChanged: () => reload(true),
              onAskChat: (task) => openChat({ reference: taskChatReference(task) }), pushToast })
          : null,
        newTaskStatus !== null
          ? h(NewTaskModal, { defaultStatus: newTaskStatus, workspaces, projects,
              defaultProjectId: selectedProject && !selectedProject.archived ? selectedProject.id : "",
              defaultWorkspaceId: filters.workspace || "",
              sessionId: currentOnly ? sessionId : null, onClose: () => setNewTaskStatus(null), onCreate: async (task) => {
                if (isNarrow && task) setSideStatus(statusOf(task));
                setNewTaskStatus(null);
                await reload(true);
              }, pushToast })
          : null,
        projectEditor && (projectEditor === "new" || projects.some((project) => project.id === projectEditor))
          ? h(ProjectModal, { key: projectEditor, project: projects.find((project) => project.id === projectEditor), workspaces,
              onClose: () => setProjectEditor(null),
              onChanged: () => reload(true),
              onSave: async () => { setProjectEditor(null); pushToast("项目已保存", "info"); await reload(true); } })
          : null,
        chatOpen ? h(QuickChat, { route: aiRoute, modelOpen, onModel: openModel, host, sessionId, seed: chatSeed, pushToast,
          workspaceId: quickCapturePayload("", tasks, sessionId).workspaceId || filters.workspace || undefined,
          onClose: () => { setChatOpen(false); setChatSeed(null); } }) : null,
        settingsOpen
          ? h(SettingsModal, {
              settings,
              route: aiRoute,
              modelOpen,
              onModel: openModel,
              workspaces,
              prefs,
              usage,
              onPrefsChange: updatePrefs,
              onClose: () => setSettingsOpen(false),
              onSave: async () => { setSettingsOpen(false); await reload(true); },
              onScan: async (mode) => { setSettingsOpen(false); await startScan(mode); },
              pushToast,
            })
          : null,
        modelOpen ? h(ModelModal, { settings, returnFocus: modelTriggerRef, onClose: () => setModelOpen(false),
          onSave: ({ settings, aiRoute }) => {
            setData((current) => current ? { ...current, settings, aiRoute } : current);
            setModelOpen(false);
            pushToast("已切换模型", "info");
            void reload(true);
          } }) : null,
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
        // 浮层出错时静默退出，避免错误页盖住整个 DSH 窗口。
        if (this.props.quiet) return null;
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
      ctx.effect(() => {
        const sync = (event) => {
          if (event.key !== PREFS_KEY && event.key !== null) return;
          prefsStore.set(readPrefs());
        };
        window.addEventListener("storage", sync);
        return () => window.removeEventListener("storage", sync);
      }, "super-kanban: preferences");

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
        openTask(id) {
          if (!hostApi.openPage()) return false;
          setFloatingOpen(false);
          requestedPageTask = id;
          for (const listener of pageTaskListeners) listener();
          return true;
        },
        /** 当前选中的全局面板 id；会话视图为 null。旧版 DSH 读不到时返回 undefined。 */
        activePanel() {
          try {
            const info = ctx.get("layout")?.panelInfo;
            return typeof info?.getSnapshot === "function" ? info.getSnapshot()?.activePanelId ?? null : undefined;
          } catch {
            return undefined;
          }
        },
        watchPanel(listener) {
          try {
            const info = ctx.get("layout")?.panelInfo;
            if (typeof info?.subscribe === "function") return info.subscribe(listener);
          } catch {
            /* layout service unavailable */
          }
          return () => {};
        },
        /** 当前在前台的会话 id（悬浮形态用它决定「放入会话」的目标）。 */
        currentSession() {
          try {
            return ctx.get("sidebarRight")?.screen?.()?.sessionId || null;
          } catch {
            return null;
          }
        },
        /** 关闭正在显示的右侧看板标签页；其他标签页不受影响。 */
        closeSide() {
          let closed = false;
          for (const close of [...sideClosers]) {
            try {
              if (close()) closed = true;
            } catch {
              /* tab already gone */
            }
          }
          if (closed) return true;
          try {
            const sidebarRight = ctx.get("sidebarRight");
            const tab = sidebarRight?.active?.();
            const shown = typeof sidebarRight?.isExpanded !== "function" || sidebarRight.isExpanded();
            if (shown && tab?.kind === SIDE_KIND && typeof sidebarRight.close === "function") {
              sidebarRight.close(tab.id);
              return true;
            }
          } catch {
            /* sidebar service unavailable */
          }
          return false;
        },
        /**
         * 三种形态互斥：打开全局或右侧看板时收起悬浮面板；
         * 打开悬浮看板时回到会话并关闭右侧看板标签页。
         */
        openSurface(surface, sessionId, from) {
          if (surface === "page") {
            if (!hostApi.openPage()) return false;
            setFloatingOpen(false);
            return true;
          }
          if (surface === "side") {
            const opened = sessionId ? hostApi.openSideTab(sessionId) : hostApi.openSide();
            if (opened) setFloatingOpen(false);
            return opened;
          }
          if (surface !== "float") return false;
          if (from === "page" || hostApi.activePanel() === PANEL_ID) {
            try {
              ctx.get("layout").selectPanel(null);
            } catch {
              /* layout service unavailable */
            }
          }
          hostApi.closeSide();
          setFloatingOpen(true);
          return true;
        },
        openChat(seed) {
          overlayChatStore.set({ ...(seed || {}), token: Date.now() });
          return true;
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
        return board({ ...(slotProps || {}), ...baseProps, sessionId, surface: "side", closeTab: info?.tab?.actions?.close,
          visible: info?.tab?.visible !== false });
      };

      function KanbanSidebarIcon({ size }) {
        return h(Icon, { name: "board", size: size || 18 });
      }

      const HeaderKanbanButton = (slotProps) => HeaderEntry({ host: hostApi, sessionId: slotProps?.sessionId });

      {
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

      {
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
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "super-kanban-summary" },
          (props) => h(BoardErrorBoundary, { quiet: true },
            h(FloatingEntry, { ...props, host: hostApi }),
            h(OverlayChat, { host: hostApi }))));
    }

    return { apply, inject: [
      "slots", "locale", "sidebarRightTabs", "sidebarRight", "layout", "sessions", "conversation", "uiWorkspace",
      "remote", "remote.session", "remote.workspaceFiles",
    ] };
  },
});
