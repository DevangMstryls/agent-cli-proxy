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

  it('reads overrides from env', () => {
    const config = loadConfig({ API_KEY: 'abc123', PORT: '9999', DEFAULT_MODEL: 'opus' });
    expect(config.port).toBe(9999);
    expect(config.defaultModel).toBe('opus');
  });
});
