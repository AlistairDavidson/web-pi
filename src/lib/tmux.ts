// tmux.ts — typed helpers for the app's tmux socket.
// The app owns ONE socket (default "web-pi"): the tmux server starts on
// first new-session and dies with the last session (exit-empty). Closing
// the browser tab detaches; sessions keep running under tmux.
// Pattern note: a LONG-LIVED externally-supervised session should get
// its OWN socket + supervisor — never share this one, or a crashing
// supervised session would look "alive". Scheduled-job runs are the
// sanctioned exception (src/lib/jobs.ts): the run is the session, it
// dies with the command, and sharing this socket is precisely what makes
// runs appear in the Live list next to interactive sessions.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { ENV, RAW_ENV } from './env';
import type { LiveSession } from './types';

export const SOCKET = ENV.WEB_PI_TMUX_SOCKET;
export const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

// In-project tmux config, applied when the tmux server starts. `-f` is read
// at server start only; carrying it on every call is a no-op afterwards and
// guarantees whichever call boots the server (first new-session) uses it.
// Exported for the /settings dashboard (resolved path, shown only).
export const CONF = ENV.WEB_PI_TMUX_CONF;
if (RAW_ENV.WEB_PI_TMUX_CONF && !fs.existsSync(CONF)) {
  console.warn(`WEB_PI_TMUX_CONF=${CONF} does not exist — using tmux defaults`);
}

/** Session name a resumed pi session runs under: 'r-' + the FULL session id.
 *  pi ids are UUIDv7, so any prefix is just the creation timestamp's high
 *  bits — sessions started within about a minute of each other share their
 *  first 8 hex chars, and a truncated name attached the second one's resume
 *  to the first one's running pi. Ids too long (or not tmux-safe) for
 *  NAME_RE get a hash of the id instead. */
export function resumeSessionName(id: string): string {
  const name = `r-${id}`;
  return NAME_RE.test(name) ? name : `r-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** Session name a scheduled job's run opens on this socket (src/lib/jobs.ts
 *  fires runs under it; the Live list shows it like any session). */
export function jobSessionName(job: string): string {
  return `webpi-${job}`;
}

type Cb<T> = (err: Error | null, out: T) => void;

function tmux(socket: string, args: string[], cb: (err: Error | null, stdout: string) => void,
  env?: Record<string, string>): void {
  const conf = fs.existsSync(CONF) ? ['-f', CONF] : [];
  execFile('tmux', [...conf, '-L', socket, ...args],
    { timeout: 5000, ...(env ? { env: Object.assign({}, process.env, env) } : {}) },
    (err, stdout) => {
      cb(err instanceof Error ? err : null, typeof stdout === 'string' ? stdout : '');
    });
}

/** `-e NAME=value` args for new-session: per-session environment, so the
 *  spawned command's env doesn't depend on when the tmux server (and the
 *  env it inherited at startup) came up. */
function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/** Live sessions on the app socket. [] on error/no server yet. */
export function listSessions(cb: Cb<LiveSession[]>): void {
  tmux(SOCKET, ['list-sessions'], (err, stdout) => {
    if (err) { cb(null, []); return; }
    const out: LiveSession[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^:]+): (\d+) windows \(created ([^)]+)\)(.*)$/);
      if (m) {
        out.push({
          name: m[1] ?? '', windows: parseInt(m[2] ?? '1', 10), created: m[3] ?? '',
          attached: (m[4] ?? '').includes('(attached)'), socket: SOCKET,
        });
      }
    }
    cb(null, out);
  });
}

export function hasSession(name: string, cb: Cb<boolean>): void {
  if (!NAME_RE.test(name)) { cb(null, false); return; }
  tmux(SOCKET, ['has-session', '-t', name], err => cb(null, !err));
}

/** Start a session running the configured command (default: vendored pi). */
export function newSession(name: string, cwd: string, command: string[],
  env: Record<string, string>, cb: (err: Error | null) => void): void {
  if (!NAME_RE.test(name)) { cb(new Error('invalid session name')); return; }
  tmux(SOCKET, ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs(env), '--', ...command],
    err => cb(err), env);
}

/** Start (or reuse) a resume session; the caller then attaches. */
export function resumeSession(shortName: string, cwd: string, command: string[],
  sessionId: string, env: Record<string, string>, cb: (err: Error | null) => void): void {
  hasSession(shortName, (err, exists) => {
    if (err) { cb(err); return; }
    if (exists) { cb(null); return; }
    tmux(SOCKET,
      ['new-session', '-d', '-s', shortName, '-c', cwd, ...envArgs(env), '--', ...command, '--session', sessionId],
      e2 => cb(e2), env);
  });
}

/** Sessions alive on the app socket, as a name set (job state checks). */
export function liveSessionNames(cb: Cb<Set<string>>): void {
  listSessions((err, live) => {
    cb(err, new Set(live.map(s => s.name)));
  });
}
