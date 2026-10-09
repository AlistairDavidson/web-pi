#!/usr/bin/env node
// main.ts — web-pi server.
// One process: serves the Astro SSR build (pages via the middleware handler,
// hashed assets statically), the REST API, and the WS→node-pty→tmux
// terminal. Loopback by default; put it behind a TLS reverse proxy
// (deploy/nginx-webpi.conf). Config: WEB_PI_* env (README table).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
// @ts-ignore — no bundled types for the native module
import * as pty from 'node-pty';
import { Auth, RateLimiter, type Auth as AuthType } from '../src/lib/auth';
import { listSessions, findSession } from '../src/lib/sessions';
import { HiddenSessions, SESSION_ID_RE } from '../src/lib/hidden-sessions';
import { StateDb } from '../src/lib/db';
import * as tmux from '../src/lib/tmux';
import { ENV, RAW_ENV, APP_ROOT, PI_BIN, PI_AGENT_DIR, PI_SESSION_DIR } from '../src/lib/env';
import * as jobs from '../src/lib/jobs';
import {
  BUSY_ERROR, PI_PACKAGE, appVersion, npmPath, piDeclared, piInstalled, runPiUpdate,
} from '../src/lib/settings';
import type { ClientMsg, ServerMsg, ConsoleState, SettingsState } from '../src/lib/types';

