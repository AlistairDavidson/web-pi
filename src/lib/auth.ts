// auth.ts — single-user login: username + password,
// salted scrypt hash in the state db (src/lib/db.ts), session tokens
// persisted there too — as sha256 hashes only (auth_sessions), so a
// restart doesn't sign everyone out and a copied db holds no usable
// token. Expiry is two clocks: a sliding idle window renewed on every
// authed request, plus an absolute cap from login — so a token dies after
// 7 days unused OR 30 days after it was issued, whichever comes first,
// even under constant use. No account machinery. Fails closed until a
// credential row exists (set it with `npm run set-password`), and fails
// closed on any db read error. Changing the password (setCredential)
// revokes every session.
import * as crypto from 'node:crypto';
import { databaseUpdate, type StateDb } from './db';
import type { ResultFailure, ResultSuccess } from '../types/result';
import { asSessionToken, type SessionToken } from '../types/branded';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;        // sliding: idle expiry
const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;  // hard cap from login
/** valid() writes a renewed expiry only when it moves at least this far,
 *  so the 15 s polls and every asset GET don't each cost a db write. The
 *  idle window is therefore precise to within this (60 s of 7 days). */
const RENEW_WRITE_MS = 60 * 1000;

interface Cred { username: string; salt: string; hash: string }

/** Session lifetimes, injectable for the unit tests (tests/unit).
 *  Production always uses the constants above — no env knobs. */
export interface SessionTtls {
  /** sliding window: renewed on every authed request */
  idleMs?: number;
  /** absolute cap from login — bounds a stolen token under constant use */
  absoluteMs?: number;
  /** renewal-write throttle (RENEW_WRITE_MS); tests pass 0 for exact slides */
  renewWriteMs?: number;
}

/** One auth_sessions row (src/lib/db.ts). */
interface SessionRow {
  /** login time (ms epoch) — the absolute clock's origin */
  created_at: number;
  /** sliding expiry (ms epoch) */
  expires_at: number;
  /** when a Set-Cookie last (re)armed the browser's Max-Age */
  cookie_at: number;
}

export type NewSessionErrorCode = 'database_error';
export type NewSessionSuccess = ResultSuccess<'new_session', { token: SessionToken }>;
export type NewSessionFailure = ResultFailure<'new_session', { token: SessionToken }, NewSessionErrorCode>;

