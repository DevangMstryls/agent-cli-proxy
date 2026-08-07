# Daemon Support — Design Spec

**Date:** 2026-08-07
**Status:** Approved, pending implementation plan

## Goal

Run `agent-cli-proxy` as a persistent background daemon on macOS, Linux, and Windows: restarts automatically on crash, and can be configured to auto-start at login/boot — using one consistent tool (`pm2`) across all three platforms, rather than three separate hand-rolled OS-specific mechanisms.

## Why pm2

Evaluated and rejected `node-mac`/`node-linux`/`node-windows` (coreybutler): all three are stale (last releases 2019–2022, `node-windows` never left beta), `node-mac`/`node-linux` both default to system-level install requiring sudo, and `node-linux` only generates legacy SysV init.d scripts rather than a real `systemd` unit.

`pm2` is actively maintained (releases within weeks of this writing, 43k+ GitHub stars), and `pm2 startup` correctly targets real `launchd` (macOS) and modern `systemd` (Linux) — not legacy init scripts. Its `sudo` requirement is scoped narrowly to the one generated boot-registration command; the app itself still runs under the normal user account. Windows has no native pm2 startup story; the current community-maintained tool for that is `pm2-installer` (a separate project, requires Administrator to install).

## Architecture

- `ecosystem.config.js` at the project root — a standard pm2 process definition:
  - `name: 'agent-cli-proxy'`
  - `script: 'dist/server.js'`
  - `cwd: __dirname` (so `dotenv/config` still resolves `.env` relative to the project root regardless of where `pm2` itself is invoked from)
  - `autorestart: true` (pm2's default, set explicitly for clarity)
  - `env: {}` — left empty; `.env` is loaded by the app itself via `dotenv/config`, not duplicated into the pm2 config, so there is exactly one place secrets/config live
- New `package.json` scripts wrapping `pm2` commands, all assuming `pm2` is installed globally (`npm install -g pm2`) and `npm run build` has already produced `dist/`:
  - `daemon:start` → `pm2 start ecosystem.config.js`
  - `daemon:stop` → `pm2 stop agent-cli-proxy`
  - `daemon:restart` → `pm2 restart agent-cli-proxy`
  - `daemon:status` → `pm2 status agent-cli-proxy`
  - `daemon:logs` → `pm2 logs agent-cli-proxy`
  - `daemon:delete` → `pm2 delete agent-cli-proxy` (removes it from pm2's process list entirely, e.g. before uninstalling)
- README gets a new "Running as a daemon" section documenting:
  1. `npm install -g pm2`
  2. `npm run build`
  3. `npm run daemon:start`
  4. Boot-persistence, presented as explicit manual steps the user runs themselves (never auto-executed by our scripts, since they require elevated privileges):
     - macOS/Linux: `pm2 startup` (prints a `sudo`-prefixed command to copy/paste and run once), then `pm2 save` to persist the current process list so it's restored on next boot.
     - Windows: install and use `pm2-installer` (linked, with a one-line description that it needs an elevated/Administrator terminal), then `pm2 save`.
  5. The `daemon:*` npm scripts for day-to-day management (stop/restart/status/logs).

## Out of scope

- Auto-running the elevated `pm2 startup` command or installing `pm2-installer` on the user's behalf — these are always explicit, visible steps the user runs themselves, never something a script silently does with elevated privileges.
- Bundling `pm2` as a project dependency — it's expected to be installed globally, consistent with how pm2 itself is normally used and documented.
- Log rotation (`pm2-logrotate`) — not requested; can be a future addition if log files grow unbounded.
- Windows Task Scheduler / non-pm2 fallback — rejected during design in favor of a single consistent tool across all platforms; Windows's extra step (`pm2-installer`) is accepted as a known asymmetry, not worked around.

## Testing

This feature is not unit-testable in the existing Vitest suite (it's OS-level process supervision, not application logic). Verification is manual:

1. `npm run build && npm run daemon:start`, confirm `pm2 status agent-cli-proxy` shows it running and `curl http://127.0.0.1:<PORT>/healthz` succeeds.
2. Kill the underlying process directly (not via `pm2 stop`) and confirm pm2 auto-restarts it (`autorestart` behavior).
3. `npm run daemon:logs` shows real server output.
4. `npm run daemon:stop` / `daemon:delete` cleanly stop it.

Boot-persistence (`pm2 startup` + `pm2 save`) is documented but not verified via an actual reboot as part of this task — that's left to the user to confirm on their own machine when they choose to enable it.
