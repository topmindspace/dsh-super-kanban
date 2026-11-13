# 架构说明

Super Kanban 是一个 **DSH 插件包**，由两个半边组成：

```
┌────────────────────────────── DSH 桌面 / web ──────────────────────────────┐
│                                                                            │
│  Host 半边（Node，插件服务）                  Browser 半边（浏览器 bundle）  │
│  index.mjs ──► server/service.mjs             client.js                     │
│                ├─ sessions.mjs   只读扫描      ├─ 全局看板（main slot）       │
│                ├─ analyzer-rules.mjs           ├─ 侧边栏入口                 │
│                ├─ analyzer-llm.mjs             ├─ 右侧栏 tab 类型            │
│                ├─ native-llm.mjs  DSH 模型服务 ├─ 会话头部快捷入口            │
│                └─ store.mjs      本机持久化    ├─ 窗口浮层（悬浮/快聊）      │
│                         ▲                     │                             │
│                         │  HTTP /super-kanban/api（owner 鉴权）              │
│                         └─────────────────────┘                             │
│                                                                            │
│  DSH 原生 LLM 服务（ctx.llm）──► 用户配置的模型提供方（官方账号 / API Key / 第三方）│
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
- **模型由 DSH 提供**：AI 研判不直连任何模型端点，统一经 DSH 原生 LLM 服务（`ctx.llm`）发起；
  模型目录、默认模型、第三方 provider 与凭证全部由 DSH 管理，看板只做「目录消费者」。
- **本机优先**：任务、项目、备注与快照保存在本机。模型调用按用途发送摘要、选中的润色草稿或快聊内容，接收方为 DSH 配置的模型服务。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `index.mjs` | Host 入口：挂载 `/super-kanban/api` 前缀路由，校验 owner 身份，启动/停止服务 |
| `client.js` | 浏览器半边：单文件 bundle，注册面板 / 入口 / 右侧栏 tab / 会话头部按钮 |
| `server/service.mjs` | 服务主体：路由分发、状态编排、扫描调度、模型解析、命令处理、SSE 广播 |
| `server/sessions.mjs` | 会话扫描与解析：发现、zstd 解压、事件解析、摘要 / 证据 / 子任务 / 产物提取 |
| `server/analyzer-rules.mjs` | 本地规则引擎：从解析结果推导任务、状态、进度、问题、优先级 |
| `server/native-llm.mjs` | 惰性获取 DSH 模型服务、选择推理设置、读取流式输出和映射用量 |
| `server/analyzer-llm.mjs` | 可选 LLM 引擎，负责研判提示词、JSON 提取、重试与预算 |
| `server/quick-chat.mjs` | 快聊模型调用，负责各模式的提示词、参考资料校验、流式 HTTP 响应、并发、断开取消和限时 |
| `server/projects.mjs` | 项目、日期及任务规划字段的存储格式与文本上限 |
| `server/store.mjs` | 持久化：`state.json` / `sessions-cache.json`，原子写、裁剪、版本迁移、损坏恢复 |
| `server/auth.mjs` | owner 鉴权决策表：归一化 `connection.admit()` 结果，异常/畸形输入一律 fail-closed 403 |
| `server/task-relations.mjs` | 任务关系校验与环检测、问题文本标识 |
| `server/http.mjs` | HTTP 公共设施：JSON 响应、受控请求体读取、错误分类、id / 载荷校验 |
| `server/titles.mjs` | 标题相似度：为用户发起的相似任务查询提供确定性的纯字符串打分 |
| `cordis.patch.yml` | Cordis bundle patch：只把 host 插件 insert 进 profile，**不含 `config:` 块**；看板设置来自 `state.json`（设置页） |
| `install.sh` / `uninstall.sh` | 把仓库链接进 DSH profile / 定向移除本插件的依赖与 bundle 条目 |
| `scripts/` | 校验、文档检查、版本一致性、隐私扫描、市场索引生成、发布辅助 |
| `tests/` | `node --test` 套件（store / analyzer / sessions / service / http / auth / titles / host-entry / package / market-index / privacy） |
| `docs/` | 公开文档、截图、GitHub Pages 落地页（`index.html`）与插件市场索引（`index.json`） |
| `.github/` | CI、发布工作流、Dependabot、Issue/PR 模板 |
| `CHANGELOG.md` | Keep a Changelog 格式的版本变更记录 |
| `dev/` | 维护者本地开发/截图/验收工具（**已在 `.gitignore` 中忽略，不随仓库分发**；见 `dev/README.md`） |
| `internal/docs-internal/` | 历史设计/QA 归档（**同样被 git 忽略**；见该目录 README） |

> npm 发布包 = `package.json` 的 `files` 列表（`index.mjs`、`client.js`、`cordis.patch.yml`、`server/`、`icon.svg`、`CHANGELOG.md`）+ npm 自动包含的 `README.md`、`README.en.md`、`LICENSE`、`package.json`。`docs/`、`dev/`、`internal/`、`.github/` 不进入 tarball。

## Host 半边

### 入口与鉴权（`index.mjs`）

1. 创建 `createKanbanService({ ctx })`，通过 `ctx.effect` 管理服务生命周期；
2. `ctx.inject(["connection", "webServer"])` 后，把 `/super-kanban/api` 注册为前缀路由；
3. 每个请求先经过 `server/auth.mjs` 的 `ownerAdmission(connection, req)`：内部调用 `connection.admit(req)`，
   只有 `owner` 身份的 peer 允许访问；返回 `{ok:false, status}`（通常 403）时直接拒绝，admission 抛错或返回
   非预期结构时同样 fail-closed；
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
   │                           （成功结果按签名 + meta 指纹进入有界 LRU，最多 6 条）
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
   │                           → resolveAiRoute()：已保存模型或 DSH 默认
   │                           → buildDigest() ≤1.5KB → DSH 原生 LLM 服务（ctx.llm）
   ▼
合并进看板                     会话锚点稳定 ID；用户锁定字段不覆盖；写历史
   │
   ▼
store.saveState()              原子写（tmp + rename）；经 SSE 通知刷新，并保留轮询恢复
   │                           （浏览器端用轻量 stateSignature 判断是否需要重渲染）
```

