# agent-cli-proxy — Design Spec

**Date:** 2026-08-06
**Status:** Approved, pending implementation plan

## Goal

An OpenAI-compatible HTTP server (`POST /v1/chat/completions`) that shells out to the `claude` CLI so any OpenAI-compatible client (Hermes, OpenChamber) can drive a Claude subscription — with full tool/agent access preserved — through a standard "custom API base URL" integration, without paying per-token API billing.

Runs on localhost only for v1. Built provider-agnostic so Codex/Cursor CLIs can be added later without touching the HTTP layer.

## Architecture

```
HTTP request (OpenAI shape)
   -> auth middleware (static bearer token)
   -> ChatCompletionsController
        -> SessionStore (maps message-history -> claude session id)
        -> ClaudeProvider (implements AgentProvider interface)
             -> spawns `claude -p ...` subprocess
             -> parses NDJSON stream-json lines
        -> SSE translator (Claude stream_event -> OpenAI chunk format)
   -> HTTP response (SSE or single JSON)
```

`AgentProvider` is a small interface (`startTurn(request) -> AsyncIterable<ProviderEvent>`, `resolveModelId(alias)`) so a future `CodexProvider`/`CursorProvider` implements the same interface. The HTTP layer, session store, and SSE translation stay provider-agnostic.

## Session / conversation mapping

OpenAI's chat completions protocol is stateless — clients resend the full `messages` array every call, with no conversation ID field. To use `claude --resume <session-id>` (cheaper, keeps Claude's own context) instead of replaying full history as one prompt each call:

- After each turn, store `hash(messages + [assistant reply]) -> claudeSessionId` in an in-memory map.
- On the next request, hash `messages[0..n-1]` (everything but the newest message). If it matches a stored entry, this is a continuation: run `claude --resume <id> -p "<newest message only>"`.
- If no match, treat as a new conversation: run `claude --session-id <new-uuid> -p "<newest message>"` (or the full transcript if there are no prior assistant turns, e.g. first message includes a system prompt).
- If the client edits/regenerates an earlier message, the hash won't match, so it's treated as a fresh branch — this is correct behavior, not a bug.
- Sessions are evicted by TTL + LRU cap (env-configurable), since `claude --resume` relies on session files persisted to disk by the CLI.
- Requests against the same session key are serialized via a lightweight per-key queue/mutex to avoid races on the same session file.

## Claude CLI invocation

```
claude -p "<message>" \
  --output-format stream-json --include-partial-messages \
  --safe-mode \
  --permission-mode acceptEdits \
  --model <mapped-model> \
  [--resume <id> | --session-id <new-uuid>] \
  --add-dir <workdir>
```

Confirmed via local testing:

- `--output-format stream-json --include-partial-messages` emits `stream_event` lines shaped as `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}}`, mapping directly onto OpenAI SSE chunks.
- The terminal `result` event carries `usage.input_tokens` / `usage.output_tokens` and `stop_reason`, used for the closing chunk's `usage` and `finish_reason`.
- **`--bare` must not be used.** It forces `ANTHROPIC_API_KEY`/`apiKeyHelper`-only auth and never reads OAuth/keychain — this would silently break subscription reuse, which is the entire point of this project.
- `--safe-mode` is used instead: it disables CLAUDE.md/hooks/plugins/MCP/output-styles (which added ~$0.16 in cache-token cost and heavy noise to a one-word "PONG" reply during testing in this workspace) while explicitly preserving normal OAuth/keychain auth, model selection, built-in tools, and permissions.

Full tool/agent access (Bash, file edit, web fetch, etc.) is intentionally kept enabled — this is meant to let Hermes/OpenChamber act as a full coding-agent frontend, not a plain chatbot. `--permission-mode acceptEdits` is the default (auto-approves file edits without requiring `bypassPermissions`, which skips all permission checks including arbitrary Bash); this is a single env var to relax further if desired.

Working directory for spawned sessions comes from a `WORKDIR` env var by default, overridable per-request via an optional extra `cwd` field in the request body (ignored by strict OpenAI clients, usable by anything that allows raw JSON fields).

## HTTP API surface

- `POST /v1/chat/completions` — standard OpenAI request shape (`model`, `messages`, `stream`); auth via `Authorization: Bearer <API_KEY>` checked against a `.env` value.
- `GET /v1/models` — static list of model aliases (`sonnet`, `opus`, `fable`, `haiku`) for client dropdowns.
- `GET /healthz` — liveness check.

## Streaming translation

Claude's `stream_event` -> `content_block_delta` -> `delta.text` maps directly to OpenAI's `chat.completion.chunk` -> `choices[0].delta.content`. The final `result` event becomes the closing SSE chunk's `usage` block and `finish_reason`. Non-streaming requests buffer all deltas server-side and return a single JSON response instead.

## Config (`.env`)

`API_KEY`, `PORT` (default 8787), `CLAUDE_BIN` (defaults to `claude` on PATH), `WORKDIR`, `DEFAULT_MODEL`, `PERMISSION_MODE`, `SESSION_TTL_MS`, `MAX_SESSIONS`.

## Error handling

Non-zero CLI exit codes and auth errors (e.g. subscription session expired, needs `claude auth login`) surface as OpenAI-style `{"error": {"message", "type", "code"}}` JSON with an appropriate HTTP status — never a raw stack trace or hung request.

## Project structure

Node.js + TypeScript, Express.

```
agent-cli-proxy/
  src/
    server.ts
    routes/chatCompletions.ts
    providers/AgentProvider.ts       # interface
    providers/ClaudeProvider.ts
    session/SessionStore.ts
    translate/openaiSse.ts
    config.ts
  .env.example
  package.json / tsconfig.json
```

## Out of scope for v1

- Codex/Cursor providers (interface is ready for them, not implemented).
- Remote deployment / auth beyond the static bearer token — localhost only.
- Translating Claude's tool use into OpenAI's client-visible `tool_calls` format — tool execution stays server-side, since the goal is full agent behavior through the chat interface, not client-driven tool calling.
