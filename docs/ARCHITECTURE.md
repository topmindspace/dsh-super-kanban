# 架构说明

Super Kanban 是一个 **DSH 插件包**，由两个半边组成：

```
┌────────────────────────────── DSH 桌面 / web ──────────────────────────────┐
│                                                                            │
│  Host 半边（Node，插件服务）                  Browser 半边（浏览器 bundle）  │
│  index.mjs ──► server/service.mjs             client.js                     │
│                ├─ sessions.mjs   只读扫描      ├─ 全页主面板（main slot）     │
│                ├─ analyzer-rules.mjs           ├─ 侧边栏入口                 │
│                ├─ analyzer-llm.mjs             ├─ 右侧栏 tab 类型            │
│                └─ store.mjs      本机持久化    ├─ 会话头部快捷入口            │
│                         ▲                     │                             │
│                         │  HTTP /super-kanban/api（owner 鉴权）              │
│                         └─────────────────────┘                             │
│                                                                            │
│  数据源（只读）：~/.dsh/storages/workspace.json                              │
│                  ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd  │
│                  ~/.dsh/storages/session_projcache/sessions/<id>.json       │
└────────────────────────────────────────────────────────────────────────────┘
```

设计原则：

- **零构建、零第三方依赖**：host 与 browser 都是手写 ESM/CJS，直接随包分发。
- **浏览器半边只通过 HTTP API 访问 host**：不直接读文件系统，不做跨源请求。
- **分析永远可降级**：规则引擎是基线，LLM 只是增强；任何 LLM 失败都不影响看板。
- **本机优先**：只有压缩摘要（可选）会离开本机。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `index.mjs` | Host 入口：挂载 `/super-kanban/api` 前缀路由，校验 owner 身份，启动/停止服务 |
| `client.js` | 浏览器半边：单文件 bundle，注册面板 / 入口 / 右侧栏 tab / 会话头部按钮 |
| `server/service.mjs` | 服务主体：HTTP 路由、状态编排、扫描调度、命令处理、SSE 广播 |
| `server/sessions.mjs` | 会话扫描与解析：发现、zstd 解压、事件解析、摘要 / 证据 / 子任务 / 产物提取 |
| `server/analyzer-rules.mjs` | 本地规则引擎：从解析结果推导任务、状态、进度、问题、优先级 |
| `server/analyzer-llm.mjs` | 可选 LLM 引擎：调用 DeepSeek 推理接口，预算控制、JSON 解析、降级 |
| `server/store.mjs` | 持久化：`state.json` / `sessions-cache.json`，原子写、裁剪、版本迁移、损坏恢复 |
| `cordis.patch.yml` | Cordis bundle patch：把 host 插件插入 profile |
| `install.sh` / `uninstall.sh` | 把仓库链接进 DSH profile / 回滚 |
| `scripts/` | 校验、隐私扫描、市场索引生成、发布辅助 |
| `tests/` | `node --test` 套件（store / analyzer / package / market-index / privacy） |

## Host 半边

### 入口与鉴权（`index.mjs`）

1. 创建 `createKanbanService({ ctx })`，通过 `ctx.effect` 管理服务生命周期；
2. `ctx.inject(["connection", "webServer"])` 后，把 `/super-kanban/api` 注册为前缀路由；
3. 每个请求先经过 `connection.admit(req)`：只有 `owner` 身份的 peer 允许访问，其他返回 403；
4. 路由处理统一交给 `service.handle(req, res, { route, url, method })`，错误不会打穿 host。

因为 DSH 的 API 只服务本机（回环地址），加上 owner 鉴权，看板 API 不会暴露给其他网络来源。

### 扫描流水线（`service.mjs` + `sessions.mjs`）

```
discover()                     workspace.json + sessions 目录 + projcache
   │                           → 会话元数据（cwd / workspace / 标题 / 活动时间）
   ▼
签名比对（sessions-cache）      size:mtimeMs 未变化 → 跳过解析
   │
   ▼
loadParsed()                   zstd 多帧解压 → JSONL → 事件模型
   │                           （用户请求 / AI 回复 / 工具调用 / todo /
   │                             交付物 / 错误 / 轮次结束原因 / 标题）
   ▼
analyzeSessionRules()          规则引擎：任务 / 状态 / 进度 / 问题 / 优先级 / 证据
   │
   ▼
buildV2Context()               keyFacts / subtasks / artifacts / sessionContext / goal
   │
   ▼
LLM 门控（可选）                 meaningful-change 门控 + 单次/每日预算
   │                           → buildDigest() ≤1.5KB → DeepSeek API
   ▼
合并进看板                     会话锚点稳定 ID；用户锁定字段不覆盖；写历史
   │
   ▼
store.saveState()              原子写（tmp + rename）；扫描进度经 SSE / 轮询可见
```

关键行为：

