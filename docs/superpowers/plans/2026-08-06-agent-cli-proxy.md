# agent-cli-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a localhost OpenAI-compatible HTTP server (`POST /v1/chat/completions`) that shells out to the `claude` CLI, so Hermes/OpenChamber can drive a Claude subscription — with full tool/agent access — through a standard "custom API base URL" integration.

**Architecture:** Express app with an `AgentProvider` interface (`ClaudeProvider` is the only implementation for now); a `SessionStore` maps hashed message-history prefixes to `claude --resume` session IDs so multi-turn conversations reuse Claude's own context instead of replaying full history; a streaming NDJSON parser converts `claude -p --output-format stream-json` output into OpenAI-shaped SSE chunks or a single JSON completion.

**Tech Stack:** Node.js 22, TypeScript (NodeNext ESM), Express 4, Vitest + Supertest for tests, `tsx` for local dev.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-agent-cli-proxy-design.md`
- Must NOT pass `--bare` to the `claude` CLI — it forces API-key-only auth and breaks subscription reuse.
- Must pass `--safe-mode` to the `claude` CLI to avoid CLAUDE.md/hook noise and cost while preserving OAuth/keychain auth.
- Full tool/agent access stays enabled (no `--tools ""`); default `--permission-mode acceptEdits`.
- Runs on localhost only; auth is a single static bearer token compared against `API_KEY`.
- `AgentProvider` must be a standalone interface so future `CodexProvider`/`CursorProvider` implementations don't require HTTP-layer changes.
- All relative imports use explicit `.js` extensions (NodeNext ESM resolution requirement, even though source files are `.ts`).

---

### Task 1: Project scaffolding, config, health endpoint

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `src/app.ts`
- Create: `src/server.ts`
- Test: `test/config.test.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Produces: `AppConfig` (`src/config.ts`) — `{ port: number; apiKey: string; claudeBin: string; workdir: string; defaultModel: string; permissionMode: string; sessionTtlMs: number; maxSessions: number }`
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`
- Produces: `AppDeps` (`src/app.ts`) — `{ config: AppConfig }`
- Produces: `createApp(deps: AppDeps): express.Express`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agent-cli-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.2",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 4: Create `.env.example`**

```
API_KEY=changeme
PORT=8787
CLAUDE_BIN=claude
WORKDIR=/absolute/path/to/a/scratch/or/project/dir
DEFAULT_MODEL=sonnet
PERMISSION_MODE=acceptEdits
SESSION_TTL_MS=86400000
MAX_SESSIONS=500
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, `node_modules/` populated, exit 0.

- [ ] **Step 6: Write the failing config test**

`test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when API_KEY is missing', () => {
    expect(() => loadConfig({})).toThrow('API_KEY');
  });

  it('applies defaults when only API_KEY is set', () => {
    const config = loadConfig({ API_KEY: 'abc123' });
    expect(config.port).toBe(8787);
    expect(config.claudeBin).toBe('claude');
    expect(config.workdir).toBe(process.cwd());
    expect(config.defaultModel).toBe('sonnet');
    expect(config.permissionMode).toBe('acceptEdits');
    expect(config.sessionTtlMs).toBe(86400000);
    expect(config.maxSessions).toBe(500);
  });

  it('reads overrides from env', () => {
    const config = loadConfig({ API_KEY: 'abc123', PORT: '9999', DEFAULT_MODEL: 'opus' });
    expect(config.port).toBe(9999);
    expect(config.defaultModel).toBe('opus');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 8: Implement `src/config.ts`**

```ts
export interface AppConfig {
  port: number;
  apiKey: string;
  claudeBin: string;
  workdir: string;
  defaultModel: string;
  permissionMode: string;
  sessionTtlMs: number;
  maxSessions: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }
  return {
    port: Number(env.PORT ?? 8787),
    apiKey,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    workdir: env.WORKDIR ?? process.cwd(),
    defaultModel: env.DEFAULT_MODEL ?? 'sonnet',
    permissionMode: env.PERMISSION_MODE ?? 'acceptEdits',
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 1000 * 60 * 60 * 24),
    maxSessions: Number(env.MAX_SESSIONS ?? 500),
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Write the failing health endpoint test**

`test/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const testConfig: AppConfig = {
  port: 0,
  apiKey: 'test-key',
  claudeBin: 'claude',
  workdir: process.cwd(),
  defaultModel: 'sonnet',
  permissionMode: 'acceptEdits',
  sessionTtlMs: 1000,
  maxSessions: 10,
};

describe('GET /healthz', () => {
  it('returns 200 ok without requiring auth', async () => {
    const app = createApp({ config: testConfig });
    const response = await request(app).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run test/app.test.ts`
Expected: FAIL — `src/app.ts` does not exist yet.

- [ ] **Step 12: Implement `src/app.ts`**

```ts
import express, { type Express } from 'express';
import type { AppConfig } from './config.js';

export interface AppDeps {
  config: AppConfig;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
```

- [ ] **Step 13: Implement `src/server.ts`**

```ts
import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, () => {
  console.log(`agent-cli-proxy listening on port ${config.port}`);
});
```

- [ ] **Step 14: Run full test suite to verify it passes**

Run: `npx vitest run`
Expected: PASS (4 tests total)

