# web-pi

**pi in the browser.** A small, self-hostable web app that gives you
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding
sessions in a terminal in your browser — new sessions, past-session resume,
live attach — all backed by tmux so nothing is lost when the tab closes.

One Node process serves everything: the Astro SSR pages (middleware
handler), the JSON API, and a WebSocket that bridges xterm.js to tmux via
node-pty. No framework on the client — just web components, with
[Web Awesome](https://webawesome.com/) (default theme, SSR'd) as the UI
toolkit.

```
Browser (xterm.js)
   │ WSS
   ▼
web-pi server (Node, loopback by default)
   │ node-pty
   ▼
tmux socket ── session per tab ── pi ── ~/.pi/agent/sessions/
```

## What you get

- **New session** — a tmux session running `pi` (command configurable);
  closing the browser tab detaches, the session keeps running.
- **Sessions** — past pi sessions parsed from pi's session store
  (`~/.pi/agent/sessions` by default), grouped by working directory, newest
  first. Click to resume: starts `pi --session <id>` at the session's
  original cwd (pi appends — history is never destroyed).
- **Live** — running tmux sessions on the app's socket; click to attach
  (`attach -d`).
- **Single-user login** — username + password, salted scrypt hash in a
  local file, `HttpOnly`/`Secure`/`SameSite=Strict` session cookie. No
  account machinery. Fails closed until the credential exists.

## Requirements

- Node ≥ 20 (a C++ toolchain for `node-pty`: build-essential / g++ / python3)
- `tmux` and `pi` on PATH (or point `WEB_PI_COMMAND` at your pi binary)
- Linux (node-pty + tmux; developed on Debian)

## Quick start

```sh
npm install
npm run build
npm run set-password          # interactive; creates auth.json (0400)
npm start                     # serves on http://127.0.0.1:3000
```

Put it behind TLS (any reverse proxy) before exposing it anywhere — the
cookie is `Secure` and login POSTs shouldn't cross plain HTTP. See
`deploy/` for a systemd unit, an nginx reverse-proxy block with WebSocket
upgrade, and a fail2ban jail for failed logins.

## Configuration (environment)

Everything is env-configured; defaults suit a single-user Linux box running
`pi` as the same user as the server.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PI_HOST` | `127.0.0.1` | Listen address (loopback + reverse proxy is the intended shape) |
| `WEB_PI_PORT` | `3000` | Listen port |
| `WEB_PI_BASE` | `/` | URL base path, e.g. `/console` when riding an existing site. **Baked into the pages at build time** — set it before `npm run build` *and* at runtime |
| `WEB_PI_HOME` | `os.homedir()` | `HOME` for spawned processes (tmux, pi) |
| `WEB_PI_SESSIONS_DIR` | pi's own resolution: `PI_CODING_AGENT_SESSION_DIR`, else `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`) | where to list past pi sessions from |
| `WEB_PI_NEW_SESSION_CWD` | `$WEB_PI_HOME` | cwd for new sessions |
| `WEB_PI_COMMAND` | `pi` | command run in a new session (whitespace-split; resume appends `--session <id>` — only pi-family CLIs support that) |
| `WEB_PI_TMUX_SOCKET` | `web-pi` | the tmux socket the app owns |
| `WEB_PI_AUTH_FILE` | `<app root>/auth.json` | credential file (0400) |
| `WEB_PI_CLIENT_DIR` | `<app root>/dist/client` | Astro hashed assets |
| `WEB_PI_ASTRO_ENTRY` | `<app root>/dist/server/entry.mjs` | Astro SSR handler |

Run under a dedicated unprivileged user (the app spawns a terminal — treat
it as a web shell by design). Don't run it as root, don't put a sudo-wielding
user behind it.

## Deploying

See [`deploy/`](deploy/) for:

- `webpi.service` — systemd unit incl. a hardening set (with notes on the
  directives that deliberately aren't there: `PrivateTmp` hides the tmux
  socket, `MemoryDenyWriteExecute` breaks V8's JIT)
- `nginx-webpi.conf` — TLS reverse proxy with the WebSocket upgrade map
- fail2ban filter + jail watching the nginx access log for failed logins

The original deployment (which this project was spun out of) runs behind
nginx at a `/console/` path on a single-purpose box with the app user owning
everything — one user, one port on loopback, fail2ban from day one. That
shape is recommended.

## Security model

- The terminal **is** the product: anyone with the session cookie can type
  into a shell as the app user. One user, strong password, TLS, fail2ban,
  loopback bind + reverse proxy. Rate limits: 10 login POSTs / 15 min / IP,
  30 WS connections / min / IP (in-memory).
- Auth fails closed: no credential file → no login possible.
- Static assets are served from a fixed route table with traversal checks;
  request bodies are size-capped.
- Past-session previews read only file heads (first user message, capped at
  64 KiB per file, 200 files).

## Project shape

- `src/pages`, `src/layouts` — Astro pages (login + app shell), SSR'd
- `src/layouts/Base.astro` — Web Awesome default theme + SSR hydration scripts
- `src/components` — web components: `<console-app>`, `<session-sidebar>`,
  `<agent-terminal>` (xterm.js island)
- `src/lib` — shared strict TS: auth (scrypt + sessions + rate limiter),
  tmux helpers, pi session-store parser, wire types
- `server` — the Node server: Astro SSR (middleware) + assets + REST + WS → node-pty → tmux

Using Web Awesome in a page (SSR pattern — server import in frontmatter,
client import in a `<script>` so it hydrates):

```astro
---
import '@awesome.me/webawesome/dist/components/button/button.js';
---
<wa-button>go</wa-button>
<script>
  import '@awesome.me/webawesome/dist/components/button/button.js';
</script>
```

## License

MIT — see [LICENSE](LICENSE).