// URL base path ('/' or '/foo', no trailing slash). Must match the base
// the pages were built with (astro.config.mjs reads the same env at build).
function normalizeBase(raw: string): string {
  let b = (raw || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (b.length > 1 && b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

const home = ENV.WEB_PI_HOME;

// Controlled pi config. `pi/` in the repo is the versioned template
// (settings.json, mcp.json, skills/, extensions/, …); the runtime agent dir
// below is what spawned pi actually uses (PI_CODING_AGENT_DIR) — seeded
// from the template at boot, so sessions never read or write ~/.pi/agent.
// NB: PI_CODING_AGENT_DIR in the *server's* environment is deliberately NOT
// a fallback — on an operator's box that's their real agent dir, and seeding
// it would overwrite their config.
const agentDir = ENV.WEB_PI_AGENT_DIR;
if (PI_AGENT_DIR && !RAW_ENV.WEB_PI_AGENT_DIR) {
  console.error(`PI_CODING_AGENT_DIR is set (${PI_AGENT_DIR}) — ignoring it; ` +
    `web-pi uses its own runtime agent dir (${agentDir}). Set WEB_PI_AGENT_DIR to move it.`);
}
const agentTemplate = path.join(APP_ROOT, 'pi');

const CFG = {
  host: ENV.WEB_PI_HOST,
  port: ENV.WEB_PI_PORT,
  base: normalizeBase(ENV.WEB_PI_BASE),
  home,
  agentDir,
  dbFile: ENV.WEB_PI_DB_FILE,
  clientDir: ENV.WEB_PI_CLIENT_DIR,
  astroEntry: ENV.WEB_PI_ASTRO_ENTRY,
  sessionsDir: ENV.WEB_PI_SESSIONS_DIR,
  newSessionCwd: ENV.WEB_PI_NEW_SESSION_CWD,
  // whitespace-split command line; resume appends --session <id> (pi-family CLI)
  command: ENV.WEB_PI_COMMAND.trim().split(/\s+/).filter(Boolean),
  trustProxy: Math.max(0, ENV.WEB_PI_TRUST_PROXY),
};

/** Seed the runtime agent dir from the versioned template, only where the
 *  runtime dir doesn't already have the file: existing files always win, so
 *  config pi itself writes (settings.json) or the operator customises is
 *  never clobbered — the template is first-boot defaults, and template files
 *  added by upgrades still land. State only pi writes (auth.json, sessions/,
 *  caches, …) is never in the template and is left alone. */
function seedAgentDir(): void {
  try {
    fs.mkdirSync(CFG.agentDir, { recursive: true });
    if (!fs.existsSync(agentTemplate)) return;
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    for (const src of walk(agentTemplate)) {
      const dst = path.join(CFG.agentDir, path.relative(agentTemplate, src));
      if (fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst);
    }
  } catch (err) {
    console.warn(`could not seed pi agent dir (${CFG.agentDir}):`, (err as Error).message);
  }
}
// Privilege split (DESIGN_REVIEW §1.1): with an absolute-path
// WEB_PI_TMUX_SOCKET the tmux server — and every pi session — runs as
// ANOTHER uid (the workspace half). The runtime agent dir belongs to
// that uid, so seeding happens workspace-side at its boot
// (docker-workspace-entrypoint.sh): web-side cp's would leave node-owned
// 0644 files pi can't write next to its config. Single-user shapes
// (relative socket name) keep seeding here.
if (tmux.forksServer(tmux.SOCKET)) seedAgentDir();
else console.log(`privilege split: tmux socket ${tmux.SOCKET} is an absolute path — ` +
  `pi agent dir seeding and tmux server ownership live on the workspace side`);

// Environment for processes spawned inside tmux sessions (pi). Delivered
// per-session via `tmux new-session -e` — deterministic no matter when the
// tmux server (and its inherited env) was started — and set on the tmux
// client calls too, so a freshly started server inherits the same values.
const sessionEnv: Record<string, string> = {
  HOME: CFG.home,
  PI_CODING_AGENT_DIR: CFG.agentDir,
};
if (PI_SESSION_DIR) {
  sessionEnv.PI_CODING_AGENT_SESSION_DIR = PI_SESSION_DIR;
}

/** Route path under the configured base ('/login' → '/foo/login'). */
const route = (p: string): string => (CFG.base === '/' ? p : CFG.base + p);

// web-pi's own persisted state: one sqlite db (login credential,
// hidden-session ids) at CFG.dbFile, opened lazily on first use
// (src/lib/db.ts). pi's session store is untouched by all of this.
const stateDb = new StateDb(CFG.dbFile);
const auth: AuthType = new Auth(stateDb);
const hiddenSessions = new HiddenSessions(stateDb);
// In-process job scheduler (src/lib/jobs.ts): definitions + run
// bookkeeping live in the state db; fires open tmux sessions on the app's
// socket under the same job-session conventions as interactive sessions.
const scheduler = new jobs.Scheduler(stateDb, { cwd: CFG.newSessionCwd, env: sessionEnv });
scheduler.start();
// The scheduler's single shutdown hook. The SIGTERM/SIGINT handler is a
// sibling task (task/session-lifecycle, merged separately); at merge time
// it calls shutdownScheduler() — wired here so teardown has exactly one
// spot. Uncalled until then on purpose: the default signal exit tears the
// process (and the tick interval) down anyway.
const shutdownScheduler = (): void => scheduler.stop();
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const wsLimiter = new RateLimiter(30, 60 * 1000);
// Password hashes in flight at once. Each scrypt holds 16 MiB and a libuv
// threadpool thread (4 by default, shared with fs) — past this, logins get
// 503 instead of queueing without bound.
const MAX_LOGIN_VERIFY = 4;
let loginVerifying = 0;

// ---------- helpers ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res: http.ServerResponse, code: number, body: string,
  headers?: Record<string, string>): void {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJSON(res: http.ServerResponse, code: number, obj: unknown,
  headers?: Record<string, string>): void {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });
}
function sendClientFile(res: http.ServerResponse, rel: string, cache: boolean): void {
  // rel is from a fixed route table or validated against traversal below.
  const file = path.normalize(path.join(CFG.clientDir, rel));
  if (!file.startsWith(CFG.clientDir + path.sep) && file !== CFG.clientDir) {
    send(res, 404, 'not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  });
}
/** JSON request body, capped at 10 KiB. Anything but a JSON object (array,
 *  string, null, …) is a bad request, so handlers can read fields freely. */
function readBody(req: http.IncomingMessage, cb: (err: Error | null, body?: Record<string, unknown>) => void): void {
  let n = 0; const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { n += c.length; if (n > 10240) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { cb(new Error('bad json')); return; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) { cb(new Error('not an object')); return; }
    cb(null, body as Record<string, unknown>); // outside the try: a throwing handler must not be re-called
  });
}
/** Client IP for the rate limiters. X-Forwarded-For is client-controlled
 *  except for the entries our own proxies appended (nginx's
 *  $proxy_add_x_forwarded_for and ALB both append), so with
 *  WEB_PI_TRUST_PROXY=N the client is the Nth entry from the right — never
 *  the leftmost, which anyone can set to get a fresh bucket per request.
 *  N=0 (default): the header is ignored and the socket peer is the client. */
function ipOf(req: http.IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '?';
  if (CFG.trustProxy === 0) return peer;
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : xff ?? '')
    .split(',').map(h => h.trim()).filter(Boolean);
  if (hops.length === 0) return peer; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}
/** decodeURIComponent that answers null instead of throwing on malformed
 *  escapes (`%E0`) — a throw in the request handler takes the process down. */
function decodeSegment(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

// ---------- origin check (DESIGN_REVIEW §1.2) ----------
// SameSite=Strict doesn't stop sibling subdomains (same site, not same
// origin) opening the terminal WS with the cookie attached, and no Origin
// check existed on the JSON POSTs. The expected origin is derived per
// request: Host + X-Forwarded-Proto, the latter honoured only behind a
// trusted proxy (the same right-most-untrusted-hop selection ipOf() uses
// for X-Forwarded-For — direct connections assume plain http).

/** Request scheme per WEB_PI_TRUST_PROXY: the Nth X-Forwarded-Proto entry
 *  from the right when proxies are trusted, else http. */
function protoOf(req: http.IncomingMessage): string {
  if (CFG.trustProxy === 0) return 'http';
  const xfp = req.headers['x-forwarded-proto'];
  const hops = (Array.isArray(xfp) ? xfp.join(',') : xfp ?? '')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (hops.length === 0) return 'http'; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}

/** Origin normalised for comparison: lowercase scheme+host, default ports
 *  (http:80, https:443) stripped — https://x:443 ≡ https://x. Origin never
 *  carries a path, so only scheme+host+port are compared (WEB_PI_BASE
 *  mounts don't affect it). Null for anything unparseable (including the
 *  literal "null" some browsers send from sandboxed frames). */
function normalizeOrigin(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const defPort = u.protocol === 'https:' ? ':443' : ':80';
  const host = u.host.toLowerCase();
  return `${u.protocol}//${host.endsWith(defPort) ? host.slice(0, -defPort.length) : host}`;
}

/** The origin this request may claim, from Host (+ trusted XFP). Null when
 *  there is no Host header to derive it from. */
function expectedOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  const proto = protoOf(req);
  const defPort = proto === 'https' ? ':443' : ':80';
  const h = host.toLowerCase();
  return `${proto}://${h.endsWith(defPort) ? h.slice(0, -defPort.length) : h}`;
}

/** Origin gate for non-GET requests: absent Origin (curl, API clients)
 *  passes; a present Origin must match the expected origin exactly. */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  const expected = expectedOrigin(req);
  return expected !== null && normalizeOrigin(origin) === expected;
}

