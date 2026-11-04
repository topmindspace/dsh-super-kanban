# 开发指南

本文说明如何在本地开发、调试与测试 Super Kanban。首次参与贡献请先阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 环境

- **Node.js** `>= 22.19.0`（使用内置 `node:zlib` 的 zstd API）。
- **DeepSeek Harness** 桌面版，或 `dsh` CLI（`dsh web`）。
- **零依赖**：仓库不需要 `npm install`，没有打包步骤；`client.js` 是手写 bundle。

## 2. 目录速览

| 路径 | 说明 |
| --- | --- |
| `index.mjs` | Host 入口（路由、鉴权、服务生命周期） |
| `server/` | Host 实现：扫描 / 规则 / LLM / 存储 / HTTP 服务 |
| `client.js` | 浏览器半边（单文件，无 JSX、无构建） |
| `cordis.patch.yml` | 把 host 插件插入 DSH profile |
| `install.sh` / `uninstall.sh` | 本地链接安装 / 卸载 |
| `scripts/` | validate、隐私扫描、市场索引、发布辅助 |
| `tests/` | `node --test` 套件 |
| `docs/` | 公开文档、截图、市场索引 |

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
- 想验证 AI 引擎，需要在隔离 home 里放一份可用的账号凭证（DSH 登录后自动写入）；没有凭证时插件会回退规则引擎，这本身也是需要验证的路径。

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
2. **再验证 LLM 路径**：构造固定的会话解析结果（`parsed`）与 digest，单独调用分析器，不依赖真实网络；失败路径（超时 / 非法 JSON / 预算耗尽）要有降级。
3. **保持 digest 预算**：`buildDigest` 输出必须 ≤1.5KB；新增字段时在测试里断言 UTF-8 字节数。
4. **保持合并幂等**：同一个会话多次扫描不应重复建卡；用户锁定字段不得被覆盖。
5. **隔离单会话失败**：解析失败只跳过该会话并计数，不能让整次扫描失败。

### 存储与版本

- 存储版本常量在 `store.mjs`（当前 v2）。新增字段时同步更新裁剪逻辑与迁移函数。
- v1 → v2 的迁移路径已有测试覆盖；新版本迁移要新增对应测试夹具。
- 写文件必须走原子写（临时文件 + rename）。

## 6. 测试与检查

```bash
npm test              # node --test "tests/**/*.test.mjs"
npm run validate      # 包清单 / Cordis patch / 文件清单 / 市场索引
npm run check:privacy # 个人路径、凭证、真实会话 id 等敏感内容扫描
npm pack --dry-run    # 查看将发布的 tarball 内容
```

新增行为时：

- 规则引擎变化 → 补 `tests/analyzer.test.mjs`；
- 存储字段 / 迁移 → 补 `tests/store.test.mjs`；
- 包结构 / files 列表 → 补 `tests/package.test.mjs`；
- 市场索引 → 补 `tests/market-index.test.mjs`；
- 隐私相关改动 → 补 `tests/check-privacy.test.mjs`。

## 7. UI 开发与截图

- 只改 `client.js`，不引入构建工具与第三方 UI 库；样式只用 DSH 设计 token（见 [DESIGN.md](DESIGN.md)）。
- 打开浅色 / 深色两套主题、1680px 与 1280px 两档宽度、右侧栏 420/756 两档宽度自检。
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

## 8. 代码风格

- Node ESM（`import` / `export`），浏览器半边使用 DSH 的模块加载器与 `React.createElement`。
- 不引入 `node_modules` 依赖；工具脚本只用 Node 内置模块。
- 对外部输入（会话日志、HTTP 请求、存储文件）保持防御式解析：非法内容只降级，不抛到上层。
- 不写死绝对路径；不在日志中打印凭证或完整会话原文。
- 注释解释「为什么」，而不是复述代码。

## 9. 发布流程

版本号、市场索引、npm 发布与 GitHub Release 的完整流程见 [MARKET.md](MARKET.md)。提交 PR 前至少运行：

```bash
npm test && npm run validate && npm run check:privacy
```

## 10. 常见开发问题

| 现象 | 排查 |
| --- | --- |
| 改了 host 代码没生效 | 重启隔离 DSH 实例；确认 profile 的 bundles 中包含本插件 |
| 改了 `client.js` 没生效 | 强制刷新窗口（必要时清缓存）；确认插件 bundle 从工作区加载 |
| 扫描总是 0 个会话 | 检查 `$DSH_HOME/storages/workspace.json` 与会话目录是否匹配；看扫描消息 |
| AI 不调用 | 确认设置里 AI 开启、当前 home 有凭证、预算未用完、门控条件满足 |
| 截图出现真实信息 | 立即改用虚构演示数据，并在 PR 前跑一遍 `npm run check:privacy` |
| DSH 升级后接口报错 | 对照 DSH 插件机制变化，先确认 `cordis.patch.yml` 与 client 注入列表 |
