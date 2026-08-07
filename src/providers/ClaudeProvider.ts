import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
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
  stdin: Writable;
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
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', options.permissionMode,
      '--model', options.model,
      '--add-dir', options.cwd,
    ];
    // Mutually exclusive by necessity: --safe-mode disables MCP servers and
    // overrides an explicit --mcp-config, so a session can have one or the
    // other. loadConfig() rejects a configuration that asks for both.
    if (options.safeMode) {
      args.push('--safe-mode');
    }
    if (options.mcpConfig) {
      args.push('--mcp-config', options.mcpConfig, '--strict-mcp-config');
    }
    if (options.allowedTools) {
      args.push('--allowedTools', options.allowedTools);
    }
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else if (options.newSessionId) {
      args.push('--session-id', options.newSessionId);
    }
    return args;
  }

  async *startTurn(options: StartTurnOptions): AsyncGenerator<ProviderEvent> {
    const child = this.spawnFn(this.claudeBin, this.buildArgs(options), { cwd: options.cwd });

    child.stdin.on('error', () => {
      // A spawn failure (e.g. ENOENT) can tear down stdin before we finish
      // writing to it; the resulting EPIPE is redundant with the ChildProcess
      // 'error' event already handled below, so just prevent it from being
      // unhandled and crashing the process.
    });
    child.stdin.write(options.prompt);
    child.stdin.end();

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