/** Is this path inside the app's base ('/foo' and '/foo/…', or anything for '/')? */
function underBase(url: string): boolean {
  return CFG.base === '/' || url === CFG.base || url.startsWith(CFG.base + '/');
}
function authed(req: http.IncomingMessage): boolean {
  return auth.valid(Auth.parseCookies(req.headers.cookie).webpi_session);
}
/** Header that clears the browser's session cookie (logout, log out everywhere). */
const clearSessionCookie = (): string =>
  `webpi_session=; HttpOnly; Secure; SameSite=Strict; Path=${CFG.base}; Max-Age=0`;

// ---------- Astro SSR (middleware) ----------
// The Astro build emits an ESM handler (dist/server/entry.mjs); loaded once
// via dynamic import (the compiled server here is CJS). Page routes render
// through it; the `next` fallback covers unknown paths (404).
type AstroHandler =
  (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => void;

const astroReady: Promise<AstroHandler> =
  import(pathToFileURL(CFG.astroEntry).href)
    .then((m: { handler: AstroHandler }) => m.handler);
astroReady.catch(err => console.error(
  `astro SSR entry failed to load (${CFG.astroEntry}) — did 'npm run build' run?):`,
  (err as Error)?.message ?? err));

function renderAstro(req: http.IncomingMessage, res: http.ServerResponse): void {
  astroReady
    .then(handler => handler(req, res, () => send(res, 404, 'not found')))
    .catch(err => { console.error('astro handler error', err); send(res, 500, 'render failed'); });
}

// ---------- security headers (DESIGN_REVIEW §1.2) ----------
// Sent by the app itself on every response — host installs (no nginx) and
// container installs get the same posture. Astro pages bundle their
// scripts as external modules (script-src 'self', no 'unsafe-inline');
// xterm and Lit inject <style> at runtime, hence style 'unsafe-inline';
// the terminal WS is same-origin (ws/wss of the page's origin — 'self'
// covers both in current browsers, wss: is listed for older Safari).
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** Same headers as a raw HTTP/1.1 response block (upgrade rejections are
 *  written straight to the socket — there is no ServerResponse). */
function securityHeaderBlock(): string {
  return Object.entries(SECURITY_HEADERS).map(([n, v]) => `${n}: ${v}\r\n`).join('');
}

/** Arm `res` so the security headers ride on every response the process
 *  sends, whichever path writes it: send()/sendJSON()/sendClientFile(),
 *  the 302, and the Astro SSR handler (which calls writeHead/setHeader on
 *  the same object). Injection happens at writeHead *and* end — whichever
 *  fires first — and is idempotent, so a handler that already set one of
 *  these (or passes its own in writeHead's headers object, which wins per
 *  Node's merge rules) keeps control of it. */
function hardenResponse(res: http.ServerResponse): void {
  const apply = (): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!res.hasHeader(name)) res.setHeader(name, value);
    }
  };
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
  res.writeHead = ((...args: unknown[]) => { apply(); return writeHead(...args); }) as typeof res.writeHead;
  res.end = ((...args: unknown[]) => { apply(); return end(...args); }) as typeof res.end;
}

