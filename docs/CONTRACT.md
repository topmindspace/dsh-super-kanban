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
  "issues": [                            // 问题 / 风险
    { "id": "i_x", "text": "问题描述", "severity": "high|medium|low", "sessionId": "session-...", "seq": 210 }
  ],
  "nextSteps": ["下一步动作"],
  "milestones": [                        // v1 遗留字段，兼容读取
    { "id": "m_x", "text": "里程碑", "done": true, "sessionId": "session-...", "seq": 170 }
  ],
  "evidence": [                          // ≤8 条，按需截断
    {
      "id": "e_x",
      "kind": "user|assistant|todo|tool|artifact|error|deliverable",
      "text": "摘要（≤200 字）",
      "quote": "原文片段（≤160 字）",
      "seq": 8,
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
  "history": [                           // ≤20 条
    { "at": "ISO", "kind": "create|status|progress|edit|archive|merge|ai",
      "from": "backlog", "to": "in_progress", "by": "ai|user", "note": "说明" }
  ],

  // v2 新增字段
  "keyFacts": [                          // ≤6 条，≤60 字
    { "id": "k_x", "text": "关键事实", "kind": "status|progress|issue|decision|artifact|goal",
      "sessionId": "session-...", "seq": 0 }
  ],
  "subtasks": [                          // ≤12 条，≤40 字
    { "id": "s_x", "text": "子任务", "done": false, "source": "ai|todo|manual", "seq": 0 }
  ],
  "artifacts": [                         // ≤6 条
    { "id": "a_x", "name": "README.md", "path": "workspace 相对路径",
      "absPath": "/abs/path/README.md", "sessionId": "session-...", "seq": 0, "time": 0 }
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
- v1 → v2 迁移：`keyFacts ← evidence 前 3`、`subtasks ← milestones`、`artifacts = []`、`sessionContext ← 首个 session`、`evidence` 截断 8 条。

## 3. HTTP API

所有路由前缀 `/super-kanban/api`，同源请求（`credentials: "same-origin"`），由 Host 侧 `connection.admit` 完成鉴权（非 owner 返回 403）。错误响应统一：

```json
{ "ok": false, "error": "code", "message": "说明" }
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
      "sessionCount": 3, "included": true, "lastActivityAt": 1793694532136 }
  ],
  "scan": {
    "state": "idle|running|done|error",
    "startedAt": "ISO|null", "finishedAt": "ISO|null",
    "processed": 7, "total": 10,
    "newTasks": 0, "updatedTasks": 2, "aiCalls": 3, "tokens": 5120,
    "message": "扫描完成：10/10 个会话", "error": null
  },
  "settings": {
    "autoScan": true,
    "scanIntervalSeconds": 120,
    "aiEnabled": true,
    "model": "deepseek-flash",
    "initialDays": 30,
    "maxTasksPerSession": 3,
    "excludeWorkspaces": [],
    "lastScanAt": "ISO|null",
    "maxAiCallsPerScan": 40,
    "dailyAiCallLimit": 150
  },
  "usage": {
    "date": "YYYY-MM-DD",
    "calls": 3,
    "tokens": 5120,
    "lastScan": { "calls": 0, "tokens": 0, "durationMs": 0, "digestBytesAvg": 0 }
  }
}
```

### POST `/command`

请求：`{ "op": "<op>", "payload": { ... } }`；响应：`{ "ok": true, "data": ... }`。扫描触发为 202 语义但返回 HTTP 200。

| op | payload | 说明 |
| --- | --- | --- |
| `task.create` | `{title, goal?, status?, priority?, tags?, workspaceId?, sessionId?, progress?}` | 手动建卡 |
| `task.update` | `{id, patch: {...}, lockFields?: string[]}` | 用户编辑；`lockFields` 中字段加锁 |
| `task.move` | `{id, status, index?}` | 拖拽换列 |
| `task.archive` | `{id, archived: boolean}` | 归档 / 恢复 |
| `task.delete` | `{id}` | 删除（自动任务也允许，记入历史） |
| `task.relink` | `{id, sessionIds: string[]}` | 手动改来源会话 |
| `task.unlock` | `{id, fields?: string[]}` | 解锁字段，交还 AI 维护 |
| `task.analyze` | `{id}` | 立即对该任务来源会话重跑研判 |
| `task.continuePrompt` | `{id, target: "session"\|"newSession"}` | 生成「继续此任务」提示词（本地模板，0 token） |
| `task.polishPrompt` | `{id, prompt}` | AI 润色提示词（耗 1 次调用，不可用时原样返回） |
| `task.importTodos` | `{id}` | 从来源会话导入待办为子任务 |
| `task.toggleSubtask` | `{id, subtaskId, done}` | 勾选子任务 |
| `task.addSubtask` | `{id, text}` | 新增子任务 |
| `task.removeSubtask` | `{id, subtaskId}` | 删除子任务 |
| `session.ignore` / `session.unignore` | `{sessionId}` | 忽略会话：不再自动建卡 |
| `settings.update` | `{patch: {...settings}}` | 更新设置 |
| `scan.start` | `{mode: "incremental"\|"full"}` | 触发扫描（运行中返回 busy） |
| `scan.cancel` | `{}` | 取消扫描 |

`task.continuePrompt` 返回：

```jsonc
{ "prompt": "结构化的继续任务提示词", "target": "session", "sessionId": "session-...",
  "workspaceId": "workspace-id", "workspaceTitle": "示例工作区", "isLive": false }
```

### GET `/session/:sessionId`

可选 query：`?after=<seq>&limit=<n>`（默认 200，最大 500）。

```jsonc
{
  "ok": true,
  "session": {
    "id": "session-...", "title": "会话标题",
    "workspaceId": "workspace-id", "workspaceTitle": "示例工作区",
    "createdAt": 1793694532120, "lastActivityAt": 1793694767953,
    "turns": 2, "eventCount": 128, "status": "completed",
    "path": ".../session.v4.jsonl.zstd",
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
- 打开会话 / 产物 / 终端后自动收起抽屉。

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

## 5. 存储上限与 Token 约束

- evidence ≤8（quote ≤160 字符）、keyFacts ≤6（≤60 字符）、subtasks ≤12（≤40 字符）、artifacts ≤6、history ≤20。
- 会话摘要 digest ≤1.5KB/会话；LLM 输出 ≤2200 tokens；每个会话最多产出 3 个任务。
- 重新研判门控：用户消息数增加 **或** 最后 turn 结束原因变化 **或** 首次 **或** 手动触发；活跃会话同一 turn 内不重复；同一会话最小分析间隔 180 秒。
- 单次扫描 AI 调用 ≤ `maxAiCallsPerScan`（5–40），每日 ≤ `dailyAiCallLimit`（10–500）；超限降级规则引擎并在 `scan.message` 说明。

## 6. 版本与迁移

- `state.version = 2`（当前）。仓库加载 v1 状态时自动迁移并落盘；迁移失败会备份原文件并重建空状态，不阻塞插件启动。
- 新增字段必须保持向后兼容：客户端对缺失字段使用默认值；服务端对未知字段宽容处理。
- 契约变更需同步更新：本文件、`tests/` 中的契约相关断言、以及 CHANGELOG。

## 7. 验收标准

1. 打开「任务看板」主面板：统计行 + 四列看板 + 工作区筛选 + 搜索可见。
2. 自动发现初始扫描范围内的会话并生成 / 更新任务；卡片显示目标、进度、来源工作区、最近活动时间、问题标记。
3. 点击卡片打开抽屉：关键事实、子任务、问题 / 下一步、会话联动、产物、证据时间线。
4. 手动：新建、编辑、拖拽换列、归档、删除、锁定字段（AI 不覆盖）、设置（AI 开关 / 间隔 / 排除工作区 / 预算）。
5. 自动扫描：启动后数秒内首扫；之后按间隔增量扫描；扫描进度实时可见；结果落盘可追溯。
6. 视觉：与 DSH 深浅色主题一致、无横向溢出、空态 / 加载态完整、1680px 与 1280px 宽度均可用。
7. 会话联动：「继续此任务」默认 0 token；提示词放入输入框但不自动发送；打开会话 / 产物 / 终端后抽屉收起。
8. 控制台无 error / 404；AI 不可用时看板仍可用（规则引擎）。
