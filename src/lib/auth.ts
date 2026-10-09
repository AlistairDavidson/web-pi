// auth.ts — single-user login: username + password,
// salted scrypt hash in the state db (src/lib/db.ts), in-memory session
// cookies. No account machinery. Fails closed until a credential row
// exists (set it with `npm run set-password`).
import * as crypto from 'node:crypto';
import type { StateDb } from './db';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

interface Cred { username: string; salt: string; hash: string }

export class Auth {
  private sessions = new Map<string, number>(); // token -> expiry ms

  constructor(private state: StateDb) {}

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
    this.sessions.set(token, now + SESSION_TTL_MS);
    for (const [t, exp] of this.sessions) if (exp < now) this.sessions.delete(t);
    return token;
  }

  /** Validate a token; sliding renewal on use. */
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (exp === undefined) return false;
    if (exp < Date.now()) { this.sessions.delete(token); return false; }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  drop(token: string | undefined): void { if (token) this.sessions.delete(token); }

  cookieHeader(token: string, path = '/'): string {
    return `webpi_session=${token}; HttpOnly; Secure; SameSite=Strict; ` +
      `Path=${path}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
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
