# 开发指南

本文说明如何在本地开发、调试与测试 Super Kanban。首次参与贡献请先阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 环境

- **Node.js** `>= 22.19.0`（使用内置 `node:zlib` 的 zstd API）。
- **DeepSeek Harness** 桌面版，或 `dsh` CLI（`dsh web`）。桌面版安装不保证 CLI 在 `PATH` 中；macOS 的 CLI 位于应用包的 `Contents/Resources/app.asar/dsh/`，`dev/` 下的本地脚本演示了如何从应用包启动；没有 CLI 时请用桌面版/插件页操作。
- **零依赖**：仓库不需要 `npm install`，没有打包步骤；`client.js` 是手写 bundle。

## 2. 目录速览

| 路径 | 说明 |
| --- | --- |
| `index.mjs` | Host 入口（路由、鉴权、服务生命周期） |
| `server/` | Host 实现：扫描 / 规则 / LLM / 存储 / HTTP 服务 |
| `client.js` | 浏览器半边（单文件，无 JSX、无构建） |
| `cordis.patch.yml` | 把 host 插件插入 DSH profile（无 `config:` 块，设置存看板 `state.json`） |
| `install.sh` / `uninstall.sh` | 本地链接安装 / 定向卸载（移除依赖与 bundle 条目，不用安装前备份整体覆盖 profile） |
| `scripts/` | validate、文档检查、版本一致性、隐私扫描、市场索引、发布辅助 |
| `tests/` | `node --test` 套件 |
| `docs/` | 公开文档、截图、GitHub Pages 落地页（`index.html`）与市场索引（`index.json`） |
| `.github/` | CI / Release 工作流、Dependabot 配置、Issue/PR 模板 |
| `CHANGELOG.md` | Keep a Changelog 格式的版本记录 |
| `dev/` | 维护者本地工具：隔离实例、API/截图、design audit、demo、verify（**git 忽略，不随仓库分发**） |
| `internal/docs-internal/` | 历史设计与 QA 归档（**git 忽略**；见该目录 `README.md`） |

### 2.1 本地维护者目录（git 忽略）

为了让公开仓库保持干净，`.gitignore` 忽略了两类只在维护者机器上存在的目录：

- `dev/`：隔离实例脚本（`restart-test.sh`、`restart-ui.sh`）、`api.sh`、`shot.mjs`、`design-audit.js`、`demo/`、`probe/`、`verify/`。每个工具的用途、前置条件与当前状态记录在 `dev/README.md`。
- `internal/docs-internal/`：v1–v3 开发期的设计/QA 历史记录，路径已按当前仓库布局更新，仅作追溯用途，其权威性让位于 `docs/`。

这两类目录不会出现在 npm 包或新克隆的仓库里；修改它们不影响 CI。公开文档不应依赖它们（如需引用，用反引号路径而不是 Markdown 链接）。

## 3. 隔离开发实例

不要直接用自己日常使用的 `~/.dsh`。推荐：

```bash
export DSH_HOME="$HOME/.dsh-dev"     # 独立 home
dsh web --port 56790                 # 或按 DSH CLI 的方式启动 web 实例
./install.sh -y                      # 把当前 checkout 链接进该 profile
```

打开 `http://127.0.0.1:56790`，刷新窗口后从左侧栏打开「任务看板」。

- host 半（`index.mjs` / `server/**`）改动：重启该 DSH 实例（或触发 profile 重新加载）后生效。
- 浏览器半（`client.js`）改动：刷新窗口即可；如果使用 DSH 的开发模式（HMR），模块会自动重载。
- 想验证 AI 引擎，在隔离 DSH 中配置本地测试模型，用看板的「选择模型」切换。分别验证共享路由、无默认模型时的本地规则，以及缺少模型时快聊的提示。

## 4. 调试

### 4.1 API

`dsh web` 启动日志里会输出带 token 的本地 URL，用它换取 cookie 后可直接调用插件 API：

