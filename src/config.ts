export interface AppConfig {
  port: number;
  apiKey: string;
  claudeBin: string;
  workdir: string;
  defaultModel: string;
  permissionMode: string;
  sessionTtlMs: number;
  maxSessions: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }
  return {
    port: Number(env.PORT ?? 8787),
    apiKey,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    workdir: env.WORKDIR ?? process.cwd(),
    defaultModel: env.DEFAULT_MODEL ?? 'sonnet',
    permissionMode: env.PERMISSION_MODE ?? 'acceptEdits',
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 1000 * 60 * 60 * 24),
    maxSessions: Number(env.MAX_SESSIONS ?? 500),
  };
}
