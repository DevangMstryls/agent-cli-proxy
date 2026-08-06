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
};

describe('ClaudeProvider.buildArgs', () => {
  it('builds args for a new session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, newSessionId: 'new-id' });
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--safe-mode',
      '--permission-mode', 'acceptEdits',
      '--model', 'sonnet',
      '--add-dir', '/tmp/workdir',
      '--session-id', 'new-id',
    ]);
  });

  it('builds args to resume an existing session', () => {
    const provider = new ClaudeProvider('claude');
    const args = provider.buildArgs({ ...baseOptions, resumeSessionId: 'existing-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('existing-id');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('hello');
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
});
