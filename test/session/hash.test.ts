import { describe, expect, it } from 'vitest';
import { hashMessages } from '../../src/session/hash.js';
import type { ChatMessage } from '../../src/types.js';

describe('hashMessages', () => {
  it('produces the same hash for identical message arrays', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(hashMessages(messages)).toBe(hashMessages([{ role: 'user', content: 'hello' }]));
  });

  it('produces different hashes when content differs', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([{ role: 'user', content: 'goodbye' }]);
    expect(a).not.toBe(b);
  });

  it('produces different hashes when message count differs', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(a).not.toBe(b);
  });

  it('ignores extra fields beyond role and content', () => {
    const a = hashMessages([{ role: 'user', content: 'hello' }]);
    const b = hashMessages([{ role: 'user', content: 'hello', name: 'ignored' } as ChatMessage]);
    expect(a).toBe(b);
  });
});
