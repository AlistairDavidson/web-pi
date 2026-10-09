// global-setup.ts — hermetic workspace for the e2e run.
// The webServer (playwright.config.ts) boots before this runs; that's fine:
// the server opens the state db, sessions dir and tmux socket lazily.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { MARKER, PASSWORD, TMUX_SOCKET, USERNAME, UUIDV7_SIBLINGS, WORKSPACE } from './env';

export default function globalSetup(): void {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORKSPACE, 'sessions'), { recursive: true });

  // Login credential in the state db (Auth reads the row per attempt;
  // the server opens the db lazily — only after this reset).
  setCredential(new StateDb(path.join(WORKSPACE, 'webpi.db')), USERNAME, PASSWORD);

  // Deterministic command for new/resumed sessions: banner + a shell we can
  // type into. WEB_PI_COMMAND is whitespace-split, so it must be one path.
  const cmd = path.join(WORKSPACE, 'cmd.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\necho '${MARKER}'\nexec /bin/sh\n`);
  fs.chmodSync(cmd, 0o755);

  // Fixture pi sessions: <scope>/<ts>_<uuid>.jsonl; line 1 = session header,
  // first user message becomes the sidebar title. mtimes drive the order.
  const mkSession = (scope: string, id: string, cwd: string, title: string, ageMin: number) => {
    const dir = path.join(WORKSPACE, 'sessions', scope);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-10-02T10-00-00_${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id, timestamp: '2026-10-02T10:00:00.000Z', cwd }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: title } }),
    ].join('\n') + '\n');
    const when = new Date(Date.now() - ageMin * 60_000);
    fs.utimesSync(file, when, when);
  };
  mkSession('alpha', '11111111-1111-1111-1111-111111111111',
    '/home/tester/proj-alpha', 'fix the login bug in auth module', 30);
  mkSession('alpha', '22222222-2222-2222-2222-222222222222',
    '/home/tester/proj-alpha', 'refactor the tmux helpers', 24 * 60);
  mkSession('srv', '33333333-3333-3333-3333-333333333333',
    '/srv/app', 'deploy checklist review', 7 * 24 * 60);
  // Same cwd as alpha and aged between it and srv, so the sidebar still
  // shows exactly two cwd groups.
  mkSession('alpha', UUIDV7_SIBLINGS[0], '/home/tester/proj-alpha', 'uuidv7 sibling one', 2 * 24 * 60);
  mkSession('alpha', UUIDV7_SIBLINGS[1], '/home/tester/proj-alpha', 'uuidv7 sibling two', 3 * 24 * 60);

  // Kill any leftover test tmux server from a previous aborted run.
  try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); }
  catch { /* no server running — fine */ }

  // The server serves dist/ + dist-server/ — build if they're missing.
  if (!fs.existsSync('dist/server/entry.mjs') || !fs.existsSync('dist-server/server/main.js')) {
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  }
}
