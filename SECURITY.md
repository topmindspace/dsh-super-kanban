# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.4.x | ✅ (current release line) |
| 0.3.x | ✅ (previous release line) |
| < 0.3 | ❌ (not released publicly) |

Security fixes land on the current release line. If you run an older line, the
recommended action is to upgrade to the latest `0.4.x` release (see
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
- Session and board data never leave the machine, except for the compact
  session digest described below when the optional LLM analyzer is enabled.

### Network and credentials

- When the LLM analyzer is enabled, the plugin calls the DeepSeek inference API
  over HTTPS using the local DSH account token, read from the DSH credentials
  file. The token is never logged, never written into board data or exports,
  and never sent anywhere else.
- No other outbound requests are made. There is no analytics endpoint, no update
  check, and no remote configuration fetch.
- Users can disable the AI engine in the board settings; the rules engine then
  runs entirely offline.

### API surface

- The plugin's HTTP API (`/super-kanban/api/*`) is mounted on the local DSH web
  server and is restricted to the authenticated owner principal; non-owner
  peers are rejected with `403`.
- The browser half renders task content as text (no HTML injection from session
  data).

### Out of scope

- Vulnerabilities in DeepSeek Harness itself or in the underlying model API.
  Report those upstream to the respective project.
- Incorrect or misleading task analysis output. The board is a decision aid;
  conclusions should be reviewed by a human.
- Issues that require an attacker to already control the user's DSH home
  directory, credentials file or local account.

### Hardening recommendations

- Keep DSH and the plugin up to date.
- Run untrusted repositories/workspaces with an isolated `DSH_HOME` and AI
  disabled.
- Review the data directory if you share a machine profile; board data can
  contain excerpts of your sessions.
