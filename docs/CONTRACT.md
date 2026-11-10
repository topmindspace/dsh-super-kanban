# 接口契约

本文是 **Host 半边**（`index.mjs` / `server/**`）与 **浏览器半边**（`client.js`）之间的唯一接口约定，同时供第三方集成参考。改动契约需同步更新本文件。

## 0. 运行形态

- DSH 插件包，通过 profile 的 `dsh.profile.bundles` 加载；`cordis.patch.yml` 插入 host 插件行。
- Host 入口 `index.mjs` 只做路由挂载与 owner 鉴权，实现集中在 `server/service.mjs`。
- 浏览器半边是单文件 bundle（无构建），由 DSH 模块加载器加载。
- 数据目录：`$DSH_HOME/storages/super-kanban/`（`state.json`、`sessions-cache.json`、`backups/`）。
- 数据源（只读）：`$DSH_HOME/storages/workspace.json`、`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd`、`$DSH_HOME/storages/session_projcache/sessions/<session>.json`。
- AI 研判经 **DSH 原生 LLM 服务**（`ctx.llm`）发起，模型目录 / 默认模型 / 第三方 provider / 凭证全部由 DSH 管理；看板不直连模型端点、不读取凭证文件（模型解析与预算规则见 §5）。

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
    "model": "deepseek-flash",           // LLM 研判时实际请求的模型；engine:"rules" 时为 ""
    "provider": "deepseek-account",      // v0.5 新增：LLM 实际使用的提供方 id；rules 时为 null（旧任务可能缺失）
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
- `ai.provider`（v0.5，additive）：LLM 研判实际使用的 DSH 模型提供方 id（来自 `GET /ai/models` 的 `providers[].id`）；
  `engine:"rules"` 时恒为 `null`、`ai.model` 恒为 `""`（规则引擎不再用旧 `settings.model` 填充）。
  旧任务可能没有该字段，客户端按「无 provider」降级展示；下次研判后由 Host 补齐。
