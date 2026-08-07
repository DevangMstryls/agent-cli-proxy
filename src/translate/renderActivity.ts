import type { ProviderEvent } from '../types.js';

const MAX_ARG = 120;
const MAX_RESULT = 200;
const MAX_ERROR = 400;

function clip(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

// Show the argument that identifies what the tool acted on, rather than dumping
// the whole input object — "Read(src/app.ts)" is what makes a trace readable.
const PRIMARY_ARGS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description'];

export function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of PRIMARY_ARGS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return clip(value, MAX_ARG);
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return clip(JSON.stringify(input), MAX_ARG);
}

// Renders Claude's internal activity as plain markdown appended to the reply.
// It cannot be returned as OpenAI `tool_calls` — the CLI has already run these,
// and a client that received tool_calls would execute them a second time.
export class ActivityRenderer {
  private emittedAnything = false;
  private atLineStart = true;

  // Separates activity markers from surrounding prose so a multi-step run reads
  // as distinct steps instead of one run-on paragraph.
  private block(text: string): string {
    const prefix = !this.emittedAnything ? '' : this.atLineStart ? '\n' : '\n\n';
    this.emittedAnything = true;
    this.atLineStart = true;
    return `${prefix}${text}\n`;
  }

  text(chunk: string): string {
    if (!chunk) return '';
    this.emittedAnything = true;
    this.atLineStart = chunk.endsWith('\n');
    return chunk;
  }

  render(event: ProviderEvent): string {
    switch (event.type) {
      case 'delta':
        return this.text(event.text);
      case 'thinking':
        return this.block(`_${clip(event.text, 2000)}_`);
      case 'tool_use': {
        const arg = summarizeToolInput(event.input);
        return this.block(arg ? `▸ **${event.name}**(${arg})` : `▸ **${event.name}**`);
      }
      case 'tool_result': {
        if (event.isError) {
          return this.block(`  ⚠ ${clip(event.text, MAX_ERROR) || 'error'}`);
        }
        const preview = clip(event.text, MAX_RESULT);
        return preview ? this.block(`  ↳ ${preview}`) : '';
      }
      default:
        return '';
    }
  }
}
