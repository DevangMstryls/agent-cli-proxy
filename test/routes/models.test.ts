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
