# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | ✅ (current release line) |
| 0.4.x | ✅ (previous release line) |
| < 0.4 | ❌ (no longer supported) |

Security fixes land on the current release line. If you run an older line, the
recommended action is to upgrade to the latest `0.5.x` release (see
[INSTALL.md](./docs/INSTALL.md)).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** through GitHub's
[private vulnerability reporting](https://github.com/topmindspace/dsh-super-kanban/security/advisories/new).
Do **not** open a public issue for a security problem.

Please include:

- the affected version (`package.json` version, or commit for a git install),
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any relevant logs **with tokens and personal data removed**.

You can expect an acknowledgement on a best-effort basis, usually within a few
days. We will keep you informed about the fix and, unless you ask otherwise,
credit you in the release notes. Please give us a reasonable window to ship a
fix before any public disclosure.

## Scope and threat model

Super Kanban is a local DSH plugin. It does not run a standalone server and
does not collect telemetry.

### Where data lives

- The board state and session analysis cache are written to
  `$DSH_HOME/storages/super-kanban/` using atomic file writes.
- DSH session logs are read **read-only** from `$DSH_HOME/sessions/` and the
  project cache under `$DSH_HOME/storages/`.
- Local host logs may contain session ids and error messages for
  troubleshooting, but never credentials, session digests or board task titles.
- Session and board data never leave the machine, except for the compact
  session digest sent through the DSH-configured model provider when the
  optional LLM analyzer is enabled (see below).

### Network and credentials

- AI analysis does **not** talk to a model provider directly. The plugin asks
  DSH's native LLM service for the analysis, so provider routing, model
  selection and credentials (DSH account, API key, third-party providers) are
  all resolved by DSH and its credentials seam. The plugin never reads
  `~/.dsh/.credentials.yaml`, never receives or stores the token, and never
  writes credentials into board data, logs or exports.
- The only requests the plugin makes are to the local DSH web server
  (`/super-kanban/api/*`, same-origin). There is no analytics endpoint, no
  update check, no remote configuration fetch and no telemetry.
- The browser half may only fetch from the same origin; it does not load
  external fonts, images or scripts.
- Users can disable the AI engine in the board settings; the rules engine then
  runs entirely offline and no model request is made.

### Where model requests go (data recipients)

- The request body is built by the plugin: a system prompt plus a **compacted
  session digest** (≤1.5KB per session: title, recent user request, recent
  reply, todo/error/tool summaries and file paths) plus the selected
  provider/model. No full transcripts, file contents, attachments, images or
  tools are sent.
- The plugin does **not** pass a `sessionId` (which would let DSH's official
  routes attach their session-log payload), so no session log is uploaded to a
  model provider by the board.
- If you follow the DSH default model, requests go to whatever provider DSH is
  configured to use (for example the DeepSeek account or an API-key provider).
  If you explicitly select a third-party model in the board settings, the
  compacted digest is sent to **that third party**, under that provider's terms
  and data policy. The board tells you this in the settings dialog.
- Model requests may also be observed by LLM middleware installed in your DSH
  deployment (e.g. for attribution); that is part of the DSH/plugin trust
  boundary, not of this plugin.

### API surface

- The plugin's HTTP API (`/super-kanban/api/*`) is mounted on the local DSH web
  server and is restricted to the authenticated owner principal; non-owner
  peers are rejected with `403`. The model-catalogue endpoint (`GET
  /super-kanban/api/ai/models`) is read-only and exposes model ids/names only —
  never credentials.
- The browser half renders task content as text (no HTML injection from session
  data).

### Out of scope

- Vulnerabilities in DeepSeek Harness itself, in the model provider you
  configured (including third-party providers and their data handling), or in
  a model's behaviour. Report those upstream to the respective project.
- Incorrect or misleading task analysis output. The board is a decision aid;
  conclusions should be reviewed by a human.
- Issues that require an attacker to already control the user's DSH home
  directory, credentials file or local account.

### Hardening recommendations

- Keep DSH and the plugin up to date.
- Only configure model providers you trust: with a third-party provider the
  compacted session digest is sent to that provider. Review the provider list
  in **DSH Settings → Models** and choose the model in the board settings
  deliberately.
- Run untrusted repositories/workspaces with an isolated `DSH_HOME` and AI
  disabled.
- Review the data directory if you share a machine profile; board data can
  contain excerpts of your sessions.
