import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadClient(services, { snapshot, view = "attention", filters, prefs, clipboard, fetch, onState, browser, inspect = false } = {}) {
  const registrations = new Map();
  let nextState = snapshot ? { initial: null, value: snapshot } : null;
  let nextId = 0;
  const React = {
    Component: class {},
    createElement(type, props, ...children) { return { type, props, children }; },
    useState(initial) {
      // Seed the initial /state result without mounting polling or DOM effects.
      if (nextState && initial === nextState.initial) {
        const { value } = nextState;
        nextState = null;
        return [value, (next) => onState?.(next)];
      }
      return [typeof initial === "function" ? initial() : initial, (value) => onState?.(value)];
    },
    useRef: (current) => ({ current }),
    useId: () => `id-${++nextId}`,
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (calculate) => calculate(),
    useCallback: (callback) => callback,
  };
  let plugin;
  const context = {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => React); } } },
    localStorage: { getItem: (key) => ({
      "dsh-super-kanban:view:page": snapshot ? view : null,
      "dsh-super-kanban:filters": filters ? JSON.stringify(filters) : null,
      "dsh-super-kanban:prefs": prefs ? JSON.stringify(prefs) : null,
    })[key] },
    navigator: { clipboard },
    document: { baseURI: "http://plugin.local/" },
    fetch, URL,
    AbortSignal,
    setTimeout,
    ...browser,
  };
  const script = inspect ? source.replace("return { apply, inject:",
    "return { apply, useBoardData, command, draftChanges, chatContext, floatingSummary, floatingReview, canAcceptTask, subscribeBoardRefresh, normalizePrefs, quickCapturePayload, " +
    "folderGlyph, folderColor, " +
    "markdownBlocks, renderInline, taskChatReference, inject:") : source;
  vm.runInNewContext(script, context, { filename: "client.js" });
  plugin.apply({
    get: (name) => services[name],
    effect() { /* no DOM in the contract test */ },
    sidebarRightTabs: { register() {} },
    slots: {
      inject(_name, register) {
        const result = register();
        if (result?.next) Array.from(result);
      },
      register(config, render) {
        registrations.set(config.name, { config, render });
      },
    },
  });
  const host = registrations.get("main").render({}).children[0].props.host;
  return { registrations, host, plugin, seedNextState: (value, initial = null) => { nextState = { initial, value }; } };
}

function* elements(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object") {
    yield node;
    yield* elements(node.children);
  }
}

function renderedText(node) {
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return typeof node === "object" && node ? renderedText(node.children) : String(node ?? "");
}

function renderAttention(tasks, statuses, opens = [], writeOverlaps = []) {
  const { registrations } = loadClient({ uiWorkspace: { openSession: (id) => opens.push(id) } }, { snapshot: { tasks, writeOverlaps } });
  const slot = registrations.get("main");
  const root = slot.render(statuses ? { useSessionStatus: (select) => select(statuses) } : {}).children[0];
  const board = statuses ? root.type(root.props) : root;
  const view = board.type(board.props);
  const collection = [...elements(view)].find((node) => node.props?.mode === "attention");
  return { view, rows: collection.type(collection.props) };
}

test("new-session preparation uses the exact DSH workspace callback and keeps existing drafts", async () => {
  const seen = [];
  const { host } = loadClient({
    uiWorkspace: {
      async openWorkspace(workspaceId, prepare) {
        seen.push(workspaceId);
        prepare("new-session");
      },
    },
    sessions: { binding: (id) => ({ id }) },
    conversation: { input: { requestDraftInitialization(binding, options) {
      seen.push(binding.id, options.prompt, options.whenDraftExists);
      return "preserved";
    } } },
  });
  const placement = await host.prepareSession("workspace", "Draft text");
  assert.equal(placement.sessionId, "new-session");
  assert.equal(placement.result, "preserved");
  assert.deepEqual(seen, ["workspace", "new-session", "Draft text", "keep"]);
});

test("superseded workspace navigation cannot report a placed draft", async () => {
  const { host } = loadClient({
    uiWorkspace: { async openWorkspace() {} },
    sessions: { binding: () => { throw new Error("no session was opened"); } },
    conversation: { input: { requestDraftInitialization() {} } },
  });
  assert.equal(await host.prepareSession("workspace", "Draft text"), null);
});

test("artifact preview enters its source session from the global panel and preserves session scope for absolute paths", async () => {
  const opened = [];
  let mounted;
  const { host } = loadClient({
    uiWorkspace: { openSession(id) { mounted = id; } },
    sidebarRight: {
      screen: () => mounted ? { sessionId: mounted } : undefined,
      openResource(address) {
        if (!mounted) throw new Error("sidebarRight: no session surface is mounted");
        opened.push(address);
      },
    },
  });
  assert.equal(await host.openResource("delivery", "/checkout with space/report #1.md"), true);
  assert.equal(mounted, "delivery");
  assert.deepEqual(opened, ["dsh-resource://file/session/delivery//checkout%20with%20space/report%20%231.md"]);
});

test("artifact previews wait for their own sidebar and the latest request wins", async () => {
  const opens = [];
  const resources = [];
  let mounted = "unrelated";
  const { host } = loadClient({
    uiWorkspace: { openSession: (id) => opens.push(id) },
    sidebarRight: {
      screen: () => ({ sessionId: mounted }),
      openResource: (address) => resources.push([mounted, address]),
    },
  });
  const first = host.openResource("first", "first.md");
  const second = host.openResource("second", "docs/second.md");
  setTimeout(() => { mounted = "second"; }, 125);
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(opens, ["first", "second"]);
  assert.deepEqual(resources, [["second", "dsh-resource://file/session/second/docs/second.md"]]);
});

test("desktop file actions use DSH's verified open and reveal RPCs with a bounded signal", async () => {
  const seen = [];
  const { host } = loadClient({ remote: {
    session: {
      canOpenWorkspacePath: async (...args) => ({ ok: args.length === 0, value: true }),
      async openWorkspacePath(request, signal) {
        assert.ok(signal instanceof AbortSignal);
        seen.push({ ...request });
        return { ok: true, value: { opened: request.path !== "/missing.md" } };
      },
    },
    workspaceFiles: {
      async stat(sessionId, path, signal) {
        assert.ok(signal instanceof AbortSignal);
        seen.push([sessionId, path]);
        return { ok: sessionId === "linked-source", value: { absolutePath: "/real/worktree/report #1.md" } };
      },
    },
  } });
  assert.equal(await host.canOpenNativeFile(), true);
  assert.equal(await host.openNativeFile("C:\\docs\\report #1.md", "open"), true);
  assert.equal(await host.openNativeFile("/checkout/report #1.md", "reveal"), true);
  assert.equal(await host.openNativeFile("report.md", "reveal"), false);
  assert.equal(await host.openNativeFile("/missing.md", "open"), false);
  assert.equal(await host.openNativeFile("/alias/report #1.md", "reveal", "linked-source"), true);
  assert.equal(await host.openNativeFile("/alias/report #1.md", "open", "invalid-source"), false);
  assert.deepEqual(seen, [
    { path: "C:\\docs\\report #1.md" }, { path: "/checkout/report #1.md", action: "reveal" }, { path: "/missing.md" },
    ["linked-source", "/alias/report #1.md"], { path: "/real/worktree/report #1.md", action: "reveal" }, ["invalid-source", "/alias/report #1.md"],
  ]);
  assert.equal(await loadClient({}).host.canOpenNativeFile(), false);
});

