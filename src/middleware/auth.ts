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
