export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// What arrives on the wire, before normalization. OpenAI allows `content` to be
// a string or an array of typed parts, so it can't be typed as ChatMessage —
// the route flattens each message to a ChatMessage before anything else runs.
export interface IncomingChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: IncomingChatMessage[];
  stream?: boolean;
  cwd?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; sessionId?: string; stopReason: string; usage: ProviderUsage }
  | { type: 'error'; message: string };

export interface StartTurnOptions {
  prompt: string;
  model: string;
  resumeSessionId?: string;
  newSessionId?: string;
  cwd: string;
  permissionMode: string;
  safeMode?: boolean;
  mcpConfig?: string;
  allowedTools?: string;
}

export interface AgentProvider {
  startTurn(options: StartTurnOptions): AsyncIterable<ProviderEvent>;
}
