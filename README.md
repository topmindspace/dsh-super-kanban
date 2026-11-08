# Super Kanban · 智能任务指挥台

**把 DSH 会话变成一张会自动更新的任务看板。** 你在 DSH 里同时推进多个会话：做到哪了、卡在哪、有没有交付——看板自动替你回答，不用翻聊天记录。每张卡都能追溯回具体会话与具体一句话。

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**简体中文** | [English](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.en.md)

> 要求 DSH `>= 0.2.1-rc.5 < 0.3.0` · Node.js `>= 22.19.0` · 零第三方依赖 · 无遥测

![任务看板（浅色）](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

## 30 秒看懂

- **适合**：同时推进多个 DSH 会话、想一眼看清「今天做完什么 / 哪张卡住了」的人。
- **不适合**：只在单个会话里用待办的人——DSH 自带 todo 可能已经够用。
- **核心差别**：任务从会话里自动长出来，不用手动维护；AI 只做增强，关掉或不可用时本地规则照样能用。

## 快速开始

### 安装（三种常用方式，另支持本地/源码安装）

三种常用方式都支持**安装特定版本**；本地目录 / 源码安装见步骤 3。

1. **插件市场（推荐）**：DSH → 插件 → 发现 → 添加索引源 `https://topmindspace.github.io/dsh-super-kanban/index.json` → 打开 **Super Kanban** 详情 → 在**版本列表**里选择精确版本（如 `0.5.1`）→ 安装 → 启用并刷新窗口。
2. **npm（精确版本）**：DSH → 插件 → 添加插件 → 输入 `dsh-super-kanban@0.5.1` → 安装 → 刷新窗口。命令行等价：`dsh plugin --profile desktop add dsh-super-kanban@0.5.1`。
3. **Git / 源码（tag 固定版本）**：`git clone https://github.com/topmindspace/dsh-super-kanban.git` → `git checkout v0.5.1` → `./install.sh -y` → 刷新窗口。`./install.sh` 需要 `bash` + `python3`；不想用命令行时，可在 DSH 插件页直接选择本地目录安装。在插件页添加仓库地址会 pin 到最新 commit；要固定版本请用这里的 tag。

[验证版本](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#23-命令行查看实际安装版本) · [升级](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级) · [回滚](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#4-回滚到旧版本) · [本地目录安装](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#方式-d本地目录源码脚本)——详细步骤见 [安装指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)。

### 第一次使用（5 步）

1. 左侧栏点 **任务看板**（或在会话右上角点看板图标，用右侧栏形态打开）。
2. 点页头 **设置**：保持「AI 联网研判」开启，「AI 研判模型」默认跟随 DSH 即可。
3. 点 **扫描**，首次按会话量需要几秒到几分钟；结论常驻统计行，可随时取消。
4. 点卡片打开详情：状态、进度、问题、关键事实、证据都在；「⋯」→「重新研判」可单卡重判。
5. 想接着干：抽屉里点 **「继续此任务」**，提示词放进原会话输入框，确认后自己发送。

## 它能做什么

- **每天 30 秒回顾**：四列看板按状态归位，一眼看清哪些会话做完了、哪些卡住了。
- **不用翻聊天记录**：任务标题、目标、进度、完成度与问题从会话自动更新，重复扫描不重复建卡。
- **卡住的地方有上下文**：问题、关键事实、产物与证据时间线都挂回来源会话，一键跳回。
- **继续任务不用重写提示词**：本地模板生成结构化提示词，确认后放回原会话或同工作区新会话，0 token、不自动发送。
- **AI 可选、模型可换**：默认跟随 DSH 默认模型，也可选你在 DSH 配置的第三方模型；关闭或不可用时自动降级本地规则。
- **两种形态**：全页四列看板，或会话右侧栏紧凑看板，宽度自适应。
- **手动也能管**：新建 / 编辑 / 拖拽 / 归档 / 删除 / 锁定字段；你改过的字段 AI 不再覆盖。
- **本地优先**：数据只写本机 `~/.dsh/storages/super-kanban/`，看板自身无遥测。

## 典型场景

- **每天早上 30 秒**：打开看板扫一眼统计行与四列，就知道昨天哪些会话有交付、哪些卡住了。
- **把一张卡继续下去**：抽屉点「继续此任务」，提示词直接放回原会话或同工作区新会话，不用自己拼上下文。
- **手动维护大看板**：新建、拖拽、锁定字段；锁过的字段不会被下一次 AI 研判覆盖。

## AI 与模型

- **默认跟随 DSH 默认模型**，看板里不需要填任何 Key。
- **想用第三方模型**：在 **DSH 设置 → 模型** 添加模型提供方（OpenAI / Anthropic / OpenRouter 等，或自定义兼容端点）并填 API Key；回到看板 设置 →「AI 研判模型」选中它。
- **没有原生模型服务**（旧 DSH / 极简组合）时自动改用本地规则引擎，扫描结论会说明原因。
- **隐私**：AI 研判只把压缩会话摘要（≤1.5KB/会话）发送给你在 DSH 中配置的模型服务商；看板无遥测、不保存凭证。详见 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)。

## 设置与预算

- **AI 预算**：默认「自动」＝本次最多用完当日剩余额度；也可固定为 20 / 40 / 80 / 150 次。
- **每日上限**：默认 150 个预算单位，按本机日历日 0 点重置（预算单位不是硬性成本上限）。
- **扫描**：自动扫描间隔可调；一次扫不完的会话下次继续，结论会提示「剩余 N 个会话下次扫描继续」。
- **入口偏好**：「显示与入口」可选两者 / 仅全局面板 / 仅会话右侧栏；保存后刷新窗口生效。

## 性能与限制

- **增量扫描**：只处理有变化的会话，日常开销很小；只有你主动「全量重扫」时才会完整解析。
- **初始扫描范围**：默认最近 30 天，可在设置中改为 7 / 14 / 30 / 90 天。
- **AI 额度与时长**：单次扫描有预算单位上限，AI 阶段最多约 10 分钟；超出后提示「剩余 N 个会话下次扫描继续」，不会丢。
- **大库首扫**：会话很多时首次扫描可能跨多轮完成；可随时取消，已完成部分保留。
- **数据体积**：看板数据在 `~/.dsh/storages/super-kanban/`（任务 / 设置 / 扫描状态 + 会话缓存），无遥测。

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

**版本策略**：当前 `0.5.x` 线主动接收安全修复；上一线 `0.4.x` 建议升级到 `0.5.x`（安全修复尽力维护）；GitHub Releases 只保留最近 3 个版本页面，历史版本请在插件市场版本列表或 Git tag 中用精确版本安装。详见 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) 与 [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级)。跨 minor 升级必须安装精确版本；DSH 大版本升级后如入口消失，先重装插件，看板数据不会丢。

