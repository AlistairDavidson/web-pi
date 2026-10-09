import { defineConfig, devices } from '@playwright/test';
import { TMUX_SOCKET, WORKSPACE } from './tests/env';

const PORT = 3470;

export default defineConfig({
  testDir: './tests',
  // Only the Playwright specs (e2e / state-dir / sessions-cache …): the
  // node:test units under tests/unit/ are `npm run test:unit` territory,
  // and Playwright's default pattern (*.@(spec|test).(c|m)…js) would import
  // them as specs and run their tests inline mid-suite.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  // Serial: tests share one login rate-limit budget (per-IP, in-memory)
  // and one tmux test socket.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './tests/global-setup.ts',
  webServer: {
    command: 'node dist-server/server/main.js',
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      WEB_PI_PORT: String(PORT),
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_DB_FILE: `${WORKSPACE}/webpi.db`,
      WEB_PI_SESSIONS_DIR: `${WORKSPACE}/sessions`,
      WEB_PI_AGENT_DIR: `${WORKSPACE}/pi-agent`,
      WEB_PI_NEW_SESSION_CWD: WORKSPACE,
      WEB_PI_TMUX_SOCKET: TMUX_SOCKET,
      WEB_PI_COMMAND: `${WORKSPACE}/cmd.sh`,
    },
  },
});
