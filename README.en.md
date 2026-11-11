# Super Kanban · AI Task Command Center

Follow multiple DeepSeek Harness (DSH) sessions on one board. Plan tasks by project, see what is running and what needs your attention, review deliverables, and resume work in the linked session.

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**English** | [简体中文](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.md)

![Super Kanban cover](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/cover.png)

> The cover illustrates the workflow. [See the actual interface](#interface-demo).

## Quick start

### Install

- **Plugin market** · In DSH, open **Plugins → Discover** and add `https://topmindspace.github.io/dsh-super-kanban/index.json`. Open **Super Kanban**, choose a version, and install it. If Discover is missing, enable the experimental plugin market using the [installation guide](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#方式-a插件市场索引推荐).
- **npm** · Open **Plugins → Add plugin** and enter `dsh-super-kanban@0.8.0`. Replace `0.8.0` with the version you want.
- **Git or local folder** · Add the repository URL or select a local folder in the plugin page. To pin a version, check out its tag and follow the [source installation steps](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#方式-d本地目录源码脚本).

Enable the plugin and reload DSH. [Verify your version, upgrade, roll back, or uninstall](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md)

### First run

1. Open **任务看板** (Task board) from the left sidebar, or use the board icon at the top of a conversation to open it on the right.
2. Confirm the scan scope in settings and select **扫描** (Scan). The initial scan covers the last 30 days by default. Check the scan button tooltip or Maintenance for results.
3. Open **待处理** (Inbox) to find sessions that need you, or open a task to see its acceptance criteria and main deliverable.
4. Choose **继续此任务** (Continue task) or **验收产出** (Review deliverables). Check the draft, put it in a linked or new session, and send it yourself.

## Features

### Follow multiple sessions

- **Live status and inbox** · Filter running tasks, find requests for approval, answers or review, and see blockers and pending deliverables. Open the corresponding session directly.
- **Incremental scans** · Update task cards with session progress, issues, and deliverables. Link multiple sessions to one task. When auto-scan is enabled, a completed turn can bring the next scan forward.
- **Full-page board and conversation sidebar** · See the whole board or keep a compact board next to the chat. Filter by workspace and switch between list, hierarchy, and deliverable views.
- **Long columns and quick actions** · Each column scrolls independently and displays up to 30 cards per page. The Done column accepts drops while collapsed. Right-click a card or use its menu to move, pin, or archive it.

### Plan and deliver

- **Projects and schedules across workspaces** · Add project and task notes and set due dates. Track completion, blockers, and overdue work. Assign tasks in bulk or link a workspace so new automatically created tasks go to its project. View or restore archived projects.
- **Manual organization and recovery** · Create, drag, pin, and bulk archive tasks. Lock fields to keep manual edits. Manage dependencies, explicitly merge tasks, recover deleted tasks, and restore backups.
- **Evidence and human review** · See the goal, acceptance criteria, main deliverable, and source sessions. Preview artifacts, copy paths, or reveal files in the file manager. The task keeps a record of acceptance.
- **Continue with context** · Draft a handoff from the acceptance criteria, key decisions, unfinished work, and artifacts. Place it in a linked session or start a new session in the same workspace.

### Models and quick chat

- **Shared model selection** · Scans, reanalysis, polishing, and quick chat share the board's selected model. Follow the DSH default or choose another model configured in DSH. Scans use local rules when AI analysis is disabled or the model is unavailable.
- **Streaming quick chat** · Ask follow-up questions, translate between Chinese and English, stop a response, copy individual replies, or clear the conversation. Switching models starts fresh context with the next message and keeps previous replies visible.

## Interface demo

[Watch the animated demo](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/demo.gif) · [Browse all screenshots](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/SCREENSHOTS.md)

![Full-page task board in the light theme](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

| Project overview | Project schedule |
| --- | --- |
| ![Project overview](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/projects.png) | ![Project schedule](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/project-schedule.png) |

| Dark board | Task details |
| --- | --- |
| ![Dark board](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-dark.png) | ![Task details](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-light.png) |

| Model picker | Conversation sidebar |
| --- | --- |
| ![Model picker](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/model-picker.png) | ![Conversation sidebar](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-panel.png) |

> Screenshots use fictional demo data.

## AI and models

Configure models and credentials in **DSH Settings → Models**. Back on the board, follow the DSH default or select a specific model. [Configure a third-party model](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#接入第三方模型或自定义模型-api)

Scans have a default daily budget of 150 analysis units. You can adjust the per-scan budget. Later scans pick up remaining sessions. [Budgets and scan progress](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#ai-预算与剩余会话)

Task and project notes stay in `~/.dsh/storages/super-kanban/` on your machine. The plugin has no telemetry. When AI analysis is enabled, the selected model service receives a compact session digest and limited related task details. Polishing and quick chat send their respective inputs when you use them. [Security and privacy policy](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md)

## Compatibility

Requires DSH `>= 0.2.1-rc.5 < 0.3.0` and Node.js `>= 22.19.0` (bundled with DSH). Tested on macOS desktop. Other desktop platforms have yet to be individually verified. The plugin has no third-party runtime dependencies.

## Documentation and contributing

- **Usage** · [Install, upgrade, and uninstall](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [Troubleshooting](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)
- **Versions** · [Changelog](https://github.com/topmindspace/dsh-super-kanban/blob/main/CHANGELOG.md) · [Roadmap](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ROADMAP.md)
- **Development** · [Contributing](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) · [Developer guide](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md) · [Architecture](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md) · [API contract](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md)

Run `npm run check` for tests and validation. Please report security issues privately as described in the security policy.

[MIT License](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
