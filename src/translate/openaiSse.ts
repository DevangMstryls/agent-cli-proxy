import { randomUUID } from 'node:crypto';
import type { ProviderEvent } from '../types.js';
import { ActivityRenderer } from './renderActivity.js';

export interface OpenAiChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export const SSE_DONE = 'data: [DONE]\n\n';

export function formatSseChunk(chunk: OpenAiChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function usageFromEvent(event: Extract<ProviderEvent, { type: 'result' }>) {
  return {
    prompt_tokens: event.usage.inputTokens,
    completion_tokens: event.usage.outputTokens,
    total_tokens: event.usage.inputTokens + event.usage.outputTokens,
  };
}

function finishReasonFromEvent(event: Extract<ProviderEvent, { type: 'result' }>) {
  return event.stopReason === 'end_turn' ? 'stop' : event.stopReason;
}

export async function* toOpenAiChunks(
  events: AsyncIterable<ProviderEvent>,
  model: string,
  now: () => number = Date.now,
): AsyncGenerator<OpenAiChunk> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(now() / 1000);
  const renderer = new ActivityRenderer();
  let sentRole = false;

  for await (const event of events) {
    if (event.type === 'delta' || event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'thinking') {
      const text = renderer.render(event);
      if (!text) continue;
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: sentRole ? { content: text } : { role: 'assistant', content: text },
            finish_reason: null,
          },
        ],
      };
      sentRole = true;
    } else if (event.type === 'result') {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReasonFromEvent(event) }],
        usage: usageFromEvent(event),
      };
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }
}

export async function toOpenAiCompletion(
  events: AsyncIterable<ProviderEvent>,
  model: string,
  now: () => number = Date.now,
): Promise<OpenAiCompletion> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(now() / 1000);
  const renderer = new ActivityRenderer();
  let content = '';
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const event of events) {
    if (event.type === 'delta' || event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'thinking') {
      content += renderer.render(event);
    } else if (event.type === 'result') {
      finishReason = finishReasonFromEvent(event);
      usage = usageFromEvent(event);
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage,
  };
}
