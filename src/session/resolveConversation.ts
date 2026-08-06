import { randomUUID } from 'node:crypto';
import { hashMessages } from './hash.js';
import type { SessionStore } from './SessionStore.js';
import type { ChatMessage, ProviderEvent } from '../types.js';

export interface ConversationResolution {
  prompt: string;
  resumeSessionId?: string;
  newSessionId?: string;
  rememberKey: string;
}

export function resolveConversation(messages: ChatMessage[], sessionStore: SessionStore): ConversationResolution {
  if (messages.length === 0) {
    throw new Error('messages must not be empty');
  }

  const lastMessage = messages[messages.length - 1];
  const rememberKey = hashMessages(messages);

  if (messages.length === 1) {
    return { prompt: lastMessage.content, newSessionId: randomUUID(), rememberKey };
  }

  const prefix = messages.slice(0, -1);
  const existing = sessionStore.lookup(hashMessages(prefix));

  if (existing) {
    return { prompt: lastMessage.content, resumeSessionId: existing.claudeSessionId, rememberKey };
  }

  const fullPrompt = messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
  return { prompt: fullPrompt, newSessionId: randomUUID(), rememberKey };
}

export async function* tapProviderEvents(
  events: AsyncIterable<ProviderEvent>,
  onEvent: (event: ProviderEvent) => void,
): AsyncGenerator<ProviderEvent> {
  for await (const event of events) {
    onEvent(event);
    yield event;
  }
}
