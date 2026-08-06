import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ClaudeProvider } from './providers/ClaudeProvider.js';
import { SessionStore } from './session/SessionStore.js';

const config = loadConfig();
const provider = new ClaudeProvider(config.claudeBin);
const sessionStore = new SessionStore(config.sessionTtlMs, config.maxSessions);
const app = createApp({ config, provider, sessionStore });

app.listen(config.port, () => {
  console.log(`agent-cli-proxy listening on port ${config.port}`);
});
