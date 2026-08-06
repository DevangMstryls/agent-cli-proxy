import type { Request, Response } from 'express';

export const MODEL_ALIASES = ['sonnet', 'opus', 'fable', 'haiku'];

export function handleListModels(_req: Request, res: Response) {
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: MODEL_ALIASES.map((id) => ({ id, object: 'model', created, owned_by: 'anthropic' })),
  });
}
