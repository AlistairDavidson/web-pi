// jobs.ts — scheduled jobs ("cron") on systemd USER units, plain CLI.
// A job = name + OnCalendar schedule + arbitrary shell command, stored as a
// pair of unit files under ~/.config/systemd/user/:
//   webpi-<name>.timer   (OnCalendar=…, Persistent=true)
//   webpi-<name>.service (Type=oneshot; ExecStart opens the run in a tmux
//                         session `webpi-<name>` on the app's own socket —
//                         timer-fired and manual runs therefore appear in
//                         the Live list and are attachable, exactly like a
//                         main-page session)
//
// SECURITY INVARIANT: this module only ever sees and touches units named
// webpi-<job>. Every unit name that reaches systemctl is built by
// unitNames() below (which rejects anything but a plain webpi-<job> stem),
// and listing filters directory entries through the same regex. Units the
// app didn't create are invisible and untouchable through this module.
//
// When `systemctl --user` is unusable (container, no user bus) every
// operation degrades to { ok:false, status:503 } with an actionable detail
// — the /jobs page shows that as a notice instead of a stack of 500s.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV } from './env';
import type { CalendarCheck, JobsState, ScheduledJob } from './types';
import { baseArgs, hasSession, jobSessionName, liveSessionNames, tmuxPath } from './tmux';

const SYSTEMCTL = ENV.WEB_PI_SYSTEMCTL;
const ANALYZE = ENV.WEB_PI_SYSTEMD_ANALYZE;
const UNIT_DIR = path.join(ENV.WEB_PI_HOME,
  '.config', 'systemd', 'user');

/** Job name charset: tmux-session-name-safe and systemd-unit-name-safe.
 *  Names starting with "webpi-" are rejected so a job can never produce a
 *  doubly-prefixed (confusingly-nested) webpi-webpi-* unit pair. */
export const JOB_NAME_RE = /^(?!webpi-)[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_SCHEDULE = 120;
const MAX_COMMAND = 4000;

export type JobOp =
  | { ok: true; name: string; session?: string }
  | { ok: false; status: number; error: string; detail: string | null };

/** Normalize a user-supplied job name the way /api/new does for sessions. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

/** The ONLY source of unit names passed to systemctl (security invariant).
 *  Returns null for anything that isn't a plain webpi-<job> pair — callers
 *  must treat that as a bad request, never fall back to raw input. */
export function unitNames(name: string): { job: string; timer: string; service: string } | null {
  if (!JOB_NAME_RE.test(name)) return null;
  return { job: name, timer: `webpi-${name}.timer`, service: `webpi-${name}.service` };
}

function run(bin: string, args: string[], timeoutMs = 15_000):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          code: e?.code === undefined ? 0 : typeof e.code === 'number' ? e.code : -1,
          stdout: String(stdout ?? ''),
          stderr: e?.message ? `${e.message}\n${String(stderr ?? '')}` : String(stderr ?? ''),
        });
      });
  });
}

function firstLine(s: string): string {
  return s.split('\n', 1)[0] ?? '';
}

/** One actionable line out of an exec failure (ENOENT → "not installed",
 *  otherwise systemd's own stderr — the "Command failed: …" noise is
 *  dropped so the UI can show something meaningful). */
function humanize(stderr: string): string {
  if (/spawn\s\S+\s+ENOENT/i.test(stderr)) return 'not installed';
  for (const line of stderr.split('\n')) {
    const t = line.replace(/^Command failed:.*$/, '').trim();
    if (t) return t;
  }
  return 'command failed';
}

// ---------- availability (cached probe) ----------

let availCache: { available: boolean; detail: string | null; at: number } | null = null;
const AVAIL_TTL_MS = 15_000;

/** Is a systemd user manager reachable from this process? */
export async function availability(force = false): Promise<{ available: boolean; detail: string | null }> {
  if (!force && availCache && Date.now() - availCache.at < AVAIL_TTL_MS) return availCache;
  const r = await run(SYSTEMCTL, ['--user', 'show-environment'], 8000);
  const out = {
    available: r.code === 0,
    detail: r.code === 0 ? null : humanize(r.stderr),
    at: Date.now(),
  };
  availCache = out;
  return out;
}

