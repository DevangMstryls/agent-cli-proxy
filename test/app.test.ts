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

describe('GET /v1/*', () => {
  it('requires auth even for unknown v1 routes', async () => {
    const app = createApp({ config: testConfig });
    const response = await request(app).get('/v1/does-not-exist');
    expect(response.status).toBe(401);
  });
});
