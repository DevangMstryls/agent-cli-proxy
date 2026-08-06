export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
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
}

export interface AgentProvider {
  startTurn(options: StartTurnOptions): AsyncIterable<ProviderEvent>;
}
