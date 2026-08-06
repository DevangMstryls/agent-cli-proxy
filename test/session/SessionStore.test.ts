import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/session/SessionStore.js';

describe('SessionStore', () => {
  it('returns undefined for an unknown key', () => {
    const store = new SessionStore(1000, 10);
    expect(store.lookup('missing')).toBeUndefined();
  });

  it('remembers and looks up a session', () => {
    const store = new SessionStore(1000, 10);
    store.remember('hash-a', 'claude-session-1');
    expect(store.lookup('hash-a')).toEqual({ claudeSessionId: 'claude-session-1', expiresAt: expect.any(Number) });
  });

  it('expires entries after the TTL elapses', () => {
    let now = 1_000_000;
    const store = new SessionStore(500, 10, () => now);
    store.remember('hash-a', 'claude-session-1');
    now += 600;
    expect(store.lookup('hash-a')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const store = new SessionStore(1000, 2);
    store.remember('hash-a', 'session-a');
    store.remember('hash-b', 'session-b');
    store.lookup('hash-a'); // touch a, making b the least recently used
    store.remember('hash-c', 'session-c'); // should evict b, not a
    expect(store.lookup('hash-a')).toBeDefined();
    expect(store.lookup('hash-b')).toBeUndefined();
    expect(store.lookup('hash-c')).toBeDefined();
  });

  it('serializes concurrent calls against the same lock key', async () => {
    const store = new SessionStore(1000, 10);
    const order: string[] = [];

    const slow = store.withLock('key', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = store.withLock('key', async () => {
      order.push('fast');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('cleans up lock entries after they settle', async () => {
    const store = new SessionStore(1000, 10);
    let firstCompleted = false;

    // First call to key 'cleanup-test'
    await store.withLock('cleanup-test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      firstCompleted = true;
    });

    // Ensure first lock is fully settled
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second call to same key should not wait on the old lock
    const start = Date.now();
    await store.withLock('cleanup-test', async () => {
      // This should execute immediately without waiting for the old lock
    });
    const duration = Date.now() - start;

    // If locks were not cleaned up, the second call would have to wait at least 15ms
    // With cleanup, it should be nearly instant
    expect(duration).toBeLessThan(10);
    expect(firstCompleted).toBe(true);
  });
});