- 旧 `settings.model` 字段已 **deprecated**：仅为旧状态 / 旧客户端兼容保留，**不权威、不用于研判，UI 不再展示**；
  模型真值来自 `settings.aiProvider/aiModel`（空 = 跟随 DSH 默认模型）。计划在 v0.6 移除。
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
      "source": "registry|discovered" }   // 工作区来源；registry=workspace.json；discovered=按会话 cwd 推断的合成工作区
  ],
  "scan": {
    "state": "idle|running|done|error",
    "startedAt": "ISO|null", "finishedAt": "ISO|null",
    "processed": 10, "total": 10,
    "newTasks": 0, "updatedTasks": 2, "aiCalls": 3, "tokens": 5120,
    // v0.5 新增，全部可选 / additive；旧客户端可忽略
    "aiDue": 5,                              // 本轮需要 AI 研判的会话数
    "aiBudget": 5,                           // 本次解析后的预算（按 aiBudgetMode）
    "aiAttempts": 3,                         // 本次实际 provider attempt 次数（含内部重试）
    "aiPending": 2,                          // 本次未拿到 AI 结论、下次继续的会话数（含失败待重试）
    "aiDeferredReason": null,                // null|"budget"|"time"|"daily"
    "message": "扫描完成：10/10 个会话 · AI 3 次/5120 tokens · 剩余 2 个会话下次扫描继续",
    "error": null
  },
  "settings": {
    "autoScan": true,
    "scanIntervalSeconds": 120,             // 自动增量扫描间隔
    "aiEnabled": true,                      // false 时扫描按钮显示「扫描（仅规则）」
    "model": "deepseek-flash",              // deprecated：不权威、不用于研判，仅为旧状态/旧客户端兼容保留（v0.6 移除）
    "aiProvider": "",                       // v0.5：DSH 模型提供方 id；"" = 跟随 DSH 默认模型（与 aiModel 成对）
    "aiModel": "",                          // v0.5：模型 id；空 = 跟随 DSH 默认模型
    "aiBudgetMode": "auto",                 // v0.5：auto（默认）=min(待研判, 每日剩余)；fixed=用 maxAiCallsPerScan
    "initialDays": 30,
    "maxTasksPerSession": 3,                // 单会话单次扫描最多产出的自动卡数
    "excludeWorkspaces": [],
    "lastScanAt": "ISO|null",
    "maxAiCallsPerScan": 40,                // 默认 40，钳 5–150；仅 aiBudgetMode="fixed" 生效
    "dailyAiCallLimit": 150                 // 每日预算单位上限（10–500，用户本地日历日滚动）；不是硬成本上限
  },
  "usage": {
    "date": "YYYY-MM-DD",                   // 用户本地日历日（不是 UTC 日）
    "calls": 3,
    "tokens": 5120,
    "lastScan": { "calls": 0, "tokens": 0, "durationMs": 0, "digestBytesAvg": 0 }
  }
}
```

`scan.message` 是**持久化的人类可读扫描结论**。扫描按钮提示和维护视图会展示它。典型内容包括：

- `扫描完成：28/28 个会话 · 本次无 AI 调用`（AI 开启但本次未调用；AI 关闭时只有前半段）；
- `扫描完成：28/28 个会话 · AI 3 次/5120 tokens · 低价值跳过 2`；
- `扫描完成：41/41 个会话 · AI 40 次/72000 tokens · 剩余 18 个会话下次扫描继续`（单次预算或 10 分钟墙钟到点，未研判会话下次继续）；
- `本次 AI 预算已用完（40 次）其余仅规则 · 剩余 18 个会话下次扫描继续`（固定档本次预算耗尽，每日额度仍有剩余）；
- `今日 AI 预算已用完（150/150）· 剩余 18 个会话明日继续（本次其余仅规则）`；
- `本次 AI 阶段已达 10 分钟上限 · 剩余 32 个会话下次扫描继续`；
- `… · N 个会话研判失败，5 分钟后重试`（进入失败冷却，冷却期内不会每轮重试）；
- `当前 DSH 未提供 AI 模型服务，本次仅规则分析；升级 DSH 后可用` /
  `所选模型提供方 <provider> 已不可用，请在设置中重新选择模型` /
  `DSH 默认模型提供方 <provider> 不可用，请在 DSH 设置 → 模型中配置` /
  `DSH 尚未设置默认模型，请在看板设置中选择模型（或先在 DSH 设置 → 模型中配置）` /
  `读取模型目录失败，本次仅规则分析` /
  `<provider> 没有可用模型（可能未配置 API Key 或未登录），请在 DSH 设置 → 模型中完成配置`；
- `扫描失败：<错误信息>` / `扫描已取消（已完成部分保留）`；
- 扫描过程中的瞬时提示（如 `AI 研判 N 个会话（预算 M）…`）也会写入 `scan.message`（SSE / 轮询可见），
  运行中扫描按钮展示进度，结束后可查看最终结论。

`scan.message` 的口径（Host 保证）：

- 所有「已用/上限」都是**扫描后**数字（`usage.calls` 已含本次成功调用）；
- 只要本轮仍有会话没拿到 AI 结论，就必须出现「剩余 N 个会话…继续」；`N` 与 `scan.aiPending` 一致；
- 文案不包含 session id / 会话标题，是给人看的自然语言，不承诺机器可解析；
- `scan.aiCalls` = 成功调用数（与 message 的「AI N 次」一致）；`scan.aiAttempts` = 实际 attempt 数（含内部重试）。

`usage.date` 跟随用户本地日历日：每日 AI 调用计数与 `dailyAiCallLimit` 在**本地午夜**滚动重置；
设置页显示的「今日」数字与预算判断都使用该字段。`usage.calls` / `usage.tokens` 只累计**成功**的 analyze
（失败 attempt 的 tokens 不计入）；失败 analyze 仍占用 1 个预算单位（见 §5.3）。

### GET `/ai/models`

只读的 AI 模型目录端点（v0.5 新增）：给看板设置页的「AI 研判模型」下拉提供数据。数据来自 DSH 原生 LLM 服务
（`listProviders()` + 每个 provider 的 `listModels()`），**不写入、不保存任何凭证**。Host 侧缓存 30 秒、整体超时约 12 秒，
并订阅 DSH 的模型目录变更事件失效缓存；单个 provider 失败只体现在 `failures[]`，不影响其它 provider（客户端建议 15 秒超时 + 30 秒内存缓存）。

```jsonc
{
  "ok": true,
  "catalogAvailable": true,               // false = 当前 DSH 没有原生 LLM 服务（旧组合），目录数组为空
  "default": { "provider": "deepseek-account", "model": "deepseek-flash" },  // 或 null
  "providers": [
    { "id": "deepseek-account", "name": "DeepSeek Account", "modelCount": 2 },
    { "id": "minimax-cn", "name": "minimax-cn", "modelCount": 0 }
  ],
  "models": [ { "provider": "deepseek-account", "id": "deepseek-flash", "name": "DeepSeek Flash" } ],
  "failures": [ { "provider": "minimax-cn", "name": "minimax-cn", "message": "credential unavailable" } ],
  "fetchedAt": "2026-11-08T04:00:00.000Z"
}
```

- **扁平包络**：与 `GET /state` 一致，不包 `data`；字段全部必返（无数据时为空数组 / `null`）。
- `catalogAvailable`：当前 DSH 组合是否提供 `llm` 服务；`false` 时 `default:null`、数组为空，看板设置页引导升级 DSH。
- `default`：DSH 的默认模型选择（`agentDefaultModel.currentSelection()`），**只含 provider/model**（不输出
  reasoningEffort —— 看板不消费）；读取不到时为 `null`。
- `providers[]`：已注册的模型提供方（`modelCount` 是该 provider 的可用模型数，可以为 0）。
- `models[]`：全部可用模型的扁平列表（`provider/id/name`），客户端按 provider 分组展示。
- `failures[]`：**provider 列表本身读取失败**的原因（网络/超时等）；「provider 正常但 `modelCount:0`」不算失败，
  多数是未配置凭证或未登录——客户端需要区分这两种空态，不能把失败误报成「未配置」。
- 错误：端点为 owner 鉴权（非 owner 403），无 `llm` 服务时仍返回 `200` + `catalogAvailable:false`，不返回 5xx。
- 该端点不进入 `GET /state`（避免 4 秒轮询携带大目录）；目录故障只影响设置页，**不阻塞扫描**。

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
| `task.analyze` | `{id}` | 立即重跑研判：**只研判主来源会话**（`primarySessionId`，旧卡回退 `sessions[0]`）；一次最多 1 个预算单位；与扫描 / 其他 AI 命令互斥（见下）；AI 不可用/超预算自动降级规则 |
| `task.continuePrompt` | `{id, target: "session"\|"newSession", purpose?, sessionId?}` | 本地生成续做草稿，`sessionId` 可指定当前任务的任一关联会话 |
| `task.accept` | `{id, expectedUpdatedAt?}` | 人工验收并锁定完成状态。归档任务须先恢复，过期修订返回 409 |
| `task.polishPrompt` | `{id, prompt}` | AI 润色提示词（耗 1 个预算单位；与扫描 / 其他 AI 命令互斥，见下；不可用时原样返回） |
| `task.importTodos` | `{id}` | 从来源会话导入待办为子任务 |
| `task.toggleSubtask` | `{id, subtaskId, done}` | 勾选子任务 |
| `task.addSubtask` | `{id, text}` | 新增子任务 |
| `task.removeSubtask` | `{id, subtaskId}` | 删除子任务 |
| `session.ignore` / `session.unignore` | `{sessionId}` | 跳过或恢复自动扫描，在会话关系与维护视图操作 |
| `settings.update` | `{patch: {...settings}}` | 更新设置；`aiProvider/aiModel` 成对提交（半对归一并记一条 warn）、`aiBudgetMode` 非法值忽略；**纯预算 patch（键集合 ⊆ {`maxAiCallsPerScan`, `dailyAiCallLimit`}）且不带 `aiBudgetMode` 时，本次更新推断为 `fixed`**（见 §6） |
| `scan.start` | `{mode: "incremental"\|"full"}` | 触发扫描（扫描运行中或显式 AI 任务进行中返回 `409 busy`，见下） |
| `scan.cancel` | `{}` | 取消扫描 |

`op` 必须是命令表自身的属性：`"constructor"`、`"__proto__"` 等非自有属性名一律返回 `400 unknown-op`。

扫描与显式 AI 命令（`task.analyze` / `task.polishPrompt`）共享同一个 analyzer 实例，三者互斥：并发请求返回
`409 busy`（扫描进行中 →「扫描进行中，请稍后再试」；显式 AI 命令之间 →「其他 AI 任务进行中，请稍后再试」；
`scan.start` 遇到扫描运行中 →「扫描正在进行中」、遇到显式 AI 命令 →「AI 任务进行中，请稍后再试」），
并发的自动扫描会顺延到下一 tick。

`task.analyze` 返回（客户端据此提示引擎与本次消耗）：

```jsonc
{ "task": { /* 更新后的 Task */ }, "engine": "llm|rules", "aiCalls": 1, "tokens": 3120, "sessions": 1,  // 只重判主来源会话，固定为 1
  "model": "deepseek-flash", "provider": "deepseek-account",  // 可选：本次实际使用的 route（rules 时 model:""、provider:null）
  "message": "AI 研判完成|AI 判断该会话无需建卡（已消耗 1 次）|今日 AI 预算已用完，已用规则引擎重判|<route 失败原因>，已用规则引擎重判|AI 不可用或未启用，已用规则引擎重判" }
