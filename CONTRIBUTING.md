# Contributing to Super Kanban

Thanks for your interest in Super Kanban, an AI task kanban plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This guide
covers the development environment, repository layout, local debugging, tests
and the pull-request flow.

## Development environment

- **Node.js** `>= 22.19.0` (the plugin uses the built-in `node:zlib` zstd APIs).
- **DeepSeek Harness** desktop app, or the `dsh` CLI running `dsh web`.
  The CLI is not always on `PATH` in a desktop install; on macOS the app bundle
  ships it under `Contents/Resources/app.asar/dsh/`, and the maintainer scripts
  in `dev/` show how to launch that bundled CLI. Use the app/plugin UI when the
  CLI is unavailable.
- No package installation is required: the plugin and all scripts have **zero
  third-party dependencies**. `node_modules/` is not used by this repository.
- `bash` + `python3` for the source-install helpers (`install.sh` / `uninstall.sh`)
  — the plugin-page install path does not need them.
- `git` and the `gh` CLI are convenient but optional for development.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.mjs` | Host entry: mounts the API on the DSH web server and starts the service. |
| `client.js` | Browser half: hand-written, build-free DSH client plugin bundle. |
| `cordis.patch.yml` | Cordis bundle patch that inserts the plugin into a DSH profile. |
| `server/` | Host implementation: session scanning, rules/LLM analysis, store, HTTP service. |
| `package.json` | npm package metadata, DSH plugin manifest (`dsh` field) and scripts. |
| `icon.svg` | Plugin icon (128×128). |
| `docs/` | Public docs, screenshots, the GitHub Pages landing page (`index.html`) and the plugin-market index (`index.json`). |
| `scripts/` | Zero-dependency validators, docs/version checkers, market-index generator and release helper. |
| `tests/` | `node --test` suites; no third-party runner. |
| `install.sh` / `uninstall.sh` | Link/unlink the local checkout into a DSH profile. |
| `.github/` | CI, release workflow, Dependabot config and issue/PR templates. |
| `CHANGELOG.md` | Keep a Changelog release notes; must match `package.json` on every release. |
| `dev/` | Maintainer-local dev/screenshot/QA tooling — **git-ignored, not distributed**; see `dev/README.md`. |
| `internal/docs-internal/` | Historical v1–v3 design/QA notes — **git-ignored**; see that directory's `README.md`. |

> The two last directories are ignored by `.gitignore` so the published repository
> and npm package stay free of local paths and machine-specific tooling. A fresh
> clone will not contain them; public docs must not link into them. Their role,
> prerequisites and history are documented in each directory's `README.md`.

## Local development

Run DSH against an isolated home so your personal profile and data stay
untouched:

```bash
export DSH_HOME="$HOME/.dsh-dev"
dsh web --port 56790          # first run creates the isolated profile
./install.sh -y               # link this checkout into that profile
```

Open `http://127.0.0.1:56790`, reload the window, and pick **任务看板** in the
sidebar. Because `install.sh` links the working tree, host-side edits
(`index.mjs`, `server/**`) take effect after a reload of the DSH profile; the
browser bundle (`client.js`) is also loaded from the working tree.

Useful commands:

```bash
npm test                      # node --test tests/
npm run validate              # metadata, syntax, files, cordis patch, market index
npm run check:privacy         # scan repository text for personal data / credentials
npm run check:docs            # doc links/anchors, screenshots, README.zh/en parity, Pages page
npm run check:version         # package.json / CHANGELOG / market index / compatibility ranges
npm run check                 # run every check above (what CI verifies)
npm run market:index          # regenerate docs/index.json (git source, current HEAD)
npm pack --dry-run            # inspect the published tarball contents
```

To exercise the AI engine you need a DSH account credential already present in
the isolated home; otherwise the plugin simply falls back to the rules engine.
No network access is required for the test suite.

## Code conventions

- **Zero third-party dependencies.** Use the Node.js standard library only.
- ES modules (`.mjs`), async/await, no build step, no transpiler.
- The browser bundle is hand-written and loaded through DSH's
  `__ModuleLoader__`; it may only depend on the modules DSH injects via
  `dsh.client.inject`.
- Keep host and client boundaries as documented in `docs/ARCHITECTURE.md`; new
  API routes and task fields belong in the contract docs first.
- Style: 2-space indentation, LF line endings, UTF-8 (see `.editorconfig`).
- Comments and identifiers in English; user-facing UI copy is Chinese for now.
- Never log tokens or credentials, and never write outside
  `$DSH_HOME/storages/super-kanban/`.
- Keep public docs and tests free of real workspace names, session ids, user
  names, machine paths or credentials. Use synthetic fixtures.

## Tests

The suite is `node --test`-based, zero-dependency and offline:

```bash
npm test
```

Please add or update tests for any behaviour change. Tests must pass on the
Node versions exercised by CI (22.19 and 24) without DSH running. CI also
prints a **non-blocking** coverage report on the Node 22.19 job via
`node --test --experimental-test-coverage`; it is informational, not a
threshold, so a coverage dip does not fail the pull request.

## Documentation

Public documentation is part of the product surface and is checked in CI:

- **Chinese and English READMEs must stay in sync.** `README.md` and
  `README.en.md` are reviewed as a pair: same section structure, tables, code
  blocks and screenshot set. `npm run check:docs` fails when they drift.
- **Links must resolve.** Use relative links between repository docs
  (`docs/INSTALL.md`) and absolute `https://github.com/topmindspace/dsh-super-kanban/...`
  links only where a file already does so for rendering on npm/GitHub. Heading
  anchors are validated too.
- **Screenshots** live in `docs/screenshots/` and must be generated from the
  fully synthetic demo dataset; never commit a screenshot containing a real
  workspace, session, account or local path.
- **Compatibility claims and example versions** are checked by
  `npm run check:version` against `package.json` (`engines`, `version`), the
  `CHANGELOG.md` entry and the committed market index.
- **Historical notes** in `internal/docs-internal/` are archival only; do not
  treat them as current documentation or link to them from public docs.
- The GitHub Pages landing page (`docs/index.html`) must not hard-code the
  package version; it reads `docs/index.json` at runtime.

Run `npm run check:docs` after touching any Markdown, screenshot, workflow badge
or the Pages landing page.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(board): add subtask filter
fix(store): keep history when migrating
docs: clarify market index generation
test(analyzer): cover title similarity thresholds
chore(ci): bump setup-node
```

Keep commits focused and describe the user-visible effect in the body when the
change is not obvious.

## Pull requests

1. Fork the repository and create a topic branch from `main`.
2. Make the change, add tests, and run `npm run check` locally (tests,
   manifest validation, privacy scan, documentation links and version
   consistency).
3. Regenerate `docs/index.json` only when you intentionally change package
   metadata (`npm run market:index`); otherwise leave it alone.
4. Open a pull request using the template. CI must be green; a maintainer will
   review.
5. By contributing you agree that your contribution is licensed under the
   repository's [MIT License](./LICENSE).

## Reporting bugs

Use the issue templates. For security vulnerabilities, **do not open a public
issue**; follow [SECURITY.md](./SECURITY.md).
