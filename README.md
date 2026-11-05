# Super Kanban · 智能任务指挥台

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

一个**生长在 DeepSeek Harness 界面里**的 AI 任务看板：它读取你各个工作区的真实 DSH 会话，自动研判任务的目标、进度、完成情况与问题，也可以完全手动管理。每张任务卡都能追溯到具体会话与具体一句话。

- **入口**：DSH 左侧栏「任务看板」，或在会话右侧栏打开紧凑形态
- **数据**：只读扫描本机 DSH 会话；看板数据保存在本机，不出本机
- **智能**：复用本机 DSH 已登录账号的模型额度，零配置；关闭后自动降级为本地规则分析

**简体中文** | [English](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.en.md)

![任务看板（浅色）](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

![看板 → 任务详情 → 继续任务 演示](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/demo.gif)

## 目录

- [它解决什么](#它解决什么)
- [功能特性](#功能特性)
- [两种形态](#两种形态)
- [安装](#安装)
- [使用](#使用)
- [AI 与隐私](#ai-与隐私)
- [界面截图](#界面截图)
- [兼容性](#兼容性)
- [常见问题](#常见问题)
- [故障排查](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)
- [开发与贡献](#开发与贡献)
- [License](#license)

## 它解决什么

你在 DSH 里同时推进多个工作区、多个会话，任务状态散落在对话里：做到哪了？卡在哪？有没有交付？是不是已经不了了之？

Super Kanban 把这些对话转成一张可持续维护的看板：

| 能力 | 说明 |
| --- | --- |
| 🎯 目标识别 | 从会话里的真实请求提炼任务标题与目标，而不是把整段 prompt 当标题 |
| 📈 进度判断 | 优先用会话中的 todo 完成率，结合交付物、轮次状态估算进度 |
| ✅ 完成判断 | 综合最后一轮回复、交付物（present / 写文件）与用户是否继续提修改来判断完成 |
| ⚠️ 问题识别 | 工具报错、用户否定/纠正、未解决的提问作为「问题」挂在卡片上 |
| 🔗 可追溯 | 每张卡带来源工作区 / 会话 / 证据时间线，一键跳回原会话 |
| 🤝 会话联动 | 「继续此任务」生成结构化提示词，确认后放入原会话或同工作区新会话输入框，不自动发送 |
| ✅ 子任务与目标 | 子任务清单（可从会话待办导入、勾选自动回写进度）、任务目标、DSH Session Goal 追踪 |
| 📦 产物跟踪 | 自动收集会话交付物与写出的文件，点击在 DSH 文档预览中打开 |
| 🧾 关键事实优先 | 卡片只保留标题/元信息/进度三层；抽屉先看 3–6 条关键事实，完整证据默认折叠 |
| ✍️ 手动维护 | 新建 / 编辑 / 拖拽换列 / 归档 / 删除 / 锁定字段；你改过的字段 AI 不再覆盖 |
| 🔄 持续维护 | 首次约数秒完成扫描，之后按间隔增量扫描；新会话自动纳入，旧任务自动更新 |
| 🧠 解释得清 | 每条研判带置信度与一句话理由，避免「黑箱改状态」 |

## 功能特性

### 双引擎分析：联网更准，离线也能用

1. **采集（本机）**：读取 `workspace.json` 与各会话的 `session.v4.jsonl.zstd`，解析用户请求、AI 回复、工具调用、todo 快照、交付物、错误与轮次结束原因。
2. **规则引擎（始终可用、零 token）**：本地规则从会话中提炼状态、进度、问题与证据，未登录、无网络或关闭 AI 时看板照常工作。
3. **LLM 研判（可选联网）**：把压缩后的会话摘要发送到 DeepSeek 推理接口，返回结构化 JSON（任务、状态、进度、问题、证据、置信度、理由）。
4. **合并（本机）**：按会话锚点合并进看板；用户锁定字段不覆盖；每次变化写操作历史。

### Token 效率

- 送模型的会话摘要（digest）压到 **≤1.5KB/会话**，只含最近变化与关键信号。
- 输出结构化：关键事实 ≤6、证据 ≤8、`max_tokens` ≤2200，单个会话解析结果有明确上限。
- **增量门控**：只在「用户消息增加 / 轮次结束 / 首次分析」时调用模型；同一活跃 turn 内不重复分析，同一会话有最小间隔。
- **预算可控**：设置里可配「单次扫描 AI 调用上限」与「每日上限」，超限自动降级规则引擎；设置页显示今日调用数与 tokens。
- 反复全量扫描已分析的会话时，**0 次 AI 调用**。

### 数据与隐私

- 看板数据只写入本机 `~/.dsh/storages/super-kanban/`，无第三方服务器、无遥测。
- 联网研判只发送**压缩摘要**：不发送完整会话原文、不发送文件内容、不发送账号凭证。
- 所有 AI 功能可在设置中一键关闭，立即降级为本地规则分析。

### 界面（v0.4）

- 与 DSH 同源的深浅色、字体与间距；"单色为底、克制的强调色"：颜色只出现在状态点、细进度线、优先级小字与类型图标上。
- 页头常驻常用动作（搜索 / 扫描 / 设置 / 在右侧栏打开 / 新建），「⋯」只保留「导出 JSON」。
- 更多视觉与交互规则见 [DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md)。

## 两种形态

同一个看板支持两种打开方式：

| 形态 | 怎么打开 | 特点 |
| --- | --- | --- |
| **全页主面板** | 左侧栏「任务看板」 | 四列完整看板 + 筛选 + 统计行，适合专注梳理 |
| **右侧侧边栏** | 会话右上角看板图标，或会话右侧栏「+」工具列表里的「任务看板」 | 边聊边看板；宽度自适应：窄（单列 + 状态分段）/ 中 / 宽（四列） |

- **右侧栏全屏**：右侧栏顶部的全屏按钮，面板铺满视口，仍可随时退出。
- **互相切换**：全页看板页头的「在右侧栏打开」图标；右侧栏看板的「在全页面板打开」图标。
- **入口偏好**：看板「设置 → 显示与入口」可选「两者（默认）/ 仅全局面板 / 仅会话右侧栏」，修改后刷新窗口生效。

## 安装

> 前置条件：已安装并至少打开过一次 DSH 桌面版（存在 `~/.dsh/profiles/desktop`），DSH 版本 `>= 0.2.1-rc.5 < 0.3.0`。

### 方式 A：插件市场索引（推荐）

> 「发现（Discover）」来自 DSH 的实验性插件市场能力：先在 **插件 → 实验性插件** 中启用 **插件市场 / Plugin market** 并按其提示重载 DSH。若你的 DSH 版本暂无该能力，请使用方式 B/C/D。

1. DSH → **插件** → **发现（Discover）**
2. **添加索引源**，粘贴：
   `https://topmindspace.github.io/dsh-super-kanban/index.json`
3. 在列表中找到 **Super Kanban** → **安装** → 启用
4. 回到 DSH 窗口按 `Cmd+R` 刷新（必要时重启 DSH）

> 市场索引在首个版本发布到 GitHub Pages 后生效；索引内容来自本仓库 `docs/`。

### 方式 B：npm 包名

DSH → 插件 → 添加插件 → 输入包名 `dsh-super-kanban`（可附加版本号，如 `dsh-super-kanban@<version>`）→ 安装 → 启用 → 刷新窗口。

> npm 包已发布：`dsh-super-kanban`（https://www.npmjs.com/package/dsh-super-kanban）。发布与索引更新流程见 [docs/MARKET.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/MARKET.md)。

### 方式 C：Git 仓库

插件 → 添加插件 → 粘贴仓库地址 `https://github.com/topmindspace/dsh-super-kanban` → 安装（DSH 会 pin 到具体 commit）→ 启用 → 刷新窗口。

### 方式 D：本地目录 / 源码安装

适合开发者和想跟进源码的用户：

```bash
git clone https://github.com/topmindspace/dsh-super-kanban.git
cd dsh-super-kanban
./install.sh -y       # 链接进默认 desktop profile 并在插件清单中登记
```

或在 DSH 插件页选择「本地目录」指向本仓库根目录。安装完成后刷新窗口，左侧栏出现「任务看板」。

### 更新插件（重要）

第三方插件**没有“自动升级”**：更新 = **卸载旧版 → 安装目标版本**，然后刷新 DSH 窗口（必要时完全退出重开）。

- **跨 minor 必须用精确版本**：`0.3.x → 0.4.x` 要安装 `dsh-super-kanban@0.4.1` 这类精确版本；旧的范围依赖 `^0.3.0` 在语义化版本下**永远不会**解析到 0.4.x（这是“更新后界面仍是旧版”的常见原因）。
- **0.4.x 内的小版本**：若 profile 依赖写的是 `^0.4.0`，0.4.1、0.4.2 等补丁版可被正常解析；若插件页安装写的是精确版本，则同样需要卸载后安装目标版本。
- 更新后先按 `Cmd+R`；界面没变则**完全退出 DSH 再打开**，再按 [INSTALL.md 的“验证版本”](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#2-验证安装与版本) 检查实际版本与依赖规格。

### 卸载

- **卸载**：插件页移除，或源码目录执行 `./uninstall.sh -y`。
- 卸载**不会删除**看板数据；彻底清空请删除 `~/.dsh/storages/super-kanban/`。

更详细的安装、更新、验证、回滚与排障说明见 [docs/INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)；遇到问题见 [docs/TROUBLESHOOTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)。

## 使用

1. 左侧栏点 **任务看板**（或会话右上角看板图标走右侧栏形态）。
2. **看板**：四列——待办 / 进行中 / 受阻 / 已完成；列头显示数量与状态色。
3. **卡片**：状态点、标题与 AI/规则标记、来源工作区与最近活动时间，以及克制的优先级、问题数、产物数、子任务进度与进度线。
4. **详情抽屉**（点卡片打开）：
   - 一句话状态摘要（点「编辑」可改字段）
   - **关键事实**（3–6 条，来自会话的关键进展 / 决策 / 问题）
   - **子任务**：勾选 / 新增 / 删除；「从会话导入待办」；进度自动回写
   - **问题 / 下一步**
   - **会话联动**：继续此任务 / 打开会话
   - **产物**：点击在 DSH 右侧栏文档预览中打开
   - 证据与历史（默认折叠）
5. **筛选**：工作区、优先级、来源、标签、关键词搜索、显示归档。
6. **工具栏**（页头常驻）：搜索、扫描、设置齿轮、在右侧栏打开、新建；「⋯」只保留「导出 JSON」。
7. **扫描**：点扫描按钮立即增量扫描；扫描进度实时显示。
8. **设置**（齿轮图标）：AI 开关、自动扫描、扫描间隔、初始扫描天数、AI 预算、显示与入口、排除工作区。

### 「继续此任务」怎么用

1. 打开任意任务卡 → 抽屉里点 **「继续此任务」**；
2. 弹窗里是一段已生成好的结构化提示词（任务目标 / 进度 / 关键事实 / 问题 / 下一步 / 来源会话），可直接编辑；
3. 选 **原会话继续** 或 **同工作区新会话**；
4. 点 **「放入会话」**：DSH 自动切到目标会话，并把提示词放进输入框——**不会自动发送**，你确认 / 修改后自己按发送即可。也可以「仅复制」或「AI 润色」提示词。

> 提示词由本地模板拼装，**默认 0 token**；只有点「AI 润色」才会调用一次模型。

### 手动与自动如何共存

- 自动任务以来源会话为锚点，多次扫描持续更新同一张卡，不会重复建卡。
- 你手动编辑并锁定的字段（默认编辑即锁定）AI 永不覆盖，可在详情里「解锁」交还给 AI。
- 手动任务（来源=手动）不会被自动扫描改动。
- 新建卡片可以不关联会话；关联后 AI 会在下次扫描时补全研判。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `/` | 聚焦搜索 |
| `n` | 新建任务 |
| `Esc` | 关闭当前浮层 / 抽屉 |
| `Cmd+R` | 刷新 DSH 窗口（插件更新后需要） |

## AI 与隐私

### 数据流

```
DSH 会话（本机只读）
        │  本机解析 / 规则引擎
        ▼
   本机看板存储 ──（可选）压缩摘要 ≤1.5KB ──► DeepSeek 推理接口
        │                                          │
        └──────────── 结构化 JSON 结果 ◄───────────┘
```

### 明确不上传的内容

- 完整会话原文、文件内容、附件
- 账号凭证 / token（凭证只在本机用于调用，不随请求内容发出）
- 任何第三方服务器（无遥测、无统计上报）

### 关闭 AI

看板页头的设置齿轮 → 关闭「AI 联网研判」，立即生效。关闭后看板继续用本地规则引擎运行，功能不缺失，只是研判颗粒度更粗。

### 成本

默认增量扫描只分析**有变化的会话**，单次扫描 AI 调用默认上限 40 次，模型默认 `deepseek-flash`。日常没有新对话时几乎零消耗。你可以在设置中调低每日上限或完全关闭 AI。

## 界面截图

| 看板（浅色） | 看板（深色） |
| --- | --- |
| ![看板-浅色](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png) | ![看板-深色](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-dark.png) |

| 任务详情（浅色） | 任务详情（深色） |
| --- | --- |
| ![任务详情-浅色](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-light.png) | ![任务详情-深色](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-dark.png) |

| 继续此任务弹窗 | 提示词放入原会话输入框 |
| --- | --- |
| ![继续此任务](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-modal.png) | ![提示词放入会话](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-placed.png) |

| 右侧栏形态（窄） | 右侧栏全屏 |
| --- | --- |
| ![右侧栏形态](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-panel.png) | ![右侧栏全屏](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-fullscreen.png) |

| 产物预览入口 | 设置（齿轮常驻） |
| --- | --- |
| ![产物](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-artifacts.png) | ![设置](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/settings-dual.png) |

| 「⋯」菜单（仅导出 JSON） | 1280 宽窗口 |
| --- | --- |
| ![工具栏菜单](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/toolbar-menu.png) | ![1280](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-1280.png) |

> 以上截图来自一套完全虚构的演示数据（虚构工作区 / 会话 / 任务），不含任何真实用户或工作区信息。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0`（在 0.2.1-rc.5 桌面版验证） |
| Node.js | `>= 22.19.0`（插件使用内置 `node:zlib` 的 zstd API） |
| 平台 | macOS 桌面版已验证；其他桌面平台理论可用但未逐一验证 |
| 第三方依赖 | 无（插件与工具脚本均为零依赖） |

> 插件依赖 DSH 的第三方插件接口，DSH 大版本升级可能带来不兼容。升级 DSH 后如入口消失，先重装插件；看板数据不会丢失。

## 常见问题

**Q：更新插件后界面还是旧版 / 看不到新功能？**
A：最常见原因是 profile 依赖仍是旧范围（如 `^0.3.0`），跨 minor 需要安装**精确版本**（如 `dsh-super-kanban@0.4.1`）。先 `Cmd+R` 刷新，再完全退出 DSH 重开；仍无效则按 [docs/TROUBLESHOOTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#更新后-ui-未变) 检查实际安装版本与依赖规格。

**Q：左侧栏没有「任务看板」？**
A：按 `Cmd+R` 刷新窗口；仍没有则重启 DSH。仍没有请查看 DSH 插件页的诊断信息（插件加载失败会提示原因）。

**Q：卡片没有更新 / 一直是旧状态？**
A：点右上角扫描按钮手动触发；或检查设置中的「自动扫描」是否开启。

**Q：AI 判断错了怎么办？**
A：点开卡片直接改字段（编辑即锁定），AI 之后不会再覆盖；如需重新判定，在来源会话中继续对话后等待下一次扫描，插件会自动更新这张卡。

**Q：不想让某些工作区进看板？**
A：看板页头设置齿轮 → 排除工作区（可多选）。

**Q：会消耗我多少额度？**
A：扫描时对**有变化的**会话各调用一次 `deepseek-flash`；设置页可查看今日调用数与 tokens。关闭 AI 后完全零额度。

**Q：数据在哪里？卸载会丢吗？**
A：`~/.dsh/storages/super-kanban/`（`state.json` / `sessions-cache.json` / `backups/`）。卸载插件不删除数据。

**Q：能导出吗？**
A：看板页头「⋯」→ 导出 JSON，下载 `super-kanban-YYYYMMDD.json`。

## 开发与贡献

- 零第三方依赖；`node --test` 测试；`scripts/` 下提供校验、隐私扫描与市场索引生成脚本。
- 常用命令：

```bash
npm test              # 单元测试
npm run validate      # 包清单、Cordis patch、文件与市场索引校验
npm run check:privacy # 扫描个人路径 / 凭证 / 会话 id 等敏感内容
npm run market:index  # 重新生成 docs/index.json
```

- 开发环境搭建、目录结构与调试方法见 [CONTRIBUTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) 与 [docs/DEVELOPMENT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md)。
- 架构说明见 [docs/ARCHITECTURE.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md)，接口契约见 [docs/CONTRACT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)，视觉规范见 [docs/DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md)。
- 发布与分发流程（市场索引、npm、Git）见 [docs/MARKET.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/MARKET.md)。
- 用户侧排障手册见 [docs/TROUBLESHOOTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)。
- 安全问题请按 [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) 私下报告，不要开公开 issue。

## License

[MIT](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