test("artifact menus preserve the file name and complete host path even when a file disappears", async () => {
  const copied = [];
  const path = "C:\\worktree\\docs\\完整交付报告 #1.md";
  const { registrations, seedNextState } = loadClient({}, {
    snapshot: { tasks: [{ id: "task", title: "发布", workspaceTitle: "发布工作区", primarySessionId: "origin", status: "done",
      artifacts: [{ id: "a1", name: "显示名称", path: "docs/完整交付报告 #1.md", absPath: path, missing: true }] }] },
    view: "artifacts", clipboard: { async writeText(value) { copied.push(value); } },
  });
  const board = registrations.get("main").render({}).children[0];
  const artifacts = [...elements(board.type(board.props))].find((node) => node.type?.name === "ArtifactsView");
  const entry = [...elements(artifacts.type(artifacts.props))].find((node) => node.type?.name === "ArtifactEntry");
  seedNextState({ trigger: { isConnected: false } });
  const row = entry.type({ ...entry.props, desktopFiles: true, pushToast() {} });
  assert.equal(row.props.title, `发布工作区\n${path}\n文件不可用`);
  assert.equal(row.children[0].props.disabled, true);
  const popup = row.children.find((node) => node?.type?.name === "QuickMenu");
  const items = popup.props.items.filter((item) => item?.run);
  assert.deepEqual(Array.from(items.filter((item) => item.disabled), (item) => item.label), ["在 DSH 中预览", "用默认应用打开", "在文件管理器中显示"]);
  await items.find((item) => item.label === "复制文件名").run();
  await items.find((item) => item.label === "复制完整路径").run();
  assert.deepEqual(copied, ["完整交付报告 #1.md", path]);
});

test("the main toolbar keeps views and filters in one row and scan details in the scan tooltip", () => {
  const { registrations } = loadClient({}, { snapshot: { tasks: [], scan: { state: "done", message: "扫描完成，低价值跳过 1" } } });
  const board = registrations.get("main").render({}).children[0];
  const view = board.type(board.props);
  const toolbar = [...elements(view)].find((node) => node.props?.className === "sk-slimbar");
  assert.ok([...elements(toolbar)].some((node) => node.props?.["aria-label"] === "任务视图"));
  assert.ok([...elements(toolbar)].some((node) => node.props?.["aria-label"] === "按项目筛选"));
  assert.ok([...elements(toolbar)].some((node) => node.props?.["aria-label"] === "任务时间范围"));
  const scan = [...elements(view)].find((node) => node.props?.["aria-label"] === "扫描会话");
  assert.match(scan.props.title, /低价值跳过 1/);
  assert.doesNotMatch(renderedText(view), /低价值跳过 1/);
});

test("a long column renders one page at a time, clamps a shortened last page, and keeps the completed count when collapsed", () => {
  const tasks = Array.from({ length: 64 }, (_, index) => ({ id: `task-${index}`, title: `任务 ${index}`, status: "done" }));
  const { registrations, seedNextState } = loadClient({}, { snapshot: { tasks }, view: "board" });
  const board = registrations.get("main").render({}).children[0];
  const column = [...elements(board.type(board.props))].find((node) => node.type?.name === "Column" && node.props.status === "done");
  const page = [...elements(column.type(column.props))].find((node) => node.type?.name === "ColumnCards");
  const cards = (view) => [...elements(view)].filter((node) => node.type?.name === "TaskCard");
  assert.equal(cards(page.type(page.props)).length, 30);
  seedNextState(2, 0);
  assert.equal(cards(page.type(page.props)).length, 4);
  seedNextState(2, 0);
  const shortened = page.type({ ...page.props, tasks: page.props.tasks.slice(0, 32) });
  assert.equal(cards(shortened).length, 2);
  assert.match(renderedText(shortened), /31–32 \/ 32/);
  const collapsed = column.type({ ...column.props, collapsed: true });
  assert.equal([...elements(collapsed)].some((node) => node.type?.name === "ColumnCards"), false);
  const toggle = [...elements(collapsed)].find((node) => node.props?.className === "sk-col-toggle");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.match(toggle.props["aria-label"], /64 项/);
});

test("a collapsed column accepts a task dragged on the board and ignores external text drops", () => {
  const task = { id: "dragged", title: "交付", status: "backlog" };
  const { registrations } = loadClient({}, { snapshot: { tasks: [task] }, view: "board" });
  const board = registrations.get("main").render({}).children[0];
  const columns = [...elements(board.type(board.props))].filter((node) => node.type?.name === "Column");
  const source = columns.find((node) => node.props.status === "backlog");
  const page = [...elements(source.type(source.props))].find((node) => node.type?.name === "ColumnCards");
  const card = [...elements(page.type(page.props))].find((node) => node.type?.name === "TaskCard");
  const transfer = new Map([["text/plain", task.id]]);
  const drops = [];
  const target = columns.find((node) => node.props.status === "done");
  const view = target.type({ ...target.props, draggingId: task.id, collapsed: true, onDropTask: (...args) => drops.push(args) });
  const event = { preventDefault() {}, dataTransfer: { getData: (type) => transfer.get(type), setData: (type, id) => transfer.set(type, id) } };
  view.props.onDrop(event);
  assert.deepEqual(drops, []);
  card.type(card.props).props.onDragStart(event);
  view.props.onDrop(event);
  assert.deepEqual(drops, [[task.id, "done"]]);
});

test("the conversation shortcut passes the scoped session through sidebar navigation", () => {
  const opens = [];
  const { registrations } = loadClient({ sidebarRight: {
    openTab(kind, options) { opens.push([kind, options.params.sessionId]); },
  } });
  const header = registrations.get("conversation.session.header.utilities");
  const headerView = header.render({ sessionId: "selected-session" });
  [...elements(headerView)].find((node) => node.props?.["aria-label"] === "打开右侧看板").props.onClick();
  assert.deepEqual(opens, [["super-kanban", "selected-session"]]);
  const sidebar = registrations.get("sidebar.right.pane.tab");
  const view = sidebar.render({ useTabInfo: () => ({ tab: { navigation: { params: { sessionId: "selected-session" } } } }) });
  assert.equal(view.children[0].props.sessionId, "selected-session");
});

