import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClaudeCliError, ClaudeProvider, type SpawnedProcess } from '../../src/providers/ClaudeProvider.js';
import type { StartTurnOptions } from '../../src/types.js';

function createFakeProcess(): {
  proc: SpawnedProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinChunks: string[];
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const stdinChunks: string[] = [];
  stdin.on('data', (chunk: Buffer) => {
    stdinChunks.push(chunk.toString());
  });
  const proc: SpawnedProcess = {
    stdin,
    stdout,
    stderr,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
  };
  return {
    proc,
    stdin,
    stdout,
    stderr,
    stdinChunks,
    emitClose: (code) => emitter.emit('close', code),
    emitError: (err) => emitter.emit('error', err),
  };
}

const baseOptions: StartTurnOptions = {
  prompt: 'hello',
  model: 'sonnet',
  cwd: '/tmp/workdir',
  permissionMode: 'acceptEdits',
  safeMode: true,
};

describe('ClaudeProvider.buildArgs', () => {
  it('builds args for a new session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, newSessionId: 'new-id' });
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--model', 'sonnet',
      '--add-dir', '/tmp/workdir',
      '--safe-mode',
      '--session-id', 'new-id',
    ]);
  });

  it('builds args to resume an existing session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, resumeSessionId: 'existing-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('existing-id');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('hello');
  });

  it('omits --safe-mode when safe mode is off', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, safeMode: false, newSessionId: 'new-id' });
    expect(args).not.toContain('--safe-mode');
  });

  it('passes an MCP config through, scoped with --strict-mcp-config', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({
      ...baseOptions,
      safeMode: false,
      mcpConfig: '/etc/mcp.json',
      newSessionId: 'new-id',
    });

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/etc/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    // --safe-mode would disable the MCP servers we just asked for.
    expect(args).not.toContain('--safe-mode');
  });

  it('passes an allowed-tools list through', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({
      ...baseOptions,
      allowedTools: 'mcp__claude-sessions__list_resumable_sessions',
      newSessionId: 'new-id',
    });

    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__claude-sessions__list_resumable_sessions');
  });

  it('omits --allowedTools when none are set', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, newSessionId: 'new-id' });
    expect(args).not.toContain('--allowedTools');
  });

  it('omits MCP flags when no config is set', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, newSessionId: 'new-id' });
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });
});

describe('ClaudeProvider.startTurn', () => {
  it('yields parsed events from stdout and resolves on a clean exit', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const iterator = provider.startTurn({ ...baseOptions, newSessionId: 'new-id' });
    const collected: unknown[] = [];
    const consuming = (async () => {
      for await (const event of iterator) {
        collected.push(event);
      }
    })();

    fake.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })}\n`);
    fake.stdout.end();
    fake.emitClose(0);

    await consuming;
    expect(collected).toEqual([{ type: 'delta', text: 'hi' }]);
    expect(fake.stdinChunks.join('')).toBe('hello');
  });

  it('throws ClaudeCliError when the process exits non-zero', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const run = (async () => {
      const collected = [];
      for await (const event of provider.startTurn({ ...baseOptions, newSessionId: 'new-id' })) {
        collected.push(event);
      }
      return collected;
    })();

    fake.stderr.write('claude: authentication expired\n');
    fake.stdout.end();
    fake.emitClose(1);

    await expect(run).rejects.toThrow(ClaudeCliError);
  });

  it('throws ClaudeCliError on non-zero exit even when the consumer stops iterating early', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const run = (async () => {
      const collected: unknown[] = [];
      for await (const event of provider.startTurn({ ...baseOptions, newSessionId: 'new-id' })) {
        collected.push(event);
        break; // simulate the consumer stopping early, triggering generator.return()
      }
      return collected;
    })();

    fake.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })}\n`);
    fake.stderr.write('claude: crashed\n');
    fake.stdout.end();
    fake.emitClose(1);

    await expect(run).rejects.toThrow(ClaudeCliError);
  });

  it('throws ClaudeCliError when the process emits an error instead of closing', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const run = (async () => {
      const collected: unknown[] = [];
      for await (const event of provider.startTurn({ ...baseOptions, newSessionId: 'new-id' })) {
        collected.push(event);
      }
      return collected;
    })();

    fake.emitError(new Error('spawn claude ENOENT'));
    fake.stdout.end();

    await expect(run).rejects.toThrow(ClaudeCliError);
    await expect(run).rejects.toThrow('spawn claude ENOENT');
  });

  it('does not crash the process when stdin emits an error', async () => {
    const fake = createFakeProcess();
    const provider = new ClaudeProvider('claude', () => fake.proc);

    const run = (async () => {
      const collected: unknown[] = [];
      for await (const event of provider.startTurn({ ...baseOptions, newSessionId: 'new-id' })) {
        collected.push(event);
      }
      return collected;
    })();

    // Simulate a torn-down pipe (e.g. EPIPE following a spawn failure). If
    // ClaudeProvider didn't register its own 'error' listener on stdin, this
    // emit would throw synchronously (Node's default behavior for an
    // unhandled stream 'error' event) and crash the whole process.
    expect(() => fake.stdin.emit('error', new Error('EPIPE'))).not.toThrow();

    fake.stdout.end();
    fake.emitClose(0);

    await expect(run).resolves.toEqual([]);
  });
});
