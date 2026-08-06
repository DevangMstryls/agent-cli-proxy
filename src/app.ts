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