// ---------- HTTP ----------
// Last-resort guard: a synchronous throw in a route must cost one 500, not
// the process (and, in the container, every tmux session with it). Inputs
// are validated in the routes; this only catches what slips through.
const server = http.createServer((req, res) => {
  hardenResponse(res);
  try { handle(req, res); }
  catch (err) {
    console.error('request handler error', err);
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }
});

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? '').split('?')[0]!;

  // Every non-GET must be same-origin when it claims any origin at all
  // (curl & co send no Origin header and pass). Checked before routing —
  // a mismatched Origin must not touch the login limiter or anything else.
  if (req.method !== 'GET' && !originOk(req)) {
    send(res, 403, 'cross-origin request rejected');
    return;
  }

  if (req.method === 'POST' && url === route('/login')) {
    if (!loginLimiter.allow(ipOf(req))) { send(res, 429, 'too many attempts'); return; }
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const username = body?.username, password = body?.password;
      if (typeof username !== 'string' || typeof password !== 'string') {
        send(res, 401, 'invalid credentials'); // nginx logs it; fail2ban watches
        return;
      }
      if (loginVerifying >= MAX_LOGIN_VERIFY) {
        send(res, 503, 'busy, try again', { 'Retry-After': '1' });
        return;
      }
      loginVerifying++;
      auth.verify(username, password)
        .then(ok => {
          if (!ok) { send(res, 401, 'invalid credentials'); return; }
          send(res, 200, 'ok', { 'Set-Cookie': auth.cookieHeader(auth.newSession(), CFG.base) });
        })
        .catch(e => { console.error('login verify failed', e); send(res, 500, 'internal error'); })
        .finally(() => { loginVerifying--; });
    });
    return;
  }

  if (req.method === 'POST' && url === route('/logout')) {
    const token = Auth.parseCookies(req.headers.cookie).webpi_session;
    auth.drop(token);
    // Logout must end the terminals this token authenticated, not just
    // future requests: they get 'signed-out' and don't reconnect.
    if (token) closeTokenSockets(token, { type: 'signed-out' });
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // PWA files from public/ (service worker, manifest, icons): served with
  // or without a session — the login page links the manifest and registers
  // the worker before any auth can exist, and none of them carry data.
  if (req.method === 'GET' && url.startsWith(CFG.base)) {
    const rel = url.slice(CFG.base.length).replace(/^\//, '');
    if (rel === 'sw.js' || rel === 'manifest.webmanifest' || rel.startsWith('icons/')) {
      sendClientFile(res, '/' + rel, rel.startsWith('icons/'));
      return;
    }
  }

  // Everything below requires a valid session...
  if (!authed(req)) {
    // ...except the PWA offline shell (static, session-free — the service
    // worker precaches it at install time, pre-auth), the hashed assets,
    // and the login page itself. Every data/terminal route stays 401.
    if (req.method === 'GET' && url === route('/offline')) {
      renderAstro(req, res);
      return;
    }
    if (req.method === 'GET' && url.startsWith(route('/_astro/'))) {
      sendClientFile(res, url.slice(CFG.base.length), true);
      return;
    }
    // Any other page GET under the base (/, /jobs, /settings, a typo'd
    // path, …) renders the login page in place — the address bar keeps
    // the URL, so signing in reloads straight into the page that was asked
    // for. No per-page allowlist to forget when a page is added.
    if (req.method === 'GET' && underBase(url) && !url.startsWith(route('/api/'))) {
      req.url = route('/login');
      renderAstro(req, res);
      return;
    }
    send(res, 401, 'unauthorized');
    return;
  }

  // 'Log out everywhere' (/settings): every token dies and every
  // terminal ends — suspected-cookie-theft recovery in one click. This
  // browser's cookie is cleared too.
  if (req.method === 'POST' && url === route('/api/logout-all')) {
    auth.dropAll();
    closeAllSockets({ type: 'signed-out' });
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  if (req.method === 'GET' && url === route('/api/state')) {
    // Two things share this one response: the poll every open tab makes
    // every 15 s re-arms the browser cookie's Max-Age when it has drifted
    // near half the sliding window (auth.cookieRefresh decides — see the
    // justification there), and the scan itself is async + title-cached
    // so the poll never holds the event loop — terminal WS traffic keeps
    // flowing while it runs.
    const refresh = auth.cookieRefresh(Auth.parseCookies(req.headers.cookie).webpi_session, CFG.base);
    listSessions(CFG.sessionsDir).then(sessList => {
      tmux.listSessions((err, live) => {
        const state: ConsoleState = {
          me: 'ok', configured: auth.configured(),
          live: err ? [] : live,
          sessions: sessList.map(s => ({ ...s, hidden: hiddenSessions.has(s.id) })),
          hiddenCount: hiddenSessions.size,
        };
        sendJSON(res, 200, state, refresh === null ? undefined : { 'Set-Cookie': refresh });
      });
    }, () => send(res, 500, 'internal error')); // unreachable: the scan tolerates junk
    return;
  }

  if (req.method === 'POST' && url === route('/api/new')) {
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const raw = String(body?.name ?? '');
      const name = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 30);
      if (!name) { send(res, 400, 'name required'); return; }
      tmux.newSession(name, CFG.newSessionCwd, CFG.command, sessionEnv, err2 => {
        if (err2) {
          // The never-fork guard's refusal is a distinct, user-facing
          // error (503 — retryable once the workspace side is back),
          // unlike a taken name (409).
          if (err2.message.startsWith(tmux.SERVER_NOT_RUNNING_MSG)) {
            sendJSON(res, 503, { error: err2.message });
          } else {
            sendJSON(res, 409, { error: 'could not create session (name taken?)' });
          }
          return;
        }
        sendJSON(res, 200, { name });
      });
    });
    return;
  }

  // Jobs are served by the in-process scheduler (src/lib/jobs.ts) —
  // available everywhere the server runs, container included; there is
  // no degraded mode anymore.
  if (url === route('/api/jobs') || url.startsWith(route('/api/jobs/'))) {
    const sub = url.slice(route('/api/jobs').length);
    const fail = (e: Error): void => sendJSON(res, 500, { error: e.message });
    const reply = (r: jobs.JobOp): void => sendJSON(res, r.ok ? 200 : r.status,
      r.ok ? { name: r.name, session: r.session ?? null } : { error: r.error, detail: r.detail });

    if (req.method === 'GET' && sub === '') {
      scheduler.listJobs().then(st => sendJSON(res, 200, st)).catch(fail);
      return;
    }
    if (req.method === 'POST' && (sub === '' || sub === '/validate')) {
      readBody(req, (err, body) => {
        if (err) { send(res, 400, 'bad request'); return; }
        if (sub === '/validate') {
          sendJSON(res, 200, jobs.checkCron(String(body?.schedule ?? '')));
        } else {
          scheduler.saveJob({
            name: String(body?.name ?? ''),
            schedule: String(body?.schedule ?? ''),
            command: String(body?.command ?? ''),
          }).then(reply).catch(fail);
        }
      });
      return;
    }
    const runNow = sub.match(/^\/([^/]+)\/run$/);
    if (req.method === 'POST' && runNow) {
      const name = decodeSegment(runNow[1]!);
      if (name === null) { send(res, 400, 'bad job name'); return; }
      scheduler.runJob(name).then(reply).catch(fail);
      return;
    }
    const remove = sub.match(/^\/([^/]+)$/);
    if (req.method === 'DELETE' && remove) {
      const name = decodeSegment(remove[1]!);
      if (name === null) { send(res, 400, 'bad job name'); return; }
      scheduler.deleteJob(name).then(reply).catch(fail);
      return;
    }
    send(res, 404, 'not found');
    return;
  }

  // Hide / unhide past sessions (sidebar 'delete' — reversible by design:
  // ids land as hidden rows in the state db's sessions table, never pi's store).
  if (req.method === 'POST' && url === route('/api/session/hide')) {
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!SESSION_ID_RE.test(id)) { send(res, 400, 'invalid session id'); return; }
      const saveErr = hiddenSessions.hide(id);
      if (saveErr) { sendJSON(res, 500, { error: 'could not save hidden state' }); return; }
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && url === route('/api/session/unhide')) {
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const saveErr = body?.all === true
        ? hiddenSessions.unhideAll()
        : typeof body?.id === 'string' && SESSION_ID_RE.test(body.id)
          ? hiddenSessions.unhide(body.id)
          : new Error('invalid session id');
      if (!saveErr) { sendJSON(res, 200, { ok: true }); return; }
      if (saveErr.message === 'invalid session id') { send(res, 400, 'invalid session id'); return; }
      sendJSON(res, 500, { error: 'could not save hidden state' });
    });
    return;
  }

  // Paths and versions only — no credential or hash contents ever leave.
  if (req.method === 'GET' && url === route('/api/settings')) {
    const state: SettingsState = {
      me: 'ok',
      appVersion: appVersion(APP_ROOT),
      nodeVersion: process.version,
      host: CFG.host,
      port: CFG.port,
      base: CFG.base,
      command: CFG.command.join(' '),
      newSessionCwd: CFG.newSessionCwd,
      agentDir: CFG.agentDir,
      sessionsDir: CFG.sessionsDir,
      stateDb: CFG.dbFile,
      tmuxSocket: tmux.SOCKET,
      tmuxConf: fs.existsSync(tmux.CONF) ? tmux.CONF : null,
      appRoot: APP_ROOT,
      piPackage: PI_PACKAGE,
      piDeclared: piDeclared(APP_ROOT),
      piInstalled: piInstalled(APP_ROOT),
      npmAvailable: npmPath() !== null,
    };
    sendJSON(res, 200, state);
    return;
  }

  // Manual `npm install pi@latest` in the app dir. Long-running by design
  // (npm timeout 10 min server-side); concurrent runs are refused (409).
  // {dryRun:true} is a check-only mode: proves npm runs, installs nothing.
  if (req.method === 'POST' && url === route('/api/update-pi')) {
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      runPiUpdate(APP_ROOT, body?.dryRun === true, r => {
        sendJSON(res, r.ok ? 200 : (r.error === BUSY_ERROR ? 409 : 500), r);
      });
    });
    return;
  }

  // Authenticated: hashed assets served statically; /login is pointless
  // when signed in (redirect); every other GET goes to the Astro SSR
  // handler (page routes; unknown paths 404 via next). API routes above
  // have already returned.
  if (req.method === 'GET') {
    if (url.startsWith(route('/_astro/'))) { sendClientFile(res, url.slice(CFG.base.length), true); return; }
    if (url === route('/login')) {
      res.writeHead(302, { Location: CFG.base === '/' ? '/' : CFG.base }).end();
      return;
    }
    renderAstro(req, res);
    return;
  }

  send(res, 404, 'not found');
}

