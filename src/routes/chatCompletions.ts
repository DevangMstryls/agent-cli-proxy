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

// Both `model` and `cwd` end up as the value of a `--flag <value>` pair passed
// to `claude` via execve (no shell involved, so no space/semicolon injection
// risk) — but a value starting with "-" can still be reinterpreted by the
// CLI's own arg parser as an unrelated flag rather than this option's value
// (e.g. model: "--dangerously-skip-permissions"), which would be a real
// argument-injection vector. Reject that shape outright rather than relying
// on the downstream parser's leniency.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/;

function assertNotFlagLike(value: string, fieldName: string): void {
  if (value.startsWith('-')) {
    throw new ApiError(`${fieldName} must not start with "-"`, 400, 'invalid_request_error');
  }
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

// A Claude session ID is a UUID; constrain the charset both to catch typos
// early and to guarantee the value can never be reinterpreted as a CLI flag
// when passed to `claude --resume <id>`.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

// First-message directive: "/resume <session-id>", optionally followed by the
// actual message text. Lets a chat client with no custom-header support bind
// a conversation to a pre-existing Claude CLI session.
const RESUME_DIRECTIVE = /^\/resume\s+(\S+)\s*/;

export interface ExplicitResume {
  sessionId: string;
  prompt: string;
}

// An explicit session ID (X-Claude-Session-Id header, or a "/resume <id>"
// directive at the start of the conversation's first user message) bypasses
// hash-based conversation matching entirely: the turn always resumes that
// session, sending only the newest message. The directive is resolved from
// the FIRST user message on every turn — clients resend full history each
// call, so this keeps later turns bound to the same session even if the
// proxy restarted and lost its in-memory session store.
export function resolveExplicitResume(
  headerSessionId: string | undefined,
  messages: ChatMessage[],
): ExplicitResume | undefined {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  const directiveMatch = firstUserMessage?.content.match(RESUME_DIRECTIVE);
  const sessionId = headerSessionId?.trim() || directiveMatch?.[1];
  if (!sessionId) return undefined;

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ApiError('session id must match ^[A-Za-z0-9][A-Za-z0-9-]*$', 400, 'invalid_request_error');
  }

  const lastMessage = messages[messages.length - 1];
  let prompt = lastMessage.content;
  if (lastMessage === firstUserMessage && directiveMatch) {
    // Turn 1 of a directive-initiated chat: strip the directive from the
    // prompt actually sent to Claude. A bare "/resume <id>" with no
    // further text becomes a simple "continue".
    prompt = lastMessage.content.slice(directiveMatch[0].length).trim() || 'continue';
  }

  return { sessionId, prompt };
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
      if (!MODEL_PATTERN.test(model)) {
        throw new ApiError('model must match ^[A-Za-z0-9][A-Za-z0-9._@:[\\]-]*$', 400, 'invalid_request_error');
      }

      const cwd = body.cwd ?? extractWorkdirFromSystemMessage(body.messages) ?? deps.config.workdir;
      assertNotFlagLike(cwd, 'cwd');

      const explicitResume = resolveExplicitResume(req.header('x-claude-session-id'), body.messages);
      const resolution = explicitResume
        ? { prompt: explicitResume.prompt, resumeSessionId: explicitResume.sessionId }
        : resolveConversation(body.messages, deps.sessionStore);

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