```bash
# 用浏览器打开一次带 token 的 URL，然后在同源页面里 fetch
curl -s -b "<cookie>" http://127.0.0.1:56790/super-kanban/api/state | head -c 400
```

常用端点：

- `GET /super-kanban/api/state`：看板快照；
- `POST /super-kanban/api/command`：`{ "op": "scan.start", "payload": { "mode": "incremental" } }` 等；
- `GET /super-kanban/api/session/<id>`：单会话事件时间线。

完整契约见 [CONTRACT.md](CONTRACT.md)。

### 4.2 日志

- host 侧日志（插件 warn / scan 结果）通常输出到 DSH 实例日志；开发时也可以在看板设置里观察扫描状态与 AI 用量。
- 浏览器侧：打开 DSH 窗口的开发者工具查看控制台与 `/super-kanban/api/*` 网络请求；插件不会吞掉 console 中的异常。

### 4.3 数据

开发用 home 的看板数据在 `$DSH_HOME/storages/super-kanban/`。调试时可以：

- 删除 `state.json` 让插件重新全量扫描；
- 直接查看 `sessions-cache.json` 的 `sigKey` 判断某个会话为什么被跳过；
- 破坏一份 `state.json` 验证备份与重建路径（会移动到 `backups/`）。

## 5. 分析流水线开发

扫描分为「发现 → 解析 → 规则 →（可选）LLM → 合并」五段，细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

开发建议：

1. **先用规则引擎验证**：规则路径不消耗额度，是最容易复现的入口；改 `analyzer-rules.mjs` 后用测试夹具跑。
2. **再验证 LLM 路径**：给 `createLlmAnalyzer({ ctx })` 注入 fake `ctx.llm`（参考 `tests/analyzer-llm.test.mjs`），构造固定的会话解析结果（`parsed`）与 digest，不依赖真实网络；失败路径（超时 / 非法 JSON / 预算耗尽）要有降级。
3. **保持 digest 预算**：`buildDigest` 输出必须 ≤1.5KB；新增字段时在测试里断言 UTF-8 字节数。
4. **保持合并幂等**：同一个会话多次扫描不应重复建卡；用户锁定字段不得被覆盖。
5. **隔离单会话失败**：解析失败只跳过该会话并计数，不能让整次扫描失败。
6. **文本上限只有一处**：截断值统一用 `server/store.mjs` 的 `TEXT_LIMITS`（客户端 `client.js` 有镜像常量）；新增/调整上限时同步改两处、补 `tests/store.test.mjs`，别在各调用点写魔法数字。
7. **状态信任规则**：AI/规则 `done` 在存在未完成手动子任务或锁定子任务清单时会被降级为 `in_progress`（见 `service.mjs` 的 trust rule）；改这块要补 `tests/service.test.mjs`，并确保历史记录里能解释原因。
8. **`seq` 语义**：引用序号用 `positiveSeqOrNull` 归一化——正整数或 `null`（永不为 0）；新增列表字段时同样处理，UI 只在有效时显示 `#N`。
9. **每日用量按本地日**：`todayKey` 使用用户本地日历日；改预算/用量逻辑时不要退回 UTC 日。

### 存储与版本

- 存储版本常量在 `store.mjs`（当前 v2）。新增字段时同步更新裁剪逻辑与迁移函数。
- v1 → v2 的迁移路径已有测试覆盖；新版本迁移要新增对应测试夹具。
- 写文件必须走原子写（临时文件 + rename）。

## 6. 测试与检查

```bash
npm test              # node --test "tests/**/*.test.mjs"
npm run validate      # 包清单 / Cordis patch / 文件清单 / 市场索引
npm run check:privacy # 个人路径、凭证、真实会话 id 等敏感内容扫描
npm run check:docs    # 文档链接 / 锚点 / 截图 / 中英 README 结构 / Pages 落地页
npm run check:version # package.json、CHANGELOG、市场索引、SECURITY 与兼容范围一致性
npm run check         # 以上全部检查（CI 的等价入口，提交 PR 前推荐）
npm pack --dry-run    # 查看将发布的 tarball 内容
```

