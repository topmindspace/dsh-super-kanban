# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 新增

- 悬浮入口上方新增待审批卡片条。会话一轮结束（`turn/end`）后，任务卡立刻钉在入口上方，不依赖扫描是否开启或正忙；点卡片本体直接回到对应会话，悬停出现的绿色对号才通过 `task.accept` 把它确认到「已完成」。不点就一直保留，刷新或重启后仍在。卡片左侧是工作区首字的彩色圆标（按工作区 id 固定取色，超出后循环），右侧只留任务名、工作区和相对时间；标题放不下时悬停横向滚动，两侧淡出。卡片会留到用户点对号为止，会话又开始了新一轮也不撤；运行中的会话本身不会额外生成卡片。默认显示三张，其余折叠为「还有 N 项」，展开悬浮面板时整条让位。

### 改进

- 扫描按会话记录已处理到的 `turn/end` 序号（`state.reviewSeen`，上限 500 个会话）：安装时只播种账本，历史会话不会一次性堆满待审批条，此后每个新轮次只弹一次。验收、手动改状态、拖到完成或忽略来源会话都会清空 `review`。

## [0.10.0] - 2026-11-13

### 新增

- 悬浮入口默认在会话界面常驻。可以拖动调整位置，右键菜单可展开悬浮看板、切换到其他形态、打开快聊或隐藏入口，隐藏后可撤销。
- 悬浮看板的面板更大，可放大和固定。面板包含待验收、待处理、运行中和最近四个类别，支持搜索，底部可随手记一条待办。
- 快聊新增写提示词、解释、总结和润色模式。回答按 Markdown 显示，可放入当前会话的输入框、存为任务或重新生成。任务详情可「就此任务快聊」，把任务摘要作为参考资料。
- 快聊可从悬浮看板、悬浮入口菜单和会话页头菜单打开。记录在当前窗口内保留，刷新窗口或开始新对话时清空。

### 改进

- 全局、右侧和悬浮三种形态同一时刻只显示一种。打开悬浮看板会回到会话并关闭右侧的看板标签页，打开全局或右侧看板会收起悬浮面板。全局或右侧看板显示时，悬浮入口暂时让位。
- 会话页头入口改为图标加菜单，看板工具栏用三个图标切换形态。设置分为三组，「显示与入口」排在最前。
- 卡片、列表和任务详情用「工作区 › 项目」显示任务归属。「项目」页说明工作区、自建项目、任务和会话的关系。
- 快聊用 Enter 发送，Shift + Enter 换行。单次回答限时 60 秒，输出上限提高到 2,000 tokens。重新生成成功后才替换原回答。
- 浮层和快聊使用与看板一致的细滚动条，输入框不再出现双重焦点框。
- 更新 README 封面、悬浮看板和快聊截图，文档补充核心概念、三种形态和快聊工作流。

### 修复

- Windows 上产物、写入重叠和研判摘要里的相对路径统一使用 `/`。
- 浮层渲染出错时静默退出，不再出现覆盖整个窗口的错误页。
- 输入法组词时按 Enter 不再触发发送或提交。
- 快聊回答过程中点「新对话」不会再把中断的回答写回记录；重试成功后清空已发送的输入。
- DSH 收起右侧栏后，悬浮入口会重新出现。

## [0.9.0] - 2026-11-12

### 新增

- 会话页头和看板工具栏可切换全局、右侧和悬浮三种形态。常驻悬浮入口可选择左右位置、圆形角标／胶囊／状态条、摘要类别和空闲隐藏。新待验收任务到达时，入口给出轻提示。
- 悬浮摘要集中显示待验收、待处理和运行中的任务。可以查看交付物、打开准确的来源会话、就地确认验收，或编辑草稿继续工作。多条待审批或待回答会话各有独立入口。
- 项目视图自动显示工作区项目，并支持跨工作区的自建项目。每个项目可直接打开看板、日程和时间线。时间线按本地日期汇总任务变更、会话证据和交付，并合并重复来源。

### 改进

