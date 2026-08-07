import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when API_KEY is missing', () => {
    expect(() => loadConfig({})).toThrow('API_KEY');
  });

  it('applies defaults when only API_KEY is set', () => {
    const config = loadConfig({ API_KEY: 'abc123' });
    expect(config.port).toBe(8787);
    expect(config.claudeBin).toBe('claude');
    expect(config.workdir).toBe(process.cwd());
    expect(config.defaultModel).toBe('sonnet');
    expect(config.permissionMode).toBe('acceptEdits');
    expect(config.sessionTtlMs).toBe(86400000);
    expect(config.maxSessions).toBe(500);
  });

  it('defaults to safe mode with no MCP config', () => {
    const config = loadConfig({ API_KEY: 'abc123' });
    expect(config.safeMode).toBe(true);
    expect(config.mcpConfig).toBeUndefined();
  });

  it('turns safe mode off automatically when an MCP config is set', () => {
    const config = loadConfig({ API_KEY: 'abc123', MCP_CONFIG: '/etc/mcp.json' });
    expect(config.mcpConfig).toBe('/etc/mcp.json');
    expect(config.safeMode).toBe(false);
  });

  it('rejects a config that asks for both MCP and safe mode', () => {
    expect(() => loadConfig({ API_KEY: 'abc123', MCP_CONFIG: '/etc/mcp.json', SAFE_MODE: 'true' })).toThrow(
      /disables MCP servers/,
    );
  });

  it('honours an explicit SAFE_MODE=false without an MCP config', () => {
    const config = loadConfig({ API_KEY: 'abc123', SAFE_MODE: 'false' });
    expect(config.safeMode).toBe(false);
    expect(config.mcpConfig).toBeUndefined();
  });

  it('treats a blank MCP_CONFIG as unset', () => {
    const config = loadConfig({ API_KEY: 'abc123', MCP_CONFIG: '   ' });
    expect(config.mcpConfig).toBeUndefined();
    expect(config.safeMode).toBe(true);
  });

  it('reads overrides from env', () => {
    const config = loadConfig({ API_KEY: 'abc123', PORT: '9999', DEFAULT_MODEL: 'opus' });
    expect(config.port).toBe(9999);
    expect(config.defaultModel).toBe('opus');
  });
});
