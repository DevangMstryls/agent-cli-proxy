import { describe, expect, it } from 'vitest';
import { formatSseChunk, SSE_DONE, toOpenAiChunks, toOpenAiCompletion } from '../../src/translate/openaiSse.js';
import type { ProviderEvent } from '../../src/types.js';

async function* fixtureEvents(): AsyncGenerator<ProviderEvent> {
  yield { type: 'delta', text: 'Hello' };
  yield { type: 'delta', text: ' world' };
  yield { type: 'result', sessionId: 'session-1', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
}

describe('toOpenAiChunks', () => {
  it('emits a role chunk on the first delta and content-only chunks after', async () => {
    const chunks = [];
    for await (const chunk of toOpenAiChunks(fixtureEvents(), 'sonnet', () => 1_700_000_000_000)) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'Hello' });
    expect(chunks[1].choices[0].delta).toEqual({ content: ' world' });
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
    expect(chunks[2].usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});

describe('formatSseChunk', () => {
  it('wraps a chunk as an SSE data line', () => {
    const line = formatSseChunk({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'sonnet',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    });
    expect(line).toBe(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sonnet","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    );
  });

  it('exports the terminal DONE marker', () => {
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });
});

describe('toOpenAiCompletion', () => {
  it('buffers all deltas into a single completion response', async () => {
    const completion = await toOpenAiCompletion(fixtureEvents(), 'sonnet', () => 1_700_000_000_000);
    expect(completion.choices[0].message).toEqual({ role: 'assistant', content: 'Hello world' });
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('rejects when the provider emits an error event', async () => {
    async function* errorEvents(): AsyncGenerator<ProviderEvent> {
      yield { type: 'error', message: 'boom' };
    }
    await expect(toOpenAiCompletion(errorEvents(), 'sonnet')).rejects.toThrow('boom');
  });
});