关键行为：

- **会话锚点**：自动任务以来源会话为种子生成稳定 ID，显式关联优先。相似标题仅用于用户查询，扫描不自动合并任务。
- **增量门控**：仅在「用户消息数增加、上一轮 turn 已结束、首次分析、手动重新研判」时调用模型；活跃 turn 内不重复分析；同一会话有最小间隔。
- **轮次结束触发**：开启自动扫描后，Host 合并 DSH 的 `turn/end` 事件，通常在最新轮次结束至少 2 秒后扫描。连续事件达到 10 秒合并上限时可先扫描已落盘部分，保留仍在等待落盘的更新。事件触发的扫描至少间隔 15 秒，繁忙时顺延。
- **扫描响应性**：扫描请求先返回，解析和应用阶段按处理时间分段让出事件循环。发送研判和应用结果前检查当前扫描范围，确保并发删除和忽略生效。
- **模型解析**。每次扫描的 AI 阶段、单卡重判、润色和快聊共用解析逻辑。已保存模型优先，否则实时读取 DSH 默认。模型不可用时，扫描走本地规则。
- **解析缓存**：`loadParsed` 的有界 LRU(6) 以「文件签名 + 文件 stat + 解析相关 meta 指纹」为键，抽屉轮询/重判/待办导入复用解析结果，文件或元数据变化时重新解析，失败不缓存。
- **刷新成本**：浏览器每 4s（扫描中 1.2s）轮询 `/state`，但只在轻量 `stateSignature`（任务 id/updatedAt/status/archived + scan/settings/usage/stats/activity/workspaces）变化时才重渲染，避免大 evidence 数组的重复序列化。
  全局、右侧和悬浮看板在同一窗口共享轮询、SSE 和在途读取。写入成功或收到变更事件后开启新一轮，迟到的旧响应会被丢弃。