- 近期视图和增量扫描共用滚动活跃周期，默认 30 天。旧任务保留在历史视图，手动、置顶、运行中、待会话交互和未完成的排期任务继续可见。会话产生新活动后自动回到范围内，也可按需扫描全部历史。
- AI 研判保留已关联任务作为上下文，其他候选按同工作区的会话活动时间优先，减少陈旧任务干扰。全局、右侧和悬浮形态共用刷新连接，修改后同步刷新并丢弃过期响应。
- 补齐日常工作流、升级路径、扫描与验收说明，并同步中英文 README、插件市场页面和接口契约。

## [0.8.0] - 2026-11-11

### 新增

- 工具栏显示当前模型。可从工具栏、快聊或设置切换模型，也可跟随 DSH 默认。扫描、重新研判、润色和快聊共用这份选择。
- 快聊支持连续追问、逐条复制和清空问答。翻译独立处理当前原文。换模型后从新一轮开始记忆，已有回答仍可查看。

### 优化与修复

- 快聊显示实际应答的模型，停止或失败时保留草稿和已收到的回答。模型目录支持手动刷新，选择失败会在弹窗中提示。
- DSH 未设置默认模型时，扫描使用本地规则，快聊提示配置模型。已选模型不可用时保留选择并提示处理。
- 更新安装、接口、隐私和排障指南，移除过时的设置布局、重复示例和历史验收说明。

## [0.7.0] - 2026-11-11

### 新增

- 项目可跨 DSH 工作区。支持项目和任务备注、到期日、批量归属、按工作区自动归入未来任务，以及项目归档与恢复。
- 日程按到期时间整理未完成的任务。从项目卡可进入该项目的日程，任务详情可直接编辑备注和到期日。
- 快聊用 DSH 默认模型流式回答短问答或翻译，支持停止和复制。

### 优化与修复

- 全页与右栏使用 DSH 原生实时状态，提供运行提示和筛选。开启自动扫描后，会话轮次结束可提前触发增量更新。
- 保存后丢弃迟到的旧读取。跨窗口编辑时自动合并不同字段的改动，同一字段冲突时保留草稿供用户确认。
- 扫描可提前取消，迟到的研判结果遵守任务删除和会话排除设置。模型超时后释放扫描，失败请求计入当日研判预算。
- 整板恢复保留仍有效的合并撤销，并校验项目引用。恢复较早的备份会保留当日已消耗的预算。

## [0.6.1] - 2026-11-10

### 新增

- 任务卡和任务列表支持右键快捷操作。产物可复制文件名和路径，并通过 DSH 预览、用默认应用打开或在文件管理器中定位。
- 长列每页显示 30 张卡，可在列底翻页。「已完成」列支持折叠，折叠时仍显示计数并接受拖入。

### 优化与修复

- 页头收为两行，视图和筛选共用工具栏，完整扫描结果移到扫描按钮提示。
- 修复长列被撑高而无法滚动、矮窗口和窄侧栏的抽屉底栏菜单被裁切。归档成功后自动关闭详情。
- 菜单共用方向键导航和焦点恢复。修复宽屏工作区下拉被隐藏、跨会话产物预览落到错误侧栏，以及外部文本拖入看板可能触发换列的问题。

## [0.6.0] - 2026-11-10

### 新增

- **待处理**汇总同一任务下等待审批、回答或审阅的 DSH 会话，直接打开对应来源。新增列表、层级、产出和维护视图，侧栏支持当前会话范围。
- **任务概览**集中展示目标、验收条件、当前阻塞与主交付物。人工验收记录完成依据，活动与证据可按来源会话筛选。
- **续做草稿**包含验收条件、关键决策、未完成项与产物，支持放入关联会话或新会话。确认放入后记录新会话关联。
- 两个运行中的会话近期在同一 Git 工作树成功写入同一文件时提示可能同时修改。
- 增加任务依赖、显式关联与合并、问题管理、批量操作、置顶、回收站和备份恢复。

### 修复

- 保存失败时回滚内存修改，编辑与验收检查任务版本。普通轮次结束需补充完成依据，相似标题仅提示用户检查，手动子任务独立保留。
- 备份恢复校验预览的文件内容与看板版本。删除共享会话的一张卡时，其他卡继续扫描。
- 全页预览先定位产物来源会话，窄屏保留任务操作和单列看板。