/** What the db stores for a token: the raw token never touches disk. */
function tokenHash(token: SessionToken): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class Auth {
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly renewWriteMs: number;

  constructor(private state: StateDb, ttls: SessionTtls = {}) {
    this.idleMs = ttls.idleMs ?? SESSION_TTL_MS;
    this.absoluteMs = ttls.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.renewWriteMs = ttls.renewWriteMs ?? RENEW_WRITE_MS;
  }

  configured(): boolean { return this.readCred() !== null; }

  /** Current credential row, or null when unset/unreadable. Read per
   *  attempt, exactly like the old cred file: a credential written after
   *  boot (set-password, test fixtures) is picked up with no restart. */
  private readCred(): Cred | null {
    try {
      const row = this.state.stmt('SELECT username, salt, hash FROM credential WHERE id = 1')
        .get() as Partial<Cred> | undefined;
      if (!row || typeof row.username !== 'string' || typeof row.salt !== 'string'
        || typeof row.hash !== 'string') return null;
      return { username: row.username, salt: row.salt, hash: row.hash };
    } catch {
      return null; // missing/unreadable db — fail closed, like a missing file
    }
  }

  /** Async scrypt: the hash runs on the libuv threadpool, so login attempts
   *  never stall the event loop (and every attached terminal with it). The
   *  hash runs even when the username is wrong — skipping it would make a
   *  wrong username measurably faster than a wrong password. */
  async verify(username: string, password: string): Promise<boolean> {
    const cred = this.readCred();
    if (!cred) return false;
    const uBuf = Buffer.from(username, 'utf8');
    const uExpect = Buffer.from(cred.username, 'utf8');
    const uOk = uBuf.length === uExpect.length && crypto.timingSafeEqual(uBuf, uExpect);
    const expect = Buffer.from(cred.hash, 'hex');
    const got = await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt(password, Buffer.from(cred.salt, 'hex'), SCRYPT.keylen, SCRYPT,
        (err, key) => (err ? reject(err) : resolve(key))));
    const pOk = expect.length === got.length && crypto.timingSafeEqual(expect, got);
    return uOk && pOk;
  }

  /** Mint a token for a fresh login and persist its hash; purges rows
   *  dead on either clock while at it (the table stays bounded). */
  newSession() {
    const token = asSessionToken(crypto.randomBytes(32).toString('hex'));
    const now = Date.now();
    const saved = databaseUpdate('could not start a session', () => {
      this.state.stmt('DELETE FROM auth_sessions WHERE expires_at < ? OR created_at + ? <= ?')
        .run(now, this.absoluteMs, now);
      return this.state.stmt(`INSERT INTO auth_sessions (token_hash, created_at, expires_at, cookie_at)
                              VALUES (?, ?, ?, ?)`)
        .run(tokenHash(token), now, now + this.idleMs, now);
    });
    if (!saved.ok) {
      return {
        ok: false, resultType: 'new_session', errorCode: saved.errorCode, errorMessage: saved.errorMessage,
      } satisfies NewSessionFailure;
    }
    return { ok: true, resultType: 'new_session', data: { token } } satisfies NewSessionSuccess;
  }

  /** The token's row; null when unknown — or when the db can't be read
   *  (fail closed: an unreadable session store authenticates nobody). */
  private row(token: SessionToken): SessionRow | null {
    try {
      const r = this.state.stmt('SELECT created_at, expires_at, cookie_at FROM auth_sessions WHERE token_hash = ?')
        .get(tokenHash(token)) as SessionRow | undefined;
      return r ?? null;
    } catch {
      return null;
    }
  }

  /** Expired on either clock — idle, or past the absolute cap from login. */
  private dead(s: SessionRow, now: number): boolean {
    return s.expires_at < now || s.created_at + this.absoluteMs <= now;
  }

  /** Validate a token; sliding renewal on use, bounded by the absolute cap. */
  valid(token: SessionToken | undefined): boolean {
    if (!token) return false;
    const s = this.row(token);
    if (!s) return false;
    const now = Date.now();
    if (this.dead(s, now)) { this.drop(token); return false; }
    const exp = now + this.idleMs;
    if (exp - s.expires_at >= this.renewWriteMs) {
      // A failed renewal write only means the token keeps its previous
      // expiry (it was valid a moment ago); the next request retries.
      databaseUpdate('could not renew the session', () =>
        this.state.stmt('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').run(exp, tokenHash(token)));
    }
    return true;
  }

  /** Sign one token out. A failed delete is reported: the caller must
   *  not claim the session ended. */
  drop(token: SessionToken | undefined) {
    return databaseUpdate('could not end the session', () =>
      token ? this.state.stmt('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token)) : { changes: 0 });
  }

  /** Validity peek WITHOUT renewal — for liveness sweeps on established
   *  WS terminals. WS traffic must never slide a token (only authed HTTP
   *  does, via valid()), so this never extends life; it only reports it.
   *  A terminal whose token died on either clock — idle, the absolute
   *  cap, or a logout — is closed by the server's sweep instead of
   *  riding the WS keepalive forever. Pure peek: a read, never a write
   *  (the next authed HTTP touch or newSession purge does the deleting). */
  alive(token: SessionToken | undefined): boolean {
    if (!token) return false;
    const s = this.row(token);
    return !!s && !this.dead(s, Date.now());
  }

  /** 'Log out everywhere': every token dies (their sockets are closed by
   *  the server route, which owns the connection tracking). */
  dropAll() {
    return databaseUpdate('could not end the sessions', () =>
      this.state.stmt('DELETE FROM auth_sessions').run());
  }

  /** Set-Cookie re-arming the browser cookie's Max-Age, or null when not
   *  due. The server renews a token on every request but the browser's
   *  cookie is otherwise fixed at login, so the two clocks drift apart:
   *  actively used, the browser would forget the cookie after `idleMs`
   *  while the token lives on. Refreshing on every authed response would
   *  put a Set-Cookie on nearly everything; instead the /api/state poll
   *  (every open tab, 15 s) calls this and we only re-arm once half the
   *  idle window passed since the last Set-Cookie — at most one extra
   *  header per few days per token, and the cookie can never lag the
   *  server's sliding window by more than that half.
   *
   *  Precondition: only called from /api/state, which sits behind
   *  auth.valid()'s renewal — the token was just touched. A dead or
   *  unknown token answers null (no header) rather than a stale one. */
  cookieRefresh(token: SessionToken | undefined, path = '/'): string | null {
    if (!token) return null;
    const s = this.row(token);
    if (!s) return null;
    const now = Date.now();
    if (this.dead(s, now)) return null;
    if (now - s.cookie_at < this.idleMs / 2) return null;
    // Re-arm only once the new cookie_at is recorded; a failed write sends
    // no header now and the next poll retries.
    const recorded = databaseUpdate('could not record the cookie refresh', () =>
      this.state.stmt('UPDATE auth_sessions SET cookie_at = ? WHERE token_hash = ?').run(now, tokenHash(token)));
    return recorded.ok ? this.cookieHeader(token, path) : null;
  }

  cookieHeader(token: SessionToken, path = '/'): string {
    return `webpi_session=${token}; HttpOnly; Secure; SameSite=Strict; ` +
      `Path=${path}; Max-Age=${Math.floor(this.idleMs / 1000)}`;
  }

  /** The session token a request carries (its webpi_session cookie), as
   *  the brand the session APIs take — the one place a cookie value
   *  becomes a SessionToken. Whether it is VALID is valid()'s call. */
  static sessionToken(cookieHeader: string | undefined): SessionToken | undefined {
    const raw = Auth.parseCookies(cookieHeader).webpi_session;
    return raw === undefined ? undefined : asSessionToken(raw);
  }

  static parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()!] = part.slice(i + 1).trim();
    }
    return out;
  }
}

