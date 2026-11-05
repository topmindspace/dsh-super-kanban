# 接口契约

本文是 **Host 半边**（`index.mjs` / `server/**`）与 **浏览器半边**（`client.js`）之间的唯一接口约定，同时供第三方集成参考。改动契约需同步更新本文件。

## 0. 运行形态

- DSH 插件包，通过 profile 的 `dsh.profile.bundles` 加载；`cordis.patch.yml` 插入 host 插件行。
- Host 入口 `index.mjs` 只做路由挂载与 owner 鉴权，实现集中在 `server/service.mjs`。
- 浏览器半边是单文件 bundle（无构建），由 DSH 模块加载器加载。
- 数据目录：`$DSH_HOME/storages/super-kanban/`（`state.json`、`sessions-cache.json`、`backups/`）。
- 数据源（只读）：`$DSH_HOME/storages/workspace.json`、`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd`、`$DSH_HOME/storages/session_projcache/sessions/<session>.json`。

## 1. 状态与优先级

```ts
type Status = "backlog" | "in_progress" | "blocked" | "done";
type Priority = "P0" | "P1" | "P2" | "P3";
```

看板四列与状态一一对应：待办 / 进行中 / 受阻 / 已完成。

## 2. Task 数据模型（v2）

```jsonc
{
  "id": "t_xxxxxxxx",                    // 稳定 ID；自动任务以 primarySessionId 为种子
  "title": "示例任务标题",
  "goal": { "text": "1-3 句任务目标", "status": "active|done|none", "source": "session|task" },
  "status": "in_progress",
  "progress": 63,                        // 0-100；有 subtasks 时 = round(done/total*100)
  "priority": "P1",
  "tags": ["示例标签"],
  "origin": "auto",                      // auto | manual | auto+edited
  "workspaceId": "workspace-id",
  "workspaceTitle": "示例工作区",
  "workspacePath": "/path/to/workspace",
  "sessions": [                          // 来源会话（≥1）
    { "id": "session-...", "title": "来源会话标题", "seqEnd": 128, "evidenceCount": 6 }
  ],
  "primarySessionId": "session-...",
  "issues": [                            // 问题 / 风险（≤5 条，≤160 字）
    { "id": "i_x", "text": "问题描述", "severity": "high|medium|low", "sessionId": "session-...", "seq": 210|null }
  ],
  "nextSteps": ["下一步动作"],            // ≤5 条，≤160 字
  "milestones": [                        // v1 遗留字段，兼容读取（≤20 条，≤120 字）
    { "id": "m_x", "text": "里程碑", "done": true, "sessionId": "session-...", "seq": 170|null }
  ],
  "evidence": [                          // ≤8 条，按需截断
    {
      "id": "e_x",
      "kind": "user|assistant|todo|tool|artifact|error|deliverable",
      "text": "摘要（≤200 字）",
      "quote": "原文片段（≤160 字）",
      "seq": 8|null,                     // 无法在时间线上定位时为 null（永不为 0）
      "time": 1793694532136,
      "sessionId": "session-...",
      "sessionTitle": "来源会话标题"
    }
  ],
  "ai": {                                // 最近一次智能研判
    "analyzedAt": "2026-11-04T02:00:00.000Z",
    "model": "deepseek-flash",
    "confidence": 0.82,
    "reason": "一句话理由",
    "engine": "llm|rules"
  },
  "lockedFields": ["status"],            // 用户手改过的字段，AI 不再覆盖
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "lastActivityAt": 1793694532136,
  "archived": false,
  "history": [                           // ≤20 条；from/to 仅状态变化类记录才有
    { "at": "ISO", "kind": "create|status|progress|edit|archive|merge|ai",
      "from": "backlog", "to": "in_progress", "by": "ai|user", "note": "说明" }
  ],

  // v2 新增字段
  "keyFacts": [                          // ≤6 条，≤60 字
    { "id": "k_x", "text": "关键事实", "kind": "status|progress|issue|decision|artifact|goal",
      "sessionId": "session-...", "seq": 0|null }
  ],
  "subtasks": [                          // ≤12 条，≤60 字
    { "id": "s_x", "text": "子任务", "done": false, "source": "ai|todo|manual", "seq": 0|null }
  ],
  "artifacts": [                         // ≤6 条；name ≤80 字
    { "id": "a_x", "name": "README.md", "path": "workspace 相对路径",
      "absPath": "/abs/path/README.md", "sessionId": "session-...", "seq": 0|null, "time": 0,
      "description": "交付说明，可为空字符串" }
  ],
  "sessionContext": {
    "sessionId": "session-...",
    "title": "来源会话标题",
    "isLive": false,
    "turnCount": 2,
    "lastTurnEnd": "completed|interrupted|error|null",
    "lastActivityAt": 1793694532136,
    "todoTotal": 8,
    "todoDone": 5
  }
}
```

