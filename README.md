# Super Kanban · 智能任务指挥台

**把 DSH 会话变成一张会自动更新的任务看板。** 它读取你本机各工作区的真实会话，自动研判任务的目标、进度、完成情况与卡点；也可以完全手动管理。每张卡都能追溯回具体会话与具体一句话。

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**简体中文** | [English](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.en.md)

> 要求 DSH `>= 0.2.1-rc.5 < 0.3.0` · Node.js `>= 22.19.0` · 零第三方依赖 · 无遥测

![任务看板（浅色）](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

## 快速开始

### 安装（三选一）

1. **插件市场（推荐）**：DSH → 插件 → 发现 → 添加索引源 `https://topmindspace.github.io/dsh-super-kanban/index.json` → 安装 **Super Kanban** → 启用并刷新窗口。
2. **npm**：DSH → 插件 → 添加插件 → 输入 `dsh-super-kanban`（升级时写精确版本）→ 安装 → 启用并刷新窗口。
3. **Git 仓库**：插件 → 添加插件 → 粘贴仓库地址 `https://github.com/topmindspace/dsh-super-kanban` → 安装 → 启用并刷新窗口。

本地目录安装、版本验证、更新与回滚见 [安装指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)。

### 第一次使用

1. 左侧栏点 **任务看板**（或在会话右上角点看板图标，用右侧栏形态打开）。
2. 点页头 **设置**：保持「AI 联网研判」开启，「AI 研判模型」默认跟随 DSH 即可。
3. 点 **扫描**，首次按会话量需要几秒到几分钟；结论会常驻在统计行。
4. 卡片自动出现后，点卡片打开详情；右上「⋯」可随时「重新研判」单张卡。
5. 想接着干：抽屉里点 **「继续此任务」**，提示词会放进原会话输入框，确认后自己发送。

## 它能做什么

- **自动建卡与更新**：从本机 DSH 会话提炼标题、目标、状态、进度、问题与下一步，增量扫描持续更新，不重复建卡。
- **AI 研判，模型可选**：默认跟随 DSH 默认模型，也可以改用你在 DSH 中配置的第三方模型；关闭或不可用时自动降级本地规则。
- **继续任务零 token**：本地模板拼出结构化提示词，确认后放入原会话或同工作区新会话，不会自动发送。
- **两种形态**：全页四列看板，或会话右侧栏紧凑看板，宽度自适应。
- **本地优先**：看板数据只写本机 `~/.dsh/storages/super-kanban/`，看板自身无遥测。
- **零第三方依赖**：插件本体与校验脚本都不带运行时依赖，无构建、无外部资源。
- **手动可控**：新建 / 编辑 / 拖拽 / 归档 / 删除 / 锁定字段；你改过的字段 AI 不再覆盖。
- **全程可追溯**：关键事实、问题、产物与证据时间线都能一键跳回来源会话。

## AI 与模型

- **默认跟随 DSH 默认模型**，看板里不需要填任何 Key。
- **想用第三方模型**：在 **DSH 设置 → 模型** 添加模型提供方（OpenAI / Anthropic / OpenRouter 等，或自定义兼容端点）并填 API Key；回到看板 设置 →「AI 研判模型」选中它，或继续跟随默认。
- **没有原生模型服务**（旧 DSH / 极简组合）时自动改用本地规则引擎，扫描结论会说明原因。
- **隐私**：AI 研判只把压缩会话摘要（≤1.5KB/会话）发送给你在 DSH 中配置的模型服务商——选第三方即发给该服务商；看板不读取、不保存凭证，也无遥测。详见 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)。

## 设置与预算

- **AI 预算**：默认「自动」＝本次最多用完当日剩余额度；也可固定为 20 / 40 / 80 / 150 次。
- **每日上限**：默认 150 个预算单位，按本机日历日 0 点重置（预算单位不是硬性成本上限）。
- **扫描**：自动扫描间隔可调；一次扫不完的会话下次继续，结论会提示「剩余 N 个会话下次扫描继续」，不会丢。
- **入口偏好**：「显示与入口」可选两者 / 仅全局面板 / 仅会话右侧栏；保存后刷新窗口生效。

## 界面截图

| 看板（深色） | 任务详情 |
| --- | --- |
| ![看板深色](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-dark.png) | ![任务详情](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-light.png) |

| 设置与预算 | 右侧栏形态 |
| --- | --- |
| ![设置](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/settings-dual.png) | ![右侧栏](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-panel.png) |

更多截图：[演示动图](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/demo.gif)、[深色任务详情](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-dark.png)、[继续任务](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-modal.png)、[提示词放入会话](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-placed.png)、[右侧栏全屏](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-fullscreen.png)、[产物预览](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-artifacts.png)、[工具栏菜单](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/toolbar-menu.png)、[1280 宽窗口](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-1280.png)。

> 截图来自一套完全虚构的演示数据，不含任何真实用户或工作区信息。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0` |
| Node.js | `>= 22.19.0`（DSH 自带，无需单独安装） |
| 平台 | macOS 桌面版已验证；其他桌面平台理论可用但未逐一验证 |
| 第三方依赖 | 无（插件与 `scripts/` 校验脚本均为零依赖） |
| AI 模型 | 由 DSH 原生模型服务提供：默认跟随 DSH 默认模型，也可选第三方 provider |

安全修复落在当前 minor 线；跨 minor 升级必须安装精确版本，步骤见 [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级)。DSH 大版本升级后如入口消失，先重装插件，看板数据不会丢失。

## 常见问题

**Q：左侧栏没有「任务看板」？**
A：按 `Cmd+R` 刷新窗口；仍没有就完全退出 DSH 再打开。还没有请查看插件页的加载诊断，或见 [排障手册](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#入口缺失)。

**Q：AI 不生效 / 一直显示「规则」？**
A：确认设置里「AI 联网研判」开启，并在 DSH 设置 → 模型中配置好模型（登录账号或填 API Key）；看板设置 →「AI 研判模型」可指定具体模型。旧 DSH 没有原生模型服务时会一直用规则引擎，升级 DSH 后可用。

**Q：怎么更新？**
A：第三方插件没有自动升级：卸载旧版 → 安装目标版本（跨 minor 用精确版本）→ 刷新窗口，详见 [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级)。

**Q：数据存在哪？卸载会丢吗？**
A：`~/.dsh/storages/super-kanban/`（`state.json` / `sessions-cache.json` / `backups/`）。卸载插件不会删除；彻底清空见 [排障手册](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#卸载与数据保留)。

**Q：怎么卸载？**
A：插件页移除，或源码目录执行 `./uninstall.sh -y`，然后刷新窗口。

## 开发与贡献

- 零第三方依赖、无构建：Host 为 Node ESM，浏览器半边为单文件 `client.js`；`npm test` 跑测试，`npm run check` 一次跑完全部校验。
- 目录结构、调试与命令见 [CONTRIBUTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) 与 [docs/DEVELOPMENT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md)。
- 架构与接口见 [ARCHITECTURE.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md)、[CONTRACT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)；视觉规范见 [DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md)。
- 安全问题请按 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) 私下报告，不要开公开 issue。

## License

[MIT](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