## [0.5.2] - 2026-11-08

Documentation-only patch release: no runtime code changes. It publishes the
rewritten user documentation to the npm package page and keeps the repository
docs/market landing page in sync.

### Changed

- **User-first README** (Chinese and English): a 30-second overview, typical
  usage scenarios, result-first feature highlights, performance and limits, a
  user-readable version policy, a documentation map, and copy-paste
  **exact-version install examples** for the plugin market version list, npm
  (`dsh-super-kanban@0.5.2`), a Git tag (`git checkout v0.5.2`) and local
  source installs (with the `bash`/`python3` prerequisite called out).
- **Install guide**: every install path now has an exact-version example,
  positive/negative SemVer examples for the cross-minor trap, a corrected
  source-change behaviour note (client refresh vs host profile reload), and a
  stable heading anchor for the local-directory section.
- **Market landing page**: feature cards, all three install paths (including
  exact-version selection), first-run steps, two screenshots, compatibility
  line, FAQ and the data/privacy note now live on GitHub Pages as well.
- **Cross-document consistency**: release links point at tag trees (they
  survive Release pruning), the changelog maintenance notes were deduplicated,
  SECURITY's supported-version policy was aligned with the README, the MARKET
  release flow was clarified, ARCHITECTURE documents the parsed-session LRU and
  the lightweight polling signature, and CONTRIBUTING's test command was fixed.
- Repository maintenance: `main` now requires a pull request with one
  approving review in addition to the passing CI checks (maintainers can still
  bypass for release commits); GitHub Releases are pruned to the newest three
  after every release, while tags and commits are retained so historical
  version pins and changelog tag links keep working. Older changelog entries
  (0.3.0/0.4.0) link to their tag trees instead of pruned release pages.
- `check-docs` now follows GitHub's real heading-slug rules (each space becomes
  one hyphen), so multi-space anchors are validated instead of silently
  passing.

## [0.5.1] - 2026-11-08

Patch release focused on performance, editor consistency and maintenance after
the v0.5.0 release review.

### Changed

- **Faster session parsing**: the host now keeps a bounded LRU (6 entries) of
  parsed session logs, keyed by file signature plus a metadata fingerprint.
  Repeated reads from the session drawer polling, “重新研判” and todo import
  skip decompression/re-parsing, while changed files or metadata still force a
  fresh parse. Failures are never cached.
- **Lighter board polling**: the browser half now compares a compact state
  signature (task id/updatedAt/status/archived plus scan/settings/usage/stats/
  activity/workspaces) instead of stringifying the complete `/state` payload on
  every 4s/1.2s poll; large boards no longer pay the evidence-array serialization
  cost on each tick.
- **Auto-card identity is kept on no-op edits**: `task.update` only turns an
  `auto` card into `auto+edited` when a field or lock actually changed, and
  `task.move` only does so on a real column change, so duplicate-card merging
  and “untouched auto card” semantics stay consistent.
- **Safer uninstall**: the uninstall helper now removes only the plugin’s
  dependency and bundle entry from the DSH profile instead of restoring the
  whole pre-install profile backup, preserving other plugins and profile edits
  made after installation. `install.sh` still records a first-install backup,
  now documented as a snapshot only (never auto-restored).
- **Third-party privacy hint uses an official-route whitelist**
  (`deepseek-account` / `deepseek-official`); custom providers named
  `deepseek-*` now correctly show the “digest will be sent to this provider”
  notice.
- Narrow-sidebar status tabs now expose `aria-controls`/`tabpanel` wiring for
  assistive technology.
- Documentation: version examples updated to 0.5.1, the `main` branch protection
  and release flow documented, and the targeted uninstall behaviour described in
  INSTALL/CONTRIBUTING/DEVELOPMENT.

## [0.5.0] - 2026-11-08

### Added

