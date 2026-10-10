// db.ts — web-pi's persisted state: one SQLite file (node:sqlite).
//
// Everything the app itself writes lives in ENV.WEB_PI_DB_FILE (default
// <state dir>/webpi.db): the login credential (single row), the login
// sessions (`auth_sessions` — token hashes only, src/lib/auth.ts), a
// `sessions` overlay table, the scheduled-jobs tables (`jobs` definitions,
// `job_runs` bookkeeping — src/lib/jobs.ts), and a small `settings` kv
// (src/lib/auto-update.ts). pi's own store (sessions/,
// provider creds under WEB_PI_AGENT_DIR) is not web-pi state and stays
// untouched.
//
// - node:sqlite's DatabaseSync is synchronous on purpose: every call here
//   is a point query on a tiny table — cheaper than the whole-file JSON
//   reads it replaces, and reads stay fail-closed the way the files were.
// - No WAL: one plain file that behaves on any volume (WAL's -wal/-shm
//   sidecars are the classic network-storage footgun — see TODO.md).
// - The connection opens lazily on first use, like the old JSON files:
//   the e2e webServer boots before global-setup resets its workspace, so
//   an eager open would latch (and orphan) a db the reset then deletes.
//
// NB: node:sqlite still prints a one-line ExperimentalWarning when it
// first loads (server boot, set-password, e2e output). Expected — see
// AGENTS.md.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '../types/result';

/** The shared "generic update" result: a write that only reports how many
 *  rows it touched (setters, deletes, flag flips). */
export type DatabaseUpdateData = { changes: number };
export type DatabaseUpdateErrorCode = 'database_error';
export type DatabaseUpdateSuccess = ResultSuccess<'database_update', DatabaseUpdateData>;
export type DatabaseUpdateFailure = ResultFailure<'database_update', DatabaseUpdateData, DatabaseUpdateErrorCode>;
export type DatabaseUpdateResult = DatabaseUpdateSuccess | DatabaseUpdateFailure;

/** Run one write at the db boundary: a thrown sqlite error (lock
 *  timeout, unwritable file, a db deleted under us) becomes a
 *  database_error failure instead of propagating. `context` prefixes the
 *  message ("could not save hidden state: …"). */
export function databaseUpdate(context: string, write: () => { changes: number | bigint }) {
  try {
    const { changes } = write();
    return { ok: true, resultType: 'database_update', data: { changes: Number(changes) } } satisfies DatabaseUpdateSuccess;
  } catch (err) {
    return {
      ok: false,
      resultType: 'database_update',
      errorCode: 'database_error',
      errorMessage: `${context}: ${(err as Error).message}`,
    } satisfies DatabaseUpdateFailure;
  }
}

/** The shared "generic read" result: a query whose answer the caller
 *  shapes itself (a row, a list, an aggregate). */
export type DatabaseReadData<T> = { value: T };
export type DatabaseReadErrorCode = 'database_error';
export type DatabaseReadSuccess<T> = ResultSuccess<'database_read', DatabaseReadData<T>>;
export type DatabaseReadFailure<T> = ResultFailure<'database_read', DatabaseReadData<T>, DatabaseReadErrorCode>;
export type DatabaseReadResult<T> = DatabaseReadSuccess<T> | DatabaseReadFailure<T>;

/** Run one read at the db boundary — databaseUpdate()'s twin for queries:
 *  a thrown sqlite error becomes a database_error failure. */
