import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadClient(services, { snapshot } = {}) {
  const registrations = new Map();
  let initialSnapshot = snapshot;
  const React = {
    Component: class {},
    createElement(type, props, ...children) { return { type, props, children }; },
    useState(initial) {
      // Seed the initial /state result without mounting polling or DOM effects.
      if (initial === null && initialSnapshot) {
        const value = initialSnapshot;
        initialSnapshot = null;
        return [value, () => {}];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useRef: (current) => ({ current }),
    useEffect() {},
    useMemo: (calculate) => calculate(),
    useCallback: (callback) => callback,
  };
  let plugin;
  const context = {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => React); } } },
    localStorage: { getItem: (key) => snapshot && key === "dsh-super-kanban:view:page" ? "attention" : null },
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
  return { registrations, host };
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
