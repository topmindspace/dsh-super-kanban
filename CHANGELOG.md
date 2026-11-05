# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Task-level AI review and re-analysis**: the drawer shows an “AI 研判 / 规则推断”
  block (engine, model, confidence, last-analysis time, one-line reason) and a
  “重新研判” action in the ⋯ menu that reruns `task.analyze` for a single card.
  “可能已过期” appears only when the source session has activity newer than the
  analysis; re-analysis reports engine/calls/tokens in a toast.
- **Persistent scan outcome** in the board header: the last-scan line keeps the
  host message (sessions processed, AI calls/tokens, “本次无 AI 调用”, budget
  fallback, cancellation, failure + retry), and the scan button reads
  “扫描（仅规则）” when AI is disabled.
- **Accessibility and keyboard support**: dialogs/drawer use `role="dialog"` +
  `aria-modal` + `aria-labelledby` with a focus trap and focus restore; cards are
  keyboard-openable with visible focus rings; icon-only buttons have
  `aria-label`s; subtask rows are real toggle + delete buttons; toasts and scan
  state are announced via `aria-live`; Esc closes the topmost layer.
- **Board and drawer usability**: backlog/archived counts in the summary (zero
  values hidden), expand-all for issues/next steps, draft edits survive
  background polls (with a quiet “后台已更新” note), the continue prompt keeps
  user edits when the target changes, search covers goal/key facts/issues/next
  steps, completed cards no longer draw the coloured progress line, archived
  cards get a “已归档” marker, and the right-sidebar workspace filter stays
  visible at every width.
- **Backend**: new test-covered modules `server/auth.mjs`, `server/http.mjs` and
  `server/titles.mjs`; the host test suite grew from 55 to 177 tests
  (`sessions`, `service`, `store-robustness`, `http`, `auth`, `titles`,
  `host-entry`, `analyzer-llm`); `server/sessions.mjs` now parses session-event
  payloads from `event.data` (lineage/cwd had silently fallen back to the
  projection cache).
- **CI/CD**: `scripts/check-docs.mjs` and `scripts/check-version.mjs` with
  `npm run check` / `check:docs` / `check:version` aggregates wired into CI and
  the release workflow; non-blocking coverage report; stricter `npm pack`
  contents assertions; Dependabot for GitHub Actions.
- Maintainer documentation for the git-ignored `dev/` and
  `internal/docs-internal/` trees, plus reproducible dev scripts.

### Changed

- Text limits are now a single source of truth (`TEXT_LIMITS` in
  `server/store.mjs`): title 80, goal 280, tags 4×12, subtasks 12×60,
  issues/next steps 5×160, milestones 20×120, key facts 6×60, evidence 8
  (text 200 / quote 160), artifact name 80; client forms use the same maxima so
  edits are no longer silently truncated.
- Evidence/issue/key-fact/subtask/milestone `seq` may be `null` when a citation
  cannot be resolved against the session timeline (never a misleading `#0`); the
  UI hides unresolved `#N` badges.
- “今日” AI usage and the daily budget roll over at the user’s local midnight
  instead of UTC.
- AI/rules “done” is kept as `in_progress` (with a history note) while unfinished
  manual or locked subtasks remain; locked status always wins; generated
  subtasks still auto-close on done.
- HTTP edge validation: malformed command bodies, unknown/prototype-inherited
  ops, malformed session ids and oversized bodies now return 400 instead of 500;
  routes and successful response shapes are unchanged.
- README.zh/README.en, INSTALL, CONTRACT, DESIGN, ARCHITECTURE, DEVELOPMENT,
  TROUBLESHOOTING and the market landing page were re-checked against the code
  (export filenames, `/ping`, `/session` limits, `TEXT_LIMITS`, nullable `seq`,
  trust rule, local-day budget, the real re-analysis path, and an explicit
  roadmap for features that are not available yet). `docs/screenshots/*.png`
  were regenerated from the synthetic demo dataset and pass the demo privacy
  audit (no forbidden strings in visible text).

### Fixed

- Clicking “锁定字段” in the task drawer no longer throws (`EDITABLE_FIELDS` was
  referenced but never defined).
- Scan finalization can no longer leave the scan mutex locked (and emit an
  unhandled rejection) when the host logger or persistence throws.
- Corrupt/partially written session logs no longer force a full re-parse on
  every scan; unchanged sessions are not re-parsed just because AI is enabled
  without credentials.
- Single-task “AI 润色” reports failure honestly instead of claiming success when
  AI is disabled/unavailable.
- Background polling no longer discards unsaved drawer edits or continue-prompt
  edits.
- Search matches goal text again (it previously compared against
  `[object Object]`).
- SSE clients that half-close are dropped (plus a client cap), request bodies
  have byte/time limits, and store loading sanitizes hostile-but-valid JSON;
  backup retention also prunes `.migrate-failed` files.
- Duplicate-title merge helpers were consolidated (a duplicate `dedupeByText`
  definition silently overrode the first).
- Privacy scanner no longer flags long kebab-case `sk-*` UI ids as API keys.
- `scripts/release.mjs` regenerates the market index before running checks.
- The new-task dialog no longer claims sessions can be linked from the drawer
  (relinking is a documented roadmap item).

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
