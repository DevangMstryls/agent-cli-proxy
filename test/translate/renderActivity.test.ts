import { describe, expect, it } from 'vitest';
import { ActivityRenderer, summarizeToolInput } from '../../src/translate/renderActivity.js';

describe('summarizeToolInput', () => {
  it('prefers the argument identifying what was acted on', () => {
    expect(summarizeToolInput({ file_path: '/src/app.ts', limit: 10 })).toBe('/src/app.ts');
    expect(summarizeToolInput({ command: 'npm test' })).toBe('npm test');
    expect(summarizeToolInput({ pattern: 'TODO' })).toBe('TODO');
  });

  it('falls back to serialized input when no known argument is present', () => {
    expect(summarizeToolInput({ weird: 'value' })).toBe('{"weird":"value"}');
  });

  it('returns an empty string for an empty input', () => {
    expect(summarizeToolInput({})).toBe('');
  });

  it('truncates a very long argument', () => {
    const summary = summarizeToolInput({ command: 'x'.repeat(500) });
    expect(summary).toHaveLength(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('ActivityRenderer', () => {
  it('passes plain text through unchanged', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'delta', text: 'hello' })).toBe('hello');
  });

  it('renders a tool call with its primary argument', () => {
    const r = new ActivityRenderer();
    const out = r.render({ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } });
    expect(out).toContain('▸ **Read**(/a.ts)');
  });

  it('renders a tool call with no arguments', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'tool_use', name: 'ListTodos', input: {} })).toContain('▸ **ListTodos**');
  });

  it('marks an errored tool result distinctly', () => {
    const r = new ActivityRenderer();
    const out = r.render({ type: 'tool_result', isError: true, text: 'permission denied' });
    expect(out).toContain('⚠');
    expect(out).toContain('permission denied');
  });

  it('previews a successful tool result', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'tool_result', isError: false, text: 'hello world' })).toContain('↳ hello world');
  });

  it('emits nothing for an empty successful tool result', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'tool_result', isError: false, text: '   ' })).toBe('');
  });

  it('renders thinking in italics', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'thinking', text: 'considering options' })).toContain('_considering options_');
  });

  it('separates a tool call from preceding prose so turns do not run together', () => {
    const r = new ActivityRenderer();
    const parts = [
      r.render({ type: 'delta', text: 'Let me look.' }),
      r.render({ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }),
      r.render({ type: 'delta', text: 'Found it.' }),
    ];
    const combined = parts.join('');

    expect(combined).toBe('Let me look.\n\n▸ **Read**(/a.ts)\nFound it.');
    // The regression this guards: "Let me look.▸..." or "...(/a.ts)Found it."
    expect(combined).not.toMatch(/\S▸/);
  });

  it('does not add a leading separator before the very first event', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'tool_use', name: 'Read', input: {} })).toBe('▸ **Read**\n');
  });

  it('ignores result and error events', () => {
    const r = new ActivityRenderer();
    expect(r.render({ type: 'error', message: 'boom' })).toBe('');
    expect(
      r.render({ type: 'result', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
    ).toBe('');
  });

  it('produces identical output for identical event sequences', () => {
    // The session-resume hash depends on this: the route reproduces the reply
    // text with a second renderer, and it must match what the client received.
    const events = [
      { type: 'delta', text: 'a' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', isError: false, text: 'file.txt' },
      { type: 'delta', text: 'done' },
    ] as const;

    const first = new ActivityRenderer();
    const second = new ActivityRenderer();
    const a = events.map((e) => first.render(e)).join('');
    const b = events.map((e) => second.render(e)).join('');

    expect(a).toBe(b);
  });
});