- **会话锚点**：自动任务以 `primarySessionId` 为种子生成稳定 ID，重复扫描不会重复建卡。
- **增量门控**：仅在「用户消息数增加、上一轮 turn 已结束、首次分析、手动重新研判」时调用模型；活跃 turn 内不重复分析；同一会话有最小间隔。
- **预算**：单次扫描 AI 调用上限、每日上限（设置可调），超限自动降级规则引擎并在扫描消息中提示。
- **隔离失败**：单个会话解析失败只记录日志并跳过，不影响其他会话和看板。
- **并发保护**：扫描进行中再次触发返回 busy；支持取消。

### 两个分析引擎

| 引擎 | 输入 | 输出 | 何时使用 |
| --- | --- | --- | --- |
| 规则（`analyzer-rules.mjs`） | 本地解析结果 | 任务标题 / 目标 / 状态 / 进度 / 问题 / 证据（启发式） | 默认基线；关闭 AI、未登录、网络失败、超预算时 |
| LLM（`analyzer-llm.mjs`） | 压缩摘要 digest + 已有任务上下文 | 结构化 JSON（任务、状态、进度、问题、关键事实、置信度、理由、merge 建议） | AI 开启且凭证可用、预算内、门控通过时 |

LLM 调用使用本机 DSH 账号凭证（从 `$DSH_HOME/.credentials.yaml` 读取，**不打印、不外发**），默认模型 `deepseek-flash`。调用失败（网络 / 鉴权 / 解析）会重试一次后降级规则引擎。

### 持久化（`store.mjs`）

- `state.json`：`version`、`tasks`、`settings`、`usage`、`ignoredSessions`、`suppressedSessions`、`deletedLog`、`workspaces`、`activity`、`scan`。
- `sessions-cache.json`：`sessions[sessionId] = { sigKey, meta }`，用于跳过未变化会话与 AI 门控。
- 写入是原子的（临时文件 + rename）；解析失败的文件会移动到 `backups/` 后以默认值重建。
- `version` 变化时执行迁移（v1 → v2），迁移失败同样走备份 + 重建路径。
- 载荷裁剪：evidence ≤8、keyFacts ≤6、subtasks ≤12、artifacts ≤6、history ≤20、quote ≤160 字符。

### HTTP API

所有路由前缀为 `/super-kanban/api`，同源 `credentials: same-origin`，错误结构统一 `{ ok: false, error, message }`。完整接口、字段与命令列表见 [CONTRACT.md](CONTRACT.md)。

| 路由 | 作用 |
| --- | --- |
| `GET /state` | 看板快照：任务、统计、工作区、扫描状态、设置、用量 |
| `POST /command` | 任务 / 设置 / 扫描等操作（`task.*`、`settings.update`、`scan.*` 等） |
| `GET /session/:id` | 单会话事件时间线（证据跳转用） |
| `GET /export` | 导出完整看板 JSON |
| `GET /events` | 可选 SSE：扫描进度与任务变化 |

## 浏览器半边（`client.js`）

单文件、无构建，通过 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 注册插件。`factory` 内使用 `require("react")` 与 `React.createElement`（无 JSX）。

### 注册的扩展点

| 扩展点 | 内容 |
| --- | --- |
| `main` slot | 全页看板主面板（`key = "super-kanban"`） |
| `sidebar.panellist` | 左侧栏「任务看板」入口 |
| `sidebarRightTabs.register` | 右侧栏看板 tab 类型（`kind = "super-kanban"`） |
| `sidebar.right.pane.tab` slot | 右侧栏看板内容 |
| `conversation.session.header.utilities` | 会话头部「打开任务看板」按钮 |

### 状态与数据流

- 首屏拉取 `/state`，之后每 4 秒轮询（页面隐藏时暂停）；扫描中加快刷新；SSE 可用时优先使用。
- 所有写操作走 `POST /command`：界面先乐观更新，失败回滚并 toast。
- 抽屉、浮层、筛选等纯 UI 状态保存在本地（localStorage / 组件状态），不入库。
- 深浅色、字体、圆角全部使用 DSH 设计 token，不引入外部字体 / 图片 / 网络资源。

### 双形态与自适应

- 同一个 Board 组件接受 `surface: "page" | "side"`。
- 按根容器宽度分档：窄（单列 + 状态分段）/ 中 / 宽（四列）。右侧栏可拖宽，拖到全屏时自动切到宽档。
- 抽屉在页面形态从右侧覆盖，在右侧栏形态则覆盖整个面板。

### 页头与入口（v0.4 实现细节）

- 全页看板页头常驻：搜索、扫描、设置齿轮、在右侧栏打开、主按钮「新建」；「⋯」菜单只保留「导出 JSON」。
- 右侧栏看板页头常驻：扫描、设置、在全页面板打开、新建、「⋯」（仅导出 JSON）。
- 页头按钮的排列与图标属于浏览器半的**实现细节**，不在 Host/浏览器契约内；契约只约束注册的 slot / tab / 数据接口（见 [CONTRACT.md](CONTRACT.md)）。

### 与 DSH 其他服务的联动

