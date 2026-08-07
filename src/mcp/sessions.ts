import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  firstMessage: string;
  lastActive: string;
  sizeBytes: number;
}

// Claude stores each project's sessions under ~/.claude/projects/<encoded-cwd>/,
// where the encoding replaces every non-alphanumeric character in the absolute
// path with "-" (so "/private/tmp/resume-test" becomes
// "-private-tmp-resume-test", and a ".claude" segment becomes "--claude").
// Case is preserved.
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectsRoot(home: string = homedir()): string {
  return path.join(home, '.claude', 'projects');
}

// A "user" record isn't always something the person typed — SDK invocations put
// the system prompt there, and slash commands, skill loads, and hook output are
// injected the same way. Those make useless session labels, so prefer the first
// record that looks human-authored and only fall back to an injected one if the
// session has nothing else.
const INJECTED_MESSAGE_PATTERNS = [
  /^\[system\]/i,
  /^Base directory for this skill:/,
  /^Caveat:/i,
  /<command-name>/,
  /<local-command-stdout>/,
  /<system-reminder>/,
];

function isInjected(text: string): boolean {
  return INJECTED_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const textPart = content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
    if (textPart) return (textPart as { text: string }).text.trim();
  }
  return undefined;
}

// Reads only as far as it needs rather than parsing the whole transcript —
// session files run to megabytes. Stops early once a human-authored message is
// found; a session that is entirely injected content is read to the end, which
// is rare and still bounded by the scan cap below.
const MAX_LINES_SCANNED = 400;

async function readSessionHead(filePath: string): Promise<{ cwd?: string; firstMessage?: string }> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let cwd: string | undefined;
  let humanMessage: string | undefined;
  let fallbackMessage: string | undefined;
  let scanned = 0;

  try {
    for await (const line of rl) {
      if (++scanned > MAX_LINES_SCANNED) break;
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') continue;

      if (!cwd && typeof parsed.cwd === 'string') {
        cwd = parsed.cwd;
      }

      if (!humanMessage && parsed.type === 'user' && parsed.isMeta !== true) {
        const text = extractText(parsed.message?.content);
        if (text) {
          if (isInjected(text)) {
            fallbackMessage ??= text;
          } else {
            humanMessage = text;
          }
        }
      }

      if (cwd && humanMessage) break;
    }
  } finally {
    rl.close();
  }

  return { cwd, firstMessage: humanMessage ?? fallbackMessage };
}

function truncate(text: string, max = 140): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export interface ListSessionsOptions {
  home?: string;
  limit?: number;
}

// Lists sessions resumable from `cwd`, newest first. The encoded directory name
// only locates the candidates — each session's own recorded `cwd` is checked
// before it's returned, so a hash collision or a stale directory can't surface
// sessions belonging to a different project.
export async function listSessions(cwd: string, options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const { home = homedir(), limit = 20 } = options;
  const dir = path.join(projectsRoot(home), encodeProjectDir(cwd));

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const sessions: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }

    const { cwd: recordedCwd, firstMessage } = await readSessionHead(filePath);
    if (recordedCwd && recordedCwd !== cwd) continue;

    sessions.push({
      sessionId: path.basename(entry, '.jsonl'),
      cwd: recordedCwd ?? cwd,
      firstMessage: firstMessage ? truncate(firstMessage) : '(no user message recorded)',
      lastActive: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  }

  sessions.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  return sessions.slice(0, limit);
}
