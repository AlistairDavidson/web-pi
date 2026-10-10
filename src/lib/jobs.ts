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
// touch the db or tmux — every entry point takes a JobName, which
// untrusted input only gets by passing JobNameSchema / JobSaveSchema
// (src/schemas) at the request boundary — and commands are arbitrary shell strings BY
// DESIGN (typed by the authenticated user, at a web shell's privilege) —
// but a command only ever reaches tmux as tmux's own command string,
// passed as argv elements to execFile: never through a server-side
// shell. argv-array spawns only.
import { CronExpressionParser } from 'cron-parser';
import type { StateDb } from './db';
import type { CalendarCheck, JobsState, ScheduledJob } from './types';
import { hasSession, jobSessionName, liveSessionNames, newSession } from './tmux';
import type { ResultFailure, ResultSuccess } from '../types/result';
import { asJobName, type JobName, type TmuxSessionName } from '../types/branded';
import { MAX_SCHEDULE, type SaveInput } from '../schemas/jobs';

// ---------- results (HTTP statuses are mapped in the HTTP layer) ----------

export type JobData = { name: JobName };

/** invalid_schedule: the schedule is not valid 5-field cron (the shape —
 *  name, lengths, one line — was already checked by JobSaveSchema). */
export type SaveJobErrorCode = 'invalid_schedule' | 'database_error';
export type SaveJobSuccess = ResultSuccess<'save_job', JobData>;
export type SaveJobFailure = ResultFailure<'save_job', JobData, SaveJobErrorCode>;
export type SaveJobResult = SaveJobSuccess | SaveJobFailure;

export type DeleteJobErrorCode = 'job_not_found' | 'database_error';
export type DeleteJobSuccess = ResultSuccess<'delete_job', JobData>;
export type DeleteJobFailure = ResultFailure<'delete_job', JobData, DeleteJobErrorCode>;
export type DeleteJobResult = DeleteJobSuccess | DeleteJobFailure;

export type RunJobData = { name: JobName; session: TmuxSessionName };
/** run_active: the previous run's session is still alive (409).
 *  tmux_error: the run session could not be opened. */
export type RunJobErrorCode = 'job_not_found' | 'run_active' | 'tmux_error';
export type RunJobSuccess = ResultSuccess<'run_job', RunJobData>;
export type RunJobFailure = ResultFailure<'run_job', RunJobData, RunJobErrorCode>;
export type RunJobResult = RunJobSuccess | RunJobFailure;

export type ListJobsErrorCode = 'database_error';
export type ListJobsSuccess = ResultSuccess<'list_jobs', JobsState>;
export type ListJobsFailure = ResultFailure<'list_jobs', JobsState, ListJobsErrorCode>;
export type ListJobsResult = ListJobsSuccess | ListJobsFailure;

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

interface JobRow { name: JobName; schedule: string; command: string; created_at: number }

