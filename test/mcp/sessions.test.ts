import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectDir, listSessions } from '../../src/mcp/sessions.js';

let home: string;

async function writeSession(
  projectCwd: string,
  sessionId: string,
  lines: unknown[],
  encodedDirOverride?: string,
): Promise<string> {
  const dir = path.join(home, '.claude', 'projects', encodedDirOverride ?? encodeProjectDir(projectCwd));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sessions-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('encodeProjectDir', () => {
  it('replaces path separators with dashes', () => {
    expect(encodeProjectDir('/private/tmp/resume-test')).toBe('-private-tmp-resume-test');
  });

  it('replaces dots with dashes, preserving case', () => {
    expect(encodeProjectDir('/Users/dev/proj/.claude/AI')).toBe('-Users-dev-proj--claude-AI');
  });
});

describe('listSessions', () => {
  it('returns an empty list when the project has no sessions directory', async () => {
    expect(await listSessions('/no/such/project', { home })).toEqual([]);
  });

  it('summarizes a session with its id, cwd, and first user message', async () => {
    const cwd = '/tmp/proj-a';
    await writeSession(cwd, 'session-1', [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', message: { role: 'user', content: 'Fix the auth bug' }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('session-1');
    expect(sessions[0].cwd).toBe(cwd);
    expect(sessions[0].firstMessage).toBe('Fix the auth bug');
    expect(sessions[0].sizeBytes).toBeGreaterThan(0);
  });

  it('extracts the first user message from array-shaped content', async () => {
    const cwd = '/tmp/proj-array';
    await writeSession(cwd, 'session-arr', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Array shaped' }] }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('Array shaped');
  });

  it('skips a session whose recorded cwd belongs to a different project', async () => {
    const cwd = '/tmp/proj-b';
    await writeSession(cwd, 'mine', [{ type: 'user', message: { role: 'user', content: 'ok' }, cwd }]);
    // Same encoded directory, but the session itself records a different cwd.
    await writeSession(cwd, 'someone-elses', [
      { type: 'user', message: { role: 'user', content: 'nope' }, cwd: '/tmp/other-project' },
    ]);

    const sessions = await listSessions(cwd, { home });

    expect(sessions.map((s) => s.sessionId)).toEqual(['mine']);
  });

  it('tolerates malformed and non-object JSON lines', async () => {
    const cwd = '/tmp/proj-malformed';
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'session-bad.jsonl'),
      ['not json', 'null', '42', JSON.stringify({ type: 'user', message: { role: 'user', content: 'survived' }, cwd })].join('\n'),
    );

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('survived');
  });

  it('prefers a human-authored message over injected system content', async () => {
    const cwd = '/tmp/proj-injected';
    await writeSession(cwd, 'session-injected', [
      { type: 'user', message: { role: 'user', content: '[system] You are a helpful assistant' }, cwd },
      { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' }, cwd },
      { type: 'user', message: { role: 'user', content: 'Actually fix the parser' }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('Actually fix the parser');
  });

  it('falls back to injected content when a session has nothing else', async () => {
    const cwd = '/tmp/proj-only-injected';
    await writeSession(cwd, 'session-only-injected', [
      { type: 'user', message: { role: 'user', content: '[system] Only system content here' }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('[system] Only system content here');
  });

  it('skips meta user records', async () => {
    const cwd = '/tmp/proj-meta';
    await writeSession(cwd, 'session-meta', [
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' }, cwd },
      { type: 'user', message: { role: 'user', content: 'the real ask' }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('the real ask');
  });

  it('reports a placeholder when a session has no user message', async () => {
    const cwd = '/tmp/proj-empty';
    await writeSession(cwd, 'session-empty', [{ type: 'queue-operation', operation: 'enqueue', cwd }]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toBe('(no user message recorded)');
  });

  it('ignores non-jsonl files', async () => {
    const cwd = '/tmp/proj-mixed';
    await writeSession(cwd, 'real', [{ type: 'user', message: { role: 'user', content: 'hi' }, cwd }]);
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignore me');

    const sessions = await listSessions(cwd, { home });
    expect(sessions.map((s) => s.sessionId)).toEqual(['real']);
  });

  it('sorts newest first and respects the limit', async () => {
    const cwd = '/tmp/proj-many';
    for (const id of ['a', 'b', 'c']) {
      await writeSession(cwd, id, [{ type: 'user', message: { role: 'user', content: id }, cwd }]);
    }
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
    // Give each a distinct, known mtime.
    await fs.utimes(path.join(dir, 'a.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
    await fs.utimes(path.join(dir, 'b.jsonl'), new Date('2026-03-01'), new Date('2026-03-01'));
    await fs.utimes(path.join(dir, 'c.jsonl'), new Date('2026-02-01'), new Date('2026-02-01'));

    const all = await listSessions(cwd, { home });
    expect(all.map((s) => s.sessionId)).toEqual(['b', 'c', 'a']);

    const limited = await listSessions(cwd, { home, limit: 2 });
    expect(limited.map((s) => s.sessionId)).toEqual(['b', 'c']);
  });

  it('truncates a long first message', async () => {
    const cwd = '/tmp/proj-long';
    await writeSession(cwd, 'session-long', [
      { type: 'user', message: { role: 'user', content: 'x'.repeat(500) }, cwd },
    ]);

    const sessions = await listSessions(cwd, { home });
    expect(sessions[0].firstMessage).toHaveLength(140);
    expect(sessions[0].firstMessage.endsWith('…')).toBe(true);
  });
});
