// settings.ts — backs the /settings dashboard: effective-config version
// facts and the manual pi updater behind POST /api/update-pi.
// `npm install @earendil-works/pi-coding-agent@latest` runs in the app's
// install dir. No restart needed: the session command is the vendored
// node_modules/.bin/pi, exec'd fresh per session, so new sessions get the
// new version (running ones keep theirs). Only when the server booted
// without a vendored pi (WEB_PI_COMMAND fell back to `pi` on PATH) does a
// restart switch sessions over to it.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UpdateResult } from './types';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000; // npm can be slow; one try, no retry
const OUTPUT_CAP = 64 * 1024;             // keep the tail for the UI

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

/** web-pi's own package.json version (app identity on the dashboard). */
export function appVersion(appRoot: string): string {
  const pkg = readJson(path.join(appRoot, 'package.json'));
  const v = pkg?.version;
  return typeof v === 'string' ? v : 'unknown';
}

/** pi's declared range in package.json dependencies (what the app pins). */
export function piDeclared(appRoot: string): string {
  const pkg = readJson(path.join(appRoot, 'package.json'));
  const deps = pkg?.dependencies;
  const range = deps && typeof deps === 'object'
    ? (deps as Record<string, unknown>)[PI_PACKAGE] : undefined;
  return typeof range === 'string' ? range : 'unknown';
}

/** pi's installed version (node_modules manifest), null if not installed. */
export function piInstalled(appRoot: string): string | null {
  const pkg = readJson(path.join(appRoot, 'node_modules', PI_PACKAGE, 'package.json'));
  const v = pkg?.version;
  return typeof v === 'string' ? v : null;
}

/** First executable `npm` on the server's PATH, null if there is none —
 *  the update button is unavailable (and says so) in that case. */
export function npmPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'npm');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

// One update at a time — npm holds locks on node_modules; a second
// concurrent run would race it. Guarded server-side, surfaced as 409.
let updateBusy = false;

export const BUSY_ERROR = 'an update is already running';

/** Run (or dry-run) the manual pi update. Never throws; reports via cb. */
export function runPiUpdate(appRoot: string, dryRun: boolean,
  cb: (r: UpdateResult) => void): void {
  const args = ['install', `${PI_PACKAGE}@latest`];
  const command = `npm ${args.join(' ')}`;
  const before = piInstalled(appRoot);
  const reply = (ok: boolean, extra: Partial<UpdateResult>): void =>
    cb({ ok, dryRun, command, before, after: before, output: '', ...extra });

  if (dryRun) {
    // Check-only: prove npm executes, touch nothing. Never blocked by an
    // in-flight real update (it holds no locks).
    const npm = npmPath();
    if (!npm) {
      reply(false, { error: 'npm was not found on the server PATH — cannot update from here' });
      return;
    }
    execFile(npm, ['--version'], { timeout: 15_000 }, (err, stdout) => {
      if (err) { reply(false, { error: `npm check failed: ${(err as Error).message}` }); return; }
      reply(true, { output: `would run \`${command}\` in ${appRoot} (npm ${String(stdout).trim()} is available)` });
    });
    return;
  }

  if (updateBusy) {
    reply(false, { error: BUSY_ERROR });
    return;
  }
  const npm = npmPath();
  if (!npm) {
    reply(false, { error: 'npm was not found on the server PATH — cannot update from here' });
    return;
  }

  updateBusy = true;
  console.log(`pi update: running \`${command}\` in ${appRoot}`);
  execFile(npm, args, { cwd: appRoot, timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      updateBusy = false;
      const after = piInstalled(appRoot);
      const output = (`${stdout}${stderr ? '\n' + stderr : ''}`).trim().slice(-OUTPUT_CAP);
      if (err) {
        const reason = err.killed
          ? `timed out after ${Math.round(UPDATE_TIMEOUT_MS / 60000)} minutes`
          : `npm exited with code ${err.code ?? '?'}`;
        console.warn(`pi update failed: ${reason}`);
        cb({ ok: false, dryRun, command, before, after, output, error: reason });
        return;
      }
      console.log(`pi update: ${before ?? 'not installed'} → ${after ?? 'not installed'} ` +
        `(new sessions use it)`);
      cb({ ok: true, dryRun, command, before, after, output });
    });
}
