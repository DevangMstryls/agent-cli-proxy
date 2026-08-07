export interface AppConfig {
  port: number;
  apiKey: string;
  claudeBin: string;
  workdir: string;
  defaultModel: string;
  permissionMode: string;
  sessionTtlMs: number;
  maxSessions: number;
  mcpConfig?: string;
  safeMode: boolean;
  allowedTools?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }

  const mcpConfig = env.MCP_CONFIG?.trim() || undefined;
  // --safe-mode strips CLAUDE.md, hooks, plugins, and skills (keeping the
  // subscription's OAuth auth intact), which keeps per-request cost and noise
  // down — but it also disables MCP servers, and it overrides an explicit
  // --mcp-config. So enabling MCP necessarily means turning safe mode off.
  // Default it off whenever MCP_CONFIG is set, while still allowing an
  // explicit SAFE_MODE to win so the two aren't silently contradictory.
  const safeMode = env.SAFE_MODE !== undefined ? env.SAFE_MODE !== 'false' : mcpConfig === undefined;

  if (mcpConfig && safeMode) {
    throw new Error(
      'MCP_CONFIG is set but SAFE_MODE is true; --safe-mode disables MCP servers. Unset SAFE_MODE or set SAFE_MODE=false.',
    );
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
    mcpConfig,
    safeMode,
    // MCP tool calls aren't covered by acceptEdits, and a `-p` session has
    // nobody to answer a permission prompt — so an MCP tool is unusable until
    // it's named here. Allowlisting the specific tools is the narrow fix;
    // PERMISSION_MODE=bypassPermissions would also work but auto-approves
    // everything, Bash included.
    allowedTools: env.ALLOWED_TOOLS?.trim() || undefined,
  };
}
