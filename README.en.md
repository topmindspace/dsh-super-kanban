# Super Kanban · AI Task Command Center

**Turns your DSH sessions into a task board that keeps itself up to date.** It reads the real sessions across your local workspaces and infers each task's goal, progress, completion and blockers — or you can manage everything by hand. Every card traces back to a specific session and a specific sentence.

[![CI](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/topmindspace/dsh-super-kanban/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-super-kanban.svg)](https://www.npmjs.com/package/dsh-super-kanban)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE)

**English** | [简体中文](https://github.com/topmindspace/dsh-super-kanban/blob/main/README.md)

> Requires DSH `>= 0.2.1-rc.5 < 0.3.0` · Node.js `>= 22.19.0` · zero third-party dependencies · no telemetry

![Task board (light)](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-light.png)

## Quick start

### Install (pick one)

1. **Plugin market (recommended)**: DSH → Plugins → Discover → add the index source `https://topmindspace.github.io/dsh-super-kanban/index.json` → install **Super Kanban** → enable and reload the window.
2. **npm**: DSH → Plugins → Add plugin → enter `dsh-super-kanban` (use an exact version when upgrading) → install → enable and reload the window.
3. **Git repository**: Plugins → Add plugin → paste `https://github.com/topmindspace/dsh-super-kanban` → install → enable and reload the window.

Local/source install, version verification, updates and rollback: [installation guide](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md).

### First run

1. Click **任务看板** (Task board) in the left sidebar (or the board icon in a conversation header for the right-sidebar layout).
2. Open **Settings** from the board header: keep "AI 联网研判" (online AI) enabled, and leave "AI 研判模型" following the DSH default.
3. Click **Scan**; the first scan takes seconds to minutes depending on session count, and the outcome stays in the stats line.
4. Cards appear automatically — click one to open the drawer; the header "⋯" menu can re-analyze a single card at any time.
5. To continue the work: click **"继续此任务"** in the drawer — the prompt is placed in the original session input and never sent automatically, so review it and press send yourself.

## What it does

- **Automatic cards that stay fresh**: derives title, goal, status, progress, issues and next steps from local DSH sessions, then keeps them updated on incremental scans without creating duplicates.
- **AI analysis with a model you choose**: follows the DSH default model by default, or uses a third-party model configured in DSH; when AI is off or unavailable it falls back to local rules.
- **Continue a task with zero tokens**: assembles a structured prompt locally and, after your confirmation, puts it into the original session or a new one in the same workspace — never sends it for you.
- **Two layouts**: a full four-column board, or a compact board in the conversation's right sidebar that adapts to its width.
- **Local-first**: board data is written only to `~/.dsh/storages/super-kanban/` on your machine, and the board itself has no telemetry.
- **Zero third-party dependencies**: neither the plugin nor the validators ship runtime dependencies; no build step, no external resources.
- **Manual control**: create / edit / drag / archive / delete / lock fields — AI never overwrites fields you changed.
- **Fully traceable**: key facts, issues, artifacts and the evidence timeline all link back to the source session.

## AI and models

- **Follows the DSH default model by default** — you do not enter any key in the board.
- **Using a third-party model**: add a model provider in **DSH Settings → Models** (OpenAI / Anthropic / OpenRouter and similar, or a custom compatible endpoint) and enter its API key; then pick it under board Settings → "AI 研判模型", or keep following the default.
- **Without a native model service** (old DSH or a minimal composition) the board switches to the local rules engine automatically and explains why in the scan outcome.
- **Privacy**: AI analysis only sends a compressed session digest (≤1.5KB per session) to the model provider you configured in DSH — choosing a third-party provider sends it there; the board never reads or stores credentials and has no telemetry. See [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md).

## Settings and budget

- **AI budget**: "Auto" by default = use up to the daily remainder per scan; or fix it at 20 / 40 / 80 / 150 calls.
- **Daily limit**: 150 budget units by default, reset at local midnight (budget units are not a hard cost cap).
- **Scanning**: the auto-scan interval is configurable; sessions a scan could not finish continue on the next scan, and the outcome says "remaining N sessions continue next scan" — nothing is lost.
- **Entry preferences**: "Display and entry" offers both / full page only / right sidebar only; changes take effect after reloading the window.

## Screenshots

| Board (dark) | Task details |
| --- | --- |
| ![Board dark](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-dark.png) | ![Task details](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-light.png) |

| Settings and budget | Right sidebar |
| --- | --- |
| ![Settings](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/settings-dual.png) | ![Right sidebar](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-panel.png) |

More screenshots: [demo GIF](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/demo.gif), [task details (dark)](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-dark.png), [continue task](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-modal.png), [prompt placed](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/continue-placed.png), [right sidebar fullscreen](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/side-fullscreen.png), [artifacts](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/drawer-artifacts.png), [toolbar menu](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/toolbar-menu.png), [1280px window](https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/docs/screenshots/board-1280.png).

> All screenshots use a fully fictional demo dataset and contain no real user or workspace information.

## Compatibility

| Item | Requirement |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0` |
| Node.js | `>= 22.19.0` (bundled with DSH, no separate install needed) |
| Platform | Verified on macOS desktop; other desktop platforms should work but are not individually verified |
| Third-party dependencies | None (plugin and `scripts/` validators are dependency-free) |
| AI models | Provided by DSH's native model service: follows the DSH default model, or a third-party provider |

Security fixes land on the current minor line; cross-minor upgrades need an exact version, see [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级). If the entry disappears after a DSH major upgrade, reinstall the plugin first — board data is not lost.

## FAQ

**Q: There is no "任务看板" in the left sidebar?**
A: Press `Cmd+R` to reload the window; if it is still missing, fully quit and reopen DSH. Still missing? Check the plugin page diagnostics, or see the [troubleshooting guide](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#入口缺失).

**Q: AI does not work / the board always shows "rules"?**
A: Make sure "AI 联网研判" is enabled in settings and that a model is configured in DSH Settings → Models (sign in, or enter an API key); board Settings → "AI 研判模型" can also pin a specific model. Old DSH builds without the native model service always use the rules engine until DSH is upgraded.

**Q: How do I update?**
A: Third-party plugins have no automatic upgrade: uninstall the old version → install the target version (exact version for cross-minor upgrades) → reload the window. See [INSTALL.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/INSTALL.md#3-更新插件升级).

**Q: Where is the data? Is it lost after uninstalling?**
A: `~/.dsh/storages/super-kanban/` (`state.json` / `sessions-cache.json` / `backups/`). Uninstalling the plugin does not delete it; to wipe it completely see the [troubleshooting guide](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/TROUBLESHOOTING.md#卸载与数据保留).

**Q: How do I uninstall?**
A: Remove it from the plugin page, or run `./uninstall.sh -y` in the source directory, then reload the window.

## Development and contributing

- Zero third-party dependencies, no build: the host is Node ESM and the browser half is a single `client.js`; run `npm test` for tests and `npm run check` for every validator at once.
- Repository layout, debugging and commands: [CONTRIBUTING.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/CONTRIBUTING.md) and [docs/DEVELOPMENT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DEVELOPMENT.md).
- Architecture and interfaces: [ARCHITECTURE.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/ARCHITECTURE.md), [CONTRACT.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/CONTRACT.md); visual rules: [DESIGN.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/docs/DESIGN.md).
- For security issues, please follow [SECURITY.md](https://github.com/topmindspace/dsh-super-kanban/blob/main/SECURITY.md) and report privately instead of opening a public issue.

## License

[MIT](https://github.com/topmindspace/dsh-super-kanban/blob/main/LICENSE) © topmindspace