说明：

- `progress`：有 subtasks 时由子任务完成率推导，否则沿用研判结果。
- `goal.text`：优先取 DSH Session Goal，其次取任务目标。
- `seq` 是「证据时间线引用」：`evidence` / `issues` / `keyFacts` / `subtasks` / `milestones` 上可能为 `null`
  （该条内容无法定位到具体会话事件时；**永不为 0**）；带 `time` 的条目（evidence / artifacts）此时 `time` 为 0。
  客户端只在 `seq` 有效时显示 `#N` 徽标。
- `ai`：AI/规则每次研判都会写入（规则引擎为 `engine:"rules"`）；`confidence` 为 0–1，`analyzedAt` 为研判时间。
  详情抽屉据此展示研判块；当来源会话在研判之后又有新活动——`sessionContext.lastActivityAt`（缺失时取
  `task.lastActivityAt`）晚于 `ai.analyzedAt + 5 分钟`——时提示「可能已过期」，没有新活动时旧研判仍然有效。
- v1 → v2 迁移：`keyFacts ← evidence 前 3`、`subtasks ← milestones`、`artifacts = []`、`sessionContext ← 首个 session`、`evidence` 截断 8 条。

### 2.1 文本与裁剪上限（Host 单一来源）

`server/store.mjs` 导出的 `TEXT_LIMITS` 是持久化的唯一上限来源；`task.create` / `task.update` /
加载与保存都会按同一套常量截断，浏览器表单的 `maxLength` 必须与之一致（避免输入被静默截断）。

| 字段 | 上限 | 字段 | 上限 |
| --- | --- | --- | --- |
| `title` | 80 字 | `goal` | 280 字 |
| `tags` | ≤4 个，每个 ≤12 字 | `keyFacts` | ≤6 条，每条 ≤60 字 |
| `subtasks` | ≤12 条，每条 ≤60 字 | `issues` | ≤5 条，每条 ≤160 字 |
| `nextSteps` | ≤5 条，每条 ≤160 字 | `milestones` | ≤20 条，每条 ≤120 字 |
| `evidence` | ≤8 条，`text` ≤200 字、`quote` ≤160 字 | `artifacts` | ≤6 条，`name` ≤80 字 |
| `history` | ≤20 条 | `sessions` | 任务的来源会话列表（自动任务通常 1 个） |

> 设置项 `maxTasksPerSession`（默认 3）限制单个会话在一次分析中最多产出多少张自动任务卡，不是 Task 字段上限。

## 3. HTTP API

所有路由前缀 `/super-kanban/api`，同源请求（`credentials: "same-origin"`），由 Host 侧 `connection.admit` 完成鉴权（非 owner 返回 403）。错误响应统一：

```json
{ "ok": false, "error": "code", "message": "说明" }
```

### GET `/ping`

轻量存活探测（开发/脚本用，返回体不含任何敏感数据）：

```jsonc
{ "ok": true, "plugin": "dsh-super-kanban", "dshHome": "/path/to/DSH_HOME", "version": 2, "time": "ISO" }
```

### GET `/state`

```jsonc
{
  "ok": true,
  "generatedAt": "ISO",
  "tasks": [ /* 含归档任务，客户端按 archived 过滤 */ ],
  "stats": {
    "total": 10, "archived": 0,
    "byStatus": { "backlog": 2, "in_progress": 3, "blocked": 1, "done": 4 },
    "doneRate": 0.4,
    "activeSessions": 4,
    "avgProgress": 55,
    "aiAnalyzed": 10,
    "issues": 3
  },
  "activity": [ { "day": "2026-11-01", "count": 42 } ],   // 最近 14 天，旧→新
  "workspaces": [
    { "id": "workspace-id", "title": "示例工作区", "path": "/path/to/workspace",
      "sessionCount": 3, "included": true, "lastActivityAt": 1793694532136,
      "source": "registry|sessions|synthetic" }   // 工作区来源；registry=workspace.json
  ],
  "scan": {
    "state": "idle|running|done|error",
    "startedAt": "ISO|null", "finishedAt": "ISO|null",
    "processed": 7, "total": 10,
    "newTasks": 0, "updatedTasks": 2, "aiCalls": 3, "tokens": 5120,
    "message": "扫描完成：10/10 个会话 · AI 3 次/5120 tokens",  // 人类可读结论，见下
    "error": null
  },
  "settings": {
    "autoScan": true,
    "scanIntervalSeconds": 120,             // 自动增量扫描间隔
    "aiEnabled": true,                      // false 时扫描按钮显示「扫描（仅规则）」
    "model": "deepseek-flash",
    "initialDays": 30,
    "maxTasksPerSession": 3,                // 单会话单次扫描最多产出的自动卡数
    "excludeWorkspaces": [],
    "lastScanAt": "ISO|null",
    "maxAiCallsPerScan": 40,
    "dailyAiCallLimit": 150
  },
  "usage": {
    "date": "YYYY-MM-DD",                   // 用户本地日历日（不是 UTC 日）
    "calls": 3,
    "tokens": 5120,
    "lastScan": { "calls": 0, "tokens": 0, "durationMs": 0, "digestBytesAvg": 0 }
  }
}
```