async function unavailable(): Promise<JobOp> {
  const a = await availability();
  return { ok: false, status: 503, error: 'scheduled jobs are unavailable', detail: a.detail };
}

// ---------- OnCalendar validation ----------

const BASIC_SPEC_RE = /^[\w*,.:~\-!?/ ]+$/;

/** Validate an OnCalendar spec with `systemd-analyze calendar`. When the
 *  binary is absent (weird box, container) fall back to a sanity check and
 *  say so via validatedBy — systemd itself would still reject the unit at
 *  reload time, so creating stays honest. */
export async function checkCalendar(spec: string): Promise<CalendarCheck> {
  const s = spec.trim();
  if (!s) return { valid: false, next: null, error: 'schedule is required', validatedBy: 'basic' };
  if (s.length > MAX_SCHEDULE || /[\r\n]/.test(s)) {
    return { valid: false, next: null, error: 'invalid schedule (too long or multi-line)', validatedBy: 'basic' };
  }
  const r = await run(ANALYZE, ['calendar', s], 8000);
  if (r.code !== 0 && /ENOENT|not found/i.test(r.stderr)) {
    return {
      valid: BASIC_SPEC_RE.test(s),
      next: null,
      error: BASIC_SPEC_RE.test(s)
        ? null
        : 'invalid characters in schedule',
      validatedBy: 'basic',
    };
  }
  if (r.code !== 0) {
    return {
      valid: false, next: null,
      error: humanize(r.stderr) || 'systemd rejected this schedule',
      validatedBy: 'systemd-analyze',
    };
  }
  const m = r.stdout.match(/(?:Next elapse|Next elapse \(in UTC\)):\s*(.+)/);
  return { valid: true, next: m ? m[1]!.trim() : null, error: null, validatedBy: 'systemd-analyze' };
}

// ---------- unit files ----------

function q(arg: string): string {
  return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** ExecStart argument quoting on top of systemd's: inside double quotes
 *  backslash-escape \ and ", and neutralize systemd's own expansions. */
export function escapeCommand(cmd: string): string {
  return cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\$/g, '$$').replace(/%/g, '%%');
}

export function unescapeCommand(s: string): string {
  return s.replace(/\\(["\\])/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%');
}

export interface JobFiles { service: string; timer: string }

export function renderUnitFiles(job: string, schedule: string, command: string,
  ctx: { tmuxBin: string; base: string[]; cwd: string; env: Record<string, string> }): JobFiles {
  const session = jobSessionName(job);
  const envArgs = Object.entries(ctx.env).map(([k, v]) => ` -e ${q(`${k}=${v}`)}`).join('');
  const service = [
    `# web-pi scheduled job "${job}" — managed by web-pi (/jobs page).`,
    `# Run semantics: each run opens tmux session ${session} on the web-pi`,
    `# socket; while the previous run's session is alive the fire is a no-op.`,
    `[Unit]`,
    `Description=web-pi job: ${job}`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `ExecStart=-${ctx.tmuxBin} ${ctx.base.map(q).join(' ')} new-session -d -s ${q(session)}` +
      ` -c ${q(ctx.cwd)}${envArgs} -- /bin/sh -c "${escapeCommand(command)}"`,
    ``,
  ].join('\n');
  const timer = [
    `# web-pi schedule for job "${job}" — managed by web-pi (/jobs page).`,
    `[Unit]`,
    `Description=web-pi job schedule: ${job}`,
    ``,
    `[Timer]`,
    `OnCalendar=${schedule.trim()}`,
    `Persistent=true`,
    `Unit=webpi-${job}.service`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join('\n');
  return { service, timer };
}

/** Parse our own unit files back (name/schedule/command for the table).
 *  Tolerates hand edits: unknown shapes yield empty strings, never throw. */
export function parseUnitFiles(service: string, timer: string): { schedule: string; command: string } {
  const t = timer.match(/^OnCalendar=(.+)$/m);
  const schedule = t ? t[1]!.trim() : '';
  let command = '';
  const exec = [...service.matchAll(/^ExecStart=(.*)$/mg)].map(m => m[1]!.trim());
  const last = exec[exec.length - 1];
  if (last) {
    const m = last.match(/--\s+\/bin\/sh\s+-c\s+"(.*)"\s*$/);
    if (m) command = unescapeCommand(m[1]!);
    else {
      const tail = last.match(/--\s+(.+)$/);
      command = tail ? tail[1]!.replace(/^"|"$/g, '') : '';
    }
  }
  return { schedule, command };
}

function unitFile(name: string): string { return path.join(UNIT_DIR, name); }

/** Job names present as timer files — the source of truth for listing.
 *  ONLY entries matching the webpi-<job> pattern (regex-validated) are
 *  ever considered; other units in the directory are ignored. */
export function jobNamesOnDisk(): string[] {
  let entries: string[];
  try { entries = fs.readdirSync(UNIT_DIR); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const m = e.match(/^webpi-(.+)\.timer$/);
    if (m && JOB_NAME_RE.test(m[1]!)) out.push(m[1]!);
  }
  return out.sort();
}

/** `systemctl --user show` for the given units, parsed into a per-unit map.
 *  Each stanza is a unit-name header line followed by Key=Value lines;
 *  unknown/never-loaded units simply yield {} — defaults cover them. */
async function showProps(units: string[]): Promise<Map<string, Map<string, string>>> {
  const map = new Map<string, Map<string, string>>();
  if (units.length === 0) return map;
  const r = await run(SYSTEMCTL,
    ['--user', 'show', '--property', 'Id,ActiveState,NextElapseUSecRealtime,LastTriggerUSec,Result,ExecMainStatus', ...units]);
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    let id = lines[0]!.trim();
    const props = new Map<string, string>();
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i > 0) {
        const k = line.slice(0, i).trim();
        props.set(k, line.slice(i + 1).trim());
        if (k === 'Id') id = line.slice(i + 1).trim();
      }
    }
    map.set(id, props);
  }
  return map;
}

function tsOrNull(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s === 'n/a' || s === '0') return null;
  return s;
}