- **活跃周期** · 增量发现保留轻量会话元数据，跳过周期外未变化的日志、研判和自动关联。旧卡和既有摘要仍可查看。新轮次使会话重新进入周期，手动全量扫描覆盖全部历史。
- **研判上下文** · 已关联任务优先进入摘要。额外候选仅来自同一工作区，按最近会话活动排序，并受活跃周期及摘要预算限制。
  显式或默认 provider 不可用时不自动换模型，直接规则降级并在扫描结论说明；无 `ctx.llm` 的旧 DSH 同样规则降级。
  请求不传 `sessionId`、不传 tools / 图片。
- **预算**：单次预算按 `aiBudgetMode` 解析（`auto` = min(待研判会话, 每日剩余)；`fixed` = min(单次上限 5–150, 每日剩余)）。
  按本地日历日累计 `usage.budgetUsed`，失败也占用单位。成功次数和 tokens 独立统计。AI 阶段到 10 分钟时取消在途研判；
  超预算 / 到点 / 每日耗尽的剩余会话降级规则引擎并保留到下次扫描继续，失败会话有 5 分钟冷却。
  任务优先级：从未 AI 研判的欠账 > 本轮有变化 > 最近活跃 > 会话 id 兜底（确定性）。
- **模型目录**：`GET /ai/models` 读取 `listProviders()` + 逐 provider `listModels()`，Host 侧 30s 缓存 + 目录事件失效；
  单个 provider 失败只记入 `failures[]`，不影响扫描。
- **用户工作优先（trust rule）**：AI/规则判定 `done` 但仍有未完成的 `source:"manual"` 子任务、或
  `lockedFields` 含 `subtasks` 的未完成清单时，状态降级为 `in_progress` 并写历史说明；锁定的 `status` 优先；
  `done` 时生成类子任务自动勾选，手动子任务不动；用户取消勾选会让卡回到 `in_progress`。
- **隔离失败**：单个会话解析失败只记录日志并跳过，不影响其他会话和看板。
- **并发保护**：扫描与显式 AI 命令（`task.analyze` / `task.polishPrompt`）共享同一个 analyzer，三者互斥（并发返回 409 busy，
  自动扫描顺延到下一 tick）。扫描进行中再次触发返回 busy，支持取消。结论写入 `scan.message`，供扫描按钮提示和维护视图读取。

### 两个分析引擎

| 引擎 | 输入 | 输出 | 何时使用 |
| --- | --- | --- | --- |
| 规则（`analyzer-rules.mjs`） | 本地解析结果 | 任务标题 / 目标 / 状态 / 进度 / 问题 / 证据（启发式） | 默认基线；关闭 AI、无 DSH 模型服务、模型不可用、超预算时 |
| LLM（`analyzer-llm.mjs`，经 `native-llm.mjs`） | 压缩摘要 digest + 已有任务上下文 + 解析出的 provider/model | 结构化 JSON（任务、状态、进度、问题、关键事实、置信度、理由、merge 建议） | AI 开启、解析出可用 route、预算内、门控通过时 |

LLM 请求经 **DSH 原生 LLM 服务**（`ctx.llm`）发出：插件不再直连模型端点、不读取 `.credentials.yaml`、不保存凭证；
模型与 provider 来自看板的模型选择（默认跟随 DSH 默认模型），第三方模型在「DSH 设置 → 模型」中配置。
调用失败（网络 / 鉴权 / 限流 / 非法 JSON）会按错误码重试（≤3 attempt）后降级规则引擎并写入失败冷却。
实际使用的 provider/model 记录到 `task.ai`。

### 任务判断与写入