| 能力 | 使用的服务 |
| --- | --- |
| 打开原会话 | `uiWorkspace.openSession(sessionId)` |
| 新建会话并预置提示词 | `uiWorkspace.startSession(workspaceId, { prompt })` |
| 把提示词放入输入框（不发送） | `sessions.binding(id)` + `conversation.input.requestDraftInitialization` |
| 产物在 DSH 中预览 | `sidebarRight.openResource("dsh-resource://file/session/...")` |
| 右栏终端 | `sidebarRight.openTab("terminal")` |
| 右栏全屏 | `sidebarRight.focusedTarget(el)` + `toggleFullscreen(target)` |

任何服务不可用时，对应按钮会提示「当前环境不支持」，不会抛出未捕获异常。

## 数据格式要点

### 工作区注册表

`$DSH_HOME/storages/workspace.json`：`tables.workspaces[workspaceId] = { path, title, sessionIds[], createdAt, updatedAt }`。插件用它的 `path` 与 `sessionIds` 把会话映射到工作区；路径按规范化后的真实路径匹配。

### 会话日志

`$DSH_HOME/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd`：

- zstd 压缩的 **JSONL 追加日志**，一个文件由多个 zstd 帧拼成；第一帧只包含一行 `session` 头；
- 插件按帧边界逐段解压后拼成文本，再按行解析 JSON；解析失败的行走容错计数，不会让整个会话失败；
- 使用到的关键事件：`session`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`turn/start`、`turn/end`、`session/title`、`deliverables/presented`、`workspace/changes`、`system/message`。

> 插件对会话日志 **只读**，不会写入或修改 `~/.dsh/sessions`。

### 会话投影缓存

`$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` 用于快速读取标题与 DSH Session Goal（`record.rows.goal.val.current`）。缓存缺失或损坏时，插件回退到从会话日志推断。

## 隐私边界

| 边界 | 实现 |
| --- | --- |
| 网络监听 | 只由 DSH 的本地 web server 提供 API；无独立端口、无外部监听 |
| API 鉴权 | `connection.admit` + owner 身份；非 owner 一律 403 |
| 出站请求 | 仅 `https://api.deepseek.com`（可选、可关闭、只发摘要） |
| 遥测 | 无 |
| 凭证 | 只在本机读取、只用于设置请求头；不写入日志、不随摘要发送 |
| 已发送内容 | 压缩会话摘要（≤1.5KB/会话）：标题、最近用户请求、最近回复、todo、错误、文件与工具摘要；不含全文、不含文件内容 |

## 扩展点一览

想扩展插件时，优先沿这些缝加：

- **新的 `POST /command` op**：在 `service.mjs` 的 `ops` 表加处理函数，同时在 `docs/CONTRACT.md` 登记。
- **新的分析信号**：在 `sessions.mjs` 的 `parseEvents` / `buildDigest` 增加字段，再在规则与 LLM prompt 中消费。
- **新的 UI 区块**：在 `client.js` 的 `BoardPage` / `TaskDrawer` 内加组件，样式只用 DSH token。
- **新的入口形态**：注册新的 slot / sidebarRight tab 类型。
- **存储字段**：在 `store.mjs` 的 `truncateTask` / 迁移函数中维护版本与裁剪规则，并补测试。

## 版本、升级与运行时

- **运行时版本**：插件实际执行的是 DSH profile 的 `node_modules/dsh-super-kanban/`（或 `install.sh` 链接的工作区）。`package.json` 的 `version` 只描述发布包，不决定运行时。
- **profile 依赖规格决定升级行为**：
  - 插件页/npm 安装写入**精确版本**（`pnpm add --save-exact`）；
  - 源码/本地目录安装写入 `link:`；
  - 手工写成范围时，`^0.4.0` 只覆盖 0.4.x，`^0.3.0` 永远不会到 0.4.x（跨 minor 需精确版本）。
- **升级动作由 DSH 完成**：第三方插件没有自动升级，也没有官方「更新」按钮；升级 = 卸载旧版 → 安装目标版本，然后刷新窗口（客户端 bundle 有缓存，必要时完全退出 DSH）。
- 用户侧步骤、版本验证与排障见 [INSTALL.md](INSTALL.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；插件数据（`state.json`）与插件版本解耦（存储格式版本见 `store.mjs`）。

## 失败与降级

| 场景 | 行为 |
| --- | --- |
| 没有账号 / 网络不可用 | 规则引擎继续工作，看板可用 |
| LLM 返回非法 JSON | 该会话本次用规则结果，记录日志 |
| 会话日志损坏 / 格式升级 | 跳过该会话并计数，其余会话正常 |
| 存储文件损坏 | 移到 `backups/`，以空状态重建，看板可继续使用 |
| 扫描被中断 | 已完成部分保留，扫描状态标记取消 |
| 浏览器服务缺失（如右侧栏不可用） | 相关按钮提示不支持，其余功能正常 |

## 测试

`tests/` 下是零依赖的 `node --test` 套件：

- `store.test.mjs`：默认值、裁剪、v1→v2 迁移、损坏恢复；
- `analyzer.test.mjs`：规则引擎的状态 / 进度 / 问题判断；
- `package.test.mjs`：包清单、files 列表、DSH 声明；
- `market-index.test.mjs`：市场索引格式与生成；
- `check-privacy.test.mjs`：隐私扫描器的规则与豁免。

运行：`npm test`。