CI（`.github/workflows/ci.yml`）在两个 Node 版本（22.19 / 24）上执行同样的检查：
`node --check` 语法检查 → `npm test` → `npm run validate` → `npm run check:privacy`
→ `npm run check:docs` → `npm run check:version` → `npm pack --dry-run` 内容断言。
其中 Node 22.19 那条还会输出 **非阻塞** 的覆盖率报告
（`node --test --experimental-test-coverage`），仅作参考，不设阈值、不因覆盖率下降失败。

CI 之外，`.github/dependabot.yml` 每周检查 GitHub Actions 的版本更新；仓库没有 npm 依赖，
因此不追踪 npm 生态。

新增行为时：

- 规则引擎变化 → 补 `tests/analyzer.test.mjs`；模型解析 / 流解析 / 预算 → 补 `tests/analyzer-llm.test.mjs`、`tests/ai-models.test.mjs`、`tests/ai-budget.test.mjs`；
- 会话发现 / 解析 / digest / 产物提取 → 补 `tests/sessions.test.mjs`；
- 存储字段 / 迁移 / 损坏恢复 → 补 `tests/store.test.mjs` 或 `tests/store-robustness.test.mjs`；
- 扫描 / 合并 / 命令编排 → 补 `tests/service.test.mjs`；
- HTTP 设施 / 鉴权 → 补 `tests/http.test.mjs`、`tests/auth.test.mjs`、`tests/host-entry.test.mjs`；
- 包结构 / files 列表 → 补 `tests/package.test.mjs`；
- 市场索引 → 补 `tests/market-index.test.mjs`；
- 隐私相关改动 → 补 `tests/check-privacy.test.mjs`。

## 7. UI 开发与截图

- 只改 `client.js`，不引入构建工具与第三方 UI 库；样式只用 DSH 设计 token（见 [DESIGN.md](DESIGN.md)）。
- 打开浅色 / 深色两套主题、1680px 与 1280px 两档宽度、右侧栏 420/756 两档宽度自检。
- 交互自检覆盖扫描按钮三态、完成卡样式、抽屉重新研判、草稿冲突处理及可展开内容。
- 在最低支持版和当前桌面版的隔离 DSH 中验证两行页头、长列分页、完成列折叠、菜单键盘焦点、归档成功与失败，以及产物复制和预览。桌面文件操作可用测试替身记录系统打开参数。
- 维护者本地有一套零依赖的 CDP 辅助脚本（`dev/shot.mjs` 截图、`dev/design-audit.js` 注入审计、`dev/demo/` 合成演示数据），前置条件见 `dev/README.md`；它们被 git 忽略，不会出现在公开仓库中。
- 截图可以用任意 CDP 工具（Playwright、Puppeteer、Chrome DevTools Protocol 脚本）驱动：

```js
// 伪代码：连接一个 headless Chrome，设置视口后截图
await page.setViewportSize({ width: 1680, height: 1050 });
await page.goto(instanceUrl);           // 带 token 的本地 URL
await page.getByText("任务看板").click(); // 打开看板
await page.screenshot({ path: "board-light.png" });
```

- 制作公开截图时**不要**使用真实会话 / 工作区 / 账号数据；建议构造一套完全虚构的 DSH home（自建 `workspace.json`、会话日志与看板状态），确认左下角不出现真实账号信息后再截图。
- 深色模式可通过页面注入 `prefers-color-scheme: dark`（CDP `Emulation.setEmulatedMedia`）或切换系统主题验证。

### 7.1 版本、升级与文档一致性

- **页头布局**。扫描、模型、快聊、设置和形态切换常驻，更多菜单收纳扫描详情与导出。窄栏用下拉选择视图。
- **验证运行时版本**：以 profile 的 `node_modules` 为准，而不是仓库 `package.json`：

  ```bash
  node -p "require(require('os').homedir() + '/.dsh/profiles/desktop/node_modules/dsh-super-kanban/package.json').version"
  ```

