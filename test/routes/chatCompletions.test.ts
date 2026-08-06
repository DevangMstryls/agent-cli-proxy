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

  it('rejects requests where message content is not a string', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-key')
      .send({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request_error');
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
});
