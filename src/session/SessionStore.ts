export interface SessionEntry {
  claudeSessionId: string;
  expiresAt: number;
}

export class SessionStore {
  private entries = new Map<string, SessionEntry>();
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions: number,
    private readonly now: () => number = Date.now,
  ) {}

  lookup(prefixHash: string): SessionEntry | undefined {
    const entry = this.entries.get(prefixHash);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.entries.delete(prefixHash);
      return undefined;
    }
    // Re-insert to mark as most recently used (Map preserves insertion order).
    this.entries.delete(prefixHash);
    this.entries.set(prefixHash, entry);
    return entry;
  }

  remember(fullHash: string, claudeSessionId: string): void {
    if (this.entries.size >= this.maxSessions && !this.entries.has(fullHash)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(fullHash, { claudeSessionId, expiresAt: this.now() + this.ttlMs });
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