// ---------- WebSocket → node-pty → tmux attach ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Live sockets per session token, fed by the upgrade handler (which has
// already validated it): POST /logout, log-out-everywhere and shutdown
// must end the terminals a token authenticated — not merely stop future
// requests — and shutdown must be able to reach every client.
const socketsByToken = new Map<string, Set<WebSocket>>();

function trackSocket(token: string, ws: WebSocket): void {
  let set = socketsByToken.get(token);
  if (!set) { set = new Set(); socketsByToken.set(token, set); }
  set.add(ws);
}
function untrackSocket(token: string, ws: WebSocket): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByToken.delete(token);
}

/** Close with a hard fallback: a peer that never answers the close frame
 *  (dead client, or a script holding a stolen token) is terminated — a
 *  logout/shutdown can't leave a live terminal behind on a limp socket. */
function closeSoon(ws: WebSocket): void {
  try { ws.close(); } catch { /* already closed */ }
  setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1500).unref();
}

/** Send `final`, then end every socket authenticated with `token`. */
function closeTokenSockets(token: string, final: ServerMsg): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  socketsByToken.delete(token);
  for (const ws of set) { wsSend(ws, final); closeSoon(ws); }
}

/** Send `final`, then end every socket, whichever token it used. */
function closeAllSockets(final: ServerMsg): void {
  for (const set of socketsByToken.values()) {
    for (const ws of set) { wsSend(ws, final); closeSoon(ws); }
  }
  socketsByToken.clear();
}

