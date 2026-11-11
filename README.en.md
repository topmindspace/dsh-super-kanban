# Super Kanban · AI Task Command Center

Manage projects and tasks in DeepSeek Harness (DSH): track session progress, handle blockers, review deliverables, and continue work from the board.

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**English** | [简体中文](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.md)

![Super Kanban cover](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/cover.png)

## Features

- **Automatic updates**: incrementally scan sessions for progress, issues, and deliverables; manage tasks manually and lock fields too.
- **Projects and schedules**: organize tasks across workspaces, add notes and due dates, and track project progress.
- **Inbox and review**: find approvals, questions, and deliverables awaiting review, then return to the linked session.
- **Flexible layouts**: use a full-page board, a conversation sidebar, and quick chat, with light and dark themes.

[View screenshots](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/SCREENSHOTS.md)

## Quick start

1. In DSH, open **Plugins → Add plugin**, enter `dsh-super-kanban@0.8.0`, install and enable it, then reload the window. You can also use the [plugin market](https://topmindspace.github.io/dsh-super-kanban/index.json) or install from source; `0.8.0` is an example of an exact version.
2. Open **任务看板** (Task board) in the left sidebar, check the scan scope in settings, and click **扫描** (Scan). The UI is currently in Chinese.
3. Open **待处理** (Inbox), select a task, and choose **继续此任务** (Continue task) or **验收产出** (Review deliverables). Review the draft and send it yourself.

[Install, upgrade, and uninstall](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [Troubleshooting](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md)

## AI and models

The board follows the DSH model configuration by default, or you can select another model configured in DSH. It uses local rules when AI is off or the model is unavailable. AI analysis sends a compact session digest and limited related task details to the selected model service; polishing and quick chat send their respective inputs when used. Board data stays locally in `~/.dsh/storages/super-kanban/`, and the plugin has no telemetry. See the [security and privacy policy](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md).

## Compatibility

Requires DSH `>= 0.2.1-rc.5 < 0.3.0` and Node.js `>= 22.19.0` (bundled with DSH). Verified on macOS desktop; other desktop platforms have not been individually verified. The plugin has no third-party dependencies.

## Documentation and contributing

[Installation](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md) · [Troubleshooting](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md) · [Security and privacy](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) · [Development](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md) · [Contributing](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) · [Roadmap](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ROADMAP.md)

Run `npm run check` for tests and validation. Please report security issues privately as described in the security policy.

[MIT License](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
