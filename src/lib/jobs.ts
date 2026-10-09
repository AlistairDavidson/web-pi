// jobs.ts — scheduled jobs ("cron") run by an in-process scheduler.
// A job = name + 5-field cron schedule + arbitrary shell command, stored
// in the state db (jobs table, src/lib/db.ts). The Scheduler ticks every
// ~30s and fires due jobs; every run — scheduler-fired or "run now" —
// opens a tmux session `webpi-<name>` on the app's own socket, so runs
// appear in the Live list and are attachable, exactly like a main-page
// session. Replaces the old systemd user-timer backend (DESIGN_REVIEW
// §3.1): jobs now work wherever the app runs, container included, at the
// cost of not firing while the server is down — boot catch-up covers that.
//
// SECURITY INVARIANT: job names are validated (JOB_NAME_RE) before they
// touch the db or tmux, and commands are arbitrary shell strings BY
// DESIGN (typed by the authenticated user, at a web shell's privilege) —
// but a command only ever reaches tmux as tmux's own command string,
// passed as argv elements to execFile: never through a server-side
// shell. argv-array spawns only.
import { CronExpressionParser } from 'cron-parser';
import type { StateDb } from './db';
import type { CalendarCheck, JobsState, ScheduledJob } from './types';
import { hasSession, jobSessionName, liveSessionNames, newSession } from './tmux';

/** Job name charset: tmux-session-name-safe. Names starting with "webpi-"
 *  are rejected so a job can never produce a doubly-prefixed (confusingly
 *  nested) webpi-webpi-* run session. */
export const JOB_NAME_RE = /^(?!webpi-)[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_SCHEDULE = 120;
const MAX_COMMAND = 4000;

export type JobOp =
  | { ok: true; name: string; session?: string }
  | { ok: false; status: number; error: string; detail: string | null };

export interface SaveInput { name: string; schedule: string; command: string }

/** Normalize a user-supplied job name the way /api/new does for sessions. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

// ---------- cron computation (pure — unit-tested with a fake now) ----------
// cron-parser takes 6/7-field expressions and even an empty string; the
// jobs UI is 5-field cron only, so the field count is enforced here first.

/** Epoch ms of the next fire STRICTLY AFTER afterMs. cron-parser's next()
 *  never returns currentDate itself, so a fire at exactly the boundary is
 *  not counted twice. Fields are interpreted in the server's local time.
 *  Throws on an invalid schedule — including a field count other than 5:
 *  cron-parser would happily take 6/7-field (and shorter) expressions,
 *  but the jobs UI is 5-field cron only. */
export function nextFireMs(schedule: string, afterMs: number): number {
  const fields = schedule.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error('schedule must be 5 cron fields: minute hour day-of-month month day-of-week');
  }
  return CronExpressionParser.parse(fields.join(' '), { currentDate: new Date(afterMs) })
    .next().getTime();
}

/** Is a run due at nowMs, given the job's last fire (or its creation,
 *  before the first fire) at referenceMs? Due = the next fire after the
 *  reference has passed. The same check covers live ticking (≤ one tick
 *  of latency) and boot catch-up after downtime: any number of missed
 *  windows collapses into this one boolean, and firing re-records
 *  last-fired, so catch-up is ONE run per job per downtime — systemd's
 *  Persistent=true semantics, minus the pile-up. */
export function isDue(schedule: string, referenceMs: number, nowMs: number): boolean {
  return nextFireMs(schedule, referenceMs) <= nowMs;
}

/** One actionable line out of a cron-parser rejection. */
function cronError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return msg.trim() || 'invalid cron schedule';
}

/** Local-time "YYYY-MM-DD HH:mm" — the schedule fields are local time, so
 *  the display is too. */