`scan.message` 是**持久化的人类可读扫描结论**，客户端统计行直接展示（不再自行拼接）。典型内容：

- `扫描完成：28/28 个会话 · 本次无 AI 调用`（AI 开启但本次未调用；AI 关闭时只有前半段）；
- `扫描完成：28/28 个会话 · AI 3 次/5120 tokens · 低价值跳过 2 · 合并重复卡 1`；
- `扫描完成：… · 预算已用完（150/150）其余仅规则`（每日预算耗尽后降级）；
- `扫描失败：<错误信息>` / `扫描已取消（已完成部分保留）`；
- 扫描过程中的瞬时提示（如 `未找到账号凭证，使用规则引擎分析`、`AI 研判 N 个会话（预算 M）…`）也会写入
  `scan.message`（SSE / 轮询可见），但界面的统计行在运行中只显示进度，结束后展示最终结论。

`usage.date` 跟随用户本地日历日：每日 AI 调用计数与 `dailyAiCallLimit` 在**本地午夜**滚动重置；
设置页显示的「今日」数字与预算判断都使用该字段。

### POST `/command`

请求：`{ "op": "<op>", "payload": { ... } }`；响应：`{ "ok": true, "data": ... }`。扫描触发为 202 语义但返回 HTTP 200。
请求体不是 JSON 对象、`payload` 不是对象或 `op` 未知时返回 `400`（`invalid-input` / `unknown-op`）。

| op | payload | 说明 |
| --- | --- | --- |
| `task.create` | `{title, goal?, status?, priority?, tags?, workspaceId?, sessionId?, progress?}` | 手动建卡 |
| `task.update` | `{id, patch: {...}, lockFields?: string[]}` | 用户编辑；`lockFields` 中字段加锁 |
| `task.move` | `{id, status, index?}` | 拖拽换列 |
| `task.archive` | `{id, archived: boolean}` | 归档 / 恢复 |
| `task.delete` | `{id}` | 删除（自动任务也允许，记入历史） |
| `task.relink` | `{id, sessionIds: string[]}` | 手动改来源会话（**Host 接口已支持，当前 UI 未暴露**，保留给后续版本） |
| `task.unlock` | `{id, fields?: string[]}` | 解锁字段，交还 AI 维护 |
| `task.analyze` | `{id}` | 立即对该任务来源会话重跑研判（扫描进行中返回 `409 busy`；AI 不可用/超预算自动降级规则） |
| `task.continuePrompt` | `{id, target: "session"\|"newSession"}` | 生成「继续此任务」提示词（本地模板，0 token） |
| `task.polishPrompt` | `{id, prompt}` | AI 润色提示词（耗 1 次调用，不可用时原样返回） |
| `task.importTodos` | `{id}` | 从来源会话导入待办为子任务 |
| `task.toggleSubtask` | `{id, subtaskId, done}` | 勾选子任务 |
| `task.addSubtask` | `{id, text}` | 新增子任务 |
| `task.removeSubtask` | `{id, subtaskId}` | 删除子任务 |
| `session.ignore` / `session.unignore` | `{sessionId}` | 忽略会话：不再自动建卡（**Host 接口已支持，当前 UI 未暴露**） |
| `settings.update` | `{patch: {...settings}}` | 更新设置 |
| `scan.start` | `{mode: "incremental"\|"full"}` | 触发扫描（运行中返回 busy） |
| `scan.cancel` | `{}` | 取消扫描 |

`op` 必须是命令表自身的属性：`"constructor"`、`"__proto__"` 等非自有属性名一律返回 `400 unknown-op`。

