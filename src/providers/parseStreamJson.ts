import { createInterface } from 'node:readline';
import type { ProviderEvent } from '../types.js';

export async function* parseClaudeStream(stdout: NodeJS.ReadableStream): AsyncGenerator<ProviderEvent> {
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed === null || typeof parsed !== 'object') {
      continue;
    }

    if (
      parsed.type === 'stream_event' &&
      parsed.event?.type === 'content_block_delta' &&
      parsed.event.delta?.type === 'text_delta'
    ) {
      yield { type: 'delta', text: parsed.event.delta.text };
      continue;
    }

    if (parsed.type === 'result') {
      if (parsed.is_error) {
        yield { type: 'error', message: parsed.result ?? 'Claude CLI reported an error' };
      } else {
        yield {
          type: 'result',
          sessionId: parsed.session_id,
          stopReason: parsed.stop_reason ?? 'end_turn',
          usage: {
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
          },
        };
      }
    }
  }
}