function formatFire(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Validate a 5-field cron schedule (the old checkCalendar, now without
 *  systemd-analyze). Same response shape: valid + the first error, or the
 *  next fire time on success. Pure: `nowMs` is injectable for tests. */
export function checkCron(spec: string, nowMs: number = Date.now()): CalendarCheck {
  const by = 'cron-parser' as const;
  const s = spec.trim();
  if (!s) return { valid: false, next: null, error: 'schedule is required', validatedBy: by };
  if (s.length > MAX_SCHEDULE || /[\r\n]/.test(s)) {
    return { valid: false, next: null, error: 'invalid schedule (too long or multi-line)', validatedBy: by };
  }
  try {
    return { valid: true, next: formatFire(nextFireMs(s, nowMs)), error: null, validatedBy: by };
  } catch (err) {
    return { valid: false, next: null, error: cronError(err), validatedBy: by };
  }
}

// ---------- scheduler ----------

const TICK_MS = 30_000;
/** Run bookkeeping kept per job (only the newest last-fired is read). */
const RUN_HISTORY = 20;

/** How late a fire may be before it counts as catch-up (downtime) rather
 *  than ordinary tick latency — purely for the origin column. */
const CATCHUP_LATENESS_MS = 2 * TICK_MS;

export interface JobContext { cwd: string; env: Record<string, string> }

interface JobRow { name: string; schedule: string; command: string; created_at: number }

function liveNames(): Promise<Set<string>> {
  return new Promise(resolve => liveSessionNames((_e, s) => resolve(s)));
}

/** The in-process scheduler: owns the jobs tables in the state db, fires
 *  due jobs into tmux, and serves the /api/jobs operations. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Jobs whose stored schedule no longer parses (hand-edited db) —
   *  warned about once, then skipped silently until re-saved. */
  private warned = new Set<string>();

  constructor(private db: StateDb, private ctx: JobContext) {}

  /** Start the tick loop. No immediate first tick on purpose: the state db
   *  opens lazily (src/lib/db.ts — the e2e webServer boots before
   *  global-setup resets its workspace), and an eager boot tick would
   *  latch a db file the reset then deletes. The first tick (≤ TICK_MS
   *  after boot) doubles as boot catch-up: isDue() treats any window
   *  missed while the server was down as due. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  /** Stop the tick loop. Runs already open in tmux are left alone — they
   *  outlive the scheduler (and, apart from the process, the server). */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private rows(): JobRow[] {
    return this.db.stmt('SELECT name, schedule, command, created_at FROM jobs ORDER BY name')
      .all() as unknown as JobRow[];
  }

  private row(name: string): JobRow | undefined {
    return this.db.stmt('SELECT name, schedule, command, created_at FROM jobs WHERE name = ?')
      .get(name) as unknown as JobRow | undefined;
  }

  private lastFired(name: string): number | null {
    const r = this.db.stmt('SELECT MAX(fired_at) AS last FROM job_runs WHERE job = ?')
      .get(name) as { last: number | null };
    return r.last;
  }

  private recordRun(name: string, origin: 'schedule' | 'catchup' | 'manual'): void {
    this.db.stmt('INSERT INTO job_runs (job, fired_at, origin) VALUES (?, ?, ?)')
      .run(name, Date.now(), origin);
    this.db.stmt(`DELETE FROM job_runs WHERE job = ? AND fired_at NOT IN
                  (SELECT fired_at FROM job_runs WHERE job = ? ORDER BY fired_at DESC LIMIT ?)`)
      .run(name, name, RUN_HISTORY);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // a slow tmux call must not stack ticks
    this.ticking = true;
    try {
      const rows = this.rows();
      const live = await liveNames();
      const now = Date.now();
      for (const row of rows) {
        // Concurrency: a job whose previous run's tmux session is still
        // alive is skipped — long-running agent jobs don't pile up.
        if (live.has(jobSessionName(row.name))) continue;
        const reference = this.lastFired(row.name) ?? row.created_at;
        let dueAt: number;
        try {
          dueAt = nextFireMs(row.schedule, reference);
        } catch {
          if (!this.warned.has(row.name)) {
            this.warned.add(row.name);
            console.warn(`job ${row.name}: stored schedule "${row.schedule}" does not parse — skipped until re-saved`);
          }
          continue;
        }
        if (dueAt <= now) {
          // Boot catch-up equivalent of Persistent=true: whatever windows
          // were missed, this fires ONCE — the recorded fire below resets
          // the reference past all of them.
          await this.fire(row, now - dueAt > CATCHUP_LATENESS_MS ? 'catchup' : 'schedule');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Open the run's tmux session and record the fire. The run is recorded
   *  FIRST: even a failed spawn must count the fire as spent, or the next
   *  tick would retry it forever. */
  private fire(row: JobRow, origin: 'schedule' | 'catchup' | 'manual'): Promise<Error | null> {
    this.recordRun(row.name, origin);
    const session = jobSessionName(row.name);
    return new Promise(resolve => {
      newSession(session, this.ctx.cwd, ['/bin/sh', '-c', row.command], this.ctx.env, err => {
        if (err) console.error(`job ${row.name}: could not open run session ${session} (${err.message})`);
        resolve(err ?? null);
      });
    });
  }

  /** List jobs: db definitions + next fire from the schedule + tmux
   *  presence for "a run is live". Never throws. */
  async listJobs(): Promise<JobsState> {
    const rows = this.rows();
    const live = await liveNames();
    const now = Date.now();
    const jobs: ScheduledJob[] = rows.map(row => {
      let next: string | null = null;
      let active = true;
      try { next = formatFire(nextFireMs(row.schedule, now)); }
      catch { active = false; } // hand-edited db row; tick warns once
      const last = this.lastFired(row.name);
      return {
        name: row.name,
        schedule: row.schedule,
        command: row.command,
        active,
        running: live.has(jobSessionName(row.name)),
        session: jobSessionName(row.name),
        next,
        last: last === null ? null : formatFire(last),
        lastResult: 'unknown',
      };
    });
    return { available: true, detail: null, jobs };
  }

  /** Create or update a job: validate, upsert into the db. The next tick
   *  (≤30s) picks the new schedule up; a schedule that is already
   *  overdue fires as a catch-up, like systemd's Persistent=true. */
  async saveJob(input: SaveInput): Promise<JobOp> {
    const name = normalizeName(input.name ?? '');
    if (!JOB_NAME_RE.test(name)) return { ok: false, status: 400, error: 'invalid job name', detail: null };
    const schedule = (input.schedule ?? '').trim();
    const command = (input.command ?? '').trim();
    if (!command) return { ok: false, status: 400, error: 'command is required', detail: null };
    if (command.length > MAX_COMMAND || /[\r\n]/.test(command)) {
      return { ok: false, status: 400, error: 'invalid command (too long or multi-line)', detail: null };
    }
    const check = checkCron(schedule);
    if (!check.valid) {
      return { ok: false, status: 400, error: check.error ?? 'invalid schedule', detail: null };
    }
    try {
      this.db.stmt(`INSERT INTO jobs (name, schedule, command, created_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (name) DO UPDATE
                    SET schedule = excluded.schedule, command = excluded.command`)
        .run(name, schedule, command, Date.now());
    } catch (err) {
      return { ok: false, status: 500, error: `could not save job: ${(err as Error).message}`, detail: null };
    }
    this.warned.delete(name);
    return { ok: true, name };
  }

  /** Delete a job: drop its definition and run bookkeeping. A live run's
   *  tmux session is deliberately left alone (kill it from Live). */
  async deleteJob(name: string): Promise<JobOp> {
    const n = String(name ?? '');
    if (!JOB_NAME_RE.test(n)) return { ok: false, status: 400, error: 'invalid job name', detail: null };
    let changed = 0;
    try {
      changed = Number(this.db.stmt('DELETE FROM jobs WHERE name = ?').run(n).changes);
      this.db.stmt('DELETE FROM job_runs WHERE job = ?').run(n);
    } catch (err) {
      return { ok: false, status: 500, error: `could not delete job: ${(err as Error).message}`, detail: null };
    }
    if (changed === 0) return { ok: false, status: 404, error: 'no such job', detail: null };
    this.warned.delete(n);
    return { ok: true, name: n };
  }

  /** Run a job now (records origin 'manual'). Skipped with 409 while the
   *  previous run's session is still alive — the same semantics a
   *  scheduler fire has. */
  async runJob(name: string): Promise<JobOp> {
    const n = String(name ?? '');
    if (!JOB_NAME_RE.test(n)) return { ok: false, status: 400, error: 'invalid job name', detail: null };
    const row = this.row(n);
    if (!row) return { ok: false, status: 404, error: 'no such job', detail: null };

    const busy = await new Promise<boolean>(resolve =>
      hasSession(jobSessionName(n), (_e, exists) => resolve(exists)));
    if (busy) {
      return {
        ok: false, status: 409,
        error: 'previous run is still active — attach to it from Live, or kill it first',
        detail: jobSessionName(n),
      };
    }

    const err = await this.fire(row, 'manual');
    if (err) {
      return { ok: false, status: 500, error: 'could not open run session', detail: err.message };
    }
    return { ok: true, name: n, session: jobSessionName(n) };
  }
}