- 规则引擎分别记录会话运行情况、任务阶段和完成依据。普通轮次正常结束时保留待确认状态，明确的 DSH 目标完成、当前轮待办完成或用户确认可提供完成依据。
- 浏览器用 DSH `useSessionStatus` 读取关联会话的运行和待交互状态，快照里缺失的会话视为空闲。宿主未提供该快照时，依据扫描快照和最近活动显示「可能运行中」。主会话提供任务阶段依据，其他会话可以补充证据、运行和待交互信息。
- 用户填写的验收条件随任务保存。主会话提供完成依据时进入待验收，人工确认记录完成依据。续做草稿按用户选择的关联会话生成，保留当前验收条件、已知交付物、未完成项和来源定位。
- 文件证据按事件发生时的工作目录解析。扫描缓存只保留近 15 分钟、仍未结束轮次的成功写入摘要，按已核验 Git 工作树和实际文件聚合。浏览器再用 DSH 原生运行状态确认是否提示可能同时修改。
- 用户命令通过同步候选状态提交。原子写成功后发布，失败回滚内存变更。长扫描保留可重试的保存状态。
- 编辑器将草稿和打开时的字段值、当前值对比。不同字段自动同步；同一字段出现不同值时，由用户选择草稿或最新值，再用当前版本提交。
- 任务删除与显式合并保存恢复快照。关系校验集中在领域模块。备份恢复校验预览的文件内容与看板版本，写入恢复点后才替换现有状态。
- 项目归属、到期日和备注通过用户命令提交。项目可绑定一个 DSH 工作区，自动建卡时按精确的工作区 ID 归入项目。工作区列表来自 DSH 注册表和扫描发现结果，关闭自动扫描时仍能从注册表绑定工作区。
- `quick-chat.mjs` 共用模型解析和 `native-llm.mjs` 的流处理，单独管理在途请求、断开取消和限时。客户端提交有限的问答历史，Host 核对实际模型后再转发。

### 持久化（`store.mjs`）

- `state.json`：`version`、`projects`、`tasks`、`settings`、`usage`、`ignoredSessions`、`suppressedSessions`、`deletedLog`、`workspaces`、`activity`、`scan`。旧 v2 数据加载时补齐项目和规划字段。
- `sessions-cache.json`：`sessions[sessionId] = { sigKey, meta }`，用于跳过未变化会话与 AI 门控。
- 写入是原子的（临时文件 + rename）；解析失败的文件会移动到 `backups/` 后以默认值重建。
- `version` 变化时执行迁移（v1 → v2），迁移失败同样走备份 + 重建路径。
- 文本与载荷上限统一由 `TEXT_LIMITS` 常量定义（title 80 / goal 280 / acceptanceCriteria 600 / tags 4×12 / subtasks 12×60 /
  issues·nextSteps 5×160 / milestones 20×120 / keyFacts 6×60 / evidence 8（text 200、quote 160）/
  artifact name 80 / history 20）；加载与保存走同一个 `truncateTask`，客户端表单镜像同一组上限。
- `seq` 由 `positiveSeqOrNull` 归一化：正整数或 `null`（永不为 0），无法定位时间线时 UI 不显示 `#N`。

### HTTP API

所有路由前缀为 `/super-kanban/api`，同源 `credentials: same-origin`，错误结构统一 `{ ok: false, error, message }`。完整接口、字段与命令列表见 [CONTRACT.md](CONTRACT.md)。

| 路由 | 作用 |
| --- | --- |
| `GET /state` | 看板快照：任务、统计、工作区、扫描状态（含 AI 预算观测字段）、设置、用量 |
| `GET /ai/models` | AI 模型目录（DSH 原生 LLM 服务；只读，30s 缓存，provider 失败隔离） |
| `POST /command` | 任务 / 设置 / 扫描等操作（`task.*`、`settings.update`、`scan.*` 等） |
| `GET /session/:id` | 单会话事件时间线（证据跳转用） |
| `GET /export` | 导出完整看板 JSON |
| `GET /events` | 可选 SSE：扫描进度与任务变化（供第三方集成；浏览器订阅以触发刷新） |
| `GET /ping` | 存活探测（开发脚本用，不含敏感数据） |

## 浏览器半边（`client.js`）

单文件、无构建，通过 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 注册插件。`factory` 内使用 `require("react")` 与 `React.createElement`（无 JSX）。

### 注册的扩展点

