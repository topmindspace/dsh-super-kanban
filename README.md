# Super Kanban · 智能任务指挥台

**用 AI 自动整理 DSH 会话，用一张看板管理任务和项目。** Super Kanban 从 DeepSeek Harness（DSH）的多条会话中提炼任务，生成任务卡，并随会话推进更新进度、阻塞和交付物。打开看板就能看到哪些工作正在运行、哪些需要你介入，以及哪些产出可以验收。

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**简体中文** | [English](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.en.md)

![Super Kanban 封面](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/cover.png)

> 封面为功能示意。[查看实际界面](#界面演示)

## 快速开始

### 安装

- **插件市场** · 在 DSH 的 **插件 → 发现** 添加索引源 `https://topmindspace.github.io/dsh-super-kanban/index.json`，打开 **Super Kanban**，选择版本并安装。找不到「发现」时，按[安装指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#方式-a插件市场索引推荐)开启实验性插件市场。
- **npm** · 在 **插件 → 添加插件** 输入 `dsh-super-kanban@0.10.0`。这里以 `0.10.0` 为例，可换成目标版本。
- **Git 或本地目录** · 在插件页添加仓库地址或选择本地目录。需要固定版本时，先检出对应标签，再按[源码安装步骤](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#方式-d本地目录源码脚本)安装。

安装后启用插件并刷新 DSH。[验证版本、升级、回滚与卸载](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)

### 第一次使用

1. 从左侧栏打开 **任务看板**。在会话里可点右上角的看板图标打开右侧看板，或点常驻的悬浮入口展开悬浮看板。
2. 在设置中确认活跃周期，然后点击 **扫描**。默认扫描最近 30 天有活动的会话，结果可在扫描按钮提示或「维护」中查看。
3. 在 **待处理** 打开需要介入的会话，或进入任务详情查看验收条件和主交付物。
4. 核对交付物后点 **确认验收**。还需要补做时，点 **继续此任务**，检查草稿并放入关联会话或新会话，由你发送。

## 功能特色

### 核心概念

- **工作区** · 对应 DSH 的一个工作目录，自动出现在看板里。
- **项目** · 你自建的分组，可以把多个工作区的任务归到一起，带备注、到期日和归档。
- **任务** · 一件可验收的工作。属于一个工作区，可选归入一个项目，可关联多条会话，其中一条为主会话。
- **会话** · DSH 里实际执行工作的对话。看板从会话提取进展、阻塞和交付物，审批和发送仍在会话里完成。

### 跟进多条会话

- **AI 自动整理任务** · 增量扫描提取任务目标、进展、阻塞和交付物，用来创建或更新任务卡。同一任务可关联多条会话。开启自动扫描后，会话轮次结束可提前触发更新。
- **实时状态与待处理** · 筛选正在运行的任务，集中查看待审批、待回答、待审阅、阻塞和待验收事项，直接跳转到对应会话。
- **全局、右侧与悬浮** · 同一块看板可以占满主区域、停靠在会话右侧，或悬浮在会话之上，同一时刻只显示一种。悬浮入口默认常驻会话界面，可拖动位置，可从右键菜单或设置里隐藏。展开后处理待验收、待处理、运行中和最近的任务，也能随手记一条待办或打开快聊。
- **待审批卡片条** · 会话一轮结束就钉在悬浮入口上方，不受扫描忙闲影响。点卡片直接回到那条会话，悬停出现的绿色对号才把它确认为「已完成」；卡片用会话标题和工作区/目录名、相对时间；点进某条会话时它的卡先收起，切走再出现，运行中或等待回答时也不显示，直到点对号；在会话里靠入口上方留下的那颗悬浮对号完成。工作区首字的彩色圆标记住来源，标题放不下时悬停滚动。默认显示三张，其余折叠为「还有 N 项」。
- **长列与快捷操作** · 各列独立滚动，每页最多显示 30 张卡。「已完成」可折叠，折叠后仍可拖入任务。右键或点「⋯」即可移动、置顶和归档任务。

### 规划与交付

- **工作区项目、时间线与日程** · 已纳入看板的工作区自动出现在项目页，自建项目可组织多个工作区的任务。用时间线回看状态、会话进展和交付，用日程跟进到期事项。近期和历史可以随时切换。
- **手动整理与恢复** · 新建、拖拽、置顶和批量归档任务，锁定字段以保留人工编辑。支持任务依赖、显式合并、回收站和备份恢复。
- **交付证据与人工验收** · 在详情查看目标、验收条件、主交付物和来源会话。可预览产物、复制路径或在文件管理器中定位，验收后保留确认记录。
- **带上下文续做** · 将验收条件、关键决策、未完成事项和产物生成草稿，可放入关联会话或同工作区的新会话。

### 模型与快聊

- **共享模型选择** · 扫描、重新研判、润色和快聊共用看板选择。默认跟随 DSH，也可在工具栏选用 DSH 已配置的模型。关闭 AI 研判或模型不可用时，扫描使用本地规则。
- **流式快聊** · 问答可连续追问，另有写提示词、解释、总结、润色和中英翻译。回答按 Markdown 显示，可复制、放入当前会话的输入框、存为任务或重新生成。在任务详情可就此任务快聊，任务摘要会作为参考。记录只在当前窗口的内存里，刷新窗口或点「新对话」即清空。

## 界面演示

[观看演示动图](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/demo.gif) · [查看全部截图](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/SCREENSHOTS.md)

![浅色主题的全局看板](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

| 项目管理 | 项目日程 |
| --- | --- |
| ![项目管理](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/projects.png) | ![项目日程](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/project-schedule.png) |

| 深色看板 | 任务详情 |
| --- | --- |
| ![深色看板](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-dark.png) | ![任务详情](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-light.png) |

| 悬浮看板 | 快聊 |
| --- | --- |
| ![悬浮看板的待验收列表、验收条件和操作](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/floating-summary.png) | ![快聊的模式切换和 Markdown 回答](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/quick-chat.png) |

> 界面截图使用虚构的演示数据。

## AI 与模型

模型和凭证在 **DSH 设置 → 模型** 配置。回到看板后可跟随 DSH 默认，或选择具体模型。[配置第三方模型](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#接入第三方模型或自定义模型-api)

扫描默认每天最多 150 个研判单位。可调整单次预算，未处理完的会话会在后续扫描继续。[预算与扫描进度](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#ai-预算与剩余会话)

任务和项目备注保存在本机 `~/.dsh/storages/super-kanban/`，插件无遥测。启用 AI 研判时，所选模型服务接收压缩会话摘要和少量相关任务信息。主动使用润色或快聊时会发送对应输入。[安全与隐私说明](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)

## 兼容性

需要 DSH `>= 0.2.1-rc.5 < 0.3.0` 和 Node.js `>= 22.19.0`（DSH 自带）。macOS 桌面版已验证，其他桌面平台尚未逐一验证。插件无第三方运行时依赖。

## 文档与贡献

- **使用** · [安装、升级与卸载](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [日常使用](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/WORKFLOWS.md) · [常见问题与排障](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)
- **版本** · [更新日志](https://github.com/topmindspace/dsh-super-kanban/blob/main/CHANGELOG.md) · [产品路线图](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ROADMAP.md)
- **开发** · [贡献指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) · [开发指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md) · [架构](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md) · [接口契约](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)

运行 `npm run check` 执行测试和校验。安全问题请按安全说明私下报告。

[MIT License](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
