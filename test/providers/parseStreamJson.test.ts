import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseClaudeStream } from '../../src/providers/parseStreamJson.js';

function linesToStream(lines: unknown[]): Readable {
  return Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

describe('parseClaudeStream', () => {
  it('emits delta events for text_delta stream_event lines', async () => {
    const stream = linesToStream([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ONG' } } },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', text: 'P' },
      { type: 'delta', text: 'ONG' },
    ]);
  });

  it('emits a result event with usage and session id', async () => {
    const stream = linesToStream([
      {
        type: 'result',
        is_error: false,
        session_id: 'session-123',
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 5 },
      },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'result', sessionId: 'session-123', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 5 } },
    ]);
  });

  it('emits an error event when result.is_error is true', async () => {
    const stream = linesToStream([
      { type: 'result', is_error: true, result: 'Authentication failed' },
    ]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'error', message: 'Authentication failed' }]);
  });

  it('skips malformed and irrelevant lines without crashing', async () => {
    const stream = Readable.from(['not json\n', `${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n`]);

    const events = [];
    for await (const event of parseClaudeStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