/** List jobs: unit files on disk + systemctl show for elapse/state +
 *  tmux presence for "a run is live". Never throws; degraded mode returns
 *  available:false and the page renders a notice. */
export async function listJobs(): Promise<JobsState> {
  const avail = await availability();
  if (!avail.available) return { available: false, detail: avail.detail, jobs: [] };

  const names = jobNamesOnDisk();
  const files = new Map<string, { service: string; timer: string }>();
  for (const n of names) {
    try {
      files.set(n, {
        service: fs.readFileSync(unitFile(`webpi-${n}.service`), 'utf8'),
        timer: fs.readFileSync(unitFile(`webpi-${n}.timer`), 'utf8'),
      });
    } catch { files.set(n, { service: '', timer: '' }); }
  }
  const units = names.flatMap(n => [`webpi-${n}.timer`, `webpi-${n}.service`]);
  const [props, live] = await Promise.all([
    showProps(units),
    new Promise<Set<string>>(resolve => liveSessionNames((_e, s) => resolve(s))),
  ]);

  const jobs: ScheduledJob[] = names.map(n => {
    const f = files.get(n)!;
    const parsed = parseUnitFiles(f.service, f.timer);
    const t = props.get(`webpi-${n}.timer`);
    const s = props.get(`webpi-${n}.service`);
    const last = tsOrNull(t?.get('LastTriggerUSec'));
    const result = s?.get('Result') ?? '';
    return {
      name: n,
      schedule: parsed.schedule,
      command: parsed.command,
      active: t?.get('ActiveState') === 'active',
      running: live.has(jobSessionName(n)),
      session: jobSessionName(n),
      next: tsOrNull(t?.get('NextElapseUSecRealtime')),
      last,
      lastResult: last === null ? 'unknown' : result === 'success' ? 'success' : 'failed',
    };
  });
  return { available: true, detail: null, jobs };
}

// ---------- mutations ----------

export interface SaveInput { name: string; schedule: string; command: string }

/** Create or update a job: validate, write both unit files, daemon-reload,
 *  enable + (re)start the timer so a new schedule takes effect at once. */
