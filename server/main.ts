// main.ts — web-pi server.
// One process: serves the Astro SSR build (pages via the middleware handler,
// hashed assets statically), the REST API, and the WS→node-pty→tmux
// terminal. Loopback by default; put it behind a TLS reverse proxy
// (deploy/nginx-webpi.conf). Config: WEB_PI_* env (README table).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
// @ts-ignore — no bundled types for the native module
import * as pty from 'node-pty';
import { Auth, RateLimiter, type Auth as AuthType } from '../src/lib/auth';
import { listSessions, findSession } from '../src/lib/sessions';
import * as tmux from '../src/lib/tmux';
import type { ClientMsg, ServerMsg, ConsoleState } from '../src/lib/types';

// URL base path ('/' or '/foo', no trailing slash). Must match the base
// the pages were built with (astro.config.mjs reads the same env at build).
function normalizeBase(raw: string): string {
  let b = (raw || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (b.length > 1 && b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

const home = process.env.WEB_PI_HOME ?? os.homedir();

const CFG = {
  host: process.env.WEB_PI_HOST ?? '127.0.0.1',
  port: parseInt(process.env.WEB_PI_PORT ?? '3000', 10),
  base: normalizeBase(process.env.WEB_PI_BASE ?? '/'),
  home,
  // dist-server/server/main.js → app root is two levels up
  authFile: process.env.WEB_PI_AUTH_FILE ?? path.join(__dirname, '..', '..', 'auth.json'),
  clientDir: process.env.WEB_PI_CLIENT_DIR ?? path.join(__dirname, '..', '..', 'dist', 'client'),
  astroEntry: process.env.WEB_PI_ASTRO_ENTRY ?? path.join(__dirname, '..', '..', 'dist', 'server', 'entry.mjs'),
  // pi's own session-store resolution, mirrored (pi env docs):
  // PI_CODING_AGENT_SESSION_DIR, else PI_CODING_AGENT_DIR/sessions (default ~/.pi/agent).
  sessionsDir: process.env.WEB_PI_SESSIONS_DIR
    ?? process.env.PI_CODING_AGENT_SESSION_DIR
    ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'sessions'),
  newSessionCwd: process.env.WEB_PI_NEW_SESSION_CWD ?? home,
  // whitespace-split command line; resume appends --session <id> (pi-family CLI)
  command: (process.env.WEB_PI_COMMAND ?? 'pi').trim().split(/\s+/).filter(Boolean),
};

/** Route path under the configured base ('/login' → '/foo/login'). */
const route = (p: string): string => (CFG.base === '/' ? p : CFG.base + p);

const auth: AuthType = new Auth(CFG.authFile);
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const wsLimiter = new RateLimiter(30, 60 * 1000);

// ---------- helpers ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
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
function readBody(req: http.IncomingMessage, cb: (err: Error | null, body?: Record<string, unknown>) => void): void {
  let n = 0; const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { n += c.length; if (n > 10240) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>); }
    catch { cb(new Error('bad json')); }
  });
}
function ipOf(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const raw: string = (Array.isArray(xff) ? xff[0] : xff) ?? req.socket.remoteAddress ?? '?';
  return raw.split(',')[0]!.trim();
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
const server = http.createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0]!;

  if (req.method === 'POST' && url === route('/login')) {
    if (!loginLimiter.allow(ipOf(req))) { send(res, 429, 'too many attempts'); return; }
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const username = body?.username, password = body?.password;
      if (typeof username !== 'string' || typeof password !== 'string' ||
        !auth.verify(username, password)) {
        send(res, 401, 'invalid credentials'); // nginx logs it; fail2ban watches
        return;
      }
      send(res, 200, 'ok', { 'Set-Cookie': auth.cookieHeader(auth.newSession(), CFG.base) });
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

  // Everything below requires a valid session...
  if (!authed(req)) {
    // ...except the login page + its hashed assets (every data/terminal
    // route stays 401).
    if (req.method === 'GET' && (url === CFG.base || url === CFG.base + '/' || url === route('/login'))) {
      req.url = route('/login'); // render the login page whatever the shell URL
      renderAstro(req, res);
      return;
    }
    if (req.method === 'GET' && url.startsWith(route('/_astro/'))) {
      sendClientFile(res, url.slice(CFG.base.length), true);
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
        live: err ? [] : live, sessions: sessList,
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
      tmux.newSession(name, CFG.newSessionCwd, CFG.command, err2 => {
        if (err2) { sendJSON(res, 409, { error: 'could not create session (name taken?)' }); return; }
        sendJSON(res, 200, { name });
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
});

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

  ws.on('message', raw => {
    if (raw == null) return;
    let msg: ClientMsg; try { msg = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as ClientMsg; } catch { return; }
    if (msg.type === 'input' && p) {
      p.write(msg.data.slice(0, 4096));
    } else if (msg.type === 'resize') {
      const c = Math.min(Math.max(parseInt(String(msg.cols), 10) || 80, 10), 500);
      const r = Math.min(Math.max(parseInt(String(msg.rows), 10) || 24, 4), 200);
      size = { cols: c, rows: r };
      if (p) { try { p.resize(c, r); } catch { /* race on exit */ } }
    } else if (msg.type === 'attach' && !p) {
      if (msg.mode === 'live') {
        const target = String(msg.target ?? '');
        if (!tmux.NAME_RE.test(target)) { wsSend(ws, { type: 'error', message: 'bad target' }); return; }
        tmux.hasSession(target, (_e, exists) => {
          if (!exists) { wsSend(ws, { type: 'error', message: 'no such live session' }); return; }
          spawnTmux([target], target);
        });
      } else if (msg.mode === 'resume') {
        const found = findSession(CFG.sessionsDir, String(msg.id ?? ''));
        if (!found) { wsSend(ws, { type: 'error', message: 'no such session' }); return; }
        let cwd = CFG.newSessionCwd;
        if (found.cwd) {
          try { if (fs.statSync(found.cwd).isDirectory()) cwd = found.cwd; } catch { /* fallback */ }
        }
        const short = 'r-' + found.id.slice(0, 8);
        tmux.resumeSession(short, cwd, CFG.command, found.id, err => {
          if (err) { wsSend(ws, { type: 'error', message: 'could not start resume session' }); return; }
          spawnTmux([short], short);
        });
      }
    }
  });

  ws.on('close', () => { if (p) { try { p.kill(); } catch { /* already gone */ } } });
  ws.on('error', () => { if (p) { try { p.kill(); } catch { /* noop */ } } });
}

server.listen(CFG.port, CFG.host, () => {
  console.log(`web-pi listening on ${CFG.host}:${CFG.port} base ${CFG.base} ` +
    `(tmux socket ${tmux.SOCKET}, command "${CFG.command.join(' ')}", client ${CFG.clientDir}, sessions ${CFG.sessionsDir})`);
});
