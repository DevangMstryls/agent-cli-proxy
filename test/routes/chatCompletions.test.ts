import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { extractWorkdirFromSystemMessage, flattenContent } from '../../src/routes/chatCompletions.js';
import { SessionStore } from '../../src/session/SessionStore.js';
import type { AppConfig } from '../../src/config.js';
import type { AgentProvider, ChatMessage, ProviderEvent, StartTurnOptions } from '../../src/types.js';

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

class ConcurrencyTrackingProvider implements AgentProvider {
  public maxConcurrent = 0;
  private current = 0;

  async *startTurn(_options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    this.current += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.current);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: 'delta', text: 'ok' };
      yield {
        type: 'result',
        sessionId: 'session-x',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    } finally {
      this.current -= 1;
    }
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

  it('accepts array-shaped content, flattening it to a prompt', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });

    expect(response.status).toBe(200);
    expect(provider.calls[0].prompt).toBe('hi');
  });

  it('flattens the multi-part shape an @folder mention produces', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({
        model: 'sonnet',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Set up @pulse-green-market/ on EKS.' },
              { type: 'text', text: '<path>/repo/pulse-green-market/</path>\n<type>directory</type>' },
              {
                type: 'file',
                mime: 'application/x-directory',
                filename: 'pulse-green-market',
                url: 'file:///repo/pulse-green-market/',
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    const prompt = provider.calls[0].prompt;
    expect(prompt).toContain('Set up @pulse-green-market/ on EKS.');
    expect(prompt).toContain('<path>/repo/pulse-green-market/</path>');
    // The attachment survives as a path the agent can actually act on.
    expect(prompt).toContain('[pulse-green-market] file:///repo/pulse-green-market/');
  });

  it('rejects content that is neither a string nor an array', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 42 }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
    expect(provider.calls).toHaveLength(0);
  });

  it('serializes concurrent requests that resolve to the same resumed session', async () => {
    const provider = new ConcurrencyTrackingProvider();
    const sessionStore = new SessionStore(testConfig.sessionTtlMs, testConfig.maxSessions);
    const app = createApp({ config: testConfig, provider, sessionStore });

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });

    const followUp = {
      model: 'sonnet',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'follow up' },
      ],
    };

    await Promise.all([
      request(app).post('/v1/chat/completions').set('Authorization', 'Bearer test-key').send(followUp),
      request(app).post('/v1/chat/completions').set('Authorization', 'Bearer test-key').send(followUp),
    ]);

    expect(provider.maxConcurrent).toBe(1);
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

  it('uses the working directory embedded in a system message when body.cwd is absent', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({
        model: 'sonnet',
        messages: [
          {
            role: 'system',
            content:
              'Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /Users/devangmstryls/desk/projects/pulse\n  Workspace root folder: /Users/devangmstryls/desk/projects/pulse\n  Is directory a git repo: yes\n</env>',
          },
          { role: 'user', content: 'hi' },
        ],
      });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].cwd).toBe('/Users/devangmstryls/desk/projects/pulse');
  });

  it('prefers an explicit body.cwd over one embedded in a system message', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({
        model: 'sonnet',
        cwd: '/explicit/override',
        messages: [
          { role: 'system', content: '<env>\n  Working directory: /from/system/message\n</env>' },
          { role: 'user', content: 'hi' },
        ],
      });

    expect(provider.calls[0].cwd).toBe('/explicit/override');
  });

  it('falls back to the configured WORKDIR when no cwd is available anywhere', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });

    expect(provider.calls[0].cwd).toBe(testConfig.workdir);
  });

  it('forwards any model string as-is, including a pinned version not in the alias list', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] });

    expect(provider.calls[0].model).toBe('claude-opus-4-8');
  });

  it('falls back to the configured DEFAULT_MODEL when model is missing or empty', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: '', messages: [{ role: 'user', content: 'hi' }] });

    expect(provider.calls[0].model).toBe(testConfig.defaultModel);
  });

  it('rejects a model value that looks like a CLI flag', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: '--dangerously-skip-permissions', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects a model value containing characters outside the allowed set', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet; rm -rf /', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
  });

  it('rejects a cwd value that looks like a CLI flag', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', cwd: '--dangerously-skip-permissions', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
    expect(provider.calls).toHaveLength(0);
  });

  it('resumes a session named via the X-Claude-Session-Id header', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .set('X-Claude-Session-Id', 'cli-session-42')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'what did we decide?' }] });

    expect(provider.calls[0].resumeSessionId).toBe('cli-session-42');
    expect(provider.calls[0].newSessionId).toBeUndefined();
    expect(provider.calls[0].prompt).toBe('what did we decide?');
  });

  it('resumes a session named via a /resume directive and strips it from the prompt', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: '/resume cli-session-42 what did we decide?' }] });

    expect(provider.calls[0].resumeSessionId).toBe('cli-session-42');
    expect(provider.calls[0].prompt).toBe('what did we decide?');
  });

  it('sends "continue" when the /resume directive has no trailing text', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: '/resume cli-session-42' }] });

    expect(provider.calls[0].resumeSessionId).toBe('cli-session-42');
    expect(provider.calls[0].prompt).toBe('continue');
  });

  it('keeps later turns bound to the directive session, sending only the newest message', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({
        model: 'sonnet',
        messages: [
          { role: 'user', content: '/resume cli-session-42 what did we decide?' },
          { role: 'assistant', content: 'We decided X.' },
          { role: 'user', content: 'and why?' },
        ],
      });

    expect(provider.calls[0].resumeSessionId).toBe('cli-session-42');
    expect(provider.calls[0].prompt).toBe('and why?');
  });

  it('rejects an explicit session id with an unsafe shape', async () => {
    const { app, provider } = buildApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .set('X-Claude-Session-Id', '--resume-something')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
    expect(provider.calls).toHaveLength(0);
  });

  it('prefers the header session id over a /resume directive', async () => {
    const { app, provider } = buildApp();

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .set('X-Claude-Session-Id', 'header-session')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: '/resume directive-session hi' }] });

    expect(provider.calls[0].resumeSessionId).toBe('header-session');
  });
});