/** Tiny per-IP fixed-window limiter. Counters live in memory. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(private max: number, private windowMs: number, private cap = 10000) {}
  allow(ip: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(ip);
    if (!b || now > b.reset) {
      if (b) this.buckets.delete(ip); // re-insert: Map order stays oldest-window-first
      b = { count: 0, reset: now + this.windowMs };
      this.buckets.set(ip, b);
      if (this.buckets.size > this.cap) this.evict(now);
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }
  /** Memory cap: drop expired windows, then the oldest ones. Never a bulk
   *  clear — that would hand every limited IP a fresh budget. */
  private evict(now: number): void {
    for (const [ip, b] of this.buckets) {
      if (this.buckets.size <= this.cap) return;
      if (now > b.reset) this.buckets.delete(ip);
    }
    for (const ip of this.buckets.keys()) {
      if (this.buckets.size <= this.cap) return;
      this.buckets.delete(ip);
    }
  }
}

/** Credential writer used by set-password (and the e2e fixtures). A new
 *  credential revokes every login session in the same transaction —
 *  whoever held the old password is signed out; open terminals close on
 *  the server's next liveness sweep (≤ 30 s). Throws on db failure (the
 *  set-password CLI reports it and exits non-zero). */
export function setCredential(state: StateDb, username: string, password: string): void {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const db = state.db();
  db.exec('BEGIN IMMEDIATE');
  try {
    state.stmt(`INSERT INTO credential (id, username, salt, hash, updated_at)
                VALUES (1, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                  username = excluded.username, salt = excluded.salt,
                  hash = excluded.hash, updated_at = excluded.updated_at`)
      .run(username, salt.toString('hex'), hash.toString('hex'), Date.now());
    state.stmt('DELETE FROM auth_sessions').run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
