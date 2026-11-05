/**
 * Super Kanban — browser half (v1, Lead build).
 *
 * Hand-written DSH client plugin bundle: a full-page "task command deck" that
 * turns workspace sessions into a maintainable kanban. Talks to the host half
 * exclusively through /super-kanban/api/*. No build step, no third-party deps.
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

    /* ============================== constants ============================== */

    const STATUS_META = {
      backlog: { label: "待办", tone: "var(--dsw-alias-label-tertiary)", desc: "未开始或等待排期" },
      in_progress: { label: "进行中", tone: "var(--dsw-alias-brand-primary)", desc: "AI 判断正在推进" },
      blocked: { label: "受阻", tone: "var(--dsw-alias-state-warn-primary)", desc: "有未解决的问题" },
      done: { label: "已完成", tone: "var(--dsw-alias-state-success-primary)", desc: "已交付或已闭环" },
    };
    const STATUS_ORDER = ["backlog", "in_progress", "blocked", "done"];
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
        throw new Error(message);
      }
      return payload;
    }

    function command(op, payload) {
      return apiRequest("/command", {
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
          .slice(0, 12)
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
        .filter((item) => item && (item.name || item.path))
        .slice(0, 6)
        .map((item, index) => ({
          id: item.id || `af_${index}`,
          name: String(item.name || String(item.path).split("/").pop() || "产物"),
          path: String(item.path || ""),
          absPath: String(item.absPath || ""),
          sessionId: String(item.sessionId || ""),
          seq: seqOf(item.seq),
          time: Number(item.time) || 0,
        }));
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

    /** task.ai 的防御性归一化：引擎、模型、置信度（0-100）、研判时间与理由。 */
    function aiInfoOf(task) {
      const raw = task && task.ai && typeof task.ai === "object" ? task.ai : null;
      if (!raw) return null;
      const analyzedAt = raw.analyzedAt ? Date.parse(raw.analyzedAt) : NaN;
      return {
        engine: raw.engine === "llm" ? "llm" : "rules",
        model: String(raw.model || "").trim(),
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.round(Math.max(0, Math.min(1, Number(raw.confidence))) * 100) : null,
        analyzedAt: Number.isFinite(analyzedAt) ? analyzedAt : null,
        reason: String(raw.reason || "").trim(),
      };
    }

    function sessionContextOf(task) {
      const ctx = task.sessionContext && typeof task.sessionContext === "object" ? task.sessionContext : null;
      const sessions = Array.isArray(task.sessions) ? task.sessions : [];
      const first = sessions[0] || {};
      const base = {
        sessionId: String((ctx && ctx.sessionId) || task.primarySessionId || first.id || ""),
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

    function statusOf(task) {
      return STATUS_META[task.status] ? task.status : "backlog";
    }

    function compareTasks(a, b) {
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
.sk-ws-select{display:none;max-width:190px}

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
.sk-modal{width:min(540px,92vw);max-height:84vh;overflow-y:auto;border-radius:16px;border:1px solid var(--sk-line-strong);
  background:var(--sk-surface);box-shadow:0 24px 72px rgba(0,0,0,.26);padding:22px;display:flex;flex-direction:column;gap:14px;
  animation:skPop .2s cubic-bezier(.2,.8,.3,1)}
@keyframes skPop{from{transform:scale(.98) translateY(6px);opacity:0}to{transform:none;opacity:1}}
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
.sk-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
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
@media (max-width:1500px){
  .sk-ws-select{display:block}
}
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
.sk-page.is-side .sk-ws-select{display:block;max-width:200px}
.sk-page.is-side.sk-tier-medium .sk-col-head{padding:10px 8px 6px 12px}
.sk-page.is-side .sk-drawer{position:absolute;top:0;right:0;bottom:0;width:100%;border-left:none;border-radius:0;box-shadow:none;z-index:61}
.sk-page.is-side .sk-mask{position:absolute;z-index:60}
.sk-page.is-side .sk-modal-mask{position:absolute;z-index:70;padding:10px}
.sk-page.is-side .sk-modal{width:100%;max-height:calc(100% - 4px);border-radius:12px;padding:16px;gap:11px}
.sk-page.is-side .sk-toasts{position:absolute;left:10px;right:10px;bottom:10px;transform:none;align-items:flex-end;max-width:none;z-index:90}
.sk-page.is-side .sk-toast{font-size:11px;padding:8px 11px}
/* narrow：状态分段 + 单列 */
.sk-page.is-side.sk-tier-narrow{padding:8px 10px 8px;gap:7px}
.sk-page.is-side.sk-tier-narrow .sk-ws-select{max-width:132px}
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
.sk-goal-text{flex:1;min-width:0;font-size:11.5px;line-height:1.55;color:var(--sk-ink-2);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sk-goal-text.is-open{-webkit-line-clamp:unset;display:block}
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
.sk-duo{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sk-duo-col{min-width:0;display:flex;flex-direction:column;gap:4px}
.sk-duo-item{font-size:11.5px;line-height:1.5;color:var(--sk-ink-2);padding-left:9px;position:relative;overflow-wrap:anywhere}
.sk-duo-item::before{content:"";position:absolute;left:0;top:7px;width:3px;height:3px;border-radius:50%;background:var(--sk-ink-4)}
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
.sk-page.is-side .sk-duo{grid-template-columns:1fr}
.sk-page.is-side .sk-continue-textarea{min-height:150px}

@media (prefers-reduced-motion:reduce){
  .sk-page *,.sk-page *::before,.sk-page *::after{animation-duration:.001ms!important;transition-duration:.001ms!important}
}

/* ======================= v3：DSH-native 单色重做 ======================= */
.sk-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 28px) 28px 24px;gap:0;background:var(--dsw-alias-bg-base)}
/* header */
.sk-header-v3{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex:none;padding-bottom:18px;min-width:0}
.sk-header-main{min-width:0;display:flex;flex-direction:column;gap:6px}
.sk-title-v3{margin:0;font-size:20px;font-weight:500;line-height:1.25;color:var(--sk-ink);letter-spacing:normal}
.sk-stats-v3{margin:0;font-size:12px;font-weight:400;line-height:1.4;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sk-stats-v3 .sk-sep{color:color-mix(in srgb,var(--sk-ink) 30%,transparent)}
.sk-stats-v3 .sk-status-dot{width:6px;height:6px;border-radius:50%;background:var(--sk-green);opacity:.6;flex:none}
.sk-stats-v3 .sk-status-dot.is-running{background:var(--sk-blue);opacity:.6;animation:skPulse 1.6s ease-in-out infinite}
.sk-stats-v3 .sk-status-dot.is-error{background:var(--sk-red);opacity:.7}
.sk-stats-v3 .sk-textlink{color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:12px;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.sk-stats-v3 .sk-textlink:hover{color:var(--sk-ink)}
.sk-header-actions{display:flex;align-items:center;gap:8px;flex:none}
.sk-search-v3{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;border:0.5px solid var(--sk-line);background:transparent;width:200px;transition:border-color .15s,background .15s;flex:none}
.sk-search-v3:focus-within{border-color:var(--sk-line-strong);background:color-mix(in srgb,var(--sk-ink) 3%,transparent)}
.sk-search-v3 svg{color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-search-v3 input{border:none;outline:none;background:transparent;color:var(--sk-ink);font:inherit;font-size:12px;width:100%;min-width:0}
.sk-search-v3 input::placeholder{color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-iconbtn-v3{display:grid;place-items:center;width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);cursor:pointer;flex:none;transition:background .15s,color .15s}
.sk-iconbtn-v3:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent);color:var(--sk-ink)}
.sk-iconbtn-v3.is-busy{color:var(--sk-ink)}
.sk-btn-primary-v3{height:32px;padding:0 14px;border-radius:8px;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;font-weight:500;cursor:pointer;flex:none;white-space:nowrap}
.sk-btn-primary-v3:hover{background:var(--dsw-alias-button-primary-hover)}
.sk-btn-primary-v3:disabled{opacity:.45;cursor:not-allowed}
/* dropdown menu */
.sk-menu-wrap{position:relative}
.sk-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:80;min-width:184px;padding:4px;border-radius:10px;background:var(--sk-surface);border:0.5px solid var(--sk-line-strong);box-shadow:var(--dsw-elevation-panel);display:flex;flex-direction:column;animation:skPop .14s cubic-bezier(.2,.8,.3,1)}
.sk-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--sk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.sk-menu-item:hover{background:color-mix(in srgb,var(--sk-ink) 6%,transparent)}
.sk-menu-item.is-danger{color:var(--sk-red)}
.sk-menu-item .sk-menu-hint{margin-left:auto;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-menu-sep{height:0.5px;margin:4px 6px;background:var(--sk-line-soft)}
/* slim filter row */
.sk-slimbar{display:flex;align-items:center;gap:6px;flex:none;min-width:0;padding:2px 0 14px;border-bottom:0.5px solid var(--sk-line-soft)}
.sk-slimbar .sk-ws-select{display:block;max-width:220px;height:28px;border-color:transparent;background-color:transparent;font-size:12px;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);padding:0 22px 0 6px;border-radius:6px}
.sk-slimbar .sk-ws-select:hover{background-color:color-mix(in srgb,var(--sk-ink) 5%,transparent);border-color:transparent;color:var(--sk-ink)}
.sk-slim-icon{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sk-slim-icon:hover{background:color-mix(in srgb,var(--sk-ink) 5%,transparent);color:var(--sk-ink)}
.sk-slim-icon.is-on{color:var(--sk-ink);background:color-mix(in srgb,var(--sk-ink) 7%,transparent)}
.sk-slim-icon .sk-filter-count{font-size:11px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent)}
.sk-slimbar .sk-count{margin-left:auto;font-size:11px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent);white-space:nowrap;font-variant-numeric:tabular-nums}
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
.sk-page.is-side .sk-header-v3{padding-bottom:12px;align-items:center;gap:8px}
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
.sk-drawer-head .sk-menu-wrap{flex:none;margin-top:1px}
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
.sk-summary-line .sk-goal-text{color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font-size:12px;line-height:1.5;flex-basis:100%;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
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
.sk-duo{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sk-duo-col{display:flex;flex-direction:column;gap:2px;min-width:0}
.sk-duo-item{font-size:12px;line-height:1.55;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);padding-left:0;position:static;overflow-wrap:anywhere}
.sk-duo-item::before{display:none}
.sk-duo-item.is-issue{color:color-mix(in srgb,var(--sk-ink) 62%,transparent)}
.sk-duo-item.is-error{color:var(--sk-red)}
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
.sk-modal{width:min(520px,92vw);border-radius:16px;border:0.5px solid var(--sk-line-strong);box-shadow:var(--dsw-elevation-panel);padding:20px;gap:14px}
.sk-modal h3{font-size:15px;font-weight:600}
.sk-modal .sub{font-size:12px;color:color-mix(in srgb,var(--sk-ink) 45%,transparent)}
.sk-modal-foot{padding-top:8px}
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
.sk-page.is-side.sk-tier-narrow .sk-header-v3{padding-bottom:10px}
.sk-page.is-side.sk-tier-narrow .sk-narrow-list{gap:8px}
.sk-page.is-side .sk-drawer{position:absolute;top:0;right:0;bottom:0;width:100%;border-left:none;border-radius:0;box-shadow:none;z-index:61}
.sk-page.is-side .sk-drawer-head{padding-left:8px}
.sk-page.is-side .sk-mask{position:absolute;z-index:60}
.sk-page.is-side .sk-modal-mask{position:absolute;z-index:80;padding:10px}
.sk-page.is-side .sk-modal{width:100%;max-height:calc(100% - 4px);border-radius:12px;padding:16px}
.sk-page.is-side .sk-toasts{position:absolute;left:10px;right:10px;bottom:10px;transform:none;align-items:flex-end;max-width:none;z-index:90}
/* board wrapper for v3 padding */
.sk-board-v3{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding-top:14px;position:relative}
.sk-empty-v3{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;padding:40px 8px;color:color-mix(in srgb,var(--sk-ink) 55%,transparent);font-size:13px;text-align:left}
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
@media (max-height:900px){.sk-page{padding-top:calc(var(--dsh-frame-top-clearance,0px) + 20px)}.sk-header-v3{padding-bottom:14px}.sk-board-v3{padding-top:10px}}

/* v3 fixes */
.sk-drawer-head{flex-direction:row;align-items:flex-start}
.sk-page.is-side .sk-drawer-head{padding-left:12px}
.sk-drawer-head-text{gap:1px}
.sk-card-v3.is-done{opacity:.6}
.sk-card-v3.is-done .sk-card-metrics{display:none}
.sk-card-v3.is-done .sk-card-meta-v3{color:color-mix(in srgb,var(--sk-ink) 40%,transparent)}
.sk-ws-picker{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0}
.sk-ws-picker .sk-ws-select{appearance:none;background-image:none;padding-right:20px;padding-left:6px;border-color:transparent;background-color:transparent;color:color-mix(in srgb,var(--sk-ink) 62%,transparent);font-size:12px;height:28px;border-radius:6px;cursor:pointer;max-width:190px}
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
.sk-page.is-side.sk-tier-narrow .sk-header-v3{padding-bottom:6px}
.sk-page.is-side.sk-tier-narrow .sk-slimbar{padding-bottom:8px}
.sk-page.is-side.sk-tier-narrow .sk-status-tabs{margin-top:0}
.sk-page.is-side.sk-tier-narrow .sk-narrow-list{padding-top:10px}
.sk-page.is-side .sk-slimbar{padding-bottom:10px}

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
.sk-duo-item{display:flex;align-items:flex-start;gap:5px;font-size:12px;line-height:1.55;color:color-mix(in srgb,var(--sk-ink) 78%,transparent);overflow-wrap:anywhere}
.sk-duo-item.is-warn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 85%,var(--sk-ink))}
.sk-duo-item.is-error{color:var(--sk-red)}
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
/* 扫描结果行 */
.sk-scan-error{color:var(--dsw-alias-state-warn-primary,#f59e0b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
.sk-scan-outcome{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* 完成卡：去掉整条彩色进度线，只保留状态点 */
.sk-card-v3.is-done .sk-card-progress-v3{display:none}
/* 右侧栏任何宽度都保留工作区下拉（原 side-wide 规则会隐藏它） */
.sk-page.is-side.sk-tier-wide .sk-ws-select{display:block}
/* 窄侧栏：卡片保留「短工作区 · 时间 · 优先级」的紧凑巡检信息 */
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3{display:flex;flex-wrap:nowrap;gap:5px;font-size:10.5px;line-height:1.35;margin-top:1px}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-ws{max-width:96px;flex:0 1 auto}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-ws-sep{flex:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-time{flex:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-metrics{margin-left:auto;gap:4px}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-card-metric{display:none}
.sk-page.is-side.sk-tier-narrow .sk-card-meta-v3 .sk-prio-text{font-size:10.5px}
.sk-page.is-side.sk-tier-narrow .sk-archived-mark{display:none}
/* 窄侧栏：统计独占一行（避免裁掉状态与扫描结论），操作图标第二行右对齐 */
.sk-page.is-side.sk-tier-narrow .sk-header-v3{flex-wrap:wrap;row-gap:6px}
.sk-page.is-side.sk-tier-narrow .sk-stats-v3{flex:0 0 100%;order:1;white-space:normal;flex-wrap:wrap;row-gap:2px;max-height:3.1em}
.sk-page.is-side.sk-tier-narrow .sk-header-actions{order:2;margin-left:auto}

`;

    function ensureStyle() {
      const tagId = "dsh-super-kanban/style.css";
      let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);
      if (!tag) {
        tag = document.createElement("style");
        tag.dataset.plugin = "dsh-super-kanban";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
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
        (element) => element.getClientRects().length > 0,
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
     * /state 每次响应都会生成新的 generatedAt，不能直接拿它判断「没变化」。
     * 这里用去掉 generatedAt 后的内容指纹比较，未变化时保留旧对象引用，避免整页重渲染。
     */
    function stateSignature(payload) {
      if (!payload || typeof payload !== "object") return "";
      try {
        return JSON.stringify({ ...payload, generatedAt: "" });
      } catch {
        return "";
      }
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
        const task = apiRequest("/state")
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

      return { data, error, loading, reload: load, setData };
    }

    /* ================================ cards =============================== */

    function TaskCard({ task, onOpen, onDragStart, onDragEnd, dragging }) {
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
      return h(
        "article",
        {
          className: cx("sk-card", "sk-card-v3", "is-" + taskStatus, done && "is-done", dragging && "dragging"),
          role: "button",
          tabIndex: 0,
          "aria-haspopup": "dialog",
          "data-task-id": task.id,
          "aria-label": `${task.title}（${STATUS_META[taskStatus].label}）`,
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", task.id);
            onDragStart(task.id);
          },
          onDragEnd: () => onDragEnd(),
          onClick: () => onOpen(task.id),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              onOpen(task.id);
            }
          },
          title: task.title,
        },
        h(
          "div",
          { className: "sk-card-v3-head" },
          h("span", { className: cx("sk-dot", "is-" + taskStatus), title: STATUS_META[taskStatus].label }),
          h("h3", { className: "sk-card-title-v3" }, task.title),
          task.archived ? h("span", { className: "sk-archived-mark", title: "已归档任务（筛选「含归档」时显示）" }, "已归档") : null,
          showEngine
            ? h("span", { className: cx("sk-ai-mark", engine === "AI" ? "is-ai" : "is-rules"), title: engine === "AI" ? "AI 研判" : "规则推断" }, engine)
            : null,
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
        h("div", { className: "sk-card-progress-v3" }, h("i", { style: { width: `${progress}%` } })),
      );
    }

    function Column({ status, tasks, onOpen, onAdd, onDropTask, draggingId, onDragStart, onDragEnd }) {
      const meta = STATUS_META[status];
      const [dragOver, setDragOver] = React.useState(false);
      return h(
        "section",
        {
          className: cx("sk-col", dragOver && "dragover"),
          onDragOver: (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOver(true);
          },
          onDragLeave: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
          },
          onDrop: (event) => {
            event.preventDefault();
            setDragOver(false);
            const id = event.dataTransfer.getData("text/plain");
            if (id) onDropTask(id, status);
          },
        },
        h(
          "header",
          { className: "sk-col-head" },
          h("span", { className: cx("sk-dot", "is-" + status) }),
          h("span", { className: "sk-col-title" }, meta.label),
          h("span", { className: "sk-col-count" }, tasks.length),
          h("span", { className: "sk-col-head-spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "sk-col-add",
              title: `在「${meta.label}」新建`,
              "aria-label": `在「${meta.label}」新建任务`,
              onClick: () => onAdd(status),
            },
            h(Icon, { name: "plus", size: 14 }),
          ),
        ),
        h(
          "div",
          { className: "sk-col-body" },
          tasks.length === 0
            ? h("div", { className: "sk-col-empty" }, status === "blocked" ? "暂无受阻任务" : "暂无任务，拖拽卡片到这里")
            : tasks.map((task) => h(TaskCard, { key: task.id, task, onOpen, onDragStart, onDragEnd, dragging: draggingId === task.id })),
        ),
      );
    }

    /** 窄屏（右侧栏 <620px）：文字状态 tab + 单列卡片。 */
    function NarrowBoard({ status, setStatus, byStatus, onOpen, onAdd, draggingId, onDragStart, onDragEnd }) {
      const list = byStatus[status] || [];
      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "sk-status-tabs", role: "tablist", "aria-label": "任务状态" },
          STATUS_ORDER.map((item) =>
            h(
              "button",
              {
                key: item,
                type: "button",
                role: "tab",
                "aria-selected": status === item,
                className: cx("sk-status-tab", status === item && "is-on"),
                onClick: () => setStatus(item),
              },
              STATUS_META[item].label,
              h("span", { className: "sk-status-tab-count" }, (byStatus[item] || []).length),
            ),
          ),
        ),
        h(
          "div",
          { className: "sk-narrow-list" },
          list.length
            ? list.map((task) =>
                h(TaskCard, {
                  key: task.id,
                  task,
                  onOpen,
                  onDragStart,
                  onDragEnd,
                  dragging: draggingId === task.id,
                }),
              )
            : h("div", { className: "sk-narrow-empty" }, `「${STATUS_META[status].label}」暂无任务`),
        ),
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
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    const CONTINUE_REQUIREMENT = "要求：先复述你的理解与计划，再按步骤执行；最后汇报产出与结论。遇到阻塞或不确定的地方要明确指出，不要静默跳过。";

    /** Host 未就绪时的本地模板（0 token），保证「继续任务」可用。 */
    function localContinuePrompt(task) {
      const goal = goalInfoOf(task);
      const facts = keyFactsOf(task);
      const issues = Array.isArray(task.issues) ? task.issues : [];
      const nextSteps = Array.isArray(task.nextSteps) ? task.nextSteps : [];
      const session = sessionContextOf(task);
      const subtasks = subtasksOf(task);
      const done = subtasks.filter((item) => item.done).length;
      const lines = [];
      lines.push("继续任务：" + (task.title || "未命名任务"));
      if (goal && goal.text) lines.push("目标 / 完成标准：" + goal.text);
      if (subtasks.length) lines.push("当前进度：" + done + "/" + subtasks.length + " 个子任务完成（" + progressOf(task) + "%）");
      else lines.push("当前进度：" + progressOf(task) + "%");
      if (facts.length) {
        lines.push("关键事实：");
        for (const fact of facts.slice(0, 5)) lines.push("- " + fact.text);
      }
      if (issues.length) {
        lines.push("待解决问题：");
        for (const issue of issues.slice(0, 3)) lines.push("- " + issue.text);
      }
      if (nextSteps.length) {
        lines.push("下一步：");
        for (const step of nextSteps.slice(0, 3)) lines.push("- " + step);
      }
      if (session.title) {
        lines.push("来源会话：" + session.title + (session.isLive ? "（进行中）" : ""));
        if (session.turnCount) lines.push("已进行 " + session.turnCount + " 轮对话；最近一次轮次状态：" + (session.lastTurnEnd || "未知"));
      }
      lines.push(CONTINUE_REQUIREMENT);
      return lines.join("\n");
    }

    /** 「继续此任务」弹窗：模板提示词可编辑 → 放入会话 / 新会话 / 复制。 */
    function ContinueTaskModal({ task, initialTarget, ctxProps, pushToast, onClose, onDone }) {
      const host = (ctxProps && ctxProps.host) || {};
      const [target, setTarget] = React.useState(initialTarget === "newSession" ? "newSession" : "session");
      const [prompt, setPrompt] = React.useState("");
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState("");
      const [note, setNote] = React.useState("");
      const session = sessionContextOf(task);
      // 用户改过 textarea 后，切换「原会话 / 新会话」不能丢编辑内容；提示词模板本身与 target 无关。
      const dirtyRef = React.useRef(false);
      const promptKeyRef = React.useRef("");

      React.useEffect(() => {
        const key = `${task.id}:${target}`;
        if (dirtyRef.current) {
          setNote("已保留你编辑的提示词；切换目标不会重新生成");
          return undefined;
        }
        if (promptKeyRef.current === key) return undefined;
        let cancelled = false;
        setLoading(true);
        setNote("");
        command("task.continuePrompt", { id: task.id, target })
          .then((res) => {
            if (cancelled) return;
            const data = (res && res.data) || res || {};
            const text = typeof data.prompt === "string" ? data.prompt : "";
            promptKeyRef.current = key;
            if (dirtyRef.current) return;
            setPrompt(text || localContinuePrompt(task));
            if (!text) setNote("Host 模板接口未就绪，已使用本地模板");
          })
          .catch(() => {
            if (cancelled || dirtyRef.current) return;
            promptKeyRef.current = key;
            setPrompt(localContinuePrompt(task));
            setNote("Host 模板接口不可用，已使用本地模板（仍然可用）");
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [target, task.id]);

      const copy = async () => {
        const ok = await copyToClipboard(prompt);
        pushToast(ok ? "提示词已复制" : "浏览器拦截了剪贴板，请手动选择文本复制", ok ? "info" : "error");
        return ok;
      };
      const toastCopiedOrManual = async (text) => {
        const copied = await copy();
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
            const ok = host.startSession ? host.startSession(task.workspaceId, prompt) : false;
            if (ok) {
              pushToast("已在新会话中预置提示词，确认后发送", "info");
              onClose();
              if (onDone) onDone();
              return;
            }
            await toastCopiedOrManual("当前环境无法新建会话");
            return;
          }
          const result = host.placeDraft ? await host.placeDraft(session.sessionId, prompt) : { ok: false, reason: "missing" };
          if (result && result.ok) {
            const state = result.result;
            if (state === "applied") {
              pushToast("提示词已放入输入框，确认后发送", "info");
              onClose();
              if (onDone) onDone();
            } else if (state === "preserved") {
              await toastCopiedOrManual("输入框已有草稿，已保留原草稿");
              onClose();
            } else {
              await toastCopiedOrManual("会话输入框未就绪");
              onClose();
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

      const disabled = loading || !!busy || !prompt.trim();
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
          h("p", { className: "sub" }, "提示词只放入输入框、不会自动发送；确认无误后再发送给 DSH。"),
          h(
            "div",
            { className: "sk-continue-target", role: "group", "aria-label": "提示词放入位置" },
            h(
              "button",
              { type: "button", "aria-pressed": target === "session", className: target === "session" ? "is-on" : "", onClick: () => setTarget("session") },
              "原会话继续",
              h("small", null, session.title || "来源会话"),
            ),
            h(
              "button",
              { type: "button", "aria-pressed": target === "newSession", className: target === "newSession" ? "is-on" : "", onClick: () => setTarget("newSession") },
              "同工作区新会话",
              h("small", null, task.workspaceTitle || "未关联工作区"),
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
          h(
            "div",
            { className: "sk-modal-foot" },
            h("button", { type: "button", className: "sk-btn ghost", onClick: onClose }, "取消"),
            h("button", { type: "button", className: "sk-btn", onClick: copy, disabled: disabled && !prompt }, "仅复制"),
            h(
              "button",
              { type: "button", className: "sk-btn", onClick: polish, disabled: loading || !!busy || !prompt.trim(), title: "消耗 1 次 AI 调用" },
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

    function TaskDrawer({ task, ctxProps, settings, onClose, onChanged, pushToast }) {
      const host = (ctxProps && ctxProps.host) || {};
      const goal = goalInfoOf(task);
      const session = sessionContextOf(task);
      const locked = Array.isArray(task.lockedFields) ? task.lockedFields : [];
      const [draft, setDraft] = React.useState(() => ({
        title: task.title || "",
        goal: (goal && goal.text) || "",
        status: task.status || "backlog",
        priority: task.priority || "P2",
        progress: pct(task.progress),
      }));
      const [editing, setEditing] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [factsExpanded, setFactsExpanded] = React.useState(false);
      const [subtasksExpanded, setSubtasksExpanded] = React.useState(false);
      const [evidenceOpen, setEvidenceOpen] = React.useState(false);
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const [expandedEvidence, setExpandedEvidence] = React.useState({});
      const [moreOpen, setMoreOpen] = React.useState(false);
      const [moreOpenFooter, setMoreOpenFooter] = React.useState(false);
      const [continueOpen, setContinueOpen] = React.useState(false);
      const [continueTarget, setContinueTarget] = React.useState("session");
      const [newSubtask, setNewSubtask] = React.useState("");
      const [subtaskBusy, setSubtaskBusy] = React.useState("");
      const [optimisticSubtasks, setOptimisticSubtasks] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [issuesExpanded, setIssuesExpanded] = React.useState(false);
      const [nextStepsExpanded, setNextStepsExpanded] = React.useState(false);
      const [reasonExpanded, setReasonExpanded] = React.useState(false);
      const [reasonOverflow, setReasonOverflow] = React.useState(false);
      const [staleNotice, setStaleNotice] = React.useState(false);
      const [analyzeBusy, setAnalyzeBusy] = React.useState(false);
      const reasonRef = React.useRef(null);
      const dialogRef = React.useRef(null);

      const subtasks = optimisticSubtasks || subtasksOf(task);
      const subtaskDone = subtasks.filter((item) => item.done).length;
      const facts = keyFactsOf(task);
      const artifacts = artifactsOf(task);
      const severityRank = { high: 0, medium: 1, low: 2 };
      const issues = (Array.isArray(task.issues) ? task.issues : [])
        .slice()
        .sort((left, right) => (severityRank[left?.severity] ?? 9) - (severityRank[right?.severity] ?? 9));
      const nextSteps = Array.isArray(task.nextSteps) ? task.nextSteps : [];
      const aiInfo = aiInfoOf(task);
      // 「可能已过期」只在会话在研判之后又产生了活动时提示：没有新活动时，
      // 旧研判仍然有效；按扫描间隔判断会让所有旧任务都误报过期。
      const lastActivityAt = Number((task.sessionContext && task.sessionContext.lastActivityAt) || task.lastActivityAt) || 0;
      const aiStale = Boolean(aiInfo && aiInfo.analyzedAt && lastActivityAt > aiInfo.analyzedAt + 5 * 60_000);
      const evidence = Array.isArray(task.evidence) ? task.evidence.slice(0, 8) : [];
      const history = Array.isArray(task.history) ? task.history.slice().reverse().slice(0, 20) : [];
      const progress = subtasks.length ? Math.round((subtaskDone / Math.max(1, subtasks.length)) * 100) : pct(task.progress) || 0;

      const resetDraft = () => {
        const currentGoal = goalInfoOf(task);
        setDraft({
          title: task.title || "",
          goal: (currentGoal && currentGoal.text) || "",
          status: task.status || "backlog",
          priority: task.priority || "P2",
          progress: pct(task.progress),
        });
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
        if (editing) setStaleNotice(true);
      }, [task.updatedAt]);

      // 研判理由超过 2 行才显示「展开理由」；展开后保留按钮以便收起。
      React.useEffect(() => {
        const node = reasonRef.current;
        if (!node || reasonExpanded) return;
        setReasonOverflow(node.scrollHeight > node.clientHeight + 1);
      }, [aiInfo && aiInfo.reason, reasonExpanded]);

      // Esc 分层：先收起抽屉内浮层 / 退出编辑，最后才关闭抽屉；「继续此任务」弹窗自己处理 Esc。
      const handleEscape = () => {
        if (continueOpen) return;
        if (moreOpen) {
          setMoreOpen(false);
          return;
        }
        if (moreOpenFooter) {
          setMoreOpenFooter(false);
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
          const patch = {
            title: draft.title.trim(),
            goal: draft.goal.trim(),
            status: draft.status,
            priority: draft.priority,
            progress: draft.progress === null ? null : Number(draft.progress),
          };
          const changed = ["title", "goal", "status", "priority", "progress"].filter((field) => {
            const before =
              field === "goal"
                ? (goalInfoOf(task) && goalInfoOf(task).text) || ""
                : field === "progress"
                  ? pct(task.progress)
                  : task[field] || "";
            return String(patch[field] ?? "") !== String(before ?? "");
          });
          await command("task.update", { id: task.id, patch, lockFields: changed });
          pushToast("已保存", "info");
          setEditing(false);
          setStaleNotice(false);
          resetDraft();
          await onChanged();
        } catch (cause) {
          pushToast("保存失败：" + cause.message, "error");
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

      const openSession = () => {
        const fn = ctxProps && ctxProps.openSession;
        if (typeof fn === "function" && fn(session.sessionId)) {
          onClose();
          return;
        }
        pushToast("当前环境不支持跳转会话", "error");
      };

      const openArtifact = (artifact) => {
        const sessionId = artifact.sessionId || session.sessionId;
        const ok = host.openResource ? host.openResource(sessionId, artifact.path) : false;
        if (!ok) {
          pushToast("当前环境无法打开预览", "error");
          return;
        }
        onClose();
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
          pushToast("任务已删除", "info");
          onClose();
          await onChanged();
        } catch (cause) {
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
        { label: "编辑任务", icon: "edit", onClick: () => { resetDraft(); setEditing(true); } },
        { label: analyzeBusy ? "重新研判中…" : "重新研判", icon: "spark", onClick: analyzeNow },
        { label: locked.length ? "解锁字段" : "锁定字段", icon: locked.length ? "unlock" : "lock", onClick: toggleLock },
        "divider",
        { label: task.archived ? "恢复任务" : "归档任务", icon: "archive", onClick: () => run(task.archived ? "恢复" : "归档", () => command("task.archive", { id: task.id, archived: !task.archived }), task.archived ? "已恢复" : "已归档") },
        { label: confirmDelete ? "确认删除任务" : "删除任务", icon: "trash", danger: true, onClick: removeTask },
      ];
      const footerMenuItems = [
        { label: "新会话继续", icon: "spark", onClick: () => { setContinueTarget("newSession"); setContinueOpen(true); } },
        { label: "打开终端", icon: "tool", onClick: openTerminal },
        { label: "复制会话 ID", icon: "copy", onClick: copySessionId },
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
            "aria-labelledby": "sk-drawer-title",
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
            h("div", { className: "sk-drawer-head-text" }, h("div", { className: "sk-drawer-kicker" }, "任务"), h("h2", { className: "sk-drawer-title-v3", id: "sk-drawer-title" }, task.title)),
            h(
              DropMenu,
              { open: moreOpen, onClose: () => setMoreOpen(false), items: drawerMenuItems },
              h(
                "button",
                { type: "button", className: "sk-iconbtn-v3", title: "更多", "aria-label": "更多任务操作", "aria-haspopup": "menu", "aria-expanded": moreOpen, onClick: () => setMoreOpen((value) => !value) },
                h(Icon, { name: "more", size: 16 }),
              ),
            ),
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
                h("span", { className: "sk-drawer-sec-title" }, "状态"),
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
                      h("span", { className: "sk-muted" }, subtasks.length ? `${subtaskDone}/${subtasks.length} 子任务` : `进度 ${progress}%`),
                      goal && goal.text ? h("span", { className: "sk-goal-text" }, goal.text) : null,
                    ),
                    aiInfo
                      ? h(
                          "div",
                          { className: "sk-ai-review" },
                          h(
                            "div",
                            { className: "sk-ai-review-head" },
                            h(Icon, { name: "spark", size: 12 }),
                            h("span", { className: "sk-ai-review-title" }, analyzeBusy ? "重新研判中…" : aiInfo.engine === "llm" ? "AI 研判" : "规则推断"),
                            aiInfo.engine === "llm" && aiInfo.model ? h("span", { className: "sk-ai-review-meta" }, aiInfo.model) : null,
                            aiInfo.engine === "llm" && aiInfo.confidence !== null ? h("span", { className: "sk-ai-review-meta" }, `${aiInfo.confidence}%`) : null,
                            aiInfo.analyzedAt ? h("span", { className: "sk-ai-review-meta" }, relTime(aiInfo.analyzedAt)) : null,
                            aiStale ? h("span", { className: "sk-ai-review-stale" }, "可能已过期") : null,
                          ),
                          aiInfo.reason
                            ? h(
                                React.Fragment,
                                null,
                                h("p", { ref: reasonRef, className: cx("sk-ai-review-reason", reasonExpanded && "is-open") }, aiInfo.reason),
                                reasonOverflow || reasonExpanded
                                  ? h("button", { type: "button", className: "sk-text", style: { alignSelf: "flex-start" }, onClick: () => setReasonExpanded((value) => !value) }, reasonExpanded ? "收起" : "展开理由")
                                  : null,
                              )
                            : h("p", { className: "sk-ai-review-reason is-empty" }, "本次未给出研判理由"),
                        )
                      : null,
                  ),
              staleNotice
                ? h("div", { className: "sk-inline-note", role: "status", "aria-live": "polite" }, "后台已更新；保存将覆盖 AI 的新结果")
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
                    if (event.key === "Enter") addSubtask();
                  },
                }),
                h("button", { type: "button", className: "sk-text", onClick: addSubtask, disabled: !newSubtask.trim() || subtaskBusy === "add" }, "添加"),
              ),
            ),
            issues.length || nextSteps.length
              ? h(
                  "div",
                  { className: "sk-drawer-sec" },
                  h("div", { className: "sk-drawer-sec-head" }, h("span", { className: "sk-drawer-sec-title" }, "问题 / 下一步")),
                  h(
                    "div",
                    { className: "sk-duo" },
                    h(
                      "div",
                      { className: "sk-duo-col" },
                      issues.length
                        ? (issuesExpanded ? issues : issues.slice(0, 3)).map((issue, index) =>
                            h(
                              "div",
                              {
                                key: issue.id || index,
                                className: cx("sk-duo-item", issue.severity === "high" ? "is-error" : issue.severity === "medium" ? "is-warn" : ""),
                                title: issue.text,
                              },
                              h(Icon, { name: "alert", size: 11 }),
                              h("span", null, issue.text),
                            ),
                          )
                        : h("div", { className: "sk-note-tiny" }, "暂无"),
                      issues.length > 3
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "sk-text",
                              style: { alignSelf: "flex-start", paddingTop: 2 },
                              "aria-label": issuesExpanded ? "收起问题列表" : `展开全部 ${issues.length} 个问题`,
                              onClick: () => setIssuesExpanded((value) => !value),
                            },
                            issuesExpanded ? "收起" : `展开全部 ${issues.length}`,
                          )
                        : null,
                    ),
                    h(
                      "div",
                      { className: "sk-duo-col" },
                      nextSteps.length
                        ? (nextStepsExpanded ? nextSteps : nextSteps.slice(0, 3)).map((step, index) =>
                            h(
                              "div",
                              { key: index, className: "sk-duo-item", title: step },
                              h(Icon, { name: "arrow", size: 11 }),
                              h("span", null, step),
                            ),
                          )
                        : h("div", { className: "sk-note-tiny" }, "暂无"),
                      nextSteps.length > 3
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "sk-text",
                              style: { alignSelf: "flex-start", paddingTop: 2 },
                              "aria-label": nextStepsExpanded ? "收起下一步列表" : `展开全部 ${nextSteps.length} 个下一步`,
                              onClick: () => setNextStepsExpanded((value) => !value),
                            },
                            nextStepsExpanded ? "收起" : `展开全部 ${nextSteps.length}`,
                          )
                        : null,
                    ),
                  ),
                )
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
                session.isLive ? h("span", null, "进行中") : h("span", null, "已结束"),
                session.turnCount ? h("span", null, `第 ${session.turnCount} 轮`) : null,
                session.todoTotal ? h("span", null, `待办 ${session.todoDone}/${session.todoTotal}`) : null,
                goal && goal.text ? h("span", null, "目标：" + clip(goal.text, 48)) : null,
              ),
            ),
            artifacts.length
              ? h(
                  "div",
                  { className: "sk-drawer-sec" },
                  h("div", { className: "sk-drawer-sec-head" }, h("span", { className: "sk-drawer-sec-title" }, "产物"), h("span", { className: "sk-note-tiny" }, `${artifacts.length}`)),
                  h(
                    "div",
                    { className: "sk-artifacts" },
                    artifacts.map((artifact) =>
                      h(
                        "button",
                        { key: artifact.id, type: "button", className: "sk-artifact", title: artifact.path || artifact.name, onClick: () => openArtifact(artifact) },
                        h(Icon, { name: "file", size: 14, className: "sk-artifact-icon" }),
                        h("span", { className: "sk-artifact-text" }, h("span", { className: "sk-artifact-name" }, artifact.name), artifact.path ? h("span", { className: "sk-artifact-path" }, artifact.path) : null),
                      ),
                    ),
                  ),
                )
              : null,
            evidence.length
              ? h(
                  "div",
                  { className: "sk-fold" },
                  h("button", { type: "button", className: "sk-fold-head", onClick: () => setEvidenceOpen((value) => !value) }, h(Icon, { name: evidenceOpen ? "chevronDown" : "chevron", size: 12 }), "证据", h("span", { className: "sk-fold-count" }, `${evidence.length} 条`)),
                  evidenceOpen
                    ? h(
                        "div",
                        { className: "sk-evidence" },
                        evidence.map((item, index) => {
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
                    ? h("div", { className: "sk-hist" }, history.map((entry, index) => h("div", { key: index }, h("span", null, relTime(entry.at)), h("span", null, entry.by === "ai" ? "AI" : "手动", " · ", entry.note || entry.kind || ""))))
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
                  h("button", { type: "button", className: "sk-btn primary", onClick: () => { setContinueTarget("session"); setContinueOpen(true); }, disabled: !session.sessionId }, "继续此任务"),
                  h("button", { type: "button", className: "sk-btn ghost", onClick: openSession, disabled: !session.sessionId }, "打开会话"),
                  h("span", { className: "sk-grow" }),
                  h(
                    DropMenu,
                    { open: moreOpenFooter, onClose: () => setMoreOpenFooter(false), items: footerMenuItems },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "sk-iconbtn-v3",
                        title: "更多操作",
                        "aria-label": "更多任务操作",
                        "aria-haspopup": "menu",
                        "aria-expanded": moreOpenFooter,
                        onClick: () => setMoreOpenFooter((value) => !value),
                      },
                      h(Icon, { name: "more", size: 16 }),
                    ),
                  ),
                ),
          ),
          continueOpen
            ? h(ContinueTaskModal, {
                task,
                initialTarget: continueTarget,
                ctxProps,
                pushToast,
                onDone: onClose,
                onClose: () => setContinueOpen(false),
              })
            : null,
        ),
      );
    }
    /* ============================== overlays ============================== */

    function NewTaskModal({ defaultStatus, workspaces, onClose, onCreate, pushToast }) {
      const [title, setTitle] = React.useState("");
      const [goal, setGoal] = React.useState("");
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
          await command("task.create", { title: title.trim(), goal: goal.trim(), status, priority, workspaceId: workspaceId || undefined });
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
          h("p", { className: "sub" }, "手动任务不会被自动扫描修改，可稍后从来源会话补充上下文。"),
          h(
            "div",
            { className: "sk-field" },
            h("label", { htmlFor: "sk-newtask-title-input" }, "标题"),
            h("input", { ref: inputRef, id: "sk-newtask-title-input", className: "sk-input", value: title, maxLength: TEXT_LIMITS.title, placeholder: "要做什么？", onChange: (event) => setTitle(event.target.value), onKeyDown: (event) => event.key === "Enter" && create() }),
          ),
          h(
            "div",
            { className: "sk-field" },
            h("label", { htmlFor: "sk-newtask-goal-input" }, "目标 / 说明（可选）"),
            h("textarea", { id: "sk-newtask-goal-input", className: "sk-textarea", value: goal, maxLength: TEXT_LIMITS.goal, rows: 2, placeholder: "一句话说明完成标准", onChange: (event) => setGoal(event.target.value) }),
          ),
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
          h(
            "div",
            { className: "sk-modal-foot" },
            h("button", { type: "button", className: "sk-btn ghost", onClick: onClose }, "取消"),
            h("button", { type: "button", className: "sk-btn primary", onClick: create, disabled: !title.trim() || saving }, saving ? "创建中…" : "创建任务"),
          ),
        ),
      );
    }

    function SettingsModal({ settings, workspaces, prefs, usage, onPrefsChange, onClose, onSave, onScan, pushToast }) {
      const [draft, setDraft] = React.useState(() => ({
        aiEnabled: settings.aiEnabled !== false,
        autoScan: settings.autoScan !== false,
        scanIntervalSeconds: settings.scanIntervalSeconds || 120,
        initialDays: settings.initialDays || 30,
        maxAiCallsPerScan: settings.maxAiCallsPerScan || 40,
        dailyAiCallLimit: settings.dailyAiCallLimit || 150,
        excludeWorkspaces: Array.isArray(settings.excludeWorkspaces) ? settings.excludeWorkspaces.slice() : [],
      }));
      const [saving, setSaving] = React.useState(false);
      // 入口偏好先暂存，取消不会写入；只有「保存设置」才真正落盘（需要刷新窗口生效）。
      const [entryDraft, setEntryDraft] = React.useState(() => prefsMode(prefs));
      const dialogRef = React.useRef(null);
      useDialogFocus(dialogRef, onClose);
      useBodyScrollLock();
      const set = (patch) => setDraft((value) => ({ ...value, ...patch }));
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
          pushToast(entryChanged ? "设置已保存；入口偏好需刷新窗口（Cmd+R）生效" : "设置已保存", "info");
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
            { className: "sk-settings-row" },
            h("div", { className: "label" }, h("b", null, "AI 联网研判"), h("span", null, "使用本机 DSH 账号模型额度分析会话；关闭后仅用本地规则推断")),
            h("button", { type: "button", className: cx("sk-switch", draft.aiEnabled && "on"), onClick: () => set({ aiEnabled: !draft.aiEnabled }), "aria-label": "AI 联网研判", role: "switch", "aria-checked": draft.aiEnabled }, h("i")),
          ),
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
            h("div", { className: "label" }, h("b", null, "AI 预算 · 单次扫描上限"), h("span", null, "超出后本次扫描降级为规则推断")),
            h(
              "select",
              { className: "sk-select", "aria-label": "单次扫描 AI 调用上限", value: draft.maxAiCallsPerScan, onChange: (event) => set({ maxAiCallsPerScan: Number(event.target.value) }) },
              [10, 20, 40].map((value) => h("option", { key: value, value }, `${value} 次`)),
            ),
          ),
          h(
            "div",
            { className: "sk-settings-row" },
            h("div", { className: "label" }, h("b", null, "AI 预算 · 每日上限"), h("span", null, "超限后当日只跑规则并提示")),
            h(
              "select",
              { className: "sk-select", "aria-label": "每日 AI 调用上限", value: draft.dailyAiCallLimit, onChange: (event) => set({ dailyAiCallLimit: Number(event.target.value) }) },
              [50, 150, 300, 500].map((value) => h("option", { key: value, value }, `${value} 次`)),
            ),
          ),
          usage
            ? h(
                "div",
                { className: "sk-usage" },
                h("div", { className: "sk-usage-row" }, h("span", null, "今日 AI 调用 ", h("b", null, usage.calls), " 次 / ", usage.date || "今天"), h("span", null, "tokens ", h("b", null, fmtTokens(usage.tokens)))),
                h(
                  "div",
                  { className: "sk-usage-row" },
                  h("span", null, "上次扫描：", h("b", null, usage.lastScan.calls), " 次调用 · ", h("b", null, fmtTokens(usage.lastScan.tokens)), " tokens · ", h("b", null, fmtDuration(usage.lastScan.durationMs))),
                  usage.calls >= draft.dailyAiCallLimit ? h("span", { className: "sk-usage-warn" }, "已达每日上限，将降级规则") : null,
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
              { type: "button", className: "sk-btn", onClick: () => onScan("full") },
              h(Icon, { name: "refresh", size: 12 }),
              "立即全量重扫",
            ),
            h("button", { type: "button", className: "sk-btn", onClick: exportJson }, h(Icon, { name: "file", size: 12 }), "导出 JSON"),
          ),
          h(
            "p",
            { className: "sub" },
            "数据只存在本机 ~/.dsh/storages/super-kanban/；AI 研判只发送压缩后的会话摘要，不发送文件内容与凭证。",
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

    function readFilters() {
      try {
        const raw = localStorage.getItem(FILTERS_KEY);
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

    function writeFilters(filters) {
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
      } catch {
        /* storage unavailable */
      }
    }

    /** DSH 菜单风格的下拉浮层：trigger + 右侧菜单。 */
    function DropMenu({ open, onClose, items, children, alignLeft }) {
      const wrapRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) onClose();
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open, onClose]);
      return h(
        "div",
        { className: "sk-menu-wrap", ref: wrapRef },
        children,
        open
          ? h(
              "div",
              { className: cx("sk-menu", alignLeft && "is-left"), role: "menu" },
              items.filter(Boolean).map((item, index) =>
                item === "divider"
                  ? h("div", { key: "sep" + index, className: "sk-menu-sep" })
                  : h(
                      "button",
                      {
                        key: item.label + index,
                        type: "button",
                        role: "menuitem",
                        className: cx("sk-menu-item", item.danger && "is-danger", item.active && "is-active"),
                        onClick: () => {
                          onClose();
                          if (item.onClick) item.onClick();
                        },
                      },
                      item.icon ? h(Icon, { name: item.icon, size: 14 }) : null,
                      item.label,
                      item.hint ? h("span", { className: "sk-menu-hint" }, item.hint) : null,
                    ),
              ),
            )
          : null,
      );
    }

    function BoardPage(props) {
      const ctxProps = props || {};
      const surface = ctxProps.surface === "side" ? "side" : "page";
      const host = ctxProps.host || {};
      const [prefs, setPrefs] = React.useState(readPrefs);
      const rootRef = React.useRef(null);
      const [rootWidth, setRootWidth] = React.useState(0);
      const [sideStatus, setSideStatus] = React.useState("in_progress");

      // 双形态三档布局：以根容器自身宽度为准（右侧栏可被拖宽 / 全屏）。
      // 量当前挂载的根节点宽度（loading→正文会换节点，因此用 ref + 低频轮询，避免错过重挂载）。
      React.useEffect(() => {
        const measure = () => {
          const node = rootRef.current;
          if (!node) return;
          const width = node.clientWidth || 0;
          setRootWidth((current) => (current === width ? current : width));
        };
        measure();
        const timer = setInterval(measure, 300);
        window.addEventListener("resize", measure);
        return () => {
          clearInterval(timer);
          window.removeEventListener("resize", measure);
        };
      }, []);

      const attachRoot = React.useCallback((node) => {
        rootRef.current = node;
        if (node) setRootWidth(node.clientWidth || 0);
      }, []);

      const tier = surface === "side" ? (rootWidth >= 980 ? "wide" : rootWidth >= 620 ? "medium" : "narrow") : "wide";
      const isNarrow = surface === "side" && tier === "narrow";
      const pageClass = cx("sk-page", surface === "side" && "is-side", "sk-tier-" + tier);

      const [toasts, pushToast] = useToasts();
      const { data, error, loading, reload, setData } = useBoardData();
      const [filters, setFilters] = React.useState(readFilters);
      const searchRef = React.useRef(null);
      const [drawerId, setDrawerId] = React.useState(null);
      const [newTaskStatus, setNewTaskStatus] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [draggingId, setDraggingId] = React.useState(null);
      const [scanBusy, setScanBusy] = React.useState(false);
      const [nowTick, setNowTick] = React.useState(0);
      const [filterOpen, setFilterOpen] = React.useState(false);
      const [moreOpen, setMoreOpen] = React.useState(false);

      React.useEffect(() => {
        const timer = setInterval(() => setNowTick((value) => value + 1), 30_000);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          const target = event.target;
          const typing = Boolean(
            target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
          );
          if (event.key === "Escape") {
            if (settingsOpen) setSettingsOpen(false);
            else if (newTaskStatus !== null) setNewTaskStatus(null);
            else if (drawerId) setDrawerId(null);
            else if (moreOpen) setMoreOpen(false);
            else if (filterOpen) setFilterOpen(false);
            return;
          }
          if (typing || hasOpenDialog()) return;
          if (event.key === "/") {
            event.preventDefault();
            if (searchRef.current) searchRef.current.focus();
          } else if ((event.key === "n" || event.key === "N") && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            setNewTaskStatus("backlog");
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [settingsOpen, newTaskStatus, drawerId, moreOpen, filterOpen]);

      React.useEffect(() => {
        writeFilters(filters);
      }, [filters]);
      React.useEffect(() => {
        if (!filterOpen) return undefined;
        const onMouseDown = (event) => {
          if (event.target && event.target.closest && event.target.closest(".sk-filter-wrap")) return;
          setFilterOpen(false);
        };
        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
      }, [filterOpen]);

      const tasks = (data && data.tasks) || [];
      const settings = (data && data.settings) || {};
      const scan = (data && data.scan) || { state: "idle" };
      const workspaces = (data && data.workspaces) || [];
      const stats = (data && data.stats) || { byStatus: {}, doneRate: 0, total: 0 };
      const usage = usageOf(data);
      const activeFilterCount = (filters.priority ? 1 : 0) + (filters.source ? 1 : 0) + (filters.tag ? 1 : 0) + (filters.showArchived ? 1 : 0);
      const clearFilters = () => setFilters({ workspace: "", priority: "", source: "", tag: "", query: "", showArchived: false });
      const tags = React.useMemo(() => allTags(tasks.filter((task) => !task.archived)), [tasks]);

      const visible = React.useMemo(() => {
        const query = filters.query.trim().toLowerCase();
        return tasks.filter((task) => {
          if (!filters.showArchived && task.archived) return false;
          if (filters.workspace && task.workspaceId !== filters.workspace) return false;
          if (filters.priority && task.priority !== filters.priority) return false;
          if (filters.tag && !(task.tags || []).includes(filters.tag)) return false;
          if (filters.source === "ai" && task.origin === "manual") return false;
          if (filters.source === "manual" && task.origin !== "manual") return false;
          if (query) {
            // v2 的 goal 是对象，直接拼接会变成 "[object Object]"；搜索覆盖目标/关键事实/问题/下一步。
            const goal = goalInfoOf(task);
            const parts = [
              task.title,
              goal && goal.text,
              task.workspaceTitle,
              ...(task.tags || []),
              ...keyFactsOf(task).map((fact) => fact.text),
              ...(Array.isArray(task.issues) ? task.issues.map((issue) => issue && issue.text) : []),
              ...(Array.isArray(task.nextSteps) ? task.nextSteps : []),
              ...(Array.isArray(task.sessions) ? task.sessions.map((session) => session && session.title) : []),
            ];
            const haystack = parts.filter(Boolean).join(" ").toLowerCase();
            if (!haystack.includes(query)) return false;
          }
          return true;
        });
      }, [tasks, filters]);

      const byStatus = React.useMemo(() => {
        const map = { backlog: [], in_progress: [], blocked: [], done: [] };
        for (const task of visible) {
          const status = statusOf(task);
          (map[status] || map.backlog).push(task);
        }
        for (const key of STATUS_ORDER) map[key].sort(compareTasks);
        return map;
      }, [visible]);

      const drawerTask = drawerId ? tasks.find((task) => task.id === drawerId) : null;

      const scanRunning = scan.state === "running";
      // 读屏播报扫描状态（可见区已有文字，这里不重复显示）。
      const scanAnnounce = scanRunning
        ? `扫描中 ${scan.processed || 0}/${scan.total || 0}`
        : scan.state === "error"
          ? `扫描失败：${scan.error || scan.message || "未知错误"}`
          : scan.state === "done"
            ? `扫描完成：新增 ${scan.newTasks || 0}，更新 ${scan.updatedTasks || 0}`
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
        if (!before || before.status === status) return;
        // 乐观更新：先落到本地，失败再回滚，避免"松手后卡片跳回去再刷新"的闪烁。
        patchTaskLocal(id, { status });
        try {
          await command("task.move", { id, status });
          pushToast(`已移动到「${STATUS_META[status].label}」`, "info");
          await reload(true);
        } catch (cause) {
          patchTaskLocal(id, { status: before.status });
          pushToast(`移动失败：${cause.message}`, "error");
        }
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

      // 统计行：总数 / 各状态 / 归档 + 上一次扫描的持久结果（完整文字放 title，避免窄栏挤压）。
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
      const archivedCount = Number(stats.archived) || 0;
      const statsLine = h(
        React.Fragment,
        null,
        h("span", { className: "sk-stats-group" }, h("span", { className: "sk-dot is-total" }), `${stats.total || tasks.length} 项`),
        h("span", { className: "sk-sep" }, "·"),
        // 0 待办 / 0 已归档不再占位，避免统计行被无信息量内容挤占（列头本身已显示计数）。
        Number(statusCounts.backlog) > 0
          ? h(
              React.Fragment,
              null,
              h("span", { className: "sk-stats-group" }, h("span", { className: "sk-dot is-backlog" }), `${statusCounts.backlog} 待办`),
              h("span", { className: "sk-sep" }, "·"),
            )
          : null,
        h("span", { className: "sk-stats-group" }, h("span", { className: "sk-dot is-in_progress" }), `${Number(statusCounts.in_progress) || 0} 进行中`),
        h("span", { className: "sk-sep" }, "·"),
        h("span", { className: "sk-stats-group" }, h("span", { className: "sk-dot is-blocked" }), `${Number(statusCounts.blocked) || 0} 受阻`),
        h("span", { className: "sk-sep" }, "·"),
        h("span", { className: "sk-stats-group" }, h("span", { className: "sk-dot is-done" }), `${Number(statusCounts.done) || 0} 完成`),
        archivedCount > 0
          ? h(
              React.Fragment,
              null,
              h("span", { className: "sk-sep" }, "·"),
              h("span", { className: "sk-stats-group is-archived" }, h("span", { className: "sk-dot is-total" }), `${archivedCount} 已归档`),
            )
          : null,
        h("span", { className: "sk-sep" }, "·"),
        scanRunning
          ? h(
              React.Fragment,
              null,
              h("span", { className: "sk-status-dot is-running" }),
              h("span", null, `扫描中 ${scan.processed || 0}/${scan.total || 0}`),
              h("button", { type: "button", className: "sk-textlink", onClick: cancelScan }, "取消"),
            )
          : scan.state === "error"
            ? h(
                React.Fragment,
                null,
                h("span", { className: "sk-status-dot is-error" }),
                h("span", { className: "sk-scan-error", title: scanTitleText }, `上次扫描失败：${scanErrorText}`),
                h("button", { type: "button", className: "sk-textlink", onClick: () => startScan("incremental") }, "重试"),
              )
            : h(
                React.Fragment,
                null,
                h("span", { className: "sk-status-dot" }),
                h(
                  "span",
                  { className: "sk-scan-outcome", title: scanTitleText },
                  `上次扫描 ${relTime(scanLastAt)}${scanOutcomeText ? " · " + scanOutcomeText : ""}`,
                ),
              ),
      );

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
      const exportMenuItems = [{ label: "导出 JSON", icon: "file", onClick: exportJson }];

      const scanButton = h(
        "button",
        {
          type: "button",
          className: "sk-iconbtn-v3" + (scanRunning ? " is-busy" : ""),
          title: scanRunning ? "扫描中，点击取消" : settings.aiEnabled === false ? "扫描（仅规则）" : "AI 扫描",
          "aria-label": scanRunning ? "取消扫描" : settings.aiEnabled === false ? "扫描（仅规则）" : "扫描会话",
          "aria-busy": scanRunning ? "true" : undefined,
          onClick: scanRunning ? cancelScan : () => startScan("incremental"),
          disabled: !scanRunning && scanBusy,
        },
        h(Icon, { name: scanRunning ? "stop" : "refresh", size: 15 }),
      );
      const actionIcon = (name, title, onClick, extraClass) =>
        h(
          "button",
          { type: "button", className: cx("sk-iconbtn-v3", extraClass), title, "aria-label": title, onClick },
          h(Icon, { name, size: 15 }),
        );
      const moreButton = (items) =>
        h(
          DropMenu,
          { open: moreOpen, onClose: () => setMoreOpen(false), items },
          h(
            "button",
            {
              type: "button",
              className: "sk-iconbtn-v3",
              title: "更多（导出）",
              "aria-label": "更多操作（导出 JSON）",
              "aria-haspopup": "menu",
              "aria-expanded": moreOpen,
              onClick: () => setMoreOpen((value) => !value),
            },
            h(Icon, { name: "more", size: 15 }),
          ),
        );
      const settingsButton = actionIcon("settings", "设置", () => setSettingsOpen(true));
      const newTextButton = h(
        "button",
        { type: "button", className: "sk-btn-primary-v3", onClick: () => setNewTaskStatus("backlog"), title: "新建任务（n）", "aria-label": "新建任务" },
        "新建",
      );

      const headerNode =
        surface === "side"
          ? h(
              "header",
              { className: "sk-header-v3" },
              h("p", { className: "sk-stats-v3" }, statsLine),
              h(
                "div",
                { className: "sk-header-actions" },
                scanButton,
                settingsButton,
                prefs.fullEntry ? actionIcon("layout", "在全页面板打开", openPageFromSide) : null,
                actionIcon("plus", "新建任务", () => setNewTaskStatus("backlog"), "is-primary"),
                moreButton(exportMenuItems),
              ),
            )
          : h(
              "header",
              { className: "sk-header-v3" },
              h(
                "div",
                { className: "sk-header-main" },
                h("h1", { className: "sk-title-v3" }, "任务看板"),
                h("p", { className: "sk-stats-v3" }, statsLine),
              ),
              h(
                "div",
                { className: "sk-header-actions" },
                h(
                  "div",
                  { className: "sk-search-v3" },
                  h(Icon, { name: "search", size: 14 }),
                  h("input", {
                    ref: searchRef,
                    "aria-label": "搜索任务、会话或标签",
                    value: filters.query,
                    placeholder: "搜索任务 / 会话 / 标签",
                    onChange: (event) => setFilters((value) => ({ ...value, query: event.target.value })),
                  }),
                ),
                scanButton,
                settingsButton,
                prefs.sideEntry ? actionIcon("panelRight", "在右侧栏打开", openSideFromPage) : null,
                newTextButton,
                moreButton(exportMenuItems),
              ),
            );

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
          h(
            "span",
            { className: "sk-ws-picker" },
            h(
              "select",
              {
                className: "sk-select sk-ws-select",
                "aria-label": "按工作区筛选",
                value: filters.workspace,
                title: "按工作区筛选",
                onChange: (event) => setFilters((value) => ({ ...value, workspace: event.target.value })),
              },
              h("option", { value: "" }, "全部工作区"),
              workspaces
                .filter((workspace) => workspace.included !== false)
                .map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)),
            ),
            h(Icon, { name: "chevronDown", size: 12, className: "sk-ws-caret" }),
          ),
          h(
            "div",
            { className: "sk-filter-wrap" },
            h(
              "button",
              {
                type: "button",
                className: cx("sk-slim-icon", activeFilterCount > 0 && "is-on"),
                "aria-expanded": filterOpen,
                "aria-haspopup": "true",
                onClick: () => setFilterOpen((value) => !value),
                title: "筛选任务",
              },
              h(Icon, { name: "filter", size: 14 }),
              "筛选",
              activeFilterCount > 0 ? h("span", { className: "sk-filter-count" }, activeFilterCount) : null,
            ),
            filterOpen
              ? h(
                  "div",
                  { className: "sk-filter-popover", role: "group", "aria-label": "筛选条件" },
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
                          tags.slice(0, 24).map((tag) => h("option", { key: tag, value: tag }, tag)),
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
          h("span", { className: "sk-count" }, `显示 ${visible.length} / ${tasks.length}`),
        ),
        visible.length === 0 && tasks.length > 0
          ? h(
              "div",
              { className: "sk-board-v3" },
              h(
                "div",
                { className: "sk-empty-v3" },
                "没有匹配的任务",
                h("button", { type: "button", className: "sk-text", onClick: clearFilters }, "清空筛选"),
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
                  onOpen: (id) => setDrawerId(id),
                  onAdd: (targetStatus) => setNewTaskStatus(targetStatus),
                  draggingId,
                  onDragStart: setDraggingId,
                  onDragEnd: () => setDraggingId(null),
                })
              : h(
                  "div",
                  { className: "sk-board-v3" },
                  STATUS_ORDER.map((status) =>
                    h(Column, {
                      key: status,
                      status,
                      tasks: byStatus[status] || [],
                      onOpen: (id) => setDrawerId(id),
                      onAdd: (targetStatus) => setNewTaskStatus(targetStatus),
                      onDropTask: (id, targetStatus) => moveTask(id, targetStatus),
                      draggingId,
                      onDragStart: setDraggingId,
                      onDragEnd: () => setDraggingId(null),
                    }),
                  ),
                ),
        drawerTask
          ? h(TaskDrawer, { task: drawerTask, ctxProps, settings, onClose: () => setDrawerId(null), onChanged: () => reload(true), pushToast })
          : null,
        newTaskStatus !== null
          ? h(NewTaskModal, { defaultStatus: newTaskStatus, workspaces, onClose: () => setNewTaskStatus(null), onCreate: async () => { setNewTaskStatus(null); await reload(true); }, pushToast })
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

    /* ================================ apply =============================== */

    function apply(ctx) {
      ctx.effect(() => {
        const tag = ensureStyle();
        return () => tag.remove();
      }, "super-kanban: styles");

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
        openSideTab() {
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
        startSession(workspaceId, prompt) {
          try {
            const ui = ctx.get("uiWorkspace");
            if (ui && typeof ui.startSession === "function") {
              ui.startSession(workspaceId, { prompt: String(prompt || "") });
              return true;
            }
          } catch {
            /* ui workspace unavailable */
          }
          return false;
        },
        openResource(sessionId, path) {
          const sid = String(sessionId || "");
          const relative = String(path || "").replace(/^\/+/, "");
          if (!sid || !relative) return false;
          const encodedPath = relative
            .split("/")
            .filter(Boolean)
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          const address = "dsh-resource://file/session/" + encodeURIComponent(sid) + "/" + encodedPath;
          try {
            const sidebarRight = ctx.get("sidebarRight");
            if (sidebarRight && typeof sidebarRight.openResource === "function") {
              sidebarRight.openResource(address);
              return true;
            }
          } catch {
            /* sidebar service unavailable */
          }
          return false;
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

      const PageKanbanBody = (slotProps) => h(BoardPage, { ...(slotProps || {}), ...baseProps, surface: "page" });
      const SideKanbanBody = (slotProps) => h(BoardPage, { ...(slotProps || {}), ...baseProps, surface: "side" });

      function KanbanSidebarIcon({ size }) {
        return h(Icon, { name: "board", size: size || 18 });
      }

      const HeaderKanbanButton = () =>
        h(
          "button",
          {
            type: "button",
            className: "sk-header-btn",
            title: "打开任务看板",
            "aria-label": "打开任务看板",
            onClick: () => hostApi.openSideTab(),
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

    return { apply, inject: ["slots", "locale", "sidebarRightTabs", "sidebarRight", "layout", "sessions", "conversation", "uiWorkspace"] };
  },
});