```

- **只研判主来源会话**：取 `task.primarySessionId`（旧卡 / 重链卡缺失时回退 `task.sessions[0].id`）；无可用会话返回
  `400 task-has-no-session`；主会话日志解析失败返回 `400 session-parse-failed`（显式失败，不再静默规则降级）。
- **互斥**：与扫描、`task.polishPrompt`、其他 AI 命令共享同一个 analyzer，并发时返回 `409 busy`（见上）；
  请求期间自动扫描顺延到下一 tick。
- 使用与扫描**相同的模型解析结果**（`settings.aiProvider/aiModel` → DSH 默认模型 → 目录首模型兜底，
  见 §5.2）；成功后任务的 `ai.provider/model` 为实际使用的 route。
- **一次 `task.analyze` 最多消耗 1 个预算单位**（一次 analyze，内部重试不重复计）：即使判定「无需建卡」
  （`ignore`/空任务）也消耗 1 次；失败 attempt 的 tokens 不计入 `tokens`。
- AI 不可用或本次预算不足时用规则引擎重判，`engine:"rules"`，`message` 说明原因（会话日志解析失败除外：返回 400）。

`task.continuePrompt` 返回：

```jsonc
{ "prompt": "结构化的继续任务提示词", "target": "session", "sessionId": "session-...",
  "workspaceId": "workspace-id", "workspaceTitle": "示例工作区", "isLive": false, "updatedAt": "ISO 8601" }
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
    "turns": 2, "eventCount": 128, "status": "active|completed|error|interrupted|unknown",  // isLive→active；无 turn 记录→unknown
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

