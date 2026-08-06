import { createHash } from 'node:crypto';
import type { ChatMessage } from '../types.js';

export function hashMessages(messages: ChatMessage[]): string {
  const canonical = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash('sha256').update(canonical).digest('hex');
}
