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
  workdir: process.cwd(),
  defaultModel: 'sonnet',
  permissionMode: 'acceptEdits',
  sessionTtlMs: 1000,
  maxSessions: 10,
};

class NoopProvider implements AgentProvider {
  async *startTurn(_options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

describe('GET /v1/models', () => {
  it('lists the supported model aliases', async () => {
    const app = createApp({ config: testConfig, provider: new NoopProvider(), sessionStore: new SessionStore(1000, 10) });
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