| 扩展点 | 内容 |
| --- | --- |
| `main` slot | 全局看板主面板（`key = "super-kanban"`） |
| `sidebar.panellist` | 左侧栏「任务看板」入口 |
| `sidebarRightTabs.register` | 右侧看板的 tab 类型（`kind = "super-kanban"`） |
| `sidebar.right.pane.tab` slot | 右侧看板内容 |
| `conversation.session.header.utilities` | 会话头部入口：按默认形态打开看板，菜单里切换形态、打开快聊、显示或隐藏悬浮入口 |
| `shell.overlay` | 窗口级浮层：悬浮入口、悬浮看板和快聊弹窗 |

### 状态与数据流

- 首屏拉取 `/state`，空闲约每 4 秒轮询，扫描中约每 1.2 秒。页面隐藏时暂停刷新，恢复可见时补一次。可用时，`GET /events` 的 SSE 更新会提前触发重读。
- 看板写操作通过 `POST /command` 和备份接口提交，快聊使用独立的流式接口。模型选择经 `settings.model` 保存，并更新当前路由显示。
- 模型弹窗按需读取 `GET /ai/models`，按提供方分组，凭证保留在 DSH。当前生效路由随 `/state` 返回，见 [接口契约](CONTRACT.md)。
- 设置弹窗的预算与用量：单次上限单下拉（自动（推荐）/ 20 / 40 / 80 / 150）、每日上限、今日用量行
  （已用 / 上限 / 剩余 / tokens / 上次扫描）；页头扫描运行中可显示 `· AI c/预算`。
- 抽屉展示 `task.ai`（引擎 / 提供方与模型 / 置信度 / 时间 / 理由）；无 `provider` 的旧任务只显示模型；
  来源会话在研判后又有新活动（`lastActivityAt > analyzedAt + 5 分钟`）才提示「可能已过期」；「重新研判」调用
  `task.analyze`；编辑中的草稿在后台更新后保留并显示提醒。
- 抽屉、浮层、筛选等纯 UI 状态保存在本地（localStorage / 组件状态），不入库。跨形态共享的界面状态（显示偏好、悬浮面板是否展开、
  快聊记录、打开的对话框数量）放在模块内的小型 store 里，组件用 `useStore` 订阅。快聊记录只在内存中，不写 localStorage。
- 深浅色、字体、圆角全部使用 DSH 设计 token，不引入外部字体 / 图片 / 网络资源。

### 三种形态与自适应

- 同一个 Board 组件接受 `surface: "page" | "side"`。悬浮看板是独立的轻量面板，与前两者共用数据读取、任务信号和验收规则。
- 三种形态互斥，由 `host.openSurface(surface, sessionId, from)` 统一协调：打开全局或右侧看板时收起悬浮面板。打开悬浮看板时回到会话，
  并关闭看板自己的右侧栏标签页。右侧看板挂载时登记自己的关闭动作，全局看板是否显示读取 `layout.panelInfo`。
- 悬浮入口默认开启，常驻会话界面。全局或右侧看板显示、或有对话框打开时让位，DSH 收起右侧栏后重新出现。位置、样式和面板大小保存在显示偏好里。
- 按根容器宽度分档：窄（单列 + 状态分段）/ 中 / 宽（四列）。右侧栏可拖宽，拖到全屏时自动切到宽档。
- 抽屉在全局看板中从右侧覆盖，在右侧看板中覆盖整个面板。

### 页头与入口