- [ ] **Step 15: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example src/config.ts src/app.ts src/server.ts test/config.test.ts test/app.test.ts package-lock.json
git commit -m "Scaffold project with config loader and health endpoint"
```

---

### Task 2: Auth middleware

**Files:**
- Create: `src/middleware/auth.ts`
- Modify: `src/app.ts`
- Modify: `test/app.test.ts`
- Test: `test/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `AppConfig` from Task 1 (`src/config.ts`)
- Produces: `createAuthMiddleware(config: AppConfig): express.RequestHandler`

- [ ] **Step 1: Write the failing auth middleware test**

`test/middleware/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../../src/middleware/auth.js';
import type { AppConfig } from '../../src/config.js';

const config = { apiKey: 'secret-token' } as AppConfig;

function buildTestApp() {
  const app = express();
  app.use(createAuthMiddleware(config));
  app.get('/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('requireApiKey middleware', () => {
  it('rejects requests without an Authorization header', async () => {
    const response = await request(buildTestApp()).get('/protected');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('rejects requests with the wrong token', async () => {
    const response = await request(buildTestApp()).get('/protected').set('Authorization', 'Bearer wrong');
    expect(response.status).toBe(401);
  });

  it('allows requests with the correct bearer token', async () => {
    const response = await request(buildTestApp())
      .get('/protected')
      .set('Authorization', 'Bearer secret-token');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/middleware/auth.test.ts`
Expected: FAIL — `src/middleware/auth.ts` does not exist yet.