### 工作视图与维护接口

`GET /state` 增加 `storage` 和 `maintenance`，分别提供写入健康状态、最近保存时间、会话读取失败数量、回收站与忽略清单。任务可携带 `attention`、`completionBasis`、`relations`、`resolvedIssues`、`pinned`。字段采用增量扩展，旧状态仍可读取。

`acceptanceCriteria` 是用户填写的多行验收条件，上限 600 字。`task.create` 接受该字段，`task.update` 在 `patch` 中接受，空字符串清空。自动研判保留此字段。有验收条件的未完成任务在会话提供完成依据时标为 `attention: "acceptance"`。`task.accept` 写入 `completionBasis: "user"`，并保留子任务的人工勾选状态。显式合并保留双方验收条件，超出上限时返回错误，合并撤销恢复各自条件。

`writeOverlaps` 是最近 15 分钟内同一 Git 工作树和文件的写入证据分组，每组形如 `{ path, sessions: [{ id, at, seq }] }`。Host 从当前未结束轮次的成功 `write`、`edit` 结果提取证据。客户端只对至少两个由 DSH 确认运行中且没有待交互请求的会话显示提示。记录使用工作树相对路径，并保留来源会话和结果序号。

- `GET /sessions?q=关键词` 返回至多 50 个可关联的会话元数据，支持会话 ID、标题、工作区和父会话查询。
- `GET /merge-candidates?id=任务ID` 返回同工作区相似卡片，只有用户执行 `task.merge` 才会改动任务。
- `task.update` 接受可选的 `expectedUpdatedAt`。版本冲突返回 HTTP 409 / `revision-conflict`。
- `task.linkSession` 接受 `{ id, sessionId, primary?, continuation?, remove? }`。续做会话被设为主会话，旧会话可继续补充产物与证据。
- `task.relate` 接受 `{ id, taskId, type, remove? }`。类型为 `parent`、`depends_on`、`related`，父子与依赖关系分别检查循环。
- `task.issue` 接受 `{ id, text, resolve? }`。手动记录的问题和已解决的同名问题在后台刷新后保留。
- `task.batch` 接受 `{ ids, archived?, priority? }`，单次最多 200 项。 `task.pin` 接受 `{ id, pinned }`。
- `task.merge` 接受 `{ id, sourceId }`。删除和合并记录可用 `task.restore` 恢复。合并后的目标被再次编辑时，接口返回冲突以保护新修改。
- `backup.preview` 接受 `{ backup }`，返回当前和待恢复的任务数量、`expectedSavedAt` 与 `backupHash`。
- `backup.restore` 接受 `{ backup, expectedSavedAt, backupHash }`。文件内容或看板版本变化时返回 409，恢复前先保留当前看板快照。浏览器支持最高 15 MiB 的备份文件，使用独立的 `POST /backup` 入口。
- `storage.retry` 重试保存。用户写入失败返回 HTTP 503 / `storage-unavailable`，且内存回滚。