// Graceful shutdown state (sequence at the bottom, by server.listen).
let shuttingDown = false;

server.on('upgrade', (req, socket, head) => {
  const url = (req.url ?? '').split('?')[0]!;
  if (url !== route('/ws')) { socket.destroy(); return; }
  if (shuttingDown) { socket.destroy(); return; } // stopping: no new terminals
  if (!wsLimiter.allow(ipOf(req))) { socket.destroy(); return; }
  // The terminal is browser-only: an upgrade must carry a matching Origin
  // (no curl/websocat clients, no cross-site WebSocket hijacking from a
  // sibling subdomain). Unlike plain HTTP there is no Origin-free path —
  // a missing header is destroyed, not waved through.
  const origin = req.headers.origin;
  if (!origin || !originOk(req)) { socket.destroy(); return; }
  const token = Auth.parseCookies(req.headers.cookie).webpi_session;
  if (!auth.valid(token)) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\n${securityHeaderBlock()}\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => attach(ws, token!));
});

interface Pty { write(d: string): void; resize(c: number, r: number): void; kill(): void;
  onData(cb: (d: string) => void): void; onExit(cb: () => void): void }

function wsSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** A client frame checked against the ClientMsg shapes — null for anything
 *  else (bad JSON, `null`, arrays, missing/mistyped fields). The types in
 *  types.ts are only a promise about well-behaved clients. */
