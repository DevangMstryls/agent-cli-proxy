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
