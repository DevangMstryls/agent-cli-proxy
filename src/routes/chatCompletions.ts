import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { toOpenAiError } from '../middleware/errorHandler.js';
import { hashMessages } from '../session/hash.js';
import { resolveConversation, tapProviderEvents } from '../session/resolveConversation.js';
import type { SessionStore } from '../session/SessionStore.js';
import { formatSseChunk, SSE_DONE, toOpenAiChunks, toOpenAiCompletion } from '../translate/openaiSse.js';
import type { AgentProvider, ChatCompletionRequest, ChatMessage } from '../types.js';

export interface ChatCompletionsDeps {
  provider: AgentProvider;
  sessionStore: SessionStore;
  config: AppConfig;
}

// Some OpenAI-compatible coding-agent clients (e.g. opencode/OpenChamber) don't
// send a structured `cwd` field — they embed it as plain text in the system
// prompt instead, inside an "<env>...Working directory: <path>...</env>"
// block. Pull it out as a fallback before defaulting to the configured
// WORKDIR, so each session's own directory is respected when the client
// provides one this way.
export function extractWorkdirFromSystemMessage(messages: ChatMessage[]): string | undefined {
  const systemMessage = messages.find((m) => m.role === 'system');
  if (!systemMessage) return undefined;
  const match = systemMessage.content.match(/Working directory:\s*(.+)/);
  return match ? match[1].trim() : undefined;
}

export function createChatCompletionsHandler(deps: ChatCompletionsDeps) {
  return async function handleChatCompletions(req: Request, res: Response) {
    try {
      const body = req.body as ChatCompletionRequest;

      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        throw new ApiError('messages must be a non-empty array', 400, 'invalid_request_error');
      }

      if (body.messages.some((m) => typeof m.content !== 'string')) {
        throw new ApiError('messages[].content must be a string', 400, 'invalid_request_error');
      }

      // Any model string the client sends is forwarded as-is to `claude --model`
      // (an alias like "opus", or a specific pinned version like
      // "claude-opus-4-8") — we don't maintain our own allowlist of valid
      // models, since Claude's own CLI already rejects genuinely invalid
      // ones (surfaced as a clean 502 via ClaudeCliError, not silently
      // swapped for the default).
      const model = typeof body.model === 'string' && body.model.trim() ? body.model : deps.config.defaultModel;
      const cwd = body.cwd ?? extractWorkdirFromSystemMessage(body.messages) ?? deps.config.workdir;
      const resolution = resolveConversation(body.messages, deps.sessionStore);

      // Requests that resolve to the same underlying Claude session (either
      // resuming an existing one or minting a new one) must be serialized —
      // two concurrent `claude --resume <id>` processes writing the same
      // session file at once is a real corruption risk.
      const lockKey = resolution.resumeSessionId ?? resolution.newSessionId!;
      await deps.sessionStore.withLock(lockKey, async () => {
        let capturedSessionId: string | undefined;
        let fullReplyText = '';
        const rawEvents = deps.provider.startTurn({
          prompt: resolution.prompt,
          model,
          resumeSessionId: resolution.resumeSessionId,
          newSessionId: resolution.newSessionId,
          cwd,
          permissionMode: deps.config.permissionMode,
        });
        const events = tapProviderEvents(rawEvents, (event) => {
          if (event.type === 'delta') {
            fullReplyText += event.text;
          } else if (event.type === 'result' && event.sessionId) {
            capturedSessionId = event.sessionId;
          }
        });

        try {
          if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            for await (const chunk of toOpenAiChunks(events, model)) {
              res.write(formatSseChunk(chunk));
            }
            res.write(SSE_DONE);
            res.end();
          } else {
            const completion = await toOpenAiCompletion(events, model);
            res.json(completion);
          }
        } finally {
          if (capturedSessionId) {
            // The remember key must match what the NEXT request's prefix hash
            // will be: the client resends this turn's messages plus the
            // assistant reply it just received, so that's what gets hashed
            // here — resolveConversation could not compute this key itself,
            // since the reply doesn't exist until the provider call completes.
            const rememberKey = hashMessages([...body.messages, { role: 'assistant', content: fullReplyText }]);
            deps.sessionStore.remember(rememberKey, capturedSessionId);
          }
        }
      });
    } catch (err) {
      // Express 4 does not auto-catch async handler rejections, so every
      // error path (validation, provider failure, mid-stream failure) is
      // handled here rather than relying on the errorHandler middleware.
      if (res.headersSent) {
        const { body: errorBody } = toOpenAiError(err);
        res.write(`data: ${JSON.stringify(errorBody)}\n\n`);
        res.write(SSE_DONE);
        res.end();
        return;
      }
      const { status, body: errorBody } = toOpenAiError(err);
      res.status(status).json(errorBody);
    }
  };
}
