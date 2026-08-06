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
