import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { parseClaudeStream } from './parseStreamJson.js';
import type { AgentProvider, ProviderEvent, StartTurnOptions } from '../types.js';

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, { cwd: options.cwd });

export class ClaudeProvider implements AgentProvider {
  constructor(
    private readonly claudeBin: string,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  buildArgs(options: StartTurnOptions): string[] {
    const args = [
      '-p', options.prompt,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--safe-mode',
      '--permission-mode', options.permissionMode,
      '--model', options.model,
      '--add-dir', options.cwd,
    ];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else if (options.newSessionId) {
      args.push('--session-id', options.newSessionId);
    }
    return args;
  }

  async *startTurn(options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    const child = this.spawnFn(this.claudeBin, this.buildArgs(options), { cwd: options.cwd });

    let stderrOutput = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    let spawnError: Error | undefined;
    let exitCode: number | null = null;
    let settled = false;
    const donePromise = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        spawnError = err;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      child.on('close', (code) => {
        exitCode = code;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });

    try {
      yield* parseClaudeStream(child.stdout);
    } finally {
      await donePromise;
      if (spawnError) {
        throw new ClaudeCliError(spawnError.message, null);
      }
      if (exitCode !== 0) {
        throw new ClaudeCliError(stderrOutput.trim() || `claude exited with code ${exitCode}`, exitCode);
      }
    }
  }
}
