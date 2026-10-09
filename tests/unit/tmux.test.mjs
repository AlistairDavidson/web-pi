// tmux.test.mjs — the privilege split's socket plumbing (src/lib/tmux.ts):
// -S-vs-L selection for WEB_PI_TMUX_SOCKET, the never-fork guard's
// decision table, and (where tmux exists — a stated requirement) the
// guarded new/resume behaviour against a real server on an absolute-path
// socket, plus the umask-0007 inheritance the split's group-sharing
// relies on. Run against the compiled output: `npm run test:unit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Absolute-path socket BEFORE the first import: tmux.ts binds SOCKET at
// module load. Everything session-shaped below then runs in split mode.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-tmux-test-'));
process.env.WEB_PI_TMUX_SOCKET = path.join(dir, 'tmux');

const { socketArgs, forksServer, isServerDown, SERVER_NOT_RUNNING_MSG,
        newSession, resumeSession, hasSession, liveSessionNames } =
  await import('../../dist-server/src/lib/tmux.js');

const SOCKET = process.env.WEB_PI_TMUX_SOCKET;

const tmuxUp = () => {
  try { execFileSync('tmux', ['-S', SOCKET, 'show-options', '-g'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const haveTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('socketArgs: absolute path → -S, relative name → -L', () => {
  assert.deepEqual(socketArgs('/run/web-pi/tmux'), ['-S', '/run/web-pi/tmux']);
  assert.deepEqual(socketArgs('web-pi'), ['-L', 'web-pi']);
  assert.deepEqual(socketArgs('web-pi-itest'), ['-L', 'web-pi-itest']);
});

test('forksServer: only relative names keep fork-to-start (the guard gate)', () => {
  assert.equal(forksServer('web-pi'), true);       // single-user: first new-session forks the server
  assert.equal(forksServer('/run/web-pi/tmux'), false); // split: another uid owns the server
  assert.equal(forksServer('/'), false);
});

test('isServerDown: down-server errors, an answering server, unknown failures', () => {
  const err = (stderr) => Object.assign(new Error('tmux failed'), { stderr });
  // No socket file / stale socket from a dead server — both mean DOWN.
  assert.equal(isServerDown(err(`error connecting to ${SOCKET} (No such file or directory)`)), true);
  assert.equal(isServerDown(err(`no server running on ${SOCKET}`)), true);
  // The one error an ALIVE server can answer list-sessions with.
  assert.equal(isServerDown(err('no sessions')), false);
  // The server answered fine.
  assert.equal(isServerDown(null), false);
  // Anything unreadable (timeout kill, permission denied on the socket)
  // reads as down: refusing is always safe, forking never is.
  assert.equal(isServerDown(err('')), true);
  assert.equal(isServerDown(err(`error connecting to ${SOCKET} (Permission denied)`)), true);
  assert.equal(isServerDown(Object.assign(new Error('x'), { stderr: Buffer.from('no server running on /x') })), true);
});

// ---------- functional (real tmux, absolute-path socket, split mode) ----------

/** Bring the server up the way the workspace entrypoint does: -f conf
 *  carrying exit-empty off (a separate `set-option` races the empty
 *  server's instant exit — the option must ride the server-start conf). */
function startServer() {
  const conf = path.join(dir, 'server.conf');
  fs.writeFileSync(conf, 'set -g exit-empty off\n');
  execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
  // tmux hardcodes the socket 0600 at creation (umask ignored); the
  // workspace entrypoint chmod 0660's it — same here, single uid is
  // enough for the mechanics under test.
  fs.chmodSync(SOCKET, 0o660);
}

test('never-fork guard: no server → clear error, and NO server gets forked', { skip: !haveTmux }, async () => {
  assert.equal(tmuxUp(), false);
  assert.equal(fs.existsSync(SOCKET), false);
  const err = await new Promise(resolve =>
    newSession('guardtest', dir, ['/bin/sh', '-c', 'true'], {}, resolve));
  assert.ok(err instanceof Error, 'newSession must fail');
  assert.ok(err.message.startsWith(SERVER_NOT_RUNNING_MSG), err.message);
  assert.equal(fs.existsSync(SOCKET), false, 'must not fork a tmux server as the web uid');
});

test('guarded create works once the workspace side owns a live server', { skip: !haveTmux }, async () => {
  startServer();
  assert.equal(tmuxUp(), true);
  const marker = path.join(dir, 'marker.txt');
  const err = await new Promise(resolve =>
    newSession('live1', dir, ['/bin/sh', '-c', `echo ok > ${JSON.stringify(marker)}; sleep 5`], {}, resolve));
  assert.equal(err, null);
  // The session really runs on the shared socket.
  assert.equal(await new Promise(r => hasSession('live1', (_e, ok) => r(ok))), true);
  const names = await new Promise(r => liveSessionNames((_e, s) => r(s)));
  assert.ok(names.has('live1'));
  // -e env delivery through the guarded path.
  const envfile = path.join(dir, 'env.txt');
  const err2 = await new Promise(resolve =>
    newSession('live2', dir, ['/bin/sh', '-c', `echo $SPLIT_PROBE > ${JSON.stringify(envfile)}; sleep 5`],
      { SPLIT_PROBE: 'delivered' }, resolve));
  assert.equal(err2, null);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.readFileSync(envfile, 'utf8').trim(), 'delivered');
});

test('resume path: reuse when the session exists, guard when the server is down', { skip: !haveTmux }, async () => {
  // Existing resume session → no create, no error.
  const err = await new Promise(resolve =>
    resumeSession('live1', dir, ['/bin/sh'], '019f4706-0000-7000-8000-000000000009', {}, resolve));
  assert.equal(err, null);
  execFileSync('tmux', ['-S', SOCKET, 'kill-server']);
  assert.equal(tmuxUp(), false);
  // Server down → the resume-create branch hits the same guard.
  const err2 = await new Promise(resolve =>
    resumeSession('r-019f4706-0000-7000-8000-000000000010', dir, ['/bin/sh'],
      '019f4706-0000-7000-8000-000000000010', {}, resolve));
  assert.ok(err2 instanceof Error);
  assert.ok(err2.message.startsWith(SERVER_NOT_RUNNING_MSG), err2.message);
});

test('umask 0007 on the tmux server is inherited by what it spawns (group-readable session files)', { skip: !haveTmux }, async () => {
  // The mechanism the split's sharing relies on (sidebar reads pi's
  // session store from the web side): the umask rides the server fork,
  // so it must be in place BEFORE start-server.
  const old = process.umask(0o007);
  startServer();
  try {
    const probe = path.join(dir, 'umask-probe.txt');
    await new Promise(resolve =>
      newSession('umasktest', dir, ['/bin/sh', '-c', `touch ${JSON.stringify(probe)}; sleep 2`], {}, resolve));
    await new Promise(r => setTimeout(r, 500));
    assert.equal(fs.statSync(probe).mode & 0o777, 0o660,
      'pane-spawned files must be group-rw under umask 0007');
  } finally {
    process.umask(old);
    try { execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
