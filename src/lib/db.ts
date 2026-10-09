// db.ts — web-pi's persisted state: one SQLite file (node:sqlite).
//
// Everything the app itself writes lives in ENV.WEB_PI_DB_FILE (default
// <state dir>/webpi.db): the login credential (single row) and a `sessions`
// overlay table today; scheduled-job bookkeeping lands on it with the
// in-process scheduler (TODO.md). pi's own store (sessions/, provider
// creds under WEB_PI_AGENT_DIR) and the systemd job units are not web-pi
// state and stay untouched.
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

/** pi session ids (uuid); also caps junk written into the state db. */
export const SESSION_ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

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
      const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (v.user_version === 0) db.exec('PRAGMA user_version = 1');
      else if (v.user_version > 1) {
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
}
