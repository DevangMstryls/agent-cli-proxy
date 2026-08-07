# agent-cli-proxy

An OpenAI-compatible HTTP server that shells out to the `claude` CLI, so any
OpenAI-compatible client (Hermes, OpenChamber, etc.) can drive a Claude
subscription — with full tool/agent access — through a standard "custom API
base URL" integration, instead of paying per-token API billing.

Runs on localhost only. Built provider-agnostic (`AgentProvider` interface)
so Codex/Cursor CLIs can be added later without HTTP-layer changes.

## Prerequisites

- Node.js 22+
- The `claude` CLI installed and already logged into your subscription
  (`claude auth login` — this proxy relies on OAuth/keychain auth, not an
  API key).

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set API_KEY to a random secret, and WORKDIR to the directory
# you want the agent to operate in (it will have Bash/Edit/file access there).
npm run build
npm start
# or, for local development with auto-reload:
npm run dev
```

## Security model

- **A valid `API_KEY` is full agent access, not just chat access.** The
  proxy runs Claude with `--permission-mode acceptEdits`, so any request
  authenticated with the bearer token can execute real Bash commands and
  edit files — it is not a scoped, read-only chat API. Treat `API_KEY`
  with the same care as shell access to the host.
- **The optional per-request `cwd` field overrides `WORKDIR`.** `WORKDIR`
  is only a default; a caller can set `cwd` in the request body to point
  the agent at *any* directory the process can reach, bypassing the
  configured root entirely.
- **Localhost binding stops remote attackers, not local ones.** The
  server binds to `127.0.0.1` only, so it isn't reachable from the
  network — but any other process or user on the same machine can still
  reach it and, if they have `API_KEY`, drive the agent.
- **Generate a real random `API_KEY`.** Don't leave `.env`'s value as the
  `.env.example` placeholder — anyone who can guess or read a
  placeholder key gets the access described above.

## Verifying it works

With the server running in one terminal:

```bash
API_KEY=<value from your .env> ./scripts/smoke-test.sh
```

This checks `/healthz`, `/v1/models`, a non-streaming chat completion, and a
streaming chat completion, in order.

## Running as a daemon

For long-lived use (rather than running `npm start` in a terminal you have to
keep open), this proxy can run under [pm2](https://pm2.keymetrics.io/) as a
managed background process that restarts automatically if it crashes, on
macOS, Linux, and Windows.

```bash
npm install -g pm2
npm run build
npm run daemon:start
```

Day-to-day management:

```bash
npm run daemon:status   # is it running?
npm run daemon:logs     # tail its stdout/stderr
npm run daemon:restart  # restart it (e.g. after changing .env or rebuilding)
npm run daemon:stop     # stop it, keep it registered with pm2
npm run daemon:delete   # remove it from pm2 entirely
```

### Auto-starting at login/boot

By default pm2 (and the process it's managing) stops when you log out or
reboot. To have it come back automatically, run one of these **yourself** —
they need elevated privileges, so nothing here runs them for you:

- **macOS / Linux:** `pm2 startup` prints a `sudo`-prefixed command tailored
  to your system; copy and run that command once, then run `pm2 save` to
  persist the current process list (including `agent-cli-proxy`) so pm2
  restores it on the next boot.
- **Windows:** pm2 has no built-in boot-startup support on Windows. Install
  [`pm2-installer`](https://github.com/jessety/pm2-installer) from an
  elevated ("Run as Administrator") terminal, following its README, then run
  `pm2 save` as above.

## Pointing Hermes / OpenChamber at it

Configure the tool's "custom OpenAI-compatible provider" (or equivalent)
with:

- Base URL: `http://localhost:8787/v1`
- API key: the `API_KEY` value from your `.env`
- Model: one of `sonnet`, `opus`, `fable`, `haiku`

## Configuration reference

| Env var           | Default        | Purpose                                                        |
| ------------------ | -------------- | ---------------------------------------------------------------- |
| `API_KEY`          | *(required)*   | Bearer token clients must send in `Authorization: Bearer <key>`  |
| `PORT`              | `8787`         | HTTP port                                                        |
| `CLAUDE_BIN`        | `claude`       | Path to the `claude` binary                                      |
| `WORKDIR`           | process cwd    | Default working directory (and tool access root) for Claude runs |
| `DEFAULT_MODEL`     | `sonnet`       | Model alias used when the request's `model` isn't recognized     |
| `PERMISSION_MODE`   | `acceptEdits`  | Claude CLI `--permission-mode`                                   |
| `SESSION_TTL_MS`    | `86400000`     | How long an idle conversation can be resumed (24h default)       |
| `MAX_SESSIONS`      | `500`          | Max concurrent tracked conversations (LRU-evicted beyond this)   |

## How conversation continuity works

OpenAI's chat completions protocol resends the full message history on every
call. This proxy hashes that history to detect when a request is a
continuation of a conversation it has already seen, and in that case uses
`claude --resume <session-id>` with just the newest message instead of
replaying the whole transcript. See
`docs/superpowers/specs/2026-08-06-agent-cli-proxy-design.md` for the full
design rationale.