- **复现升级陷阱**（隔离环境）：把隔离 profile 的依赖写成 `^0.4.0` 再安装，可观察到 semver 不会跨 minor；改成精确版本 `dsh-super-kanban@0.10.0` 重装后界面才更新。完整命令见 [INSTALL.md 第 8 节](INSTALL.md#8-开发者隔离环境安装与升级验证)。
- **文档同步**：涉及安装/升级/UI 入口的改动，需同步更新 [INSTALL.md](INSTALL.md)、[TROUBLESHOOTING.md](TROUBLESHOOTING.md)、[MARKET.md](MARKET.md) 以及中英文 README 的截图与描述。
- **文档检查（CI 强制）**：`npm run check:docs` 会校验公开文档的相对链接与锚点、README 中英结构（章节数 / 表格 / 代码块 / 截图集合）、截图引用、GitHub Pages 落地页与历史 `plugin/` 布局残留；`npm run check:version` 会校验 `package.json`、`CHANGELOG.md`、`docs/index.json`、`SECURITY.md` 与文档中兼容范围的一致性。改文档后必须跑这两项。
- **发布包与文档版本**：README 不写死当前版本；示例版本号（如 `0.10.0`）只用于演示精确安装，实际以 npm latest / 插件页为准。

## 8. 代码风格

- Node ESM（`import` / `export`），浏览器半边使用 DSH 的模块加载器与 `React.createElement`。
- 不引入 `node_modules` 依赖；工具脚本只用 Node 内置模块。
- 对外部输入（会话日志、HTTP 请求、存储文件）保持防御式解析：非法内容只降级，不抛到上层。
- 不写死绝对路径；不在日志中打印凭证或完整会话原文。
- 注释解释「为什么」，而不是复述代码。

## 9. 发布流程

`main` 分支已启用保护：PR 必须先通过 CI 状态检查（Node 22.19 / Node 24）并获得 **1 个 approving review** 才能合并，
且新 push 会作废旧审批；禁止 force push 与删除分支。维护者发版时可按发布流程直接向 `main` 提交版本/索引 commit 并打 tag
（tag 必须与 `package.json` 版本一致）。发布后只保留最近 3 个 GitHub Release 页面（tag/commit 保留）。

发布前在隔离 DSH 中检查 npm 打包产物。使用合成会话和本地测试模型覆盖项目编辑、日程、会话状态、三种形态的切换与互斥、悬浮入口的拖动和隐藏、共享模型切换、快聊各模式、追问、放入会话与取消。提交版本代码后运行 `npm run release`，生成索引并执行全量检查。提交索引后原子推送 main 和版本标签，再核对 npm 精确版本、GitHub Release 和线上市场索引。完整步骤见 [MARKET.md](MARKET.md)。

提交 PR 前至少运行：

```bash
npm test && npm run validate && npm run check:privacy && npm run check:docs && npm run check:version
# 或一次跑完：npm run check
```

## 10. 常见开发问题

| 现象 | 排查 |
| --- | --- |
| 改了 host 代码没生效 | 重启隔离 DSH 实例；确认 profile 的 bundles 中包含本插件 |
| 改了 `client.js` 没生效 | 强制刷新窗口（必要时清缓存）；确认插件 bundle 从工作区加载 |
| 扫描总是 0 个会话 | 检查 `$DSH_HOME/storages/workspace.json` 与会话目录是否匹配；看扫描消息 |
| AI 不调用 | 确认设置里 AI 开启、隔离 DSH 已配置模型（默认或第三方 provider + API Key）、预算未用完、门控条件满足 |
| 截图出现真实信息 | 立即改用虚构演示数据，并在 PR 前跑一遍 `npm run check:privacy` |
| DSH 升级后接口报错 | 对照 DSH 插件机制变化，先确认 `cordis.patch.yml` 与 client 注入列表 |
