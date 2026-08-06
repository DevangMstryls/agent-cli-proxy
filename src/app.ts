import express, { type Express, Router } from 'express';
import type { AppConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { handleListModels } from './routes/models.js';

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
  v1.get('/models', handleListModels);
  app.use('/v1', v1);

  return app;
}