手动子任务上限为 100 项，自动提取的摘要子任务最多 12 项。产物按交付类型和时间排序，任务可保留最多 24 项。

### GET `/events`（SSE，可选）

客户端使用同源 `EventSource` 接收状态变化通知。通知会合并触发 `/state` 刷新。轮询仍用于断线恢复，页面隐藏时暂停刷新。

```
event: scan
data: {"state":"running","processed":3,"total":10,"message":"…"}

event: changed
data: {"reason":"init"|"scan"|"task"|"settings","tasksChanged":2}
```

- 连接建立时会先发一帧 `scan`（当前扫描状态）与一帧 `changed`，`reason:"init"`。
- 断线后的重连由使用方自行处理；浏览器半当前只轮询 `/state`。

## 4. 浏览器半边要求

- 注册 `main` 面板（key=`super-kanban`）与 `sidebar.panellist` 入口（id=`super-kanban`，label「任务看板」）。
- 注册右侧栏 tab 类型与 `sidebar.right.pane.tab` slot；注册会话头部快捷入口（`conversation.session.header.utilities`）。
- 打开会话使用 `ctx.get("uiWorkspace")?.openSession(sessionId)`。
- 只允许同源 fetch；不得访问外部网络、不得加载外部字体 / 图片。
- 样式只使用 DSH 设计 token（`--dsw-alias-*` 等）与插件自有 CSS 变量，深浅色自适应。
- 固定轮询 `/state`（4 秒，页面隐藏时暂停；扫描中约 1.2 秒），不使用 `EventSource`；`GET /events` 供第三方集成 / 后续使用。
- 所有写操作乐观更新 + 失败回滚 + 轻量 toast。
- 抽屉在存在 `task.ai` 时展示研判块（引擎 `AI 研判`/`规则推断`、提供方与模型、置信度、最近研判时间、理由）；
  `ai.provider` 缺失的旧任务只展示 `model`，不再显示空的分隔符；
  当来源会话在研判后又有新活动（`sessionContext.lastActivityAt`，缺失时取 `task.lastActivityAt`，
  晚于 `ai.analyzedAt + 5 分钟`）时标记「可能已过期」，没有新活动时旧研判仍然有效。用户从抽屉
  「⋯」→「重新研判」调用 `task.analyze`。
- 设置弹窗提供「AI 研判模型」只读控件：数据来自 `GET /ai/models`，原生 `<select>` 按 provider 分组，
  首项「跟随 DSH 默认」；不提供 API Key / baseURL / 模型拉取表单（第三方模型与凭证统一在「DSH 设置 → 模型」
  配置，看板只读目录、不保存凭证）；选中非官方提供方时提示「压缩摘要会发送给该模型服务商」。
  下拉必须能覆盖「加载中 / 目录为空 / 无 provider / provider 读取失败 / 旧 DSH 无 llm / 已保存模型不在目录」等状态。
- 设置弹窗的预算与用量：单次上限为单个下拉（`自动（推荐）/ 20 / 40 / 80 / 150`，当前值不在档位时补「固定 N 次」）；
  每日上限仍可调；用量行展示今日 `已用/上限/剩余`、tokens 与上次扫描，剩余不足或耗尽用琥珀文字说明
  （不加大进度条 / 彩色盒子）。