- [ ] **Step 3: Implement `src/middleware/auth.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';

export function createAuthMiddleware(config: AppConfig) {
  return function requireApiKey(req: Request, res: Response, next: NextFunction) {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || token !== config.apiKey) {
      res.status(401).json({
        error: {
          message: 'Invalid or missing API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/middleware/auth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the middleware onto a `/v1` router in `src/app.ts`**

Modify `src/app.ts` to:

```ts
import express, { type Express, Router } from 'express';
import type { AppConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';

export interface AppDeps {
  config: AppConfig;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const v1 = Router();
  v1.use(createAuthMiddleware(deps.config));
  app.use('/v1', v1);

  return app;
}
```

- [ ] **Step 6: Add a regression test to `test/app.test.ts`**

Append to `test/app.test.ts`:

```ts
describe('GET /v1/*', () => {
  it('requires auth even for unknown v1 routes', async () => {
    const app = createApp({ config: testConfig });
    const response = await request(app).get('/v1/does-not-exist');
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 7: Run full suite to verify it passes**

Run: `npx vitest run`
Expected: PASS (7 tests total)

- [ ] **Step 8: Commit**

```bash
git add src/middleware/auth.ts src/app.ts test/middleware/auth.test.ts test/app.test.ts
git commit -m "Add bearer token auth middleware for /v1 routes"
```

---

### Task 3: Model alias route

**Files:**
- Create: `src/routes/models.ts`
- Modify: `src/app.ts`
- Test: `test/routes/models.test.ts`

**Interfaces:**
- Produces: `MODEL_ALIASES: string[]` (`src/routes/models.ts`) — `['sonnet', 'opus', 'fable', 'haiku']`
- Produces: `handleListModels(req: Request, res: Response): void`

- [ ] **Step 1: Write the failing test**

`test/routes/models.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';

const testConfig: AppConfig = {
  port: 0,
  apiKey: 'test-key',
  claudeBin: 'claude',
  workdir: process.cwd(),
  defaultModel: 'sonnet',
  permissionMode: 'acceptEdits',
  sessionTtlMs: 1000,
  maxSessions: 10,
};

describe('GET /v1/models', () => {
  it('lists the supported model aliases', async () => {
    const app = createApp({ config: testConfig });
    const response = await request(app)
      .get('/v1/models')
      .set('Authorization', 'Bearer test-key');

    expect(response.status).toBe(200);
    expect(response.body.object).toBe('list');
    expect(response.body.data.map((m: { id: string }) => m.id)).toEqual([
      'sonnet',
      'opus',
      'fable',
      'haiku',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/models.test.ts`
Expected: FAIL — `src/routes/models.ts` does not exist yet, and `/v1/models` is not mounted.

- [ ] **Step 3: Implement `src/routes/models.ts`**

```ts
import type { Request, Response } from 'express';

export const MODEL_ALIASES = ['sonnet', 'opus', 'fable', 'haiku'];

export function handleListModels(_req: Request, res: Response) {
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: MODEL_ALIASES.map((id) => ({ id, object: 'model', created, owned_by: 'anthropic' })),
  });
}
```

- [ ] **Step 4: Mount the route in `src/app.ts`**

Add to the imports:

```ts
import { handleListModels } from './routes/models.js';
```

Add after `v1.use(createAuthMiddleware(deps.config));`:

```ts
  v1.get('/models', handleListModels);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/routes/models.test.ts`
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add src/routes/models.ts src/app.ts test/routes/models.test.ts
git commit -m "Add GET /v1/models endpoint"
```

---

### Task 4: Message hashing utility

**Files:**
- Create: `src/types.ts`
- Create: `src/session/hash.ts`
- Test: `test/session/hash.test.ts`

**Interfaces:**
- Produces: `ChatMessage` (`src/types.ts`) — `{ role: 'system' | 'user' | 'assistant'; content: string }`
- Produces: `hashMessages(messages: ChatMessage[]): string`

- [ ] **Step 1: Create `src/types.ts`**

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  cwd?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; sessionId?: string; stopReason: string; usage: ProviderUsage }
  | { type: 'error'; message: string };

export interface StartTurnOptions {
  prompt: string;
  model: string;
  resumeSessionId?: string;
  newSessionId?: string;
  cwd: string;
  permissionMode: string;
}

export interface AgentProvider {
  startTurn(options: StartTurnOptions): AsyncIterable<ProviderEvent>;
}
```

- [ ] **Step 2: Write the failing hash test**

`test/session/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashMessages } from '../../src/session/hash.js';
import type { ChatMessage } from '../../src/types.js';

describe('hashMessages', () => {
  it('produces the same hash for identical message arrays', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(hashMessages(messages)).toBe(hashMessages([{ role: 'user', content: 'hello' }]));
  });

  it('produces different hashes when content differs', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([{ role: 'user', content: 'goodbye' }]);
    expect(a).not.toBe(b);
  });

  it('produces different hashes when message count differs', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(a).not.toBe(b);
  });

  it('ignores extra fields beyond role and content', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([{ role: 'user', content: 'hello', name: 'ignored' } as ChatMessage]);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/session/hash.test.ts`
Expected: FAIL — `src/session/hash.ts` does not exist yet.

- [ ] **Step 4: Implement `src/session/hash.ts`**

```ts
import { createHash } from 'node:crypto';
import type { ChatMessage } from '../types.js';

export function hashMessages(messages: ChatMessage[]): string {
  const canonical = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash('sha256').update(canonical).digest('hex');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/session/hash.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/session/hash.ts test/session/hash.test.ts
git commit -m "Add shared types and message-history hashing utility"
```

---

### Task 5: SessionStore (TTL + LRU + per-key lock)

**Files:**
- Create: `src/session/SessionStore.ts`
- Test: `test/session/SessionStore.test.ts`

**Interfaces:**
- Produces: `SessionEntry` — `{ claudeSessionId: string; expiresAt: number }`
- Produces: `SessionStore` class with `lookup(prefixHash: string): SessionEntry | undefined`, `remember(fullHash: string, claudeSessionId: string): void`, `withLock<T>(key: string, fn: () => Promise<T>): Promise<T>`
- Consumes: none beyond constructor args `(ttlMs: number, maxSessions: number, now?: () => number)`

- [ ] **Step 1: Write the failing test**

`test/session/SessionStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/session/SessionStore.js';

describe('SessionStore', () => {
  it('returns undefined for an unknown key', () => {
    const store = new SessionStore(1000, 10);
    expect(store.lookup('missing')).toBeUndefined();
  });

  it('remembers and looks up a session', () => {
    const store = new SessionStore(1000, 10);
    store.remember('hash-a', 'claude-session-1');
    expect(store.lookup('hash-a')).toEqual({ claudeSessionId: 'claude-session-1', expiresAt: expect.any(Number) });
  });

  it('expires entries after the TTL elapses', () => {
    let now = 1_000_000;
    const store = new SessionStore(500, 10, () => now);
    store.remember('hash-a', 'claude-session-1');
    now += 600;
    expect(store.lookup('hash-a')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const store = new SessionStore(1000, 2);
    store.remember('hash-a', 'session-a');
    store.remember('hash-b', 'session-b');
    store.lookup('hash-a'); // touch a, making b the least recently used
    store.remember('hash-c', 'session-c'); // should evict b, not a
    expect(store.lookup('hash-a')).toBeDefined();
    expect(store.lookup('hash-b')).toBeUndefined();
    expect(store.lookup('hash-c')).toBeDefined();
  });

  it('serializes concurrent calls against the same lock key', async () => {
    const store = new SessionStore(1000, 10);
    const order: string[] = [];

    const slow = store.withLock('key', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = store.withLock('key', async () => {
      order.push('fast');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session/SessionStore.test.ts`
Expected: FAIL — `src/session/SessionStore.ts` does not exist yet.

- [ ] **Step 3: Implement `src/session/SessionStore.ts`**

```ts
export interface SessionEntry {
  claudeSessionId: string;
  expiresAt: number;
}

export class SessionStore {
  private entries = new Map<string, SessionEntry>();
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions: number,
    private readonly now: () => number = Date.now,
  ) {}

  lookup(prefixHash: string): SessionEntry | undefined {
    const entry = this.entries.get(prefixHash);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.entries.delete(prefixHash);
      return undefined;
    }
    // Re-insert to mark as most recently used (Map preserves insertion order).
    this.entries.delete(prefixHash);
    this.entries.set(prefixHash, entry);
    return entry;
  }

  remember(fullHash: string, claudeSessionId: string): void {
    if (this.entries.size >= this.maxSessions && !this.entries.has(fullHash)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(fullHash, { claudeSessionId, expiresAt: this.now() + this.ttlMs });
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session/SessionStore.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionStore.ts test/session/SessionStore.test.ts
git commit -m "Add SessionStore with TTL eviction, LRU capacity, and per-key locking"
```

---

### Task 6: Claude stream-json parser

**Files:**
- Create: `src/providers/parseStreamJson.ts`
- Test: `test/providers/parseStreamJson.test.ts`

**Interfaces:**
- Consumes: `ProviderEvent` from `src/types.ts` (Task 4)
- Produces: `parseClaudeStream(stdout: NodeJS.ReadableStream): AsyncGenerator<ProviderEvent>`

Reference NDJSON shapes (captured from a real `claude -p --output-format stream-json --include-partial-messages` run):

```
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"P"}}, ...}
{"type":"result","is_error":false,"session_id":"a1247603-...","stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":5}, ...}
```

- [ ] **Step 1: Write the failing test**

`test/providers/parseStreamJson.test.ts`:

```ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseClaudeStream } from '../../src/providers/parseStreamJson.js';

function linesToStream(lines: unknown[]): Readable {
  return Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

describe('parseClaudeStream', () => {
  it('emits delta events for text_delta stream_event lines', async () => {
    const stream = linesToStream([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ONG' } } },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', text: 'P' },
      { type: 'delta', text: 'ONG' },
    ]);
  });

  it('emits a result event with usage and session id', async () => {
    const stream = linesToStream([
      {
        type: 'result',
        is_error: false,
        session_id: 'session-123',
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 5 },
      },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'result', sessionId: 'session-123', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 5 } },
    ]);
  });

  it('emits an error event when result.is_error is true', async () => {
    const stream = linesToStream([
      { type: 'result', is_error: true, result: 'Authentication failed' },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'error', message: 'Authentication failed' }]);
  });

  it('skips malformed and irrelevant lines without crashing', async () => {
    const stream = Readable.from(['not json\n', `${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n`]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/parseStreamJson.test.ts`
Expected: FAIL — `src/providers/parseStreamJson.ts` does not exist yet.

- [ ] **Step 3: Implement `src/providers/parseStreamJson.ts`**

```ts
import { createInterface } from 'node:readline';
import type { ProviderEvent } from '../types.js';

export async function* parseClaudeStream(stdout: NodeJS.ReadableStream): AsyncGenerator<ProviderEvent> {
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      parsed.type === 'stream_event' &&
      parsed.event?.type === 'content_block_delta' &&
      parsed.event.delta?.type === 'text_delta'
    ) {
      yield { type: 'delta', text: parsed.event.delta.text };
      continue;
    }

    if (parsed.type === 'result') {
      if (parsed.is_error) {
        yield { type: 'error', message: parsed.result ?? 'Claude CLI reported an error' };
      } else {
        yield {
          type: 'result',
          sessionId: parsed.session_id,
          stopReason: parsed.stop_reason ?? 'end_turn',
          usage: {
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
          },
        };
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/parseStreamJson.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/parseStreamJson.ts test/providers/parseStreamJson.test.ts
git commit -m "Add NDJSON parser for claude stream-json output"
```

---

### Task 7: ClaudeProvider

**Files:**
- Create: `src/providers/ClaudeProvider.ts`
- Test: `test/providers/ClaudeProvider.test.ts`

**Interfaces:**
- Consumes: `parseClaudeStream` (Task 6), `AgentProvider`/`ProviderEvent`/`StartTurnOptions` (Task 4)
- Produces: `ClaudeCliError` class — `{ message: string; exitCode: number | null }`
- Produces: `SpawnedProcess` interface — `{ stdout: Readable; stderr: Readable; on(event: 'close', listener: (code: number | null) => void): void }`
- Produces: `SpawnFn` type — `(command: string, args: string[], options: { cwd: string }) => SpawnedProcess`
- Produces: `ClaudeProvider` class implementing `AgentProvider`, constructor `(claudeBin: string, spawnFn?: SpawnFn)`, exposes `buildArgs(options: StartTurnOptions): string[]` and `startTurn(options: StartTurnOptions): AsyncGenerator<ProviderEvent>`

- [ ] **Step 1: Write the failing test**

`test/providers/ClaudeProvider.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClaudeCliError, ClaudeProvider, type SpawnedProcess } from '../../src/providers/ClaudeProvider.js';
import type { StartTurnOptions } from '../../src/types.js';

function createFakeProcess(): { proc: SpawnedProcess; stdout: PassThrough; stderr: PassThrough; emitClose: (code: number | null) => void } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc: SpawnedProcess = {
    stdout,
    stderr,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
  };
  return { proc, stdout, stderr, emitClose: (code) => emitter.emit('close', code) };
}

const baseOptions: StartTurnOptions = {
  prompt: 'hello',
  model: 'sonnet',
  cwd: '/tmp/workdir',
  permissionMode: 'acceptEdits',
};

describe('ClaudeProvider.buildArgs', () => {
  it('builds args for a new session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, newSessionId: 'new-id' });
    expect(args).toEqual([
      '-p', 'hello',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--safe-mode',
      '--permission-mode', 'acceptEdits',
      '--model', 'sonnet',
      '--add-dir', '/tmp/workdir',
      '--session-id', 'new-id',
    ]);
  });

  it('builds args to resume an existing session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, resumeSessionId: 'existing-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('existing-id');
    expect(args).not.toContain('--session-id');
  });
});

describe('ClaudeProvider.startTurn', () => {
  it('yields parsed events from stdout and resolves on a clean exit', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const iterator = provider.startTurn({ ...baseOptions, newSessionId: 'new-id' });
    const collected: unknown[] = [];
    const consuming = (async () => {
      for await (const event of iterator) {
        collected.push(event);
      }
    })();

    fake.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })}\n`);
    fake.stdout.end();
    fake.emitClose(0);

    await consuming;
    expect(collected).toEqual([{ type: 'delta', text: 'hi' }]);
  });

  it('throws ClaudeCliError when the process exits non-zero', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const run = (async () => {
      const collected = [];
      for await (const event of provider.startTurn({ ...baseOptions, newSessionId: 'new-id' })) {
        collected.push(event);
      }
      return collected;
    })();

    fake.stderr.write('claude: authentication expired\n');
    fake.stdout.end();
    fake.emitClose(1);

    await expect(run).rejects.toThrow(ClaudeCliError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/ClaudeProvider.test.ts`
Expected: FAIL — `src/providers/ClaudeProvider.ts` does not exist yet.

- [ ] **Step 3: Implement `src/providers/ClaudeProvider.ts`**

```ts
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { parseClaudeStream } from './parseStreamJson.js';
import type { AgentProvider, ProviderEvent, StartTurnOptions } from '../types.js';

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  on(event: 'close', listener: (code: number | null) => void): void;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, { cwd: options.cwd });

export class ClaudeProvider implements AgentProvider {
  constructor(
    private readonly claudeBin: string,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  buildArgs(options: StartTurnOptions): string[] {
    const args = [
      '-p', options.prompt,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--safe-mode',
      '--permission-mode', options.permissionMode,
      '--model', options.model,
      '--add-dir', options.cwd,
    ];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else if (options.newSessionId) {
      args.push('--session-id', options.newSessionId);
    }
    return args;
  }

  async *startTurn(options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    const child = this.spawnFn(this.claudeBin, this.buildArgs(options), { cwd: options.cwd });

    let stderrOutput = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    yield* parseClaudeStream(child.stdout);

    const exitCode = await exitPromise;
    if (exitCode !== 0) {
      throw new ClaudeCliError(stderrOutput.trim() || `claude exited with code ${exitCode}`, exitCode);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/ClaudeProvider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/ClaudeProvider.ts test/providers/ClaudeProvider.test.ts
git commit -m "Add ClaudeProvider that spawns the claude CLI and streams parsed events"
```

---

### Task 8: OpenAI SSE / completion translators

**Files:**
- Create: `src/translate/openaiSse.ts`
- Test: `test/translate/openaiSse.test.ts`

**Interfaces:**
- Consumes: `ProviderEvent` (Task 4)
- Produces: `OpenAiChunk`, `OpenAiCompletion` types
- Produces: `formatSseChunk(chunk: OpenAiChunk): string`, `SSE_DONE: string`
- Produces: `toOpenAiChunks(events: AsyncIterable<ProviderEvent>, model: string, now?: () => number): AsyncGenerator<OpenAiChunk>`
- Produces: `toOpenAiCompletion(events: AsyncIterable<ProviderEvent>, model: string, now?: () => number): Promise<OpenAiCompletion>`

- [ ] **Step 1: Write the failing test**

`test/translate/openaiSse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatSseChunk, SSE_DONE, toOpenAiChunks, toOpenAiCompletion } from '../../src/translate/openaiSse.js';
import type { ProviderEvent } from '../../src/types.js';

async function* fixtureEvents(): AsyncGenerator<ProviderEvent> {
  yield { type: 'delta', text: 'Hello' };
  yield { type: 'delta', text: ' world' };
  yield { type: 'result', sessionId: 'session-1', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
}

describe('toOpenAiChunks', () => {
  it('emits a role chunk on the first delta and content-only chunks after', async () => {
    const chunks = [];
    for await (const chunk of toOpenAiChunks(fixtureEvents(), 'sonnet', () => 1_700_000_000_000)) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'Hello' });
    expect(chunks[1].choices[0].delta).toEqual({ content: ' world' });
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
    expect(chunks[2].usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});

describe('formatSseChunk', () => {
  it('wraps a chunk as an SSE data line', () => {
    const line = formatSseChunk({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'sonnet',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    });
    expect(line).toBe(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sonnet","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    );
  });

  it('exports the terminal DONE marker', () => {
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });
});

describe('toOpenAiCompletion', () => {
  it('buffers all deltas into a single completion response', async () => {
    const completion = await toOpenAiCompletion(fixtureEvents(), 'sonnet', () => 1_700_000_000_000);
    expect(completion.choices[0].message).toEqual({ role: 'assistant', content: 'Hello world' });
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('rejects when the provider emits an error event', async () => {
    async function* errorEvents(): AsyncGenerator<ProviderEvent> {
      yield { type: 'error', message: 'boom' };
    }
    await expect(toOpenAiCompletion(errorEvents(), 'sonnet')).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/translate/openaiSse.test.ts`
Expected: FAIL — `src/translate/openaiSse.ts` does not exist yet.

- [ ] **Step 3: Implement `src/translate/openaiSse.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ProviderEvent } from '../types.js';

export interface OpenAiChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export const SSE_DONE = 'data: [DONE]\n\n';

export function formatSseChunk(chunk: OpenAiChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function usageFromEvent(event: Extract<ProviderEvent, { type: 'result' }>) {
  return {
    prompt_tokens: event.usage.inputTokens,
    completion_tokens: event.usage.outputTokens,
    total_tokens: event.usage.inputTokens + event.usage.outputTokens,
  };
}

function finishReasonFromEvent(event: Extract<ProviderEvent, { type: 'result' }>) {
  return event.stopReason === 'end_turn' ? 'stop' : event.stopReason;
}

export async function* toOpenAiChunks(
  events: AsyncIterable<ProviderEvent>,
  model: string,
  now: () => number = Date.now,
): AsyncGenerator<OpenAiChunk> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(now() / 1000);
  let sentRole = false;

  for await (const event of events) {
    if (event.type === 'delta') {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: sentRole ? { content: event.text } : { role: 'assistant', content: event.text },
            finish_reason: null,
          },
        ],
      };
      sentRole = true;
    } else if (event.type === 'result') {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReasonFromEvent(event) }],
        usage: usageFromEvent(event),
      };
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }
}

export async function toOpenAiCompletion(
  events: AsyncIterable<ProviderEvent>,
  model: string,
  now: () => number = Date.now,
): Promise<OpenAiCompletion> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(now() / 1000);
  let content = '';
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const event of events) {
    if (event.type === 'delta') {
      content += event.text;
    } else if (event.type === 'result') {
      finishReason = finishReasonFromEvent(event);
      usage = usageFromEvent(event);
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/translate/openaiSse.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/translate/openaiSse.ts test/translate/openaiSse.test.ts
git commit -m "Add OpenAI-shaped SSE chunk and completion translators"
```

---

### Task 9: Conversation resolution and event tapping

**Files:**
- Create: `src/session/resolveConversation.ts`
- Test: `test/session/resolveConversation.test.ts`

**Interfaces:**
- Consumes: `hashMessages` (Task 4), `SessionStore` (Task 5), `ChatMessage`/`ProviderEvent` (Task 4)
- Produces: `ConversationResolution` — `{ prompt: string; resumeSessionId?: string; newSessionId?: string; rememberKey: string }`
- Produces: `resolveConversation(messages: ChatMessage[], sessionStore: SessionStore): ConversationResolution`
- Produces: `tapProviderEvents(events: AsyncIterable<ProviderEvent>, onEvent: (event: ProviderEvent) => void): AsyncGenerator<ProviderEvent>`

- [ ] **Step 1: Write the failing test**

`test/session/resolveConversation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveConversation, tapProviderEvents } from '../../src/session/resolveConversation.js';
import { SessionStore } from '../../src/session/SessionStore.js';
import { hashMessages } from '../../src/session/hash.js';
import type { ChatMessage, ProviderEvent } from '../../src/types.js';

describe('resolveConversation', () => {
  it('starts a new session for the first message in a conversation', () => {
    const store = new SessionStore(1000, 10);
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const resolution = resolveConversation(messages, store);

    expect(resolution.prompt).toBe('hello');
    expect(resolution.newSessionId).toBeDefined();
    expect(resolution.resumeSessionId).toBeUndefined();
    expect(resolution.rememberKey).toBe(hashMessages(messages));
  });

  it('resumes an existing session when the prefix hash is known', () => {
    const store = new SessionStore(1000, 10);

    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you?' },
    ];
    // Prefix (first two messages) must match a remembered full-turn hash.
    store.remember(hashMessages(messages.slice(0, 2)), 'claude-session-1');

    const resolution = resolveConversation(messages, store);
    expect(resolution.prompt).toBe('how are you?');
    expect(resolution.resumeSessionId).toBe('claude-session-1');
    expect(resolution.newSessionId).toBeUndefined();
  });

  it('starts a new session with the full transcript when the prefix is unknown', () => {
    const store = new SessionStore(1000, 10);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ];

    const resolution = resolveConversation(messages, store);
    expect(resolution.newSessionId).toBeDefined();
    expect(resolution.prompt).toContain('first message');
    expect(resolution.prompt).toContain('second message');
  });

  it('throws when given an empty message array', () => {
    const store = new SessionStore(1000, 10);
    expect(() => resolveConversation([], store)).toThrow('messages must not be empty');
  });
});

describe('tapProviderEvents', () => {
  it('invokes the callback for every event while still yielding them', async () => {
    async function* source(): AsyncGenerator<ProviderEvent> {
      yield { type: 'delta', text: 'hi' };
      yield { type: 'result', sessionId: 'session-1', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }

    const seen: ProviderEvent[] = [];
    const collected: ProviderEvent[] = [];
    for await (const event of tapProviderEvents(source(), (e) => seen.push(e))) {
      collected.push(event);
    }

    expect(seen).toEqual(collected);
    expect(collected).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session/resolveConversation.test.ts`
Expected: FAIL — `src/session/resolveConversation.ts` does not exist yet.

- [ ] **Step 3: Implement `src/session/resolveConversation.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { hashMessages } from './hash.js';
import type { SessionStore } from './SessionStore.js';
import type { ChatMessage, ProviderEvent } from '../types.js';

export interface ConversationResolution {
  prompt: string;
  resumeSessionId?: string;
  newSessionId?: string;
  rememberKey: string;
}

export function resolveConversation(messages: ChatMessage[], sessionStore: SessionStore): ConversationResolution {
  if (messages.length === 0) {
    throw new Error('messages must not be empty');
  }

  const lastMessage = messages[messages.length - 1];
  const rememberKey = hashMessages(messages);

  if (messages.length === 1) {
    return { prompt: lastMessage.content, newSessionId: randomUUID(), rememberKey };
  }

  const prefix = messages.slice(0, -1);
  const existing = sessionStore.lookup(hashMessages(prefix));

  if (existing) {
    return { prompt: lastMessage.content, resumeSessionId: existing.claudeSessionId, rememberKey };
  }

  const fullPrompt = messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
  return { prompt: fullPrompt, newSessionId: randomUUID(), rememberKey };
}

export async function* tapProviderEvents(
  events: AsyncIterable<ProviderEvent>,
  onEvent: (event: ProviderEvent) => void,
): AsyncGenerator<ProviderEvent> {
  for await (const event of events) {
    onEvent(event);
    yield event;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session/resolveConversation.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/resolveConversation.ts test/session/resolveConversation.test.ts
git commit -m "Add conversation resolution (resume vs new session) and event tapping"
```

---

### Task 10: `POST /v1/chat/completions` route and error handling

**Files:**
- Create: `src/errors.ts`
- Create: `src/middleware/errorHandler.ts`
- Create: `src/routes/chatCompletions.ts`
- Modify: `src/app.ts`
- Test: `test/routes/chatCompletions.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, `ChatCompletionRequest` (Task 4); `SessionStore` (Task 5); `ClaudeCliError` (Task 7); `toOpenAiChunks`, `toOpenAiCompletion`, `formatSseChunk`, `SSE_DONE` (Task 8); `resolveConversation`, `tapProviderEvents` (Task 9); `MODEL_ALIASES` (Task 3)
- Produces: `ApiError` class (`src/errors.ts`) — `{ message: string; status: number; code: string }`
- Produces: `toOpenAiError(err: unknown): { status: number; body: { error: { message: string; type: string; code: string } } }`
- Produces: `errorHandler: express.ErrorRequestHandler`
- Produces: `createChatCompletionsHandler(deps: { provider: AgentProvider; sessionStore: SessionStore; config: AppConfig }): express.RequestHandler`
- Modifies: `AppDeps` in `src/app.ts` to add `provider: AgentProvider; sessionStore: SessionStore`

- [ ] **Step 1: Create `src/errors.ts`**

```ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
```

- [ ] **Step 2: Create `src/middleware/errorHandler.ts`**

```ts
import type { ErrorRequestHandler } from 'express';
import { ApiError } from '../errors.js';
import { ClaudeCliError } from '../providers/ClaudeProvider.js';

export function toOpenAiError(err: unknown): {
  status: number;
  body: { error: { message: string; type: string; code: string } };
} {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { message: err.message, type: err.code, code: err.code } } };
  }
  if (err instanceof ClaudeCliError) {
    return {
      status: 502,
      body: { error: { message: err.message, type: 'provider_error', code: 'claude_cli_error' } },
    };
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return { status: 500, body: { error: { message, type: 'internal_error', code: 'internal_error' } } };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const { status, body } = toOpenAiError(err);
  res.status(status).json(body);
};
```

- [ ] **Step 3: Write the failing route test**

`test/routes/chatCompletions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { SessionStore } from '../../src/session/SessionStore.js';
import type { AppConfig } from '../../src/config.js';
import type { AgentProvider, ProviderEvent, StartTurnOptions } from '../../src/types.js';

const testConfig: AppConfig = {
  port: 0,
  apiKey: 'test-key',
  claudeBin: 'claude',
  workdir: '/tmp',
  defaultModel: 'sonnet',
  permissionMode: 'acceptEdits',
  sessionTtlMs: 60_000,
  maxSessions: 10,
};

class StubProvider implements AgentProvider {
  public calls: StartTurnOptions[] = [];
  private replySessionId = 'stub-session-1';

  async *startTurn(options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push(options);
    yield { type: 'delta', text: 'Hello' };
    yield { type: 'delta', text: ' world' };
    yield {
      type: 'result',
      sessionId: this.replySessionId,
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }
}

function buildApp() {
  const provider = new StubProvider();
  const sessionStore = new SessionStore(testConfig.sessionTtlMs, testConfig.maxSessions);
  const app = createApp({ config: testConfig, provider, sessionStore });
  return { app, provider, sessionStore };
}

describe('POST /v1/chat/completions', () => {
  it('returns a non-streaming completion', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message).toEqual({ role: 'assistant', content: 'Hello world' });
    expect(response.body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('streams SSE chunks when stream is true', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.header['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('"content":"Hello"');
    expect(response.text).toContain('data: [DONE]');
  });

  it('rejects requests without a valid API key', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(401);
  });

  it('rejects requests with an empty messages array', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
  });

  it('resumes the same claude session on the second turn of a conversation', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({
        model: 'sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello world' },
          { role: 'user', content: 'follow up' },
        ],
      });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].newSessionId).toBeDefined();
    expect(provider.calls[1].resumeSessionId).toBe('stub-session-1');
    expect(provider.calls[1].prompt).toBe('follow up');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/routes/chatCompletions.test.ts`
Expected: FAIL — `createApp` does not accept `provider`/`sessionStore` yet, and the route does not exist.

- [ ] **Step 5: Implement `src/routes/chatCompletions.ts`**

```ts
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { toOpenAiError } from '../middleware/errorHandler.js';
import { resolveConversation, tapProviderEvents } from '../session/resolveConversation.js';
import type { SessionStore } from '../session/SessionStore.js';
import { formatSseChunk, SSE_DONE, toOpenAiChunks, toOpenAiCompletion } from '../translate/openaiSse.js';
import type { AgentProvider, ChatCompletionRequest } from '../types.js';
import { MODEL_ALIASES } from './models.js';

export interface ChatCompletionsDeps {
  provider: AgentProvider;
  sessionStore: SessionStore;
  config: AppConfig;
}

export function createChatCompletionsHandler(deps: ChatCompletionsDeps) {
  return async function handleChatCompletions(req: Request, res: Response) {
    try {
      const body = req.body as ChatCompletionRequest;

      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        throw new ApiError('messages must be a non-empty array', 400, 'invalid_request_error');
      }

      const model = MODEL_ALIASES.includes(body.model) ? body.model : deps.config.defaultModel;
      const cwd = body.cwd ?? deps.config.workdir;
      const resolution = resolveConversation(body.messages, deps.sessionStore);

      let capturedSessionId: string | undefined;
      const rawEvents = deps.provider.startTurn({
        prompt: resolution.prompt,
        model,
        resumeSessionId: resolution.resumeSessionId,
        newSessionId: resolution.newSessionId,
        cwd,
        permissionMode: deps.config.permissionMode,
      });
      const events = tapProviderEvents(rawEvents, (event) => {
        if (event.type === 'result' && event.sessionId) {
          capturedSessionId = event.sessionId;
        }
      });

      try {
        if (body.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          for await (const chunk of toOpenAiChunks(events, model)) {
            res.write(formatSseChunk(chunk));
          }
          res.write(SSE_DONE);
          res.end();
        } else {
          const completion = await toOpenAiCompletion(events, model);
          res.json(completion);
        }
      } finally {
        if (capturedSessionId) {
          deps.sessionStore.remember(resolution.rememberKey, capturedSessionId);
        }
      }
    } catch (err) {
      // Express 4 does not auto-catch async handler rejections, so every
      // error path (validation, provider failure, mid-stream failure) is
      // handled here rather than relying on the errorHandler middleware.
      if (res.headersSent) {
        const { body: errorBody } = toOpenAiError(err);
        res.write(`data: ${JSON.stringify(errorBody)}\n\n`);
        res.write(SSE_DONE);
        res.end();
        return;
      }
      const { status, body: errorBody } = toOpenAiError(err);
      res.status(status).json(errorBody);
    }
  };
}
```

- [ ] **Step 6: Wire the route into `src/app.ts`**

Replace the contents of `src/app.ts` with:

```ts
import express, { type Express, Router } from 'express';
import type { AppConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createChatCompletionsHandler } from './routes/chatCompletions.js';
import { handleListModels } from './routes/models.js';
import type { SessionStore } from './session/SessionStore.js';
import type { AgentProvider } from './types.js';

export interface AppDeps {
  config: AppConfig;
  provider: AgentProvider;
  sessionStore: SessionStore;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const v1 = Router();
  v1.use(createAuthMiddleware(deps.config));
  v1.get('/models', handleListModels);
  v1.post('/chat/completions', createChatCompletionsHandler(deps));
  app.use('/v1', v1);

  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 7: Update existing tests that construct `AppDeps` without `provider`/`sessionStore`**

In `test/app.test.ts`, `test/routes/models.test.ts`, and any other file calling `createApp({ config: testConfig })`, add a stub provider and a real `SessionStore`:

```ts
import { SessionStore } from '../src/session/SessionStore.js';
import type { AgentProvider, ProviderEvent, StartTurnOptions } from '../src/types.js';

class NoopProvider implements AgentProvider {
  async *startTurn(_options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

// wherever createApp({ config: testConfig }) was called:
createApp({ config: testConfig, provider: new NoopProvider(), sessionStore: new SessionStore(1000, 10) });
```

Adjust the relative import paths (`../src/...` vs `../../src/...`) to match each test file's location.

- [ ] **Step 8: Run full suite to verify everything passes**

Run: `npx vitest run`
Expected: PASS (all tests across all files, no failures)

- [ ] **Step 9: Commit**

```bash
git add src/errors.ts src/middleware/errorHandler.ts src/routes/chatCompletions.ts src/app.ts test/routes/chatCompletions.test.ts test/app.test.ts test/routes/models.test.ts
git commit -m "Add POST /v1/chat/completions with streaming, session resume, and error handling"
```

---

### Task 11: README and manual smoke test

**Files:**
- Create: `README.md`
- Create: `scripts/smoke-test.sh`

**Interfaces:**
- None (documentation and a manual verification script; no new exported code).

- [ ] **Step 1: Create `scripts/smoke-test.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_KEY="${API_KEY:?Set API_KEY to the value from your .env file}"

echo "== Health check =="
curl -sf "${BASE_URL}/healthz"
echo

echo "== Models =="
curl -sf "${BASE_URL}/v1/models" -H "Authorization: Bearer ${API_KEY}"
echo

echo "== Non-streaming chat completion =="
curl -sf "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say PONG and nothing else."}]}'
echo

echo "== Streaming chat completion =="
curl -sf -N "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Count from 1 to 5."}],"stream":true}'
echo
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x scripts/smoke-test.sh`

- [ ] **Step 3: Create `README.md`**

```markdown
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

\`\`\`bash
npm install
cp .env.example .env
# edit .env: set API_KEY to a random secret, and WORKDIR to the directory
# you want the agent to operate in (it will have Bash/Edit/file access there).
npm run build
npm start
# or, for local development with auto-reload:
npm run dev
\`\`\`

## Verifying it works

With the server running in one terminal:

\`\`\`bash
API_KEY=<value from your .env> ./scripts/smoke-test.sh
\`\`\`

This checks `/healthz`, `/v1/models`, a non-streaming chat completion, and a
streaming chat completion, in order.

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
```

- [ ] **Step 4: Manually verify end-to-end with the real `claude` CLI**

Run: `npm run dev` in one terminal, then in another: `API_KEY=<your key> ./scripts/smoke-test.sh`
Expected: All four sections print successfully; the streaming section shows incremental `data: {...}` chunks ending in `data: [DONE]`.

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/smoke-test.sh
git commit -m "Add README and manual smoke-test script"
```
