// auth.ts — single-user login: username + password,
// salted scrypt hash in the state db (src/lib/db.ts), in-memory session
// tokens. Expiry is two clocks: a sliding idle window renewed on every
// authed request, plus an absolute cap from login — so a token dies after
// 7 days unused OR 30 days after it was issued, whichever comes first,
// even under constant use. No account machinery. Fails closed until a
// credential row exists (set it with `npm run set-password`).
import * as crypto from 'node:crypto';
import type { StateDb } from './db';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;        // sliding: idle expiry
const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;  // hard cap from login

interface Cred { username: string; salt: string; hash: string }

/** Session lifetimes, injectable for the unit tests (tests/unit).
 *  Production always uses the constants above — no env knobs. */
export interface SessionTtls {
  /** sliding window: renewed on every authed request */
  idleMs?: number;
  /** absolute cap from login — bounds a stolen token under constant use */
  absoluteMs?: number;
}

interface SessionRec {
  /** sliding expiry (ms epoch) */
  exp: number;
  /** login time — the absolute clock's origin */
  created: number;
  /** when a Set-Cookie last (re)armed the browser's Max-Age */
  cookieAt: number;
}

export class Auth {
  private sessions = new Map<string, SessionRec>(); // token -> clocks
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(private state: StateDb, ttls: SessionTtls = {}) {
    this.idleMs = ttls.idleMs ?? SESSION_TTL_MS;
    this.absoluteMs = ttls.absoluteMs ?? SESSION_ABSOLUTE_MS;
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

  newSession(): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.sessions.set(token, { exp: now + this.idleMs, created: now, cookieAt: now });
    for (const [t, s] of this.sessions) if (this.dead(s, now)) this.sessions.delete(t);
    return token;
  }

  /** Expired on either clock — idle, or past the absolute cap from login. */
  private dead(s: SessionRec, now: number): boolean {
    return s.exp < now || s.created + this.absoluteMs <= now;
  }

  /** Validate a token; sliding renewal on use, bounded by the absolute cap. */
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    const now = Date.now();
    if (this.dead(s, now)) { this.sessions.delete(token); return false; }
    s.exp = now + this.idleMs;
    return true;
  }

  drop(token: string | undefined): void { if (token) this.sessions.delete(token); }

  /** 'Log out everywhere': every token dies (their sockets are closed by
   *  the server route, which owns the connection tracking). */
  dropAll(): void { this.sessions.clear(); }

  /** Set-Cookie re-arming the browser cookie's Max-Age, or null when not
   *  due. The server renews a token on every request but the browser's
   *  cookie is otherwise fixed at login, so the two clocks drift apart:
   *  actively used, the browser would forget the cookie after `idleMs`
   *  while the token lives on. Refreshing on every authed response would
   *  put a Set-Cookie on nearly everything; instead the /api/state poll
   *  (every open tab, 15 s) calls this and we only re-arm once half the
   *  idle window passed since the last Set-Cookie — at most one extra
   *  header per few days per token, and the cookie can never lag the
   *  server's sliding window by more than that half. */
  cookieRefresh(token: string | undefined, path = '/'): string | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const now = Date.now();
    if (this.dead(s, now)) return null;
    if (now - s.cookieAt < this.idleMs / 2) return null;
    s.cookieAt = now;
    return this.cookieHeader(token, path);
  }

  cookieHeader(token: string, path = '/'): string {
    return `webpi_session=${token}; HttpOnly; Secure; SameSite=Strict; ` +
      `Path=${path}; Max-Age=${Math.floor(this.idleMs / 1000)}`;
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

/** Credential writer used by set-password (and the e2e fixtures). */
export function setCredential(state: StateDb, username: string, password: string): void {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  state.stmt(`INSERT INTO credential (id, username, salt, hash, updated_at)
              VALUES (1, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET
                username = excluded.username, salt = excluded.salt,
                hash = excluded.hash, updated_at = excluded.updated_at`)
    .run(username, salt.toString('hex'), hash.toString('hex'), Date.now());
}