`task.analyze` 返回（客户端据此提示引擎与本次消耗）：

```jsonc
{ "task": { /* 更新后的 Task */ }, "engine": "llm|rules", "aiCalls": 1, "tokens": 3120,
  "sessions": 1, "message": "AI 研判完成|今日 AI 预算已用完，已用规则引擎重判|AI 不可用或未启用，已用规则引擎重判" }
```

`task.continuePrompt` 返回：

```jsonc
{ "prompt": "结构化的继续任务提示词", "target": "session", "sessionId": "session-...",
  "workspaceId": "workspace-id", "workspaceTitle": "示例工作区", "isLive": false }
```

### GET `/session/:sessionId`

可选 query：`?after=<seq>&limit=<n>`（默认 200，最大 500；非数字/非正数 `limit` 回退为 200）。
`sessionId` 为不透明查找键：畸形百分号编码、包含路径分隔符或超过 200 字符时返回 `400 invalid-input`；
格式合法但不存在时返回 `404 session-not-found`。

```jsonc
{
  "ok": true,
  "session": {
    "id": "session-...", "title": "会话标题",
    "workspaceId": "workspace-id", "workspaceTitle": "示例工作区",
    "createdAt": 1793694532120, "lastActivityAt": 1793694767953,
    "turns": 2, "eventCount": 128, "status": "completed",
    "path": ".../session.v4.jsonl.zstd",
    "cwd": "/path/to/workspace",           // 会话工作目录
    "parentSession": "session-...|null",   // 子代理会话的父会话
    "delegationDepth": 0,                  // 委派层级（主会话为 0）
    "isLive": false,                       // 是否仍在进行中的 turn
    "goalText": "DSH Session Goal 文本|null", "goalStatus": "active|done|null",
    "todos": [ { "content": "待办内容", "status": "pending|in_progress|completed" } ],
    "todoTotal": 8, "todoDone": 5
  },
  "events": [
    { "seq": 8, "time": 1793694532136, "kind": "user|assistant|todo|tool|error|deliverable",
      "role": "user|assistant|tool|system", "text": "≤2000 字",
      "toolName": "bash|null",
      "todos": [ { "content": "…", "status": "pending" } ],
      "isError": false }
  ]
}
```

### GET `/export`

`Content-Disposition: attachment; filename="super-kanban-YYYYMMDD.json"`，返回完整 state + sessions-cache 摘要（**不含 token / 凭证**）。

> 浏览器半导出时通过 `fetch("/export")` 取回同一份 JSON，另存为 `super-kanban-YYYY-MM-DD.json`（ISO 日期，如 `super-kanban-2026-11-05.json`）；HTTP 头里的文件名只用于直接下载该路由的客户端。

### GET `/events`（SSE，可选）

```
event: scan
data: {"state":"running","processed":3,"total":10,"message":"…"}

event: changed
data: {"reason":"scan"|"task"|"settings","tasksChanged":2}
```

客户端可降级为每 4 秒轮询 `/state`。

## 4. 浏览器半边要求

- 注册 `main` 面板（key=`super-kanban`）与 `sidebar.panellist` 入口（id=`super-kanban`，label「任务看板」）。
- 注册右侧栏 tab 类型与 `sidebar.right.pane.tab` slot；注册会话头部快捷入口（`conversation.session.header.utilities`）。
- 打开会话使用 `ctx.get("uiWorkspace")?.openSession(sessionId)`。
- 只允许同源 fetch；不得访问外部网络、不得加载外部字体 / 图片。
- 样式只使用 DSH 设计 token（`--dsw-alias-*` 等）与插件自有 CSS 变量，深浅色自适应。
- 轮询 `/state`（4 秒，页面隐藏时暂停）；扫描中加快刷新；SSE 可选。
- 所有写操作乐观更新 + 失败回滚 + 轻量 toast。
- 抽屉在存在 `task.ai` 时展示研判块（引擎 `AI 研判`/`规则推断`、模型、置信度、最近研判时间、理由）；
  当来源会话在研判后又有新活动（`sessionContext.lastActivityAt`，缺失时取 `task.lastActivityAt`，
  晚于 `ai.analyzedAt + 5 分钟`）时标记「可能已过期」，没有新活动时旧研判仍然有效。用户从抽屉
  「⋯」→「重新研判」调用 `task.analyze`。
- 用户正在编辑字段时，后台轮询 / 扫描 / 重新研判不得丢弃草稿；展示一条「后台已更新；保存将覆盖 AI 的新结果」提醒。
- 打开会话 / 产物 / 终端后自动收起抽屉。
- 页头按钮的布局与图标（如设置常驻、右侧栏入口常驻、「⋯」仅导出 JSON）属于浏览器半实现细节，不在本契约内；契约只约束注册项、数据交互与行为约定。

