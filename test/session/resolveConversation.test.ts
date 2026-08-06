import { describe, expect, it } from 'vitest';
import { resolveConversation, tapProviderEvents } from '../../src/session/resolveConversation.js';
import { SessionStore } from '../../src/session/SessionStore.js';
import { hashMessages } from '../../src/session/hash.js';
import type { ChatMessage, ProviderEvent } from '../../src/types.js';

describe('resolveConversation', () => {
  it('starts a new session for the first message in a conversation', () => {
    const store = new SessionStore(1000, 10);
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const resolution = resolveConversation(messages, store);

    expect(resolution.prompt).toBe('hello');
    expect(resolution.newSessionId).toBeDefined();
    expect(resolution.resumeSessionId).toBeUndefined();
    expect(resolution.rememberKey).toBe(hashMessages(messages));
  });

  it('resumes an existing session when the prefix hash is known', () => {
    const store = new SessionStore(1000, 10);

    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you?' },
    ];
    // Prefix (first two messages) must match a remembered full-turn hash.
    store.remember(hashMessages(messages.slice(0, 2)), 'claude-session-1');

    const resolution = resolveConversation(messages, store);
    expect(resolution.prompt).toBe('how are you?');
    expect(resolution.resumeSessionId).toBe('claude-session-1');
    expect(resolution.newSessionId).toBeUndefined();
  });

  it('starts a new session with the full transcript when the prefix is unknown', () => {
    const store = new SessionStore(1000, 10);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ];

    const resolution = resolveConversation(messages, store);
    expect(resolution.newSessionId).toBeDefined();
    expect(resolution.prompt).toContain('first message');
    expect(resolution.prompt).toContain('second message');
  });

  it('throws when given an empty message array', () => {
    const store = new SessionStore(1000, 10);
    expect(() => resolveConversation([], store)).toThrow('messages must not be empty');
  });
});

describe('tapProviderEvents', () => {
  it('invokes the callback for every event while still yielding them', async () => {
    async function* source(): AsyncGenerator<ProviderEvent> {
      yield { type: 'delta', text: 'hi' };
      yield { type: 'result', sessionId: 'session-1', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }

    const seen: ProviderEvent[] = [];
    const collected: ProviderEvent[] = [];
    for await (const event of tapProviderEvents(source(), (e) => seen.push(e))) {
      collected.push(event);
    }

    expect(seen).toEqual(collected);
    expect(collected).toHaveLength(2);
  });
});