function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  switch (m.type) {
    case 'input':
      return typeof m.data === 'string' ? { type: 'input', data: m.data } : null;
    case 'resize':
      return typeof m.cols === 'number' && typeof m.rows === 'number'
        ? { type: 'resize', cols: m.cols, rows: m.rows } : null;
    case 'attach':
      if (m.mode === 'live' && typeof m.target === 'string') return { type: 'attach', mode: 'live', target: m.target };
      if (m.mode === 'resume' && typeof m.id === 'string') return { type: 'attach', mode: 'resume', id: m.id };
      return null;
    default:
      return null;
  }
}

// Keepalive: a ping per connection this often. Idle-timeout proxies (ALB
// defaults to 60s; nginx's proxy_read_timeout) count it as traffic, so a
// terminal sitting at pi's prompt isn't cut; a ping unanswered by the next
// tick means the peer is gone — terminate, and the pty is reaped.
const PING_INTERVAL_MS = 30_000;

function attach(ws: WebSocket, token: string): void {
  trackSocket(token, ws);
  let p: Pty | null = null;
  // The client sends {attach} and {resize} back-to-back on open, but the
  // pty only exists after an async tmux lookup — remember the requested
  // size and spawn at it, or the session opens at 80x24 inside a larger
  // browser terminal ("terminal not fitting on open").
  let size = { cols: 80, rows: 24 };

  function spawnTmux(args: string[], label: string): boolean {
    const env = Object.assign({}, process.env, {
      TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: CFG.home,
      PI_CODING_AGENT_DIR: CFG.agentDir,
    });
    let x: Pty;
    try {
      x = pty.spawn('tmux', [...tmux.socketArgs(tmux.SOCKET), 'attach', '-d', '-t', ...args],
        { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: CFG.newSessionCwd, env }) as Pty;
    } catch (e) {
      wsSend(ws, { type: 'error', message: 'spawn failed: ' + (e as Error).message });
      return false;
    }
    x.onData(d => wsSend(ws, { type: 'output', data: d }));
    x.onExit(() => { wsSend(ws, { type: 'exit', target: label }); ws.close(); });
    p = x;
    wsSend(ws, { type: 'attached', target: label, socket: tmux.SOCKET });
    return true;
  }

  function onMessage(msg: ClientMsg): void {
    if (msg.type === 'input') {
      // Written whole: the client splits big pastes into consecutive input
      // frames (agent-terminal.ts), and maxPayload bounds any one frame.
      if (p) p.write(msg.data);
    } else if (msg.type === 'resize') {
      const c = Math.min(Math.max(Math.trunc(msg.cols) || 80, 10), 500);
      const r = Math.min(Math.max(Math.trunc(msg.rows) || 24, 4), 200);
      size = { cols: c, rows: r };
      if (p) { try { p.resize(c, r); } catch { /* race on exit */ } }
    } else if (msg.type === 'attach' && !p) {
      if (msg.mode === 'live') {
        const target = msg.target;
        if (!tmux.NAME_RE.test(target)) { wsSend(ws, { type: 'error', message: 'bad target' }); return; }
        tmux.hasSession(target, (_e, exists) => {
          if (!exists) { wsSend(ws, { type: 'error', message: 'no such live session' }); return; }
          spawnTmux([target], target);
        });
      } else {
        const found = findSession(CFG.sessionsDir, msg.id);
        if (!found) { wsSend(ws, { type: 'error', message: 'no such session' }); return; }
        let cwd = CFG.newSessionCwd;
        if (found.cwd) {
          try { if (fs.statSync(found.cwd).isDirectory()) cwd = found.cwd; } catch { /* fallback */ }
        }
        const name = tmux.resumeSessionName(found.id);
        tmux.resumeSession(name, cwd, CFG.command, found.id, sessionEnv, err => {
          if (err) {
            const message = err.message.startsWith(tmux.SERVER_NOT_RUNNING_MSG)
              ? tmux.SERVER_NOT_RUNNING_MSG // the never-fork guard — say it, don't bury it
              : 'could not start resume session';
            wsSend(ws, { type: 'error', message });
            return;
          }
          spawnTmux([name], name);
        });
      }
    }
  }

  ws.on('message', raw => {
    const msg = parseClientMsg(Buffer.from(raw as Buffer).toString('utf8'));
    if (!msg) return; // malformed frames are dropped, never thrown on
    try { onMessage(msg); }
    catch (err) { console.error('ws message handler error', err); }
  });

  let alive = true;
  ws.on('pong', () => { alive = true; });
  const keepalive = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    // Liveness sweep: the expiry clocks must bind established terminals
    // too. A socket whose token died — idle, the 30-day absolute cap, or
    // a logout-everywhere — gets the signed-out message and closes on
    // the next tick instead of riding the keepalive forever (a terminal
    // is a live shell; the token dying for HTTP must end it too).
    // Non-renewing on purpose (auth.alive): WS traffic never slides a
    // token — only authed HTTP does, via auth.valid.
    if (!auth.alive(token)) { closeTokenSockets(token, { type: 'signed-out' }); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_INTERVAL_MS);

  ws.on('close', () => {
    untrackSocket(token, ws);
    clearInterval(keepalive);
    if (p) { try { p.kill(); } catch { /* already gone */ } }
  });
  ws.on('error', () => { if (p) { try { p.kill(); } catch { /* noop */ } } });
}