全局看板和右侧看板共用模型、快聊、扫描、设置和形态切换入口。宽屏显示当前模型名称，窄栏保留图标。
快聊由 `shell.overlay` 承载，三种形态打开的是同一个全窗口弹窗。宿主没有这个插槽时，退回到面板内的弹窗。
扫描按钮显示进度、取消和重试，维护视图保留完整扫描结论。交互细节见 [设计规范](DESIGN.md)。

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
| 出站请求 | 模型请求经 **DSH 原生 LLM 服务**发出，目标是「你在 DSH 中配置的模型服务商」（官方账号 / API Key / 第三方 provider）。研判可选、可关闭，只发压缩摘要；润色和快聊仅在用户使用时发送对应内容。看板自身无其它出站请求（无遥测、无更新检查、无远程配置） |
| 凭证 | 不再由插件读取或保存：凭证由 DSH 的 credentials 机制解析，经 `ctx.llm` 使用；插件日志与导出中不含任何 token |
| 请求内容 | system prompt + 压缩会话摘要（≤1.5KB/会话）：标题、最近用户请求、最近回复、todo、错误、文件与工具摘要；不含全文、不含文件内容；不传 `sessionId`（不会附带官方会话日志扩展字段）、不传 tools / 图片 |
| 第三方模型 | 用户选择第三方 provider 时，相关请求内容会发送给该服务商（由用户自行在 DSH 中配置并承担其条款）；模型选择弹窗标明提供方，README / SECURITY 明确披露 |

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
  - 手工写成范围时，`^0.9.0` 只覆盖 0.9.x。升级到 0.10.x 时使用目标精确版本。
- **升级动作由 DSH 完成**：第三方插件没有自动升级，也没有官方「更新」按钮；升级 = 卸载旧版 → 安装目标版本，然后刷新窗口（客户端 bundle 有缓存，必要时完全退出 DSH）。
- 用户侧步骤、版本验证与排障见 [INSTALL.md](INSTALL.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；插件数据（`state.json`）与插件版本解耦（存储格式版本见 `store.mjs`）。

## 失败与降级

| 场景 | 行为 |
| --- | --- |
| 没有 DSH 模型服务（无 `ctx.llm`） | 规则引擎继续工作，看板可用；扫描结论说明「当前 DSH 未提供 AI 模型服务」 |
| 模型提供方不可用 / 未配置凭证 / 未登录 | 该会话（或整轮）规则降级 + 明确文案 + 5 分钟失败冷却；不整轮失败、不 5xx |
| 所选模型已下线 / provider 被删 | 不自动换模型：规则降级并在扫描结论提示重选；模型只是不在目录时先按原 route 尝试 |
| LLM 返回非法 JSON / 输出截断 | 带纠正消息重试（≤3 attempt）；仍失败则该会话本次用规则结果，记录日志 |
| 会话日志损坏 / 格式升级 | 跳过该会话并计数，其余会话正常 |
| 存储文件损坏 | 移到 `backups/`，以空状态重建，看板可继续使用 |
| 扫描被中断 / 取消 | 已完成部分保留，扫描状态标记取消；取消是静默的，不写 `llmError`、不进入失败冷却 |
| 浏览器服务缺失（如右侧栏不可用） | 相关按钮提示不支持，其余功能正常 |

## 测试

`tests/` 下是零依赖的 `node --test` 套件：

- `store.test.mjs` / `store-robustness.test.mjs`：默认值、裁剪、v1→v2 迁移、损坏文件与畸形 JSON 的自愈；
- `analyzer.test.mjs`：规则引擎的状态 / 进度 / 问题判断；
- `analyzer-llm.test.mjs`：原生 LLM 引擎的流累积 / usage 映射 / 失败码 / JSON 修复 / 超时与降级（fake `ctx.llm`，不联网）；
- `ai-budget.test.mjs` / `ai-models.test.mjs`：AI 预算（auto / fixed、优先级、墙钟、冷却、剩余文案）与模型解析、目录端点（fake `ctx`）；
- `sessions.test.mjs`：会话发现、事件解析、digest 预算、产物 / 子任务提取；
- `service.test.mjs`：扫描 / 合并 / 命令编排（不启动 DSH）；
- `http.test.mjs` / `auth.test.mjs`：HTTP 设施与载荷校验 / owner 鉴权 fail-closed；
- `titles.test.mjs`：合并用的标题相似度；
- `host-entry.test.mjs`：Cordis 入口（路由前缀、鉴权接线、生命周期）；
- `package.test.mjs`：包清单、files 列表、DSH 声明与脚本质量门；
- `market-index.test.mjs`：市场索引格式与生成；
- `check-privacy.test.mjs`：隐私扫描器的规则与豁免。

运行：`npm test`。