/** The in-process scheduler: owns the jobs tables in the state db, fires
 *  due jobs into tmux, and serves the /api/jobs operations. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Jobs whose stored schedule no longer parses (hand-edited db) —
   *  warned about once, then skipped silently until re-saved. */
  private warned = new Set<JobName>();

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

  // Row reads: names come from our own db, validated on write (trusted).
  private rows(): JobRow[] {
    return (this.db.stmt('SELECT name, schedule, command, created_at FROM jobs ORDER BY name')
      .all() as unknown as Array<Omit<JobRow, 'name'> & { name: string }>)
      .map(r => ({ ...r, name: asJobName(r.name) }));
  }

  private row(name: JobName): JobRow | undefined {
    const r = this.db.stmt('SELECT name, schedule, command, created_at FROM jobs WHERE name = ?')
      .get(name) as unknown as (Omit<JobRow, 'name'> & { name: string }) | undefined;
    return r && { ...r, name: asJobName(r.name) };
  }

  private lastFired(name: JobName): number | null {
    const r = this.db.stmt('SELECT MAX(fired_at) AS last FROM job_runs WHERE job = ?')
      .get(name) as { last: number | null };
    return r.last;
  }

  private recordRun(name: JobName, origin: 'schedule' | 'catchup' | 'manual'): void {
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
      const live = await liveSessionNames();
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
    } catch (err) {
      // A tick must never take the server (and, in the container, every
      // tmux session with it) down: the db calls here — rows(),
      // lastFired(), recordRun() — can throw (a lock timeout, a state db
      // the e2e suite deletes mid-run); log and try again next tick.
      // tmux failures come back as results from fire() and never reach this.
      console.error('scheduler tick failed:', (err as Error)?.message ?? err);
    } finally {
      this.ticking = false;
    }
  }

  /** Open the run's tmux session and record the fire. The run is recorded
   *  FIRST: even a failed spawn must count the fire as spent, or the next
   *  tick would retry it forever. */
  private async fire(row: JobRow, origin: 'schedule' | 'catchup' | 'manual') {
    this.recordRun(row.name, origin);
    const session = jobSessionName(row.name);
    const opened = await newSession(session, this.ctx.cwd, ['/bin/sh', '-c', row.command], this.ctx.env);
    if (!opened.ok) console.error(`job ${row.name}: could not open run session ${session} (${opened.errorMessage})`);
    return opened;
  }

  /** List jobs: db definitions + next fire from the schedule + tmux
   *  presence for "a run is live". */
  async listJobs() {
    let rows: JobRow[];
    try {
      rows = this.rows();
    } catch (err) {
      return {
        ok: false, resultType: 'list_jobs', errorCode: 'database_error',
        errorMessage: `could not list jobs: ${(err as Error).message}`,
      } satisfies ListJobsFailure;
    }
    const live = await liveSessionNames();
    const now = Date.now();
    const jobs: ScheduledJob[] = [];
    for (const row of rows) {
      let next: string | null = null;
      let active = true;
      try { next = formatFire(nextFireMs(row.schedule, now)); }
      catch { active = false; } // hand-edited db row; tick warns once
      let last: number | null;
      try {
        last = this.lastFired(row.name);
      } catch (err) {
        return {
          ok: false, resultType: 'list_jobs', errorCode: 'database_error',
          errorMessage: `could not list jobs: ${(err as Error).message}`,
        } satisfies ListJobsFailure;
      }
      jobs.push({
        name: row.name,
        schedule: row.schedule,
        command: row.command,
        active,
        running: live.has(jobSessionName(row.name)),
        session: jobSessionName(row.name),
        next,
        last: last === null ? null : formatFire(last),
        lastResult: 'unknown',
      });
    }
    return { ok: true, resultType: 'list_jobs', data: { available: true, detail: null, jobs } } satisfies ListJobsSuccess;
  }

  /** Create or update a job: cron check, then upsert into the db. The
   *  input was parsed by JobSaveSchema at the boundary (name normalized +
   *  branded, schedule/command trimmed and shape-checked). The next tick
   *  (≤30s) picks the new schedule up; a schedule that is already overdue
   *  fires as a catch-up, like systemd's Persistent=true. */
  async saveJob(input: SaveInput) {
    const { name, schedule, command } = input;
    const fail = (errorCode: SaveJobErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_job', data: { name }, errorCode, errorMessage }) satisfies SaveJobFailure;
    const check = checkCron(schedule);
    if (!check.valid) return fail('invalid_schedule', check.error ?? 'invalid schedule');
    try {
      this.db.stmt(`INSERT INTO jobs (name, schedule, command, created_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (name) DO UPDATE
                    SET schedule = excluded.schedule, command = excluded.command`)
        .run(name, schedule, command, Date.now());
    } catch (err) {
      return fail('database_error', `could not save job: ${(err as Error).message}`);
    }
    this.warned.delete(name);
    return { ok: true, resultType: 'save_job', data: { name } } satisfies SaveJobSuccess;
  }

  /** Delete a job: drop its definition and run bookkeeping. A live run's
   *  tmux session is deliberately left alone (kill it from Live). */
  async deleteJob(name: JobName) {
    let changed = 0;
    try {
      changed = Number(this.db.stmt('DELETE FROM jobs WHERE name = ?').run(name).changes);
      this.db.stmt('DELETE FROM job_runs WHERE job = ?').run(name);
    } catch (err) {
      return {
        ok: false, resultType: 'delete_job', data: { name }, errorCode: 'database_error',
        errorMessage: `could not delete job: ${(err as Error).message}`,
      } satisfies DeleteJobFailure;
    }
    if (changed === 0) {
      return {
        ok: false, resultType: 'delete_job', data: { name }, errorCode: 'job_not_found', errorMessage: 'no such job',
      } satisfies DeleteJobFailure;
    }
    this.warned.delete(name);
    return { ok: true, resultType: 'delete_job', data: { name } } satisfies DeleteJobSuccess;
  }

  /** Run a job now (records origin 'manual'). Refused (run_active) while
   *  the previous run's session is still alive — the same semantics a
   *  scheduler fire has. */
  async runJob(name: JobName) {
    const session = jobSessionName(name);
    const row = this.row(name);
    if (!row) {
      return {
        ok: false, resultType: 'run_job', data: { name, session }, errorCode: 'job_not_found', errorMessage: 'no such job',
      } satisfies RunJobFailure;
    }
    if (await hasSession(session)) {
      return {
        ok: false, resultType: 'run_job', data: { name, session }, errorCode: 'run_active',
        errorMessage: 'previous run is still active — attach to it from Live, or kill it first',
      } satisfies RunJobFailure;
    }
    const opened = await this.fire(row, 'manual');
    if (!opened.ok) {
      return {
        ok: false, resultType: 'run_job', data: { name, session }, errorCode: 'tmux_error',
        errorMessage: opened.errorMessage,
      } satisfies RunJobFailure;
    }
    return { ok: true, resultType: 'run_job', data: { name, session } } satisfies RunJobSuccess;
  }
}
