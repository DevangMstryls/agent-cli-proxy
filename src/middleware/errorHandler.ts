import type { ErrorRequestHandler } from 'express';
import { ApiError } from '../errors.js';
import { ClaudeCliError } from '../providers/ClaudeProvider.js';

export function toOpenAiError(err: unknown): {
  status: number;
  body: { error: { message: string; type: string; code: string } };
} {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { message: err.message, type: err.code, code: err.code } } };
  }
  if (err instanceof ClaudeCliError) {
    return {
      status: 502,
      body: { error: { message: err.message, type: 'provider_error', code: 'claude_cli_error' } },
    };
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return { status: 500, body: { error: { message, type: 'internal_error', code: 'internal_error' } } };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const { status, body } = toOpenAiError(err);
  res.status(status).json(body);
};