- 页头扫描状态在运行中可追加 `· AI c/预算`（`scan.aiCalls` / `scan.aiBudget`，缺失时只显示次数）；
  完成/失败时仍原样展示 Host 的 `scan.message`，客户端不解析 message 数字、不自行拼「剩余」。
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
// 产物在 DSH 文档预览中打开，先确保有已挂载的会话界面
ctx.get("sidebarRight").openResource(
  `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split("/").map(encodeURIComponent).join("/")}`,
);
// 右侧栏终端 / 全屏
ctx.get("sidebarRight").openTab("terminal", { params: {} });
const target = ctx.get("sidebarRight").focusedTarget(el);
if (target) ctx.get("sidebarRight").toggleFullscreen(target);
```

## 5. 存储上限、Token 与 AI 信任规则

### 5.1 存储、输出与门控

- 存储裁剪上限见 [§2.1](#21-文本与裁剪上限host-单一来源)；`truncateTask` 在加载与保存时都执行同一套上限。
- 会话摘要 digest ≤1.5KB/会话；单次 LLM 请求 `maxTokens` ≤4096（Host 按模型能力取 `min(4096, 模型输出上限)`）；
  每个会话最多产出 `maxTasksPerSession`（默认 3）个任务。
- 重新研判门控：用户消息数增加 **或** 最后 turn 结束原因变化 **或** 首次 **或** 手动触发；活跃会话同一 turn 内不重复；
  同一会话最小分析间隔 180 秒。
- **用户工作优先（trust rule）**：AI/规则给出 `done`，但任务仍有未完成的 `source:"manual"` 子任务或
  `lockedFields` 含 `subtasks` 的清单时，Host 会把状态降级为 `in_progress` 并追加一条 `history` 说明
  （「…建议完成，但仍有 N 个手动子任务未完成；保持进行中…」）。用户锁定的 `status` 优先，不会被覆盖；
  状态为 `done` 时**生成类**子任务（`source` 非 `manual`）自动勾选完成，`manual` 子任务不动；
  用户取消勾选子任务会让 `done` 卡回到 `in_progress`（写历史）。

### 5.2 AI 模型解析（v0.5，Host 唯一入口）

扫描、`task.analyze`、`task.polishPrompt` 都使用**同一个**解析器，在各自开始时解析一次（中途改设置不影响当前操作）。
解析只做**同步**检查（`listProviders()` 注册表 + DSH 默认模型的活引用）；除「无默认可读」时的**目录首模型兜底**
外，热路径不逐会话调用 `listModels`，模型目录不参与路由校验（只服务设置页与兜底）；判断顺序：

| 输入情况 | 行为 |
| --- | --- |
| 无 DSH 原生 LLM 服务（旧 DSH / 极简组合） | 规则引擎；`scan.message` 说明「当前 DSH 未提供 AI 模型服务，本次仅规则分析；升级 DSH 后可用」 |
| 显式 `aiProvider + aiModel` 均非空且 provider 已注册 | 使用显式 route；热路径不查目录（模型不在目录也不阻断，运行时失败按错误码降级） |
| 显式字段非空但 provider 未注册 | **不自动换模型**；规则引擎 + 提示「所选模型提供方 `<provider>` 已不可用，请在设置中重新选择模型」 |
| 只有 provider 或只有 model（半对） | 归一为「跟随 DSH 默认」：`settings.update` 收到半对 patch 时记一条 warn，加载旧 state 时静默归一 |
| 无显式 + DSH 默认模型有效且 provider 已注册 | 使用 DSH 默认模型（**活引用**：用户在 DSH 里切模型会跟随） |
| 无显式 + DSH 默认 provider 未注册 | **不自动换模型**；规则引擎 + 提示「DSH 默认模型提供方 `<provider>` 不可用，请在 DSH 设置 → 模型中配置」 |
| 无显式 + 无 DSH 默认模型可读（服务缺失 / `currentSelection()` 为 null） | 目录首模型兜底：取第一个有模型的 provider 的第一个模型；目录为空 / 读取失败 → 规则引擎 + 提示 |
| 显式/默认 provider 已注册但目录 0 模型（多为凭证缺失） | 不预先拦截，仍按 route 尝试一次；失败码（`MISSING_CREDENTIAL` / 未登录 / `NO_ADAPTER` 等）→ 该会话规则降级 + 失败冷却，不整轮失败 |
| 扫描取消 / abort | 静默，不写 `llmError`、不进入失败冷却 |

- 请求经 **DSH 原生 LLM 服务**发出：看板不读 `.credentials.yaml`、不硬编码 endpoint、不保存凭证；
  模型目录、默认模型与第三方 provider 全部由 DSH 管理。
- 请求**不传 `sessionId`**（否则官方路由会附带会话日志扩展字段）、不传 tools / 图片；
  出站内容 = system prompt + ≤1.5KB 会话摘要 + 请求的 provider/model。
- 模型输出由 Host 解析 JSON 并修复；不合法时附带纠正消息重试（单次 analyze 内 ≤3 次 provider attempt，
  可重试错误码才重试，`truncated` / 上下文超限等直接降级）。
- 实际使用的 `provider/model` 写入 `task.ai`；`task.analyze` 的提示需说明使用的引擎与模型。

### 5.3 AI 预算规则（v0.5）

- **单次预算（扫描）**：`scanBudget = min(本轮待研判会话数, 单次上限, 每日剩余预算单位)`：
  - `settings.aiBudgetMode = "auto"`（默认）：单次上限取每日剩余，即 `min(本轮待研判数, 每日剩余)`；
  - `settings.aiBudgetMode = "fixed"`：单次上限 = `maxAiCallsPerScan`（钳 **5–150**），实际仍不超过本轮待研判数。
- **每日上限**：`dailyAiCallLimit`（10–500，默认 150）是**每日 analyzer 预算单位上限**，按用户本地日历日滚动重置。
- **预算单位口径**：一次 `analyze` 消耗 1 个预算单位——扫描中的每个会话、`task.analyze` 的一次重新研判
  （**每次最多 1 个**，即使判定无需建卡 / `ignore` / 空任务也计 1 次）、`task.polishPrompt` 的一次润色各计 1；
  失败 analyze 也占 1 个；**内部重试不重复计单位**。`usage.calls` / `usage.tokens` 只累计成功调用，
  失败 attempt 的 tokens 不计入。
- 每日上限**不是硬成本 / 硬请求上限**：一次 analyze 最多 3 次 provider attempt（含内部重试），最坏出站请求 / 费用
  可达预算单位的 3×（默认每日最坏 450 次 attempt）；文档与界面不得宣称「日成本硬上限」。
- **AI 阶段墙钟 600 秒（10 分钟）**：这是**停止派发**的时间点，不是整个扫描的硬时长——到点后不再派发新批次，
  在途批次完成（受单次请求 60 秒超时约束）后停止，因此扫描总时长可能略超 10 分钟；未研判会话标记为「下次继续」，
  `scan.message` 记为「本次 AI 阶段已达 10 分钟上限」。
- **优先级**：从未做过 AI 研判的欠账 > 本轮有变化 > 最近活跃时间降序 > 会话 id 兜底（确定性）。
- **失败冷却 300 秒（5 分钟）**：会话级 analyze 失败后记录 `llmError` / `aiErrorAt`，冷却期内本轮不再尝试，
  避免每轮扫描反复烧预算；用户取消（abort）不写错误、不冷却。
- **超限行为**：超出单次预算 / 墙钟 / 每日上限后，未研判会话降级规则引擎并**保留待下次重试**；
  `scan.aiPending` = 本次未拿到 AI 结论的会话数（**含失败待重试**）；
  `scan.aiDeferredReason = "budget" | "time" | "daily" | null` 说明未完成原因；
  `scan.message` 用「剩余 N 个会话下次扫描继续」/「今日 AI 预算已用完…明日继续」解释续跑。
- `scan.aiCalls` = 成功调用次数；`scan.aiAttempts` = 实际 attempt 次数（含重试）；
  `task.analyze` / `task.polishPrompt` 与扫描互斥，不可用或预算不足时分别规则降级 / 原样返回提示词。

## 6. 版本与迁移

- `state.version = 2`（当前）。仓库加载 v1 状态时自动迁移并落盘；迁移失败会备份原文件并重建空状态，不阻塞插件启动。
- 新增字段必须保持向后兼容：客户端对缺失字段使用默认值；服务端对未知字段宽容处理。
- 运行时版本由 DSH profile 的 `node_modules/dsh-super-kanban` 决定；profile 依赖规格（精确版本 / 范围 / `link:`）影响升级行为，见 [INSTALL.md](INSTALL.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
- 契约变更需同步更新：本文件、`tests/` 中的契约相关断言、以及 CHANGELOG。

### 6.1 v0.5 迁移与兼容（AI 模型 + 预算）

v0.5 把 AI 研判从插件内置的 DeepSeek 官方直连改为 **DSH 原生 LLM 服务**，并重构预算语义。变更全部保持
**additive / 向后兼容**，`state.version` 仍为 2（不需要 schema 升级）：

| 变更 | 兼容约定 |
| --- | --- |
| `settings.aiProvider` / `settings.aiModel` | 新增字段，空串 = 跟随 DSH 默认模型；必须**成对**（同时为空或同时非空），半对输入归一为跟随默认（`settings.update` 收到半对 patch 时记一条 warn，加载旧 state 静默归一）；字符集 `provider` = `[A-Za-z0-9._:-]{0,100}`、`model` = `[A-Za-z0-9._:/@-]{0,200}`，非法值丢弃。不要求模型当前存在于目录（保存后下次扫描生效，运行时失败再降级）。 |
| `settings.aiBudgetMode` | 新增 `"auto" \| "fixed"`，默认 `"auto"`；非法值丢弃、保留原值。旧 `state.json` 缺该字段 → 加载时自然继承默认 `"auto"`，`maxAiCallsPerScan` 原值保留（**无迁移代码**）。 |
| `maxAiCallsPerScan` | 钳制范围由 5–40 放宽为 **5–150**；仅在 `fixed` 下生效，`auto` 下保留数值供切回。 |
| 旧客户端 `settings.update` | **仅当 patch 键集合 ⊆ {`maxAiCallsPerScan`, `dailyAiCallLimit`}（纯预算 patch）、包含 `maxAiCallsPerScan` 且不带 `aiBudgetMode`** 时，Host 才把**本次更新**推断为 `"fixed"`（旧 UI 的数值设置继续生效）；旧页面保存完整设置表单（含 `autoScan` 等键）**不会**改变 `aiBudgetMode`。加载旧 state 不走该推断，仍默认 `"auto"`。 |
| `GET /ai/models` | 新增只读端点；旧 Host 无此路由时新客户端按 `catalogAvailable:false` 降级（不得阻塞设置保存）。 |
| `task.ai.provider` | 新增可选字段；旧任务缺失时客户端按「无 provider」展示，下一次研判后补齐。`engine:"rules"` 时 `model:""`、`provider:null`。 |
| `scan.aiDue/aiBudget/aiAttempts/aiPending/aiDeferredReason` | 新增可选字段；旧客户端忽略即可。缺失时新客户端只做最小降级（运行中仅显示 `aiCalls`）。 |
| `settings.model` | **deprecated**：不权威、不用于研判，仅为旧状态 / 旧客户端兼容保留，UI 不再展示；计划 v0.6 移除。 |
| 旧直连通道 | **已移除**：不再读取 `.credentials.yaml`、不再硬编码模型 endpoint；DSH 无 `ctx.llm` 时规则引擎兜底并在 `scan.message` 说明。`engines.dsh` 维持 `>=0.2.1-rc.5 <0.3.0`，靠运行时 feature-detect。 |

## 7. 验收标准

1. 打开「任务看板」主面板：统计行 + 四列看板 + 工作区筛选 + 搜索可见。
2. 自动发现初始扫描范围内的会话并生成 / 更新任务；卡片显示目标、进度、来源工作区、最近活动时间、问题标记。
3. 点击卡片打开抽屉：AI 研判块（引擎 / 提供方与模型 / 置信度 / 时间 / 理由）、关键事实、子任务、问题 / 下一步、会话联动、产物、证据时间线；「⋯」→「重新研判」只重判该卡。
4. 手动：新建、编辑、拖拽换列、归档、删除、锁定字段（AI 不覆盖）、设置（AI 开关 / 模型 / 间隔 / 排除工作区 / 预算）。
5. 自动扫描启动后数秒内首扫，之后按间隔增量扫描。扫描按钮显示运行进度和取消或重试动作，最近结果可在提示和维护视图查看。
6. 视觉：与 DSH 深浅色主题一致、无横向溢出、空态 / 加载态完整、1680px 与 1280px 宽度均可用。
7. 会话联动：「继续此任务」默认 0 token；提示词放入输入框但不自动发送；打开会话 / 产物 / 终端后抽屉收起。
8. 控制台无 error / 404；AI 不可用时看板仍可用（规则引擎）。
9. **AI 模型（v0.5）**：`GET /super-kanban/api/ai/models` owner 可读、非 owner 403；旧 DSH 无 `ctx.llm` 时返回
   `catalogAvailable:false` 而非 5xx；provider 读取失败进 `failures[]` 且不影响其它 provider；设置页保存
   `aiProvider/aiModel` 后下一次扫描 / 重新研判生效（无需重启），扫描任务 `task.ai.provider` 为实际 route。
10. **AI 预算（v0.5）**：`aiBudgetMode:"auto"` 与 `"fixed"` 两种模式均按 §5.3 生效；`aiDue/aiBudget/aiAttempts/aiPending/
    aiDeferredReason` 按可选字段下发；`scan.message` 的「已用/上限」为扫描后数字并带「剩余 N 个会话下次继续」；
    10 分钟墙钟（停止派发）与 5 分钟失败冷却生效；旧客户端纯预算 patch（只含 `maxAiCallsPerScan` / `dailyAiCallLimit`，
    且包含 `maxAiCallsPerScan`）按 `fixed` 生效，完整旧表单保存不改变 `aiBudgetMode`。
11. **隐私（v0.5）**：AI 请求经 DSH 原生 LLM 服务、不传 `sessionId`、不传 tools / 图片；看板不读、不存模型凭证；
    选中第三方提供方时设置页提示摘要会发送给该服务商；README / SECURITY 的数据流说明与实际一致。
