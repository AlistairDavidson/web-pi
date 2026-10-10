// split.spec.ts — the privilege split's HTTP surface (DESIGN_REVIEW §1.1),
// exercised end to end against the compiled server with an ABSOLUTE-path
// WEB_PI_TMUX_SOCKET: new-session must surface the never-fork guard as a
// clear 503 while the workspace-side server is down (and must not fork
// one), then succeed once a server is up on that socket. Non-page spec
// (sessions-cache / state-dir pattern): spawns its OWN server child on
// its own port — the login below goes to that private process, not the
// suite's shared :3470 webServer, so the serial suite's shared login
// budget is untouched. Single-uid here: the cross-uid ACL (server-access)
// needs two uids and is compose/entrypoint territory —
// docker-workspace-entrypoint.sh carries that half, verified separately.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3481;
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'tester';
const PASSWORD = 'correct-horse-9';
const MARKER = 'SPLIT_MARKER_READY';

/** Child env with the WEB_PI_ / PI_CODING_AGENT_ overrides stripped: the
 *  values under test must not see this machine's (or the suite
 *  webServer's) explicit settings. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('WEB_PI_') && !k.startsWith('PI_CODING_AGENT')) env[k] = v;
  }
  return { ...env, ...extra };
}

test('absolute socket: 503 + no fork while the workspace server is down; sessions work once it is up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-split-'));
  const socket = path.join(dir, 'tmux');
  const cmd = path.join(dir, 'cmd.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\necho '${MARKER}'\nexec /bin/sh\n`);
  fs.chmodSync(cmd, 0o755);

  // Credential for the private server (own db, own login budget).
  const pw = spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT, input: `${USERNAME}\n${PASSWORD}\n${PASSWORD}\n`,
    env: bareEnv({ WEB_PI_PORT: '0', WEB_PI_STATE_DIR: dir }),
  });
  expect(pw.status, pw.stderr?.toString()).toBe(0);

  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      WEB_PI_PORT: String(PORT), WEB_PI_HOST: '127.0.0.1',
      WEB_PI_STATE_DIR: dir,
      WEB_PI_TMUX_SOCKET: socket, // absolute ⇒ split mode: -S + never-fork guard
      WEB_PI_NEW_SESSION_CWD: dir,
      WEB_PI_COMMAND: cmd,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout!.on('data', (d: Buffer) => { boot += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { boot += d.toString(); });

  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    });
    try { spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not boot; output: ${boot}`)), 15_000);
      child.stdout!.on('data', () => { if (boot.includes('web-pi listening')) { clearTimeout(timer); resolve(); } });
      child.on('error', reject);
    });
    // The split-mode boot note is part of the contract under test.
    expect(boot).toContain('privilege split');

    const login = await fetch(`${BASE}/login`, {
      method: 'POST', body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('webpi_session=');

    // Workspace server down: guard refuses — 503, the message, and NO
    // tmux server forked as the web uid (the socket file must not appear).
    const refused = await fetch(`${BASE}/api/new`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'split-test' }),
    });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error)
      .toContain('workspace tmux server not running');
    expect(fs.existsSync(socket)).toBe(false);

    // Same refusal on the WS resume path: a fixture session in the
    // sessions dir, attach {mode:'resume'} while the server is down —
    // resumeSession's create branch must surface the guard's message, not
    // 'could not start resume session', and still not fork.
    // (The terminal WS is the one route a browser can drive; it demands
    // a same-origin Origin header.)
    const sid = '019f4706-0000-7000-8000-00000000abcd';
    // <state>/pi-agent/sessions is the default WEB_PI_SESSIONS_DIR for
    // this child (no override set in its env).
    const sessDir = path.join(dir, 'pi-agent', 'sessions', 'proj');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, `2026-10-02T10-00-00_${sid}.jsonl`), [
      JSON.stringify({ type: 'session', id: sid, timestamp: '2026-10-02T10:00:00.000Z', cwd: dir }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'split fixture' } }),
    ].join('\n') + '\n');
    // The server was booted before the fixture existed; sessions scan is
    // directory-per-request, so no restart is needed.
    const wsErr = await new Promise<string | null>(resolve => {
      // undici's WebSocket: extra handshake headers ride the options'
      // `headers` object (its `origin` option is not the Origin header).
      // (The DOM lib's WebSocket type doesn't know undici's options form.)
      const UndiciWebSocket = WebSocket as unknown as
        new (url: string, init: { headers: Record<string, string> }) => WebSocket;
      const w = new UndiciWebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: BASE, cookie } });
      const done = (v: string | null): void => { try { w.close(); } catch { /* closing */ } resolve(v); };
      w.onopen = () => w.send(JSON.stringify({ type: 'attach', mode: 'resume', id: sid }));
      w.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as { type: string; message?: string };
        if (m.type === 'error') done(m.message ?? null);
      };
      w.onclose = () => done(null);
      w.onerror = () => done(null);
      setTimeout(() => done(null), 5000).unref?.();
    });
    expect(wsErr).toBe('workspace tmux server not running');
    expect(fs.existsSync(socket)).toBe(false);

    // Bring the server up exactly like docker-workspace-entrypoint.sh:
    // umask 0007 + a conf carrying exit-empty off (a separate set-option
    // races the empty server's instant exit) + chmod 0660 (tmux creates
    // the socket 0600 regardless of umask).
    const conf = path.join(dir, 'conf-src');
    fs.writeFileSync(conf, 'set -g exit-empty off\n');
    spawnSync('sh', ['-c',
      `umask 0007; tmux -S ${socket} -f ${conf} start-server && chmod 0660 ${socket}`]);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o660);

    const ok = await fetch(`${BASE}/api/new`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'split-live' }),
    });
    expect(ok.status).toBe(200);

    // The session runs on the shared socket (this is what the sidebar's
    // Live list reads) and its output is capturable — attach-grade access.
    await expect.poll(() => spawnSync('tmux', ['-S', socket, 'has-session', '-t', 'split-live']).status,
      { timeout: 5000 }).toBe(0);
    await expect.poll(() =>
      spawnSync('tmux', ['-S', socket, 'capture-pane', '-p', '-t', 'split-live']).stdout?.toString() ?? '',
      { timeout: 5000 }).toContain(MARKER);

    // /api/state lists it live (web's read-only view of the shared socket).
    const state = await (await fetch(`${BASE}/api/state`, { headers: { cookie } })).json() as
      { live: { name: string }[] };
    expect(state.live.map(s => s.name)).toContain('split-live');
  } finally {
    await stop();
  }
});