test("the conversation header can open all surfaces and remember its preferred target", () => {
  const seen = [];
  const { registrations, seedNextState } = loadClient({ layout: { selectPanel: (id) => seen.push(id) } },
    { prefs: { sideEntry: false } });
  const header = registrations.get("conversation.session.header.utilities");
  const first = header.render({ sessionId: "session" });
  const button = [...elements(first)].find((node) => node.props?.["aria-label"] === "打开全局看板");
  button.props.onClick();
  assert.equal([...elements(first)].find((node) => node.props?.["aria-label"] === "切换看板形态").props["aria-expanded"], false);
  seedNextState({ trigger: {} }, false);
  const expanded = header.render({ sessionId: "session" });
  const menu = [...elements(expanded)].find((node) => node.type?.name === "QuickMenu");
  const items = Array.from(menu.props.items).filter((item) => item !== "divider");
  assert.deepEqual(items.map((item) => item.id), ["page", "side", "float", "chat", "entry"]);
  assert.equal(items[0].label, "全局看板（默认）");
  items.find((item) => item.id === "float").run();
  assert.deepEqual(seen, ["super-kanban"]);
  const next = header.render({});
  assert.ok([...elements(next)].some((node) => node.props?.["aria-label"] === "打开悬浮看板"));
  const overlay = registrations.get("shell.overlay").render({});
  assert.equal(overlay.children[0].type(overlay.children[0].props).props.open, true);
  // The header menu opens quick chat in the overlay without any board being mounted.
  items.find((item) => item.id === "chat").run();
  const chat = overlay.children[1].type(overlay.children[1].props);
  assert.equal(chat.props.request.sessionId, "session");
});

test("stored preferences from 0.9 gain the persistent launcher while explicit v2 choices are kept", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const legacy = plugin.normalizePrefs({ surface: "page", floatEnabled: false, floatStyle: "bar", floatSummaries: ["running"], floatHideEmpty: true });
  assert.deepEqual(
    [legacy.surface, legacy.floatEnabled, legacy.floatStyle, legacy.floatHideEmpty, Array.from(legacy.floatSummaries)],
    ["page", true, "badge", false, ["acceptance", "attention", "running"]]);
  const configured = plugin.normalizePrefs({ floatEnabled: true, floatStyle: "bar", floatPosition: "left", floatSummaries: ["running"] });
  assert.deepEqual([configured.floatStyle, configured.floatPosition, Array.from(configured.floatSummaries)], ["bar", "left", ["running"]]);
  const current = plugin.normalizePrefs({ version: 2, floatEnabled: false, floatHideEmpty: true, floatOffset: 120.4, floatSize: "large", floatPinned: true });
  assert.deepEqual(
    [current.floatEnabled, current.floatHideEmpty, current.floatOffset, current.floatSize, current.floatPinned],
    [false, true, 120, "large", true]);
  assert.equal(plugin.normalizePrefs({ version: 2, floatOffset: -5, floatSize: "huge" }).floatOffset, 0);
  const hidden = loadClient({}, { prefs: { version: 2, floatEnabled: false } });
  const entry = hidden.registrations.get("shell.overlay").render({}).children[0];
  assert.equal(entry.type(entry.props), null);
});

test("only one board surface shows at a time", () => {
  const seen = [];
  let active = "super-kanban";
  const tab = { id: "tab-1", kind: "super-kanban" };
  const { host, registrations } = loadClient({
    layout: {
      selectPanel: (id) => { seen.push(["panel", id]); active = id; },
      panelInfo: { getSnapshot: () => ({ activePanelId: active }), subscribe: () => () => {} },
    },
    sidebarRight: {
      active: () => tab,
      close: (id) => seen.push(["close", id]),
      openTab: (kind, options) => seen.push(["tab", kind, options?.params?.sessionId]),
    },
  });
  const floating = () => {
    const entry = registrations.get("shell.overlay").render({}).children[0];
    return entry.type(entry.props);
  };
  // Floating leaves the global board and closes the docked board tab, never another tab.
  assert.equal(host.openSurface("float"), true);
  assert.deepEqual(seen, [["panel", null], ["close", "tab-1"]]);
  assert.equal(floating().props.open, true);
  tab.kind = "terminal";
  seen.length = 0;
  host.openSurface("float");
  assert.deepEqual(seen, []);
  // Opening either docked surface collapses the floating panel.
  assert.equal(host.openSurface("side", "session"), true);
  assert.equal(floating().props.open, false);
  host.openSurface("float");
  assert.equal(host.openSurface("page"), true);
  assert.equal(floating().props.open, false);
  assert.deepEqual(seen.at(-1), ["panel", "super-kanban"]);
  // While the global board is on screen the launcher steps aside.
  const panel = floating();
  assert.equal(panel.type(panel.props), null);
});

test("the launcher menu hides the entry with an undo and the floating panel offers every category", async () => {
  const requests = [];
  const task = { id: "owner", title: "当前会话的任务", status: "in_progress", workspaceId: "ws-1", workspaceTitle: "工作区一",
    projectId: "p-1", primarySessionId: "current", lastActivityAt: Date.now() };
  const services = { sidebarRight: { screen: () => ({ sessionId: "current" }) } };
  const menuClient = loadClient(services, {});
  menuClient.seedNextState({ trigger: {} }, false);
  const closed = menuClient.registrations.get("shell.overlay").render({}).children[0];
  const closedPanel = closed.type(closed.props);
  const closedView = closedPanel.type(closedPanel.props);
  const menu = [...elements(closedView)].find((node) => node.type?.name === "QuickMenu");
  const labels = Array.from(menu.props.items).filter((item) => item && item !== "divider").map((item) => item.label);
  assert.deepEqual(labels, ["展开悬浮看板", "打开右侧看板", "打开全局看板", "快聊", "移到左侧", "隐藏悬浮入口"]);
  Array.from(menu.props.items).find((item) => item?.label === "隐藏悬浮入口").run();
  const afterHide = menuClient.registrations.get("shell.overlay").render({}).children[0];
  const notice = afterHide.type(afterHide.props);
  const noticeView = notice.type(notice.props);
  const hasLauncher = (view) => [...elements(view)].some((node) => node.props?.className?.includes?.("sk-float-trigger"));
  assert.equal(hasLauncher(noticeView), false);
  [...elements(noticeView)].find((node) => node.type === "button" && renderedText(node) === "撤销").props.onClick();
  const restored = menuClient.registrations.get("shell.overlay").render({}).children[0];
  const restoredPanel = restored.type(restored.props);
  assert.equal(hasLauncher(restoredPanel.type(restoredPanel.props)), true);

  const { host, registrations } = loadClient(services, {
    snapshot: { tasks: [task], projects: [{ id: "p-1", name: "跨区项目" }] },
    fetch: async (url, options) => {
      requests.push([url.pathname, options.body ? JSON.parse(options.body) : null]);
      return { ok: true, json: async () => ({ ok: true, tasks: [task] }) };
    },
  });
  host.openSurface("float");
  const entry = registrations.get("shell.overlay").render({}).children[0];
  const panel = entry.type(entry.props);
  const view = panel.type(panel.props);
  const tabs = [...elements(view)].find((node) => node.props?.["aria-label"] === "任务类别");
  assert.deepEqual([...elements(tabs)].filter((node) => node.type === "button").map((node) => renderedText(node)),
    ["待验收 0", "待处理 0", "运行中 0", "最近 1"]);
  // An expanded panel replaces the launcher; an empty quick note is never sent.
  assert.equal(hasLauncher(view), false);
  const form = [...elements(view)].find((node) => node.type === "form");
  assert.equal(form.props.className, "sk-float-add");
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(requests, []);
});