### 与 DSH 服务的联动约定

```js
// 打开已有会话
ctx.get("uiWorkspace").openSession(sessionId);
// 新建会话并预置提示词
ctx.get("uiWorkspace").startSession(workspaceId, { prompt });
// 把提示词放入输入框（不发送）
const binding = ctx.get("sessions").binding(sessionId);   // 可轮询最多 ~3s
ctx.get("conversation").input.requestDraftInitialization(binding, {
  prompt, whenDraftExists: "replace",                    // 或 "keep"
});                                                      // "applied" | "preserved" | "blocked"
// 产物在 DSH 文档预览中打开
ctx.get("sidebarRight").openResource(
  `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split("/").map(encodeURIComponent).join("/")}`,
);
// 右侧栏终端 / 全屏
ctx.get("sidebarRight").openTab("terminal", { params: {} });
const target = ctx.get("sidebarRight").focusedTarget(el);
if (target) ctx.get("sidebarRight").toggleFullscreen(target);
```

## 5. 存储上限、Token 与 AI 信任规则

- 存储裁剪上限见 [§2.1](#21-文本与裁剪上限host-单一来源)；`truncateTask` 在加载与保存时都执行同一套上限。
- 会话摘要 digest ≤1.5KB/会话；LLM 输出 ≤2200 tokens；每个会话最多产出 `maxTasksPerSession`（默认 3）个任务。
- 重新研判门控：用户消息数增加 **或** 最后 turn 结束原因变化 **或** 首次 **或** 手动触发；活跃会话同一 turn 内不重复；同一会话最小分析间隔 180 秒。
- 单次扫描 AI 调用 ≤ `maxAiCallsPerScan`（5–40），每日 ≤ `dailyAiCallLimit`（10–500）；超限降级规则引擎并在 `scan.message` 说明。
- **用户工作优先（trust rule）**：AI/规则给出 `done`，但任务仍有未完成的 `source:"manual"` 子任务或
  `lockedFields` 含 `subtasks` 的清单时，Host 会把状态降级为 `in_progress` 并追加一条 `history` 说明
  （「…建议完成，但仍有 N 个手动子任务未完成；保持进行中…」）。用户锁定的 `status` 优先，不会被覆盖；
  状态为 `done` 时**生成类**子任务（`source` 非 `manual`）自动勾选完成，`manual` 子任务不动；
  用户取消勾选子任务会让 `done` 卡回到 `in_progress`（写历史）。

## 6. 版本与迁移

- `state.version = 2`（当前）。仓库加载 v1 状态时自动迁移并落盘；迁移失败会备份原文件并重建空状态，不阻塞插件启动。
- 新增字段必须保持向后兼容：客户端对缺失字段使用默认值；服务端对未知字段宽容处理。
- 运行时版本由 DSH profile 的 `node_modules/dsh-super-kanban` 决定；profile 依赖规格（精确版本 / 范围 / `link:`）影响升级行为，见 [INSTALL.md](INSTALL.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
- 契约变更需同步更新：本文件、`tests/` 中的契约相关断言、以及 CHANGELOG。

## 7. 验收标准

1. 打开「任务看板」主面板：统计行 + 四列看板 + 工作区筛选 + 搜索可见。
2. 自动发现初始扫描范围内的会话并生成 / 更新任务；卡片显示目标、进度、来源工作区、最近活动时间、问题标记。
3. 点击卡片打开抽屉：AI 研判块（引擎/模型/置信度/时间/理由）、关键事实、子任务、问题 / 下一步、会话联动、产物、证据时间线；「⋯」→「重新研判」只重判该卡。
4. 手动：新建、编辑、拖拽换列、归档、删除、锁定字段（AI 不覆盖）、设置（AI 开关 / 间隔 / 排除工作区 / 预算）。
5. 自动扫描：启动后数秒内首扫；之后按间隔增量扫描；统计行常驻显示上次扫描结论（完成 / 失败+重试 / 运行中+取消），结果落盘可追溯。
6. 视觉：与 DSH 深浅色主题一致、无横向溢出、空态 / 加载态完整、1680px 与 1280px 宽度均可用。
7. 会话联动：「继续此任务」默认 0 token；提示词放入输入框但不自动发送；打开会话 / 产物 / 终端后抽屉收起。
8. 控制台无 error / 404；AI 不可用时看板仍可用（规则引擎）。
