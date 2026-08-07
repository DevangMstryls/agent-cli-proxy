import { createInterface } from 'node:readline';
import type { ProviderEvent } from '../types.js';

// A tool_result's content is a string on some tools and an array of blocks on
// others; normalize both to plain text for display.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

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

    // Assistant text streams incrementally as deltas, so it's read from
    // stream_event rather than from the buffered `assistant` message below —
    // otherwise output would only appear once each turn had fully completed.
    if (
      parsed.type === 'stream_event' &&
      parsed.event?.type === 'content_block_delta' &&
      parsed.event.delta?.type === 'text_delta'
    ) {
      yield { type: 'delta', text: parsed.event.delta.text };
      continue;
    }

    // Tool calls and thinking only arrive complete, on the buffered `assistant`
    // message — their streamed form is a partial JSON accumulation that isn't
    // useful until finished. Text blocks are skipped here because the deltas
    // above already carried them.
    if (parsed.type === 'assistant') {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          yield {
            type: 'tool_use',
            name: block.name,
            input: block.input && typeof block.input === 'object' ? block.input : {},
          };
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          yield { type: 'thinking', text: block.thinking };
        }
      }
      continue;
    }

    // Tool results come back on a `user` message — the CLI feeds them to the
    // model the same way a client would.
    if (parsed.type === 'user') {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          yield {
            type: 'tool_result',
            isError: block.is_error === true,
            text: toolResultText(block.content),
          };
        }
      }
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