## 常见问题

**Q：左侧栏没有「任务看板」？**
A：按 `Cmd+R` 刷新窗口；仍没有就完全退出 DSH 再打开。还没有请看插件页的加载诊断，或 [排障手册](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#入口缺失)。

**Q：AI 不生效 / 一直显示「规则」？**
A：确认设置里「AI 联网研判」开启，并在 DSH 设置 → 模型中配置好模型；看板设置 →「AI 研判模型」可指定具体模型。旧 DSH 没有原生模型服务时会一直用规则引擎。

**Q：怎么更新到特定版本？**
A：第三方插件没有自动升级：卸载旧版 → 安装目标精确版本（如 `dsh-super-kanban@0.5.1`，或在市场版本列表里选择）→ 刷新窗口。步骤见 [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级)。

**Q：数据存在哪？卸载会丢吗？**
A：`~/.dsh/storages/super-kanban/`（`state.json` / `sessions-cache.json` / `backups/`）。卸载插件不会删除数据；彻底清空见 [排障手册](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#卸载与数据保留)。

**Q：怎么卸载？**
A：插件页移除，或源码目录执行 `./uninstall.sh -y`，然后刷新窗口。

## 文档导航

- 安装 / 升级 / 回滚 / 卸载：[INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)
- 排障（入口 / AI / 扫描 / 预算）：[TROUBLESHOOTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)
- 安全与隐私边界：[SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)
- 开发与维护：[DEVELOPMENT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md)、[MARKET.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/MARKET.md)、[ARCHITECTURE.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md)、[CONTRACT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)、[DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md)

## 开发与贡献

- 零第三方依赖、无构建：Host 为 Node ESM，浏览器半边为单文件 `client.js`；`npm test` 跑测试，`npm run check` 一次跑完全部校验。
- 目录结构与调试见 [CONTRIBUTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) 与 [docs/DEVELOPMENT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md)。
- 架构与接口见 [ARCHITECTURE.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md)、[CONTRACT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)；视觉规范见 [DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md)。
- 安全问题请按 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) 私下报告，不要开公开 issue。

## License

[MIT](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