- **AI analysis through the DSH native model service**: analysis requests now go
  through DSH's `llm` service instead of the plugin's built-in DeepSeek API
  client. Model catalogue, default model, third-party providers and credentials
  are all managed by DSH; the plugin no longer reads `.credentials.yaml` or
  hard-codes a model endpoint, and old DSH builds without the service fall back
  to the rules engine with an explicit scan message.
- **AI model selection**: new board settings `aiProvider`/`aiModel` (empty =
  follow the DSH default model, which is a live reference), an “AI 研判模型”
  block in the settings dialog with a native grouped select and a refresh
  button, and support for models configured in **DSH Settings → Models**
  (catalogue providers or custom OpenAI/Anthropic-compatible endpoints), which
  become selectable without restarting the board.
- **Model catalogue endpoint** `GET /super-kanban/api/ai/models` (flat
  `{ok, catalogAvailable, default, providers, models, failures, fetchedAt}`,
  owner-only, 30s host cache, per-provider failure isolation) and
  `task.ai.provider` for the drawer (“provider / model”; rules results now carry
  `model:""`, `provider:null`).
- **Automatic AI budget**: new `settings.aiBudgetMode` (`"auto"` default =
  min(sessions due this scan, daily remainder) or `"fixed"`); the per-scan limit
  `maxAiCallsPerScan` can now be set up to **150** (5–150, fixed mode only), the
  daily limit stays 150 budget units, and a 10-minute AI-phase wall clock plus a
  5-minute per-session failure cooldown keep long scans bounded.
- **Budget observability and continuation**: new optional scan fields
  `aiDue/aiBudget/aiAttempts/aiPending/aiDeferredReason`; scans prioritise
  never-analysed sessions, then changed, then most recently active; messages
  such as “剩余 N 个会话下次扫描继续” / “今日 AI 预算已用完（150/150）· 剩余 N 个会话明日继续”
  explain deferred work, and the settings page shows used/limit/remaining,
  tokens and the last scan.

- **Task-level AI review and re-analysis**: the drawer shows an “AI 研判 / 规则推断”
  block (engine, model, confidence, last-analysis time, one-line reason) and a
  “重新研判” action in the ⋯ menu that reruns `task.analyze` for a single card.
  “可能已过期” appears only when the source session has activity newer than the
  analysis; re-analysis reports engine/calls/tokens in a toast.
- **Persistent scan outcome** in the board header: the last-scan line keeps the
  host message (sessions processed, AI calls/tokens, “本次无 AI 调用”, budget
  fallback, cancellation, failure + retry), and the scan button reads
  “扫描（仅规则）” when AI is disabled.
- **Accessibility and keyboard support**: dialogs/drawer use `role="dialog"` +
  `aria-modal` + `aria-labelledby` with a focus trap and focus restore; cards are
  keyboard-openable with visible focus rings; icon-only buttons have
  `aria-label`s; subtask rows are real toggle + delete buttons; toasts and scan
  state are announced via `aria-live`; Esc closes the topmost layer.
- **Board and drawer usability**: backlog/archived counts in the summary (zero
  values hidden), expand-all for issues/next steps, draft edits survive
  background polls (with a quiet “后台已更新” note), the continue prompt keeps
  user edits when the target changes, search covers goal/key facts/issues/next
  steps, completed cards no longer draw the coloured progress line, archived
  cards get a “已归档” marker, and the right-sidebar workspace filter stays
  visible at every width.
- **Backend**: new test-covered modules `server/auth.mjs`, `server/http.mjs` and
  `server/titles.mjs`; the host test suite grew from 55 to 177 tests
  (`sessions`, `service`, `store-robustness`, `http`, `auth`, `titles`,
  `host-entry`, `analyzer-llm`); `server/sessions.mjs` now parses session-event
  payloads from `event.data` (lineage/cwd had silently fallen back to the
  projection cache).
- **CI/CD**: `scripts/check-docs.mjs` and `scripts/check-version.mjs` with
  `npm run check` / `check:docs` / `check:version` aggregates wired into CI and
  the release workflow; non-blocking coverage report; stricter `npm pack`
  contents assertions; Dependabot for GitHub Actions.