test("quick capture files the note under the current session's workspace without linking the session", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const tasks = [
    { id: "other", workspaceId: "ws-2", primarySessionId: "elsewhere" },
    { id: "owner", workspaceId: "ws-1", sessions: [{ id: "current" }] },
  ];
  assert.deepEqual({ ...plugin.quickCapturePayload("补一条回归测试", tasks, "current") }, { title: "补一条回归测试", status: "backlog", workspaceId: "ws-1" });
  assert.deepEqual({ ...plugin.quickCapturePayload("没有会话时", tasks, null) }, { title: "没有会话时", status: "backlog" });
  assert.deepEqual({ ...plugin.quickCapturePayload("未知会话", tasks, "unknown") }, { title: "未知会话", status: "backlog" });
});

test("quick chat answers render common Markdown without HTML and keep an unfinished code block readable", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const blocks = plugin.markdownBlocks("## 结论\n\n先做 **A**。\n\n1. 第一步\n   - 细节\n2. 第二步\n\n> 提示\n\n```js\nconst a = 1;\n<script>alert(1)</script>");
  assert.deepEqual(Array.from(blocks, (block) => block.type), ["heading", "paragraph", "list", "quote", "code"]);
  assert.deepEqual(Array.from(blocks[2].items, (item) => [item.marker, item.depth, item.text]), [["1.", 0, "第一步"], ["•", 1, "细节"], ["2.", 0, "第二步"]]);
  assert.deepEqual([blocks[4].lang, blocks[4].text], ["js", "const a = 1;\n<script>alert(1)</script>"]);
  const inline = plugin.renderInline("用 `npm test` 跑 **全部** 测试，见 [文档](https://example.com/a) 和 [坏链接](javascript:alert(1))", "k");
  assert.deepEqual(Array.from(inline).filter((node) => typeof node === "object").map((node) => [node.type, node.props.href, node.children[0]]),
    [["code", undefined, "npm test"], ["strong", undefined, "全部"], ["a", "https://example.com/a", "文档"]]);
  assert.match(inline.at(-1), /坏链接/);
});

test("follow-up context skips one-shot modes and stopped answers", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const route = { ok: true, provider: "demo", model: "selected" };
  const turn = (input, extra = {}) => ({ ...route, input, answer: "answer", ...extra });
  const turns = [turn("first"), turn("translated", { mode: "translate-zh" }), turn("partial", { stopped: true }), turn("second", { mode: "ask" })];
  assert.deepEqual(Array.from(plugin.chatContext(turns, route).turns, ({ input }) => input), ["first", "second"]);
});

test("a task becomes a bounded quick chat reference", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const reference = plugin.taskChatReference({ id: "t", title: "修复登录", status: "blocked", priority: "P1", workspaceTitle: "前端",
    projectName: "大促", acceptanceCriteria: "单测通过", nextSteps: ["补测试"], issues: [{ text: "接口超时" }], notes: "x".repeat(9000) });
  assert.equal(reference.title, "修复登录");
  assert.match(reference.text, /任务：修复登录\n状态：受阻/);
  assert.match(reference.text, /工作区：前端\n项目：大促/);
  assert.match(reference.text, /验收条件：单测通过/);
  assert.match(reference.text, /未解决的问题：\n- 接口超时/);
  assert.equal(reference.text.length, 6000);
});

test("floating summaries share the acceptance rule and exclude historical and archived cards", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const now = Date.now();
  const ready = (id, fields = {}) => ({ id, status: "in_progress", attention: "acceptance", acceptanceCriteria: "检查产物",
    primarySessionId: id, origin: "auto", lastActivityAt: now - 1000, ...fields });
  const items = [ready("accept"), ready("active"), ready("approval"), ready("archived", { archived: true }),
    ready("past", { lastActivityAt: now - 40 * 86_400_000, createdAt: new Date(now).toISOString() }),
    ready("accepted", { status: "done", completionBasis: "user" })];
  const summary = plugin.floatingSummary(items, new Map([
    ["active", { running: true }], ["approval", { pendingInteraction: { kind: "approval" } }],
  ]), 30, now);
  assert.deepEqual(Array.from(summary.acceptance, (row) => row.task.id), ["accept"]);
  assert.deepEqual(Array.from(summary.attention, (row) => row.task.id), ["accept", "approval"]);
  assert.deepEqual(Array.from(summary.running, (row) => row.task.id), ["active"]);
});

test("floating acceptance orders by delivery time even after a recent manual edit", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const now = Date.now();
  const task = (id, time, history = []) => ({ id, status: "in_progress", attention: "acceptance", lastActivityAt: time, history,
    artifacts: [{ kind: "deliverable", path: "result.md", time }] });
  const recent = task("recent-delivery", now - 2000);
  const edited = task("older-delivery", now - 3000, [{ by: "user", at: new Date(now - 1000).toISOString() }]);
  const result = plugin.floatingSummary([edited, recent], new Map(), 30, now);
  assert.deepEqual(Array.from(result.acceptance, ({ task }) => task.id), ["recent-delivery", "older-delivery"]);
});

