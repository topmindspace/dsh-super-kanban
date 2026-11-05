# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-11-05

Documentation-only patch release: the plugin code is unchanged from 0.4.0.

### Added

- **Upgrade guide**: how to update an installed plugin, how to verify the
  installed version, the SemVer-range pitfall (`^0.3.0` never resolves 0.4.x;
  cross-minor upgrades need an exact version or a reinstall), and how to roll
  back.
- **Troubleshooting guide** (`docs/TROUBLESHOOTING.md`): stale UI after an
  update, missing entry point, blank board, 401/403, scanning and AI issues,
  artifact previews, sidebar widths, uninstall/data retention and diagnostics.
- **Absolute README asset and document links**, so screenshots, the demo GIF
  and docs links render correctly on the npm package page as well as GitHub.

### Changed

- README (Chinese and English), INSTALL, MARKET, DESIGN, ARCHITECTURE,
  DEVELOPMENT and CONTRACT were re-checked against the 0.4 UI and updated where
  they still described earlier behaviour (toolbar actions, accent marks, board
  status markers).

## [0.4.0] - 2026-11-05

UI refinement release: put the frequently used toolbar actions back on the
toolbar and bring back restrained emphasis and status marks without returning
to the earlier visual clutter.

### Added

- **Toolbar actions are visible**: Settings and "open in right sidebar" are
  now persistent icon buttons in the board header and the compact right-panel
  header. The overflow menu keeps only **Export JSON**.
- **Restrained emphasis and status marks**: cards show a small status dot and a
  state-tinted progress line (backlog neutral, in progress brand, blocked
  amber, done green), colored priority text (P0 error, P1 amber), issue count,
  artifact count, subtask progress and a low-key AI/rules marker. Column
  headers and the summary line carry matching status dots.
- **Task drawer depth**: colored status/priority text, type icons for key
  facts, severity-colored issues, and a brand-colored session link, while the
  primary button and DSH typography stay neutral.
- **English README** (`README.en.md`) alongside the Chinese README.

### Changed

- Color is now limited to dots, thin progress lines, small icons and short
  labels; there are no colored blocks, gradients or glow effects. Light and
  dark themes, the full board, the compact sidebar and narrow windows were all
  checked against the DSH type scale and spacing.

## [0.3.0] - 2026-11-05

First public release. Super Kanban turns the sessions of a DeepSeek Harness
workspace into a maintainable task board.

### Added

- **Automatic task analysis**: sessions are scanned on a schedule and turned
  into tasks with goal, status, progress, priority, issues, next steps,
  milestones and traceable evidence.
- **Two analysis engines**: a zero-dependency rules engine that always works
  offline, and an optional LLM engine that reuses the local DSH account quota
  and degrades to rules when disabled, over budget or offline.
- **Task detail drawer**: key facts first, editable status, subtasks, issues /
  next steps, session context, artifacts and evidence with a direct jump back
  to the source session.
- **Session hand-off**: one-click "continue this task" prompt built locally
  from the task context (no model call), inserted into the original session or
  a new session in the same workspace.
- **Subtask, artifact and goal tracking**: deterministic extraction from todo
  snapshots, write/edit tool calls and presented deliverables, plus DSH session
  goals when available.
- **Dual presentation**: a full-page board panel and a compact right-sidebar
  panel, with configurable entry visibility and a shortcut from the session
  header.
- **Manual task management**: create, edit, drag between columns, archive,
  delete, relink sessions, lock fields so analysis never overwrites them.
- **Local-first storage**: board state under the DSH home storage directory,
  atomic writes, corrupt-file recovery and version migration.
- **DSH-native visual language**: monochrome-first styling, a restrained type
  scale, hairline borders and DSH design tokens for light and dark themes.

### Changed

- Analysis output and storage are budgeted: compact session digests, incremental
  gating, per-scan and daily AI call limits, and capped evidence, key facts,
  subtasks, artifacts and history.
- Evidence and task payloads are trimmed for density; the board and drawer
  prioritise "what matters now" over raw transcript dumps.

### Security

- The plugin runs locally inside DSH, reads session storage read-only, serves
  its HTTP API to the authenticated owner only, and sends nothing to third
  parties. When the LLM engine is enabled it calls the DeepSeek inference API
  with the local DSH account token; tokens are never logged or persisted by the
  plugin. See [SECURITY.md](./SECURITY.md).

[Unreleased]: https://github.com/topmindspace/dsh-super-kanban/compare/v0.4.1...HEAD
[0.3.0]: https://github.com/topmindspace/dsh-super-kanban/releases/tag/v0.3.0
[0.4.0]: https://github.com/topmindspace/dsh-super-kanban/releases/tag/v0.4.0
[0.4.1]: https://github.com/topmindspace/dsh-super-kanban/releases/tag/v0.4.1