- Maintainer documentation for the git-ignored `dev/` and
  `internal/docs-internal/` trees, plus reproducible dev scripts.

### Changed

- **AI budget default behaviour change**: upgrading from 0.4.x switches the AI
  budget from a fixed 40 calls to “auto” (up to the daily remainder). The daily
  limit (150), the local-day rollover and the rules-engine fallback are
  unchanged; pick “固定 40 次” in settings to restore the old behaviour.
- **Analysis results record the provider**: the drawer shows provider / model
  for new analyses; `task.ai.model` is empty and `task.ai.provider` is `null`
  for rules results (the rules engine no longer copies the deprecated
  `settings.model`). Existing tasks are not rewritten and keep rendering with
  the model they show today.
- **Old clients stay compatible**: a `settings.update` whose patch contains
  only the budget keys (`maxAiCallsPerScan`/`dailyAiCallLimit`, no
  `aiBudgetMode`) is treated as `"fixed"` for that update; a legacy page saving
  its full settings form no longer silently switches an auto budget to fixed.
  Loading an old `state.json` still defaults to `"auto"`.
- `settings.model` is deprecated and no longer used for analysis; it is kept
  only for old-state / old-client compatibility and will be removed in v0.6.
- README (zh/en), SECURITY, CONTRACT, ARCHITECTURE, DESIGN, INSTALL, MARKET and
  TROUBLESHOOTING now describe the DSH-native model path, third-party data
  recipients, the new budget semantics and the 0.5 upgrade notes.
- Text limits are now a single source of truth (`TEXT_LIMITS` in
  `server/store.mjs`): title 80, goal 280, tags 4×12, subtasks 12×60,
  issues/next steps 5×160, milestones 20×120, key facts 6×60, evidence 8
  (text 200 / quote 160), artifact name 80; client forms use the same maxima so
  edits are no longer silently truncated.
- Evidence/issue/key-fact/subtask/milestone `seq` may be `null` when a citation
  cannot be resolved against the session timeline (never a misleading `#0`); the
  UI hides unresolved `#N` badges.
- “今日” AI usage and the daily budget roll over at the user’s local midnight
  instead of UTC.
- AI/rules “done” is kept as `in_progress` (with a history note) while unfinished
  manual or locked subtasks remain; locked status always wins; generated
  subtasks still auto-close on done.
- HTTP edge validation: malformed command bodies, unknown/prototype-inherited
  ops, malformed session ids and oversized bodies now return 400 instead of 500;
  routes and successful response shapes are unchanged.
- README.zh/README.en, INSTALL, CONTRACT, DESIGN, ARCHITECTURE, DEVELOPMENT,
  TROUBLESHOOTING and the market landing page were re-checked against the code
  (export filenames, `/ping`, `/session` limits, `TEXT_LIMITS`, nullable `seq`,
  trust rule, local-day budget, the real re-analysis path, and an explicit
  roadmap for features that are not available yet). `docs/screenshots/*.png`
  were regenerated from the synthetic demo dataset and pass the demo privacy
  audit (no forbidden strings in visible text).

### Fixed

- The budget-exhausted scan message no longer reports pre-scan “used/limit”
  numbers (it could show e.g. 23/24 while the scan had actually used 24/24);
  all counters in the scan message are now post-scan.
- A failed analysis no longer leaves the session to be retried on every scan:
  failures write `llmError`/`aiErrorAt` and honour the 5-minute cooldown, while
  a cancelled scan no longer records a failure.
- `task.analyze` now counts analyses that decide “no card needed” (ignore/empty)
  against the budget and reports the consumption honestly.
- The “budget used up” flag is now set for mixed success/failure batches too, so
  the scan message no longer silently omits that the budget ran out.
- Clicking “锁定字段” in the task drawer no longer throws (`EDITABLE_FIELDS` was
  referenced but never defined).
- Scan finalization can no longer leave the scan mutex locked (and emit an
  unhandled rejection) when the host logger or persistence throws.
- Corrupt/partially written session logs no longer force a full re-parse on
  every scan; unchanged sessions are not re-parsed just because AI is enabled
  without credentials.