export function databaseRead<T>(context: string, read: () => T) {
  try {
    return { ok: true, resultType: 'database_read', data: { value: read() } } satisfies DatabaseReadSuccess<T>;
  } catch (err) {
    return {
      ok: false,
      resultType: 'database_read',
      errorCode: 'database_error',
      errorMessage: `${context}: ${(err as Error).message}`,
    } satisfies DatabaseReadFailure<T>;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS credential (
    id         INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
    username   TEXT    NOT NULL,
    salt       TEXT    NOT NULL,   -- hex
    hash       TEXT    NOT NULL,   -- hex, scrypt
    updated_at INTEGER NOT NULL
  );
  -- Overlay on pi's session store: the fs store stays the truth for a
  -- session's existence; rows appear here only where web-pi has an
  -- opinion to record (hidden today; app_id/display_name/pinned later).
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT    PRIMARY KEY,  -- pi's id
    hidden_at  INTEGER                -- NULL = visible
  );
  -- Scheduled-job definitions for the in-process scheduler
  -- (src/lib/jobs.ts). command is an arbitrary shell string BY DESIGN
  -- (typed by the authenticated user) — it only ever reaches tmux as
  -- tmux's own command string, never a server-side shell.
  CREATE TABLE IF NOT EXISTS jobs (
    name       TEXT    PRIMARY KEY,  -- JOB_NAME_RE (src/schemas/patterns.ts)
    schedule   TEXT    NOT NULL,     -- 5-field cron
    command    TEXT    NOT NULL,
    created_at INTEGER NOT NULL      -- epoch ms; catch-up reference until the first fire
  );
  -- One row per fired run (scheduler tick, boot catch-up, or "run now").
  -- MAX(fired_at) per job is its last-fired: what boot catch-up compares
  -- against the schedule (systemd Persistent=true equivalent).
  CREATE TABLE IF NOT EXISTS job_runs (
    job      TEXT    NOT NULL,
    fired_at INTEGER NOT NULL,       -- epoch ms the run's tmux session opened
    origin   TEXT    NOT NULL        -- 'schedule' | 'catchup' | 'manual'
  );
  CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, fired_at);
  -- Small app-settings kv (one row per key, JSON-encoded values). Keys
  -- are owned by their module (today: pi auto-update, src/lib/auto-update.ts).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Login sessions (src/lib/auth.ts), so a restart doesn't sign everyone
  -- out. Keyed by sha256(token): the raw token never touches disk, so a
  -- copied db (or backup) holds nothing a browser could present.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT    PRIMARY KEY,  -- hex sha256 of the cookie token
    created_at INTEGER NOT NULL,     -- epoch ms of login: the absolute cap's origin
    expires_at INTEGER NOT NULL,     -- sliding idle expiry (renewal writes throttled)
    cookie_at  INTEGER NOT NULL      -- when a Set-Cookie last re-armed the browser's Max-Age
  );
`;

/** web-pi's state database: a lazily-opened node:sqlite connection (see
 *  module comment) plus cached prepared statements. */
export class StateDb {
  private conn: DatabaseSync | null = null;
  private stmts = new Map<string, StatementSync>();

  constructor(readonly file: string) {}

  /** The connection — dir and schema happen on first use. */
  db(): DatabaseSync {
    if (this.conn) return this.conn;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      // set-password (its own process) may write while the server holds
      // the db open — let sqlite wait out the lock instead of failing.
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec(SCHEMA);
      // user_version: 1 = credential + sessions; 2 adds the job tables;
      // 3 adds the settings kv table; 4 adds auth_sessions (additive — the
      // CREATE IF NOT EXISTS block above brings any older db up to v4
      // shape; nothing is dropped).
      const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (v.user_version < 4) db.exec('PRAGMA user_version = 4');
      else if (v.user_version > 4) {
        throw new Error(`state db ${this.file} is schema v${v.user_version} — newer than this build understands`);
      }
      if (fresh) fs.chmodSync(this.file, 0o600); // it holds the password hash
      this.conn = db;
      return db;
    } catch (err) {
      try { db.close(); } catch { /* never got open */ }
      throw err as Error;
    }
  }

  /** Prepared statement, compiled once per connection. Opens the db if needed. */
  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db().prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  /** Read one app-settings value (settings kv table); null when unset. */
  getSetting(key: string): string | null {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Write one app-settings value. Throws on db failure — callers wrap it
   *  in databaseUpdate() so failure reaches the user as a Result (the API
   *  500s instead of lying). */
  setSetting(key: string, value: string): { changes: number | bigint } {
    return this.stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
