// tmux.ts — typed helpers for the app's tmux socket.
// The app owns ONE socket (default "web-pi"): the tmux server starts on
// first new-session and dies with the last session (exit-empty). Closing
// the browser tab detaches; sessions keep running under tmux.
// Pattern note: anything that must be systemd-supervised should get its
// OWN socket + unit — never share this one, or a crashing supervised
// session would leave its unit looking "active".
import { execFile } from 'node:child_process';
import type { LiveSession } from './types';

export const SOCKET = process.env.WEB_PI_TMUX_SOCKET ?? 'web-pi';
export const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

type Cb<T> = (err: Error | null, out: T) => void;

function tmux(socket: string, args: string[], cb: (err: Error | null, stdout: string) => void): void {
  execFile('tmux', ['-L', socket, ...args], { timeout: 5000 }, (err, stdout) => {
    cb(err instanceof Error ? err : null, typeof stdout === 'string' ? stdout : '');
  });
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

/** Start a session running the configured command (default: pi). */
export function newSession(name: string, cwd: string, command: string[],
  cb: (err: Error | null) => void): void {
  if (!NAME_RE.test(name)) { cb(new Error('invalid session name')); return; }
  tmux(SOCKET, ['new-session', '-d', '-s', name, '-c', cwd, '--', ...command], err => cb(err));
}

/** Start (or reuse) a resume session; the caller then attaches. */
export function resumeSession(shortName: string, cwd: string, command: string[],
  sessionId: string, cb: (err: Error | null) => void): void {
  hasSession(shortName, (err, exists) => {
    if (err) { cb(err); return; }
    if (exists) { cb(null); return; }
    tmux(SOCKET,
      ['new-session', '-d', '-s', shortName, '-c', cwd, '--', ...command, '--session', sessionId],
      e2 => cb(e2));
  });
}
