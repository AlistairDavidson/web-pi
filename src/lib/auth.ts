// auth.ts — single-user login: username + password,
// salted scrypt hash in a local file, in-memory session cookies.
// No account machinery. Fails closed until the cred file exists.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

interface Cred { username: string; salt: string; hash: string }

export class Auth {
  private authFile: string;
  private sessions = new Map<string, number>(); // token -> expiry ms

  constructor(authFile: string) { this.authFile = authFile; }

  configured(): boolean {
    try { fs.accessSync(this.authFile, fs.constants.R_OK); return true; }
    catch { return false; }
  }

  private readCred(): Cred | null {
    if (!this.configured()) return null;
    try { return JSON.parse(fs.readFileSync(this.authFile, 'utf8')) as Cred; }
    catch { return null; }
  }

  verify(username: string, password: string): boolean {
    const cred = this.readCred();
    if (!cred) return false;
    const uBuf = Buffer.from(username, 'utf8');
    const uExpect = Buffer.from(cred.username, 'utf8');
    const uOk = uBuf.length === uExpect.length && crypto.timingSafeEqual(uBuf, uExpect);
    if (!uOk) return false;
    const expect = Buffer.from(cred.hash, 'hex');
    const got = crypto.scryptSync(password, Buffer.from(cred.salt, 'hex'),
      SCRYPT.keylen, SCRYPT);
    return expect.length === got.length && crypto.timingSafeEqual(expect, got);
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
  constructor(private max: number, private windowMs: number) {}
  allow(ip: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(ip);
    if (!b || now > b.reset) { b = { count: 0, reset: now + this.windowMs }; this.buckets.set(ip, b); }
    if (b.count >= this.max) return false;
    b.count++;
    if (this.buckets.size > 10000) this.buckets.clear(); // paranoia cap
    return true;
  }
}

/** Cred-file writer used by set-password. */
export function writeCred(authFile: string, username: string, password: string): void {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const tmp = authFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    username, salt: salt.toString('hex'), hash: hash.toString('hex'),
  }), { mode: 0o400 });
  fs.renameSync(tmp, authFile);
  fs.chmodSync(authFile, 0o400);
}