export async function saveJob(input: SaveInput,
  ctx: { cwd: string; env: Record<string, string> }): Promise<JobOp> {
  const avail = await availability();
  if (!avail.available) return unavailable();

  const name = normalizeName(input.name ?? '');
  const units = unitNames(name);
  if (!units) return { ok: false, status: 400, error: 'invalid job name', detail: null };
  const schedule = (input.schedule ?? '').trim();
  const command = (input.command ?? '').trim();
  if (!command) return { ok: false, status: 400, error: 'command is required', detail: null };
  if (command.length > MAX_COMMAND || /[\r\n]/.test(command)) {
    return { ok: false, status: 400, error: 'invalid command (too long or multi-line)', detail: null };
  }
  const check = await checkCalendar(schedule);
  if (!check.valid) {
    return { ok: false, status: 400, error: check.error ?? 'invalid schedule', detail: null };
  }

  const tmuxBin = await tmuxPath();
  const files = renderUnitFiles(name, schedule, command,
    { tmuxBin, base: baseArgs(), cwd: ctx.cwd, env: ctx.env });
  try {
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(unitFile(units.service), files.service, { mode: 0o644 });
    fs.writeFileSync(unitFile(units.timer), files.timer, { mode: 0o644 });
  } catch (e) {
    return { ok: false, status: 500, error: `could not write unit files: ${(e as Error).message}`, detail: null };
  }

  // reload first so the manager sees the new definition, then enable
  // (timers.target symlink) and restart — restart works both for a fresh
  // timer and for one already running with the old schedule.
  for (const args of [
    ['daemon-reload'],
    ['enable', units.timer],
    ['restart', units.timer],
  ] as string[][]) {
    const r = await run(SYSTEMCTL, ['--user', ...args]);
    if (r.code !== 0) {
      return {
        ok: false, status: 500,
        error: `systemctl --user ${args.join(' ')} failed`,
        detail: humanize(r.stderr),
      };
    }
  }
  return { ok: true, name };
}

/** Delete a job: stop timer + service, disable, drop both unit files,
 *  reset any failed state, daemon-reload. A live run's tmux session is
 *  deliberately left alone (kill it from Live if you want). */
export async function deleteJob(name: string): Promise<JobOp> {
  const avail = await availability();
  if (!avail.available) return unavailable();

  const units = unitNames(String(name ?? ''));
  if (!units) return { ok: false, status: 400, error: 'invalid job name', detail: null };
  if (!jobNamesOnDisk().includes(units.job)) {
    return { ok: false, status: 404, error: 'no such job', detail: null };
  }

  // Order matters: stop the timer before the service so nothing re-fires.
  for (const args of [
    ['disable', '--now', units.timer],
    ['stop', units.service],
    ['reset-failed', units.service],
  ] as string[][]) {
    await run(SYSTEMCTL, ['--user', ...args]); // best-effort: unit may be absent
  }
  for (const f of [units.timer, units.service]) {
    try { fs.unlinkSync(unitFile(f)); } catch { /* already gone */ }
  }
  const reload = await run(SYSTEMCTL, ['--user', 'daemon-reload']);
  if (reload.code !== 0) {
    return { ok: false, status: 500, error: 'systemctl --user daemon-reload failed', detail: humanize(reload.stderr) };
  }
  return { ok: true, name: units.job };
}

/** Run a job now: start its service once (oneshot → returns immediately;
 *  the ExecStart opens tmux session webpi-<name>). Skipped with 409 while
 *  the previous run's session is still alive — same semantics a timer
 *  fire has. */
export async function runJob(name: string): Promise<JobOp> {
  const avail = await availability();
  if (!avail.available) return unavailable();

  const units = unitNames(String(name ?? ''));
  if (!units) return { ok: false, status: 400, error: 'invalid job name', detail: null };
  if (!jobNamesOnDisk().includes(units.job)) {
    return { ok: false, status: 404, error: 'no such job', detail: null };
  }

  const busy = await new Promise<boolean>(resolve =>
    hasSession(jobSessionName(units.job), (_e, exists) => resolve(exists)));
  if (busy) {
    return {
      ok: false, status: 409,
      error: 'previous run is still active — attach to it from Live, or kill it first',
      detail: jobSessionName(units.job),
    };
  }

  const r = await run(SYSTEMCTL, ['--user', 'start', units.service]);
  if (r.code !== 0) {
    return {
      ok: false, status: 500, error: 'systemctl --user start failed',
      detail: humanize(r.stderr),
    };
  }
  return { ok: true, name: units.job, session: jobSessionName(units.job) };
}