- Single-task “AI 润色” reports failure honestly instead of claiming success when
  AI is disabled/unavailable.
- Background polling no longer discards unsaved drawer edits or continue-prompt
  edits.
- Search matches goal text again (it previously compared against
  `[object Object]`).
- SSE clients that half-close are dropped (plus a client cap), request bodies
  have byte/time limits, and store loading sanitizes hostile-but-valid JSON;
  backup retention also prunes `.migrate-failed` files.
- Duplicate-title merge helpers were consolidated (a duplicate `dedupeByText`
  definition silently overrode the first).
- Privacy scanner no longer flags long kebab-case `sk-*` UI ids as API keys.
- `scripts/release.mjs` regenerates the market index before running checks.
- The new-task dialog no longer claims sessions can be linked from the drawer
  (relinking is a documented roadmap item).
- **AI commands and scans are now mutually exclusive**: `task.analyze` and
  `task.polishPrompt` share one in-process mutex with scans, so a long
  re-analysis can no longer race an automatic scan, overwrite the shared
  analyzer budget or skew daily usage; concurrent explicit commands return 409
  with a specific message, and auto scans simply defer to the next tick.
- **“重新研判” re-judges exactly one session**: it now targets the card's
  `primarySessionId` (falling back to the first linked session), consuming at
  most one budget unit; previously a multi-session/relinked card ran up to 12
  analyses and kept only the last result. A broken source log now returns
  `400 session-parse-failed` instead of silently producing a rules result.
- SSE clients that stop reading are dropped on backpressure (1MB buffer or a
  failed write) instead of growing the host buffer without bound.
- The legacy-client budget inference is now limited to budget-only patches
  (see “Changed”); unrelated saves from an old page keep the current mode.
- Token accounting falls back to input+output+cache tokens when a provider
  omits `totalTokens`.
- Host logs no longer print the DSH home path or task titles; merge/build logs
  use ids and the ready line only reports counts.
- The bundle patch no longer carries an unused `config:` block (settings live in
  the board state), and the validator now requires `server/native-llm.mjs` in
  the shipped server files; CI's `npm pack` assertions also cover it.
- README.md/README.en.md were rewritten to a ~110-line user-first quick start
  (install → first steps → features → model/privacy → FAQ), and public docs
  were corrected after a pre-release accuracy/privacy review (third-party data
  recipients, polling vs SSE, `/session` status enum, workspace source enum,
  release flow, settings order and version examples).

### Security

- **Third-party model disclosure**: the compressed session digest (≤1.5KB per
  session, including session excerpts) is sent to the model provider selected
  through DSH; explicitly choosing a third-party provider sends it to that
  provider. The settings dialog, README and SECURITY document this, and the
  previous “nothing is sent to third-party servers” wording has been removed.
- **Credential handling moved to DSH**: the plugin no longer reads or parses
  `.credentials.yaml`, no longer holds a DeepSeek token and no longer
  hard-codes an API endpoint; requests go through DSH's native model service
  and its credentials seam, so the plugin never sees provider credentials.
- **No session-log upload**: analysis requests do not pass a `sessionId`, so
  DSH's official session-log extension is not attached to model requests.

## [0.4.1] - 2026-11-05

Documentation-only patch release: the plugin code is unchanged from 0.4.0.

### Added

- **Upgrade guide**: how to update an installed plugin, how to verify the
  installed version, the SemVer-range pitfall (`^0.3.0` never resolves 0.4.x;
  cross-minor upgrades need an exact version or a reinstall), and how to roll
  back.
- **Troubleshooting guide** (`docs/TROUBLESHOOTING.md`): stale UI after an
  update, missing entry point, blank board, 401/403, scanning and AI issues,
  artifact previews, sidebar widths, uninstall/data retention and diagnostics.
- **Absolute README asset and document links**, so screenshots, the demo GIF
  and docs links render correctly on the npm package page as well as GitHub.

### Changed

- README (Chinese and English), INSTALL, MARKET, DESIGN, ARCHITECTURE,
  DEVELOPMENT and CONTRACT were re-checked against the 0.4 UI and updated where
  they still described earlier behaviour (toolbar actions, accent marks, board
  status markers).