test("floating review and continuation use the delivery source while title modifiers use the primary session", async () => {
  const opened = [];
  const resources = [];
  const changes = [];
  const task = { id: "ready", title: "待验收任务", status: "in_progress", attention: "acceptance",
    primarySessionId: "primary", workspaceTitle: "工作区一", acceptanceCriteria: "检查报告",
    sessions: [{ id: "primary" }, { id: "delivery" }],
    artifacts: [{ kind: "deliverable", path: "report.md", sessionId: "delivery" }] };
  const { host, registrations } = loadClient({
    uiWorkspace: { openSession: (id) => opened.push(id) },
    sidebarRight: { screen: () => ({ sessionId: "delivery" }), openResource: (address) => resources.push(address) },
  }, {
    snapshot: { tasks: [task] },
    onState: (value) => changes.push(value),
  });
  host.openSurface("float");
  const entry = registrations.get("shell.overlay").render({}).children[0];
  const panel = entry.type(entry.props);
  const view = panel.type(panel.props);
  assert.match(renderedText(view), /工作区一.*report\.md.*检查报告/);
  const buttons = Array.from(elements(view)).filter((node) => node.type === "button");
  buttons.find((button) => renderedText(button) === "继续").props.onClick({ currentTarget: {} });
  const choice = changes.find((value) => value?.id === "ready");
  assert.equal(choice.sessionId, "delivery");
  buttons.find((button) => renderedText(button) === task.title).props.onClick({ metaKey: true });
  buttons.find((button) => renderedText(button) === task.title).props.onClick({ altKey: true });
  buttons.find((button) => renderedText(button) === "打开来源").props.onClick();
  assert.deepEqual(opened, ["primary", "primary", "delivery"]);
  await buttons.find((button) => renderedText(button) === "查看交付物").props.onClick();
  assert.deepEqual(resources, ["dsh-resource://file/session/delivery/report.md"]);
});

test("floating running preview shows three cards and offers to show the rest", () => {
  const tasks = Array.from({ length: 4 }, (_, id) => ({ id: String(id), title: `运行任务 ${id}`, primarySessionId: String(id), status: "in_progress" }));
  const statuses = new Map(tasks.map((task) => [task.id, { running: true }]));
  const changes = [];
  const { host, registrations } = loadClient({}, {
    snapshot: { tasks }, prefs: { version: 2, floatSummaries: ["running"] }, onState: (value) => changes.push(value),
  });
  host.openSurface("float");
  const entry = registrations.get("shell.overlay").render({ useSessionStatus: (select) => select(statuses) }).children[0];
  const withStatus = entry.type(entry.props);
  const panel = withStatus.type(withStatus.props);
  const view = panel.type(panel.props);
  assert.equal(Array.from(elements(view)).filter((node) => node.type === "article").length, 3);
  Array.from(elements(view)).find((node) => node.type === "button" && renderedText(node) === "查看全部 4 项").props.onClick();
  assert.deepEqual(changes, [4]);
});

test("floating pending requests and running actions open their exact sessions", () => {
  const task = { id: "task", title: "多会话任务", status: "in_progress", primarySessionId: "idle", sessions: [
    { id: "idle", title: "主会话" }, { id: "approval", title: "部署会话" },
    { id: "question", title: "设计会话" }, { id: "worker", title: "执行会话" },
  ] };
  const statuses = new Map([
    ["approval", { pendingInteraction: { kind: "approval" } }],
    ["question", { pendingInteraction: { kind: "question" } }],
    ["worker", { running: true }],
  ]);
  const opens = [];
  const buttonsFor = (category) => {
    const { host, registrations } = loadClient({ uiWorkspace: { openSession: (id) => opens.push(id) } }, {
      snapshot: { tasks: [task] }, prefs: { version: 2, floatSummaries: [category] },
    });
    host.openSurface("float");
    const entry = registrations.get("shell.overlay").render({ useSessionStatus: (select) => select(statuses) }).children[0];
    const withStatus = entry.type(entry.props);
    const panel = withStatus.type(withStatus.props);
    return [...elements(panel.type(panel.props))].filter((node) => node.type === "button");
  };
  const requests = buttonsFor("attention").filter((node) => node.props["aria-label"]?.startsWith("打开会话："));
  assert.equal(requests.length, 2);
  for (const button of requests) button.props.onClick();
  buttonsFor("running").find((button) => renderedText(button) === "打开运行会话").props.onClick();
  assert.deepEqual(opens, ["approval", "question", "worker"]);
});

test("the recent schedule keeps unfinished dated tasks even after the activity cutoff", () => {
  const lastActivityAt = Date.now() - 45 * 86_400_000;
  const { registrations } = loadClient({}, { view: "schedule", snapshot: { tasks: [
    { id: "planned", title: "跨月交付", status: "in_progress", origin: "auto", lastActivityAt, dueDate: "2099-01-01" },
    { id: "inactive", title: "旧的未排期任务", status: "in_progress", origin: "auto", lastActivityAt },
  ] } });
  const root = registrations.get("main").render({}).children[0];
  const schedule = [...elements(root.type(root.props))].find((node) => node.props?.mode === "schedule");
  assert.deepEqual(Array.from(schedule.props.tasks, ({ id }) => id), ["planned"]);
});

test("floating acceptance sends the task revision and refreshes a conflicting snapshot", async () => {
  const task = { id: "ready", title: "待验收任务", status: "in_progress", attention: "acceptance",
    acceptanceCriteria: "检查结果", updatedAt: "revision" };
  const requests = [];
  const changes = [];
  const { host, registrations } = loadClient({}, {
    snapshot: { tasks: [task] },
    onState: (value) => changes.push(value),
    fetch: async (url, options) => {
      requests.push([url.pathname, options.body ? JSON.parse(options.body) : null]);
      return options.body ? { ok: false, status: 409, json: async () => ({ ok: false, error: "revision-conflict" }) } :
        { ok: true, json: async () => ({ ok: true, tasks: [{ ...task, status: "done", completionBasis: "user" }] }) };
    },
  });
  host.openSurface("float");
  const entry = registrations.get("shell.overlay").render({}).children[0];
  const panel = entry.type(entry.props);
  const button = [...elements(panel.type(panel.props))].find((node) => node.type === "button" && renderedText(node) === "确认验收");
  await button.props.onClick();
  assert.deepEqual(requests, [
    ["/super-kanban/api/command", { op: "task.accept", payload: { id: "ready", expectedUpdatedAt: "revision" } }],
    ["/super-kanban/api/state", null],
  ]);
  assert.ok(changes.includes("任务已更新，请查看最新状态后再确认。"));
  assert.ok(changes.some((value) => value?.tasks?.[0]?.completionBasis === "user"));
});

