// state-dir.spec.ts — default state layout (DESIGN_REVIEW §3.3): with only
// WEB_PI_HOME (and a port) set, everything web-pi persists lands under
// $WEB_PI_HOME/.local/state/web-pi — set-password writes webpi.db there,
// the server seeds pi-agent/ from the repo pi/ template — while
// WEB_PI_STATE_DIR and the per-path overrides still win. Runs the compiled
// dist-server via child_process (like global-setup), not imports, so it
// covers the built artifact an operator actually runs.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const INPUT = 'tester\ncorrect-horse-9\ncorrect-horse-9\n';

/** Child env with the WEB_PI_ / PI_CODING_AGENT_ overrides stripped: the
 *  defaults under test must not see this machine's (or the suite's
 *  webServer's) explicit values. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('WEB_PI_') && !k.startsWith('PI_CODING_AGENT')) env[k] = v;
  }
  return { ...env, ...extra };
}

/** run set-password with exactly the given WEB_PI_* vars (port 0: never a
 *  real listener; set-password only parses the env, it never binds). */
function setPassword(env: Record<string, string>) {
  return spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT,
    env: bareEnv({ WEB_PI_PORT: '0', ...env }),
    input: INPUT,
  });
}

test('set-password with only WEB_PI_HOME defaults the db into ~/.local/state/web-pi', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-state-home-'));
  const r = setPassword({ WEB_PI_HOME: home });
  expect(r.status, r.stderr?.toString()).toBe(0);
  const db = path.join(home, '.local', 'state', 'web-pi', 'webpi.db');
  expect(fs.existsSync(db)).toBe(true);
  expect(fs.statSync(db).mode & 0o777).toBe(0o600); // it holds the password hash
  const row = new DatabaseSync(db).prepare('SELECT username FROM credential').get() as
    | { username: string }
    | undefined;
  expect(row?.username).toBe('tester');
});

test('server boot seeds pi-agent under the state dir from the repo template', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-state-home-'));
  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    // Port 0: an ephemeral listener is enough — the assertions are on disk
    // layout, and this spec must never collide with the suite's :3470.
    env: bareEnv({
      WEB_PI_HOME: home,
      WEB_PI_PORT: '0',
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_TMUX_SOCKET: 'webpi-state-itest',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    // seedAgentDir() runs synchronously before listen — by the time the
    // boot log prints, the runtime dir exists and is seeded.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not boot; stdout: ${out}`)), 15_000);
      child.stdout!.on('data', () => {
        if (out.includes('web-pi listening')) { clearTimeout(timer); resolve(); }
      });
      child.on('error', reject);
    });
  } finally {
    child.kill('SIGTERM');
  }
  const seeded = path.join(home, '.local', 'state', 'web-pi', 'pi-agent');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  const templateFiles = walk(path.join(ROOT, 'pi'));
  expect(templateFiles.length).toBeGreaterThan(0);
  for (const src of templateFiles) {
    const dst = path.join(seeded, path.relative(path.join(ROOT, 'pi'), src));
    expect(fs.existsSync(dst), dst).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  }
});

test('WEB_PI_STATE_DIR moves the layout; WEB_PI_DB_FILE still outranks it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-state-home-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-state-dir-'));
  const explicit = path.join(home, 'explicit.db');

  const a = setPassword({ WEB_PI_HOME: home, WEB_PI_STATE_DIR: state });
  expect(a.status, a.stderr?.toString()).toBe(0);
  expect(fs.existsSync(path.join(state, 'webpi.db'))).toBe(true);
  expect(fs.existsSync(path.join(home, '.local'))).toBe(false);

  const before = fs.statSync(path.join(state, 'webpi.db')).mtimeMs;
  const b = setPassword({ WEB_PI_HOME: home, WEB_PI_STATE_DIR: state, WEB_PI_DB_FILE: explicit });
  expect(b.status, b.stderr?.toString()).toBe(0);
  expect(fs.existsSync(explicit)).toBe(true);
  expect(fs.statSync(path.join(state, 'webpi.db')).mtimeMs).toBe(before); // untouched
});