## [0.4.0] - 2026-11-05

UI refinement release: put the frequently used toolbar actions back on the
toolbar and bring back restrained emphasis and status marks without returning
to the earlier visual clutter.

### Added

- **Toolbar actions are visible**: Settings and "open in right sidebar" are
  now persistent icon buttons in the board header and the compact right-panel
  header. The overflow menu keeps only **Export JSON**.
- **Restrained emphasis and status marks**: cards show a small status dot and a
  state-tinted progress line (backlog neutral, in progress brand, blocked
  amber, done green), colored priority text (P0 error, P1 amber), issue count,
  artifact count, subtask progress and a low-key AI/rules marker. Column
  headers and the summary line carry matching status dots.
- **Task drawer depth**: colored status/priority text, type icons for key
  facts, severity-colored issues, and a brand-colored session link, while the
  primary button and DSH typography stay neutral.
- **English README** (`README.en.md`) alongside the Chinese README.

### Changed

- Color is now limited to dots, thin progress lines, small icons and short
  labels; there are no colored blocks, gradients or glow effects. Light and
  dark themes, the full board, the compact sidebar and narrow windows were all
  checked against the DSH type scale and spacing.

## [0.3.0] - 2026-11-05

First public release. Super Kanban turns the sessions of a DeepSeek Harness
workspace into a maintainable task board.

### Added

- **Automatic task analysis**: sessions are scanned on a schedule and turned
  into tasks with goal, status, progress, priority, issues, next steps,
  milestones and traceable evidence.
- **Two analysis engines**: a zero-dependency rules engine that always works
  offline, and an optional LLM engine that reuses the local DSH account quota
  and degrades to rules when disabled, over budget or offline.
- **Task detail drawer**: key facts first, editable status, subtasks, issues /
  next steps, session context, artifacts and evidence with a direct jump back
  to the source session.
- **Session hand-off**: one-click "continue this task" prompt built locally
  from the task context (no model call), inserted into the original session or
  a new session in the same workspace.
- **Subtask, artifact and goal tracking**: deterministic extraction from todo
  snapshots, write/edit tool calls and presented deliverables, plus DSH session
  goals when available.
- **Dual presentation**: a full-page board panel and a compact right-sidebar
  panel, with configurable entry visibility and a shortcut from the session
  header.
- **Manual task management**: create, edit, drag between columns, archive,
  delete, relink sessions, lock fields so analysis never overwrites them.
- **Local-first storage**: board state under the DSH home storage directory,
  atomic writes, corrupt-file recovery and version migration.
- **DSH-native visual language**: monochrome-first styling, a restrained type
  scale, hairline borders and DSH design tokens for light and dark themes.

### Changed

- Analysis output and storage are budgeted: compact session digests, incremental
  gating, per-scan and daily AI call limits, and capped evidence, key facts,
  subtasks, artifacts and history.
- Evidence and task payloads are trimmed for density; the board and drawer
  prioritise "what matters now" over raw transcript dumps.

### Security

- The plugin runs locally inside DSH, reads session storage read-only, serves
  its HTTP API to the authenticated owner only, and sends nothing to third
  parties. When the LLM engine is enabled it calls the DeepSeek inference API
  with the local DSH account token; tokens are never logged or persisted by the
  plugin. See [SECURITY.md](./SECURITY.md). *(Historical v0.3.0 note; since
  v0.5.0 model requests go through the DSH native model service — see the
  current SECURITY.md.)*

[Unreleased]: https://github.com/topmindspace/dsh-super-kanban/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/topmindspace/dsh-super-kanban/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/topmindspace/dsh-super-kanban/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.8.0
[0.7.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.7.0
[0.6.1]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.6.1
[0.6.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.6.0
[0.5.2]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.5.2
[0.5.1]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.5.1
[0.3.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.3.0
[0.4.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.4.0
[0.4.1]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.4.1
[0.5.0]: https://github.com/topmindspace/dsh-super-kanban/tree/v0.5.0