test("mounted board surfaces share refresh notifications even for local changes without SSE", async () => {
  let opens = 0;
  let closes = 0;
  const events = new Map();
  const timers = new Map();
  const { plugin } = loadClient({}, { inspect: true,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), browser: {
    EventSource: class {
      constructor() { opens += 1; }
      addEventListener(name, listener) { events.set(name, listener); }
      close() { closes += 1; }
    },
    document: { baseURI: "http://plugin.local/", hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimeout(callback, delay) { const key = Symbol(); timers.set(key, { callback, delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
  } });
  const loads = [];
  const first = plugin.subscribeBoardRefresh(() => loads.push("page"));
  const second = plugin.subscribeBoardRefresh(() => loads.push("float"));
  assert.equal(opens, 1);
  events.get("changed")();
  const fireRefresh = () => {
    const [key, timer] = [...timers].find(([, timer]) => timer.delay === 180);
    timers.delete(key);
    timer.callback();
  };
  fireRefresh();
  assert.deepEqual(loads, ["page", "float"]);
  await plugin.command("task.move", { id: "one", status: "done" });
  fireRefresh();
  assert.deepEqual(loads, ["page", "float", "page", "float"]);
  first();
  assert.equal(closes, 0);
  second();
  assert.equal(closes, 1);
});

test("a workspace timeline includes custom project tasks and deduplicates shared source evidence", () => {
  const now = Date.now();
  const source = { time: now - 1000, seq: 8, sessionId: "exact-source", kind: "deliverable", text: "核验报告" };
  const tasks = [
    { id: "workspace-task", title: "工作区任务", workspaceId: "ws-one", projectId: "virtual", status: "in_progress", evidence: [source],
      artifacts: [{ kind: "deliverable", sessionId: "exact-source", seq: 8, time: now - 1000, path: "duplicate.md" },
        { kind: "deliverable", sessionId: "file-source", seq: 10, time: now - 3000, path: "checklist.md" }] },
    { id: "linked-task", title: "关联任务", workspaceId: "ws-one", status: "done", evidence: [source],
      history: [{ at: new Date(now - 2000).toISOString(), kind: "status", note: "确认验收" },
        { at: new Date(now - 4000).toISOString(), kind: "edit", note: "解决问题：补齐构建权限" }] },
    { id: "other", title: "其他工作区任务", workspaceId: "ws-two", projectId: "virtual", status: "done", evidence: [source] },
  ];
  const opened = [];
  const { registrations } = loadClient({ uiWorkspace: { openSession: (id) => opened.push(id) } }, {
    snapshot: { tasks, workspaces: [{ id: "ws-one", title: "工作区一" }], projects: [{ id: "virtual", name: "自建项目" }] },
    view: "timeline", filters: { workspace: "ws-one" },
  });
  const root = registrations.get("main").render({}).children[0];
  const timeline = [...elements(root.type(root.props))].find((node) => node.props?.range === "recent");
  const content = timeline.type(timeline.props);
  const body = renderedText(content);
  assert.match(body, /工作区一 · 时间线.*核验报告.*已验收.*关联任务/);
  assert.match(body, /checklist\.md.*解决问题：补齐构建权限/);
  assert.equal(body.match(/核验报告/g).length, 1);
  assert.doesNotMatch(body, /其他工作区任务|duplicate\.md/);
  [...elements(content)].filter((node) => node.type === "button" && renderedText(node) === "打开来源会话")
    .forEach((button) => button.props.onClick());
  assert.deepEqual(opened, ["exact-source", "file-source"]);
});

test("attention counts tasks and opens each exact pending session even when the primary is idle", () => {
  const opens = [];
  const task = { id: "task", title: "交付任务", status: "done", primarySessionId: "primary", sessions: [
    { id: "secondary", title: "发布核验" }, { id: "third", title: "方案讨论" }, { id: "secondary", title: "发布核验" },
  ] };
  const blocker = { id: "blocker", title: "高优先级依赖", status: "blocked", priority: "P0",
    relations: [{ type: "depends_on", taskId: "unfinished" }] };
  const { view, rows } = renderAttention([blocker, task], new Map([
    ["primary", { running: false }],
    ["secondary", { running: true, pendingInteraction: { kind: "approval" } }],
    ["third", { pendingInteraction: { kind: "plan-review" } }],
    ["unrelated", { pendingInteraction: { kind: "question" } }],
  ]), opens);
  const count = [...elements(view)].find((node) => node.props?.className === "sk-view-count");
  assert.equal(renderedText(count).trim(), "2");
  assert.match(renderedText(rows), /^交付任务.*高优先级依赖/);
  const buttons = [...elements(rows)].filter((node) => node.type === "button" && renderedText(node) === "打开会话");
  assert.deepEqual(buttons.map((node) => node.props["aria-label"]), ["打开会话：发布核验（待审批）", "打开会话：方案讨论（待审阅方案）"]);
  for (const node of buttons) node.props.onClick();
  assert.deepEqual(opens, ["secondary", "third"]);
  assert.doesNotMatch(renderedText(rows), /会话运行中/);
});

test("native running state clears stale review hints without including archived requests or historical issues on completed tasks", () => {
  const { rows } = renderAttention([
    { id: "running", title: "新一轮已启动", status: "in_progress", primarySessionId: "live", attention: "review" },
    { id: "archive", title: "已归档任务", status: "done", archived: true, primarySessionId: "archived" },
    { id: "done", title: "历史问题任务", status: "done", issues: [{ text: "历史错误", severity: "high" }] },
    { id: "idle", title: "已停止待确认", status: "in_progress", primarySessionId: "idle", attention: "review", sessionContext: { isLive: true } },
  ], new Map([
    ["live", { running: true }],
    ["archived", { pendingInteraction: { kind: "question" } }],
    ["idle", { running: false }],
  ]));
  const text = renderedText(rows);
  assert.match(text, /已停止待确认待确认进度/);
  assert.doesNotMatch(text, /新一轮已启动|已归档任务|历史问题任务|会话运行中/);
});

test("a session absent from the native snapshot stops showing a stale running marker", () => {
  const task = { id: "task", title: "正在处理", status: "in_progress", primarySessionId: "session",
    sessionContext: { isLive: true, lastActivityAt: Date.now() }, attention: "review" };
  const running = renderAttention([task], new Map([["session", { running: true }]]));
  assert.match(renderedText(running.view), /1 运行中/);
  const idle = renderAttention([task], new Map());
  assert.doesNotMatch(renderedText(idle.view), /1 运行中/);
  assert.match(renderedText(idle.rows), /待确认进度/);
});

test("supporting session activity pauses stale review hints while native prompts still surface", () => {
  const task = { id: "task", title: "联合交付", status: "in_progress", attention: "acceptance",
    sessions: [{ id: "primary", title: "主会话" }, { id: "support", title: "并行核验" }] };
  const statuses = new Map([["support", { running: true }]]);
  assert.doesNotMatch(renderedText(renderAttention([task], statuses).rows), /待验收/);
  statuses.set("support", { running: true, pendingInteraction: { kind: "question" } });
  assert.match(renderedText(renderAttention([task], statuses).rows), /待回答 · 并行核验/);
});

test("open tasks due today or earlier appear in the inbox, while completed tasks do not", () => {
  const { rows } = renderAttention([
    { id: "late", title: "要交付", status: "backlog", dueDate: "2000-01-01" },
    { id: "finished", title: "已交付", status: "done", dueDate: "2000-01-01" },
    { id: "future", title: "之后交付", status: "backlog", dueDate: "9999-12-31" },
  ]);
  assert.match(renderedText(rows), /要交付已逾期 · 2000-01-01/);
  assert.doesNotMatch(renderedText(rows), /已交付|之后交付/);
});

test("schedule groups open tasks by calendar date and keeps undated work collapsed", () => {
  const now = new Date();
  const days = (offset) => {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    return [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
  };
  const task = (id, title, offset) => ({ id, title, dueDate: offset === undefined ? null : days(offset), status: "backlog" });
  const tasks = [task("late", "明天以前", -1), task("today", "今天交付", 0), task("near", "近期安排", 7),
    task("later", "未来安排", 8), task("none", "还没排期"), { ...task("done", "已结束任务", 0), status: "done" }];
  const { registrations } = loadClient({}, { snapshot: { tasks }, view: "schedule" });
  const root = registrations.get("main").render({}).children[0];
  const collection = [...elements(root.type(root.props))].find((node) => node.props?.mode === "schedule");
  const schedule = collection.type(collection.props);
  const output = renderedText(schedule);
  assert.match(output, /已逾期1明天以前.*今天1今天交付.*未来 7 天1近期安排.*更晚1未来安排/);
  assert.doesNotMatch(output, /已结束任务/);
  const undated = [...elements(schedule)].find((node) => node.type === "details");
  assert.equal(undated.props.open, undefined);
  assert.match(renderedText(undated), /未设到期日1还没排期/);
});

test("concurrent draft edits only conflict on fields changed to different values", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const base = { name: "旧名", notes: "", dueDate: "", status: "backlog" };
  const result = plugin.draftChanges(base,
    { ...base, notes: "用户备注", dueDate: "2028-02-01", status: "in_progress" },
    { ...base, name: "新名", notes: "另一处备注", status: "in_progress" });
  assert.deepEqual(Array.from(result.conflicts), ["notes"]);
  assert.deepEqual({ ...result.patch }, { notes: "用户备注", dueDate: "2028-02-01" });
});

test("a successful write starts a fresh shared state request and a late older response is discarded", async () => {
  const pending = [];
  const updates = [];
  const { plugin } = loadClient({}, { inspect: true, onState: (value) => { if (value?.tasks) updates.push(value.tasks[0].title); },
    fetch(url) {
      if (url.pathname.endsWith("/command")) return Promise.resolve(Response.json({ ok: true, data: {} }));
      const request = Promise.withResolvers();
      pending.push(request);
      return request.promise;
    } });
  const board = plugin.useBoardData();
  const sibling = plugin.useBoardData();
  const before = board.reload(true);
  await plugin.command("project.update", { id: "project" });
  const after = board.reload(true);
  const shared = sibling.reload(true);
  assert.equal(pending.length, 2);
  pending[1].resolve(Response.json({ ok: true, tasks: [{ id: "t", title: "新状态", updatedAt: "new" }] }));
  await Promise.all([after, shared]);
  pending[0].resolve(Response.json({ ok: true, tasks: [{ id: "t", title: "旧状态", updatedAt: "old" }] }));
  assert.equal(await before, null);
  assert.deepEqual(updates, ["新状态", "新状态"]);
});

test("board snapshots reconcile a local model update even after a switch back elsewhere", async () => {
  const updates = [];
  const route = { ok: true, provider: "demo", model: "previous" };
  const { plugin } = loadClient({}, { inspect: true,
    fetch: async () => Response.json({ ok: true, tasks: [], aiRoute: route }),
    onState: (value) => { if (value?.aiRoute) updates.push(value.aiRoute.model); } });
  const board = plugin.useBoardData();
  await board.reload(true);
  board.setData((state) => ({ ...state, aiRoute: { ...route, model: "local-choice" } }));
  await board.reload(true);
  assert.deepEqual(updates, ["previous", "previous"]);
});

test("quick chat only supplies recent contiguous turns from the selected model", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const route = { ok: true, provider: "demo", model: "selected" };
  const turns = Array.from({ length: 6 }, (_, index) => ({ ...route, input: String(index), answer: "answer" }));
  assert.deepEqual(Array.from(plugin.chatContext(turns, route).turns, ({ input }) => input), ["2", "3", "4", "5"]);
  turns[4].provider = "another-provider";
  assert.deepEqual(Array.from(plugin.chatContext(turns, route).turns, ({ input }) => input), ["5"]);
  assert.equal(plugin.chatContext(turns, { ...route, model: "different" }), undefined);
  const large = turns.map((turn) => ({ ...turn, provider: route.provider, answer: "x".repeat(12_000) }));
  assert.equal(plugin.chatContext(large, route).turns.length, 1);
});

test("without native status, the inbox distinguishes usable deliverables from unconfirmed progress", () => {
  const { rows } = renderAttention([
    { id: "review", title: "已有交付", status: "in_progress", attention: "review", artifacts: [{ name: "验证报告", path: "report.md", kind: "deliverable" }] },
    { id: "progress", title: "仅有历史文件", status: "in_progress", attention: "review", artifacts: [{ name: "旧报告", path: "old.md", kind: "deliverable", missing: true }] },
  ]);
  assert.match(renderedText(rows), /已有交付待验收 · 验证报告/);
  assert.match(renderedText(rows), /仅有历史文件待确认进度/);
  assert.doesNotMatch(renderedText(rows), /打开会话/);
});

test("file overlap requires two actually running sessions and clears when either starts waiting", () => {
  const tasks = ["one", "two"].map((id) => ({ id, title: id, status: "in_progress", primarySessionId: id, sessionContext: { isLive: true } }));
  const overlap = [{ path: "file.md", sessions: tasks.map(({ id }) => ({ id, at: Date.now(), seq: 3 })) }];
  const statuses = new Map(tasks.map(({ id }) => [id, { running: true }]));
  assert.match(renderedText(renderAttention(tasks, statuses, [], overlap).rows), /可能同时修改 · file\.md/);
  statuses.set("two", { running: true, pendingInteraction: { kind: "approval" } });
  const waiting = renderedText(renderAttention(tasks, statuses, [], overlap).rows);
  assert.doesNotMatch(waiting, /可能同时修改/);
  assert.match(waiting, /待审批/);
  assert.doesNotMatch(renderedText(renderAttention(tasks, null, [], overlap).rows), /可能同时修改/);
});

test("the inbox distinguishes a failed turn from a running retry", () => {
  const task = { id: "failure", title: "回归测试", status: "blocked", primarySessionId: "test-session",
    sessionContext: { lastTurnEnd: "error" }, issues: [{ text: "测试命令退出", severity: "high" }] };
  assert.match(renderedText(renderAttention([task]).rows), /执行失败 · 测试命令退出/);
  const retry = renderAttention([task], new Map([["test-session", { running: true }]]));
  assert.doesNotMatch(renderedText(retry.rows), /执行失败/);
  assert.match(renderedText(retry.rows), /会话运行中/);
});

/* ------------------------------------------------------------------ */
/* Review strip pinned above the launcher                              */
/* ------------------------------------------------------------------ */

test("folder badges keep a stable colour and a readable initial", () => {
  const { plugin } = loadClient({}, { inspect: true });
  assert.equal(plugin.folderGlyph("产品文档"), "产");
  assert.equal(plugin.folderGlyph("data-pipeline"), "D");
  assert.equal(plugin.folderGlyph(""), "任");
  assert.equal(plugin.folderColor("ws_alpha"), plugin.folderColor("ws_alpha"));
  assert.match(plugin.folderColor("ws_alpha"), /^#[0-9A-F]{6}$/);
  const spread = new Set(Array.from({ length: 12 }, (_, index) => plugin.folderColor(`ws_${index}`)));
  assert.ok(spread.size >= 5, "a handful of workspaces should not collapse onto one colour");
});

test("a review card stays until approved even if the session runs again", () => {
  const { plugin } = loadClient({}, { inspect: true });
  const now = Date.now();
  const task = (id, fields = {}) => ({ id, title: id, status: "in_progress", primarySessionId: id, origin: "auto",
    lastActivityAt: now - 1000, ...fields });
  const items = [
    task("running", { review: { at: now - 30000, sessionId: "running", seq: 3 } }),
    task("pending", { review: { at: now - 20000, sessionId: "pending", seq: 4 } }),
    task("review-old", { review: { at: now - 40000, sessionId: "review-old", seq: 5, kind: "completed" } }),
    task("review-new", { status: "done", completionBasis: "session_todos", review: { at: now - 10000, sessionId: "review-new", seq: 6 } }),
    task("accepted", { status: "done", completionBasis: "user", review: { at: now - 5000, sessionId: "accepted", seq: 7 } }),
    task("archived", { archived: true, review: { at: now - 5000, sessionId: "archived", seq: 8 } }),
  ];
  const statuses = new Map([
    ["running", { running: true }],
    ["pending", { pendingInteraction: { kind: "approval" } }],
  ]);
  const rows = plugin.floatingReview(items, statuses, now);
  // A new turn or a pending request does not retract the finished-turn card;
  // only approval (done + user) or archival keeps it off the strip.
  assert.deepEqual(Array.from(rows, (row) => [row.kind, row.task.id]), [
    ["review", "review-new"], ["review", "pending"], ["review", "running"], ["review", "review-old"],
  ]);
  assert.deepEqual(Array.from(rows, (row) => row.sessionId),
    ["review-new", "pending", "running", "review-old"]);
  assert.ok(!rows.some((row) => ["accepted", "archived"].includes(row.task.id)));
  const running = rows.find((row) => row.task.id === "running").task;
  assert.equal(plugin.canAcceptTask(running), true, "a finished turn can be approved while a new turn runs");
  const waiting = rows.find((row) => row.task.id === "pending").task;
  assert.equal(plugin.canAcceptTask(waiting), false, "a pending interaction still owns the accept guard");
});

test("a finished turn stays pinned until its hover check mark is clicked", async () => {
  const now = Date.now();
  const task = { id: "weekly", title: "生成本周周报", status: "done", completionBasis: "session_todos",
    primarySessionId: "source", workspaceTitle: "数据管道", updatedAt: "rev-1", lastActivityAt: now - 2000,
    review: { at: now - 30_000, sessionId: "source", seq: 12, kind: "completed" } };
  const requests = [];
  const opens = [];
  const { host, registrations } = loadClient({ uiWorkspace: { openSession: (id) => opens.push(id) } }, {
    snapshot: { tasks: [task] },
    fetch: async (url, options) => {
      requests.push([url.pathname, options.body ? JSON.parse(options.body) : null]);
      return options.body
        ? { ok: true, json: async () => ({ ok: true, data: { ...task, status: "done", completionBasis: "user" } }) }
        : { ok: true, json: async () => ({ ok: true, tasks: [{ ...task, completionBasis: "user" }] }) };
    },
  });
  const entry = registrations.get("shell.overlay").render({}).children[0];
  const panel = entry.type(entry.props);
  const rendered = panel.type(panel.props);
  const stripElement = [...elements(rendered)].find((node) => node.type?.name === "ReviewStrip");
  assert.ok(stripElement, "the strip is pinned above the launcher");
  const strip = stripElement.type(stripElement.props);
  assert.match(renderedText(strip), /生成本周周报.*数据管道 · (刚刚|\d+ 分钟前)/);
  assert.doesNotMatch(renderedText(strip), /待审批|已完成|本轮结束/);
  const check = [...elements(strip)].find((node) => node.props?.["aria-label"] === "确认完成：生成本周周报");
  assert.ok(check, "the check mark is present (revealed by hover in CSS)");
  await check.props.onClick({ stopPropagation() {} });
  assert.deepEqual(requests[0],
    ["/super-kanban/api/command", { op: "task.accept", payload: { id: "weekly", expectedUpdatedAt: "rev-1" } }]);
  const open = [...elements(strip)].find((node) => node.props?.["aria-label"] === "打开会话：生成本周周报");
  open.props.onClick();
  assert.deepEqual(opens, ["source"]);
});

test("more than three pinned cards collapse behind a count and expand in place", () => {
  const now = Date.now();
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: `t-${index}`, title: `任务 ${index}`, status: "in_progress", primarySessionId: `s-${index}`,
    lastActivityAt: now - index * 1000, review: { at: now - index * 1000, sessionId: `s-${index}`, seq: index + 1 },
  }));
  const { registrations } = loadClient({}, { snapshot: { tasks } });
  const entry = registrations.get("shell.overlay").render({}).children[0];
  const panel = entry.type(entry.props);
  const stripOf = (node) => {
    const element = [...elements(node)].find((item) => item.type?.name === "ReviewStrip");
    return element ? element.type(element.props) : null;
  };
  const cards = (node) => [...elements(node || [])].filter((item) => item.props?.className?.startsWith?.("sk-pin-card"));
  const view = panel.type(panel.props);
  const strip = stripOf(view);
  assert.equal(cards(strip).length, 3);
  assert.ok([...elements(strip)].some((node) => node.type === "button" && renderedText(node) === "还有 2 项"));
  const stripElement = [...elements(view)].find((item) => item.type?.name === "ReviewStrip");
  const expanded = stripElement.type({ ...stripElement.props, expanded: true });
  assert.equal(cards(expanded).length, 5);
  assert.ok([...elements(expanded)].some((node) => renderedText(node) === "收起"));
});
