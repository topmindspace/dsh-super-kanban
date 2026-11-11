# Super Kanban · 智能任务指挥台

在 DeepSeek Harness（DSH）中管理项目和任务：跟踪会话进展、处理阻塞、查看交付物，并从看板继续工作。

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**简体中文** | [English](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.en.md)

![Super Kanban 封面](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/cover.png)

## 功能

- **自动更新**：增量扫描会话，整理任务进度、问题和交付物；也可手动管理和锁定字段。
- **项目与日程**：跨工作区组织任务，设置备注和到期日，查看项目进度与待办。
- **待处理与验收**：集中查看审批、问题和待验收事项，回到关联会话继续工作。
- **灵活使用**：支持全页看板、会话右侧栏和快聊，兼容浅色与深色界面。

[查看界面截图](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/SCREENSHOTS.md)

## 快速开始

1. 在 DSH 的 **插件 → 添加插件** 输入 `dsh-super-kanban@0.8.0`，安装、启用并刷新窗口。也可通过[插件市场](https://topmindspace.github.io/dsh-super-kanban/index.json)或源码安装；`0.8.0` 是精确版本示例。
2. 打开左侧 **任务看板**，在设置中确认扫描范围，然后点击 **扫描**。
3. 在 **待处理** 查看需要关注的事项，打开任务详情，选择 **继续此任务** 或 **验收产出**。检查草稿后由你发送。

[安装、升级与卸载指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [常见问题与排障](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)

## AI 与模型

默认跟随 DSH 的模型配置，也可在看板中选择 DSH 已配置的模型；关闭 AI 或模型不可用时使用本地规则。AI 研判会向所选模型服务发送压缩会话摘要和少量相关任务信息，主动使用润色或快聊时也会发送相应输入。看板数据保存在本机 `~/.dsh/storages/super-kanban/`，插件自身无遥测。详见[安全与隐私说明](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)。

## 兼容性

需要 DSH `>= 0.2.1-rc.5 < 0.3.0` 和 Node.js `>= 22.19.0`（DSH 自带）。macOS 桌面版已验证，其他桌面平台尚未逐一验证。插件无第三方依赖。

## 文档与贡献

[安装指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [排障](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md) · [安全与隐私](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) · [开发指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md) · [贡献指南](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) · [路线图](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ROADMAP.md)

运行 `npm run check` 执行测试和校验。安全问题请按安全说明私下报告。

[MIT License](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
