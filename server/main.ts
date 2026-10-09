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
seedAgentDir();

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
function sendJSON(res: http.ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });
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
/** Is this path inside the app's base ('/foo' and '/foo/…', or anything for '/')? */
function underBase(url: string): boolean {
  return CFG.base === '/' || url === CFG.base || url.startsWith(CFG.base + '/');
}
function authed(req: http.IncomingMessage): boolean {
  return auth.valid(Auth.parseCookies(req.headers.cookie).webpi_session);
}

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

// ---------- HTTP ----------
// Last-resort guard: a synchronous throw in a route must cost one 500, not
// the process (and, in the container, every tmux session with it). Inputs
// are validated in the routes; this only catches what slips through.
const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch (err) {
    console.error('request handler error', err);
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }
});

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? '').split('?')[0]!;

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
    auth.drop(Auth.parseCookies(req.headers.cookie).webpi_session);
    send(res, 200, 'ok', {
      'Set-Cookie': `webpi_session=; HttpOnly; Secure; SameSite=Strict; Path=${CFG.base}; Max-Age=0`,
    });
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

  if (req.method === 'GET' && url === route('/api/state')) {
    const sessList = listSessions(CFG.sessionsDir);
    tmux.listSessions((err, live) => {
      const state: ConsoleState = {
        me: 'ok', configured: auth.configured(),
        live: err ? [] : live,
        sessions: sessList.map(s => ({ ...s, hidden: hiddenSessions.has(s.id) })),
        hiddenCount: hiddenSessions.size,
      };
      sendJSON(res, 200, state);
    });
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
        if (err2) { sendJSON(res, 409, { error: 'could not create session (name taken?)' }); return; }
        sendJSON(res, 200, { name });
      });
    });
    return;
  }

  // Listed with available:false (200) when systemctl --user is unusable —
  // the /jobs page renders an explanatory notice instead of 500s; the
  // mutating routes 503 in that case. See src/lib/jobs.ts for the
  // webpi-* unit conventions and ownership invariant.
  if (url === route('/api/jobs') || url.startsWith(route('/api/jobs/'))) {
    const sub = url.slice(route('/api/jobs').length);
    const jobCtx = { cwd: CFG.newSessionCwd, env: sessionEnv };
    const fail = (e: Error): void => sendJSON(res, 500, { error: e.message });
    const reply = (r: jobs.JobOp): void => sendJSON(res, r.ok ? 200 : r.status,
      r.ok ? { name: r.name, session: r.session ?? null } : { error: r.error, detail: r.detail });

    if (req.method === 'GET' && sub === '') {
      jobs.listJobs().then(st => sendJSON(res, 200, st)).catch(fail);
      return;
    }
    if (req.method === 'POST' && (sub === '' || sub === '/validate')) {
      readBody(req, (err, body) => {
        if (err) { send(res, 400, 'bad request'); return; }
        if (sub === '/validate') {
          jobs.checkCalendar(String(body?.schedule ?? '')).then(c => sendJSON(res, 200, c)).catch(fail);
        } else {
          jobs.saveJob({
            name: String(body?.name ?? ''),
            schedule: String(body?.schedule ?? ''),
            command: String(body?.command ?? ''),
          }, jobCtx).then(reply).catch(fail);
        }
      });
      return;
    }
    const runNow = sub.match(/^\/([^/]+)\/run$/);
    if (req.method === 'POST' && runNow) {
      const name = decodeSegment(runNow[1]!);
      if (name === null) { send(res, 400, 'bad job name'); return; }
      jobs.runJob(name).then(reply).catch(fail);
      return;
    }
    const remove = sub.match(/^\/([^/]+)$/);
    if (req.method === 'DELETE' && remove) {
      const name = decodeSegment(remove[1]!);
      if (name === null) { send(res, 400, 'bad job name'); return; }
      jobs.deleteJob(name).then(reply).catch(fail);
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

server.on('upgrade', (req, socket, head) => {
  const url = (req.url ?? '').split('?')[0]!;
  if (url !== route('/ws')) { socket.destroy(); return; }
  if (!wsLimiter.allow(ipOf(req))) { socket.destroy(); return; }
  if (!auth.valid(Auth.parseCookies(req.headers.cookie).webpi_session)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => attach(ws));
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

function attach(ws: WebSocket): void {
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
      x = pty.spawn('tmux', ['-L', tmux.SOCKET, 'attach', '-d', '-t', ...args],
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
          if (err) { wsSend(ws, { type: 'error', message: 'could not start resume session' }); return; }
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
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_INTERVAL_MS);

  ws.on('close', () => {
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
