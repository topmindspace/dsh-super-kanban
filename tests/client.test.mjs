import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadClient(services, { snapshot, view = "attention", clipboard } = {}) {
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
        return [value, () => {}];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
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
    localStorage: { getItem: (key) => snapshot && key === "dsh-super-kanban:view:page" ? view : null },
    navigator: { clipboard },
    AbortSignal,
    setTimeout,
  };
  vm.runInNewContext(source, context, { filename: "client.js" });
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
  return { registrations, host, seedNextState: (value, initial = null) => { nextState = { initial, value }; } };
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
  assert.ok([...elements(toolbar)].some((node) => node.props?.["aria-label"] === "按工作区筛选"));
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
  header.render({ sessionId: "selected-session" }).props.onClick();
  assert.deepEqual(opens, [["super-kanban", "selected-session"]]);
  const sidebar = registrations.get("sidebar.right.pane.tab");
  const view = sidebar.render({ useTabInfo: () => ({ tab: { navigation: { params: { sessionId: "selected-session" } } } }) });
  assert.equal(view.children[0].props.sessionId, "selected-session");
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