server.listen(CFG.port, CFG.host, () => {
  console.log(`web-pi listening on ${CFG.host}:${CFG.port} base ${CFG.base} ` +
    `(tmux socket ${tmux.SOCKET}, command "${CFG.command.join(' ')}", client ${CFG.clientDir}, sessions ${CFG.sessionsDir})`);
  // Best-effort vendored-pi version at boot — makes dependency drift visible.
  if (CFG.command[0] === PI_BIN) {
    execFile(PI_BIN, ['--version'], { timeout: 5000 }, (err, out) =>
      console.log(err ? `pi: version check failed (${(err as Error).message})` : `pi ${String(out).trim()}`));
  }
});

// ---------- graceful shutdown (SIGTERM / SIGINT) ----------
// Docker stop, compose, systemd — the container's init relays the signal
// and the stop must not hang (SIGKILL waits behind stopTimeout, and every
// attached terminal goes with it). The sequence: stop accepting new
// connections, tell every open WS 'restart' and close it, then exit once
// the sockets have drained. shutdownSteps is a small ordered list of
// closures — other subsystems register into it by pushing (the in-process
// scheduler stops its tick loop there, so no job fires mid-drain);
// deliberately not a framework, just "later in the array runs later".
const SHUTDOWN_DEADLINE_MS = 5000;
const whenClosed = new Promise<void>(resolve => server.once('close', resolve));
const shutdownSteps: Array<() => void | Promise<void>> = [
  () => { shutdownScheduler(); },                    // 0. stop firing scheduled jobs
  () => { server.close(); },                        // 1. stop listening
  () => { closeAllSockets({ type: 'restart' }); },  // 2. notify + close every client
  () => {
    // Re-armed on an interval, not one-shot: a terminal's close makes the
    // console page re-poll /api/state on its keep-alive socket — busy
    // (not idle) at the moment of a one-shot call, then idle with nothing
    // left to close it, so the one-shot form usually lands on the
    // deadline with a misleading "drain unfinished". The sweep closes each
    // straggler the moment it goes idle, so the drain usually completes
    // clean; the deadline stays as the backstop.
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    return whenClosed.finally(() => clearInterval(sweep));
  },
];

function shutdown(signal: string): void {
  if (shuttingDown) process.exit(0); // a second signal skips the drain
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  // A stuck socket must not hold the stop past the deadline.
  const deadline = setTimeout(() => {
    console.error(`shutdown: drain unfinished after ${SHUTDOWN_DEADLINE_MS}ms — exiting`);
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS);
  (async () => {
    for (const step of shutdownSteps) {
      try { await step(); } catch (err) { console.error('shutdown step failed:', err); }
    }
    clearTimeout(deadline);
    process.exit(0);
  })();
}
// on(), not once(): a repeated SAME signal would have consumed its once
// listener and taken the default exit (143) mid-drain — with on(), the
// shuttingDown flag makes every later signal the fast exit path.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