describe('extractWorkdirFromSystemMessage', () => {
  it('extracts the path following "Working directory:" in a system message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '<env>\n  Working directory: /a/b/c\n  Platform: darwin\n</env>' },
      { role: 'user', content: 'hi' },
    ];
    expect(extractWorkdirFromSystemMessage(messages)).toBe('/a/b/c');
  });

  it('returns undefined when there is no system message', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(extractWorkdirFromSystemMessage(messages)).toBeUndefined();
  });

  it('returns undefined when the system message has no working directory line', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
    expect(extractWorkdirFromSystemMessage(messages)).toBeUndefined();
  });
});

describe('flattenContent', () => {
  it('passes a plain string through untouched', () => {
    expect(flattenContent('just text')).toBe('just text');
  });

  it('joins multiple text parts with blank lines', () => {
    expect(flattenContent([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('one\n\ntwo');
  });

  it('renders a file part as a labelled path', () => {
    expect(flattenContent([{ type: 'file', filename: 'repo', url: 'file:///x/repo/' }])).toBe(
      '[repo] file:///x/repo/',
    );
  });

  it('falls back to the bare url when a file part has no filename', () => {
    expect(flattenContent([{ type: 'file', url: 'file:///x/y' }])).toBe('file:///x/y');
  });

  it('renders an OpenAI image_url part', () => {
    expect(flattenContent([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }])).toBe(
      '[image] https://x/y.png',
    );
  });

  it('skips parts it cannot render rather than failing the request', () => {
    expect(flattenContent([{ type: 'text', text: 'kept' }, { type: 'mystery' }, null, 7])).toBe('kept');
  });

  it('returns an empty string for an array with nothing usable', () => {
    expect(flattenContent([{ type: 'mystery' }])).toBe('');
  });

  it('returns undefined for a type that is neither string nor array', () => {
    expect(flattenContent(42)).toBeUndefined();
    expect(flattenContent(null)).toBeUndefined();
    expect(flattenContent(undefined)).toBeUndefined();
  });
});
