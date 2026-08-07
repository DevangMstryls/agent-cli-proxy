import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listSessions } from './sessions.js';

const server = new McpServer({
  name: 'claude-sessions',
  version: '0.1.0',
});

server.registerTool(
  'list_resumable_sessions',
  {
    title: 'List resumable Claude sessions',
    description:
      'List the Claude Code CLI sessions that can be resumed from a given working directory, newest first. ' +
      'Returns each session id along with the first user message and when it was last active. ' +
      'Pass a session id to agent-cli-proxy as "/resume <session-id> <your message>" or via the ' +
      'X-Claude-Session-Id header to continue that conversation. Claude stores sessions per working ' +
      'directory, so a session is only resumable from the directory it was started in.',
    inputSchema: {
      cwd: z
        .string()
        .describe('Absolute path of the working directory to list sessions for (e.g. /Users/you/projects/app).'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Maximum number of sessions to return, newest first. Defaults to 20.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cwd, limit }) => {
    const sessions = await listSessions(cwd, { limit });

    if (sessions.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No resumable Claude sessions found for ${cwd}.`,
          },
        ],
      };
    }

    const lines = sessions.map(
      (s) => `${s.sessionId}\n  last active: ${s.lastActive}\n  first message: ${s.firstMessage}`,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `${sessions.length} resumable session(s) for ${cwd}:\n\n${lines.join('\n\n')}`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('claude-sessions MCP server failed to start:', err);
  process.exit(1);
});
