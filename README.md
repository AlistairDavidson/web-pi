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
  closing the browser tab detaches, the session keeps running. A dropped
  connection (proxy idle timeout, server restart, network blip) reattaches
  to the same tmux session on its own, with backoff.
- **Sessions** — past pi sessions parsed from pi's session store
  (`~/.pi/agent/sessions` by default), grouped by working directory, newest
  first. Click to resume: starts `pi --session <id>` at the session's
  original cwd (pi appends — history is never destroyed). Type in the
  filter box to search titles/paths; hide a session to declutter the list —
  hiding only records the id in a small server-side state file (never
  touches pi's store) and is reversible via "N hidden — manage".
- **Live** — running tmux sessions on the app's socket; click to attach
  (`attach -d`).
- **Jobs** (`/jobs`) — scheduled commands ("cron") on the built-in
  scheduler: name + 5-field cron schedule + arbitrary shell command. Every
  run — scheduler-fired or "run now" — opens in a tmux session on the app's
  socket, so it shows up in Live and is attachable like any session.
- **Settings** — `/settings`: read-only dashboard of the effective config
  (listen address, paths, versions) plus one action, a manual update-pi
  button.
- **Single-user login** — username + password, salted scrypt hash in the
  sqlite state db (`webpi.db`), `HttpOnly`/`Secure`/`SameSite=Strict`
  session cookie. No account machinery. Fails closed until the credential
  exists.

## Requirements

- Node ≥ 22.13 (for the built-in `node:sqlite`; plus a C++ toolchain for
  `node-pty`: build-essential / g++ / python3)
- `tmux` on PATH — pi ships as an npm dependency (`npm install` vendors it)
- Linux (node-pty + tmux; developed on Debian)

## Quick start

```sh
npm install
npm run build
npm run set-password          # interactive; writes the credential into webpi.db (0600)
npm start                     # serves on http://127.0.0.1:3000
```

Put it behind TLS (any reverse proxy) before exposing it anywhere — the
cookie is `Secure` and login POSTs shouldn't cross plain HTTP. See
`deploy/` for an nginx reverse-proxy block with WebSocket upgrade, and a
fail2ban jail for failed logins. Container route:

```sh
docker compose up -d        # builds the image, serves on 127.0.0.1:3000
```

## Developing

**In the container** (same image as production):

```sh
docker compose --profile dev up dev   # astro dev :4321 + API/WS :3001
```

The repo is bind-mounted into the container at `/app`; `node_modules` is a
shadow volume so the container builds its own native deps (`node-pty`)
without touching the host's. First boot npm-installs (a few minutes);
later boots self-heal in seconds. Everything is real: `webpi.db` login,
session listing, live attach — and pi sessions start in `/app` (the repo),
self-modification included. Page edits hot-reload through the bind mount.
Dev state (`webpi.db`, `pi-agent/`) lives in the container's `/tmp`
(`WEB_PI_STATE_DIR: /tmp/web-pi-state`) — throwaway: recreate the dev
service and you re-run set-password; production's `webpi-state` volume is
untouched by the profile.

Notes:
- Dev runs as `${UID:-1000}:${GID:-1000}` so the container user matches
  the host checkout's owner. Bash doesn't export `UID`/`GID` — `export
  UID GID` first (or drop `UID=$(id -u)`/`GID=$(id -g)` lines in a `.env`
  next to `compose.yaml`).
- The repo bind uses the `:z` volume flag — required on SELinux-enforcing
  hosts (relabels the tree `container_file_t`), a no-op elsewhere.
- Dev shares ports 3001/4321 with the host flow below — run one or the
  other, not both.
- The dev profile builds the `dev` image target (`web-pi:local-dev`),
  which carries `build-essential`/`python3` for the in-container
  `node-pty` build; the prod image (`web-pi:local`) stays slim.

**On the host** (no docker): two processes — `astro dev` serves the pages
(HMR), but the REST API and the terminal WS live in the Node server, not in
Astro; the Vite server proxies `/api`, `/ws`, and login/logout POSTs to it:

```sh
npm run dev:server   # API + WS half on :3001 (compiles dist-server first)
npm run dev          # astro dev on :4321, proxying to the dev API server
```

Everything works against the dev server as it does in production, and the
login rate limit is in-memory: restart `dev:server` to clear it while
iterating on the login page. Override the proxy target with `WEB_PI_DEV_API`
if you run the API half elsewhere.

## Configuration (environment)

Everything is env-configured; defaults suit a single-user Linux box running
`pi` as the same user as the server. The `WEB_PI_*` contract is declared
once, typed, in a schema shared by Astro and the Node server:
`astro.config.mjs`'s `env.schema` (imported from `src/lib/env-schema.ts`)
declares every runtime variable — names, types, and the static defaults —
and the compiled server reads the same schema through `src/lib/env.ts` (the
typed runtime equivalent of `astro:env/server` for a plain-tsc build; see
the comments there for why the server can't import the Astro virtual module
directly). Number variables that aren't integers stop the server at boot.
Defaults that must be computed at boot (homedir, app-root paths, the
vendored-pi probe) live beside the reads in `src/lib/env.ts`. The one
exception is the dev-only `WEB_PI_DEV_API`, which `astro.config.mjs` reads
directly.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PI_HOST` | `127.0.0.1` | Listen address (loopback + reverse proxy is the intended shape) |
| `WEB_PI_PORT` | `3000` | Listen port |
| `WEB_PI_TRUST_PROXY` | `0` | Reverse-proxy hops in front of the server (nginx = `1`, ALB → nginx = `2`). The login/WS rate limits key on the client IP that many entries from the right of `X-Forwarded-For`; the origin check also derives its scheme from the `X-Forwarded-Proto` hop it selects (see [Security model](#security-model)); `0` ignores the headers and uses the socket peer. Set it to match your proxies: too low and every client shares the proxy's bucket, too high and clients can pick their own |
| `WEB_PI_BASE` | `/` | URL base path, e.g. `/console` on a dedicated vhost (the app wants its own hostname — see [Security model](#security-model)). **Baked into the pages at build time** — set it before `npm run build` *and* at runtime |
| `WEB_PI_HOME` | `os.homedir()` | `HOME` for spawned processes (tmux, pi) |
| `WEB_PI_STATE_DIR` | `$WEB_PI_HOME/.local/state/web-pi` | one directory for all web-pi state: the sqlite db (`webpi.db`) and the runtime `pi-agent/` (pi credentials + sessions). Per-path overrides (`WEB_PI_DB_FILE`, `WEB_PI_AGENT_DIR`) still win. In the container compose points it at `/state` on a dedicated volume |
| `WEB_PI_AGENT_DIR` | `<state dir>/pi-agent` | runtime pi agent dir (config, credentials, sessions for spawned pi) — seeded from the repo's `pi/` template where absent (a stray `PI_CODING_AGENT_DIR` in the server's env is ignored with an error logged) |
| `WEB_PI_SESSIONS_DIR` | `PI_CODING_AGENT_SESSION_DIR`, else `<agent dir>/sessions` | where to list past pi sessions from |
| `WEB_PI_NEW_SESSION_CWD` | `$WEB_PI_HOME` | cwd for new sessions |
| `WEB_PI_COMMAND` | `<app root>/node_modules/.bin/pi` (falls back to `pi` on PATH) | command run in a new session (whitespace-split; resume appends `--session <id>` — only pi-family CLIs support that) |
| `WEB_PI_TMUX_SOCKET` | `web-pi` | the tmux socket the app owns |
| `WEB_PI_TMUX_CONF` | `<app root>/tmux.conf` | tmux server config, applied when the tmux server starts (escape-time, scrollback, truecolour — see the file) |
| `WEB_PI_DB_FILE` | `<state dir>/webpi.db` | sqlite state db (0600): login credential, `sessions` overlay table (hidden flags), scheduled-job tables (`jobs`, `job_runs` — the in-process scheduler). Fresh setup: `npm run set-password` creates it |
| `WEB_PI_CLIENT_DIR` | `<app root>/dist/client` | Astro hashed assets |
| `WEB_PI_ASTRO_ENTRY` | `<app root>/dist/server/entry.mjs` | Astro SSR handler |
| `WEB_PI_DEV_API` | `http://127.0.0.1:3001` | dev only: where `astro dev` proxies `/api`, `/ws`, login/logout (the `npm run dev:server` process) |

Run under a dedicated unprivileged user (the app spawns a terminal — treat
it as a web shell by design). Don't run it as root, don't put a sudo-wielding
user behind it.

## Scheduled jobs (/jobs) — the in-process scheduler

The jobs page is cron-with-a-face: each job is a **name**, a **5-field
cron schedule** (`minute hour day-of-month month day-of-week`, validated
live in-app with [cron-parser](https://www.npmjs.com/package/cron-parser))
and an arbitrary **shell command**. Jobs live in the sqlite state db
(`jobs` table; one `job_runs` bookkeeping row per fire) and are fired by
a scheduler inside the server process — no systemd, no extra daemon, so
jobs work in every install shape, the container included.

- **Firing**: the scheduler ticks every ~30s and opens due jobs with
  `tmux new-session -d -s webpi-<name>` on the app's own socket (same
  `-f` conf, cwd and `PI_CODING_AGENT_DIR` env a main-page session
  gets). Runs therefore appear in **Live** and attach like any session —
  including runs that fired while you had no browser open.
- **Downtime catch-up**: each fire is recorded in `job_runs`; on boot the
  scheduler compares the last fire against the schedule and fires **one**
  catch-up run per job whose window passed while the server was down —
  systemd's `Persistent=true` equivalent, deliberately capped at one run
  (a job that missed three dailies runs once, not three times).
- **Run semantics**: a fire is **skipped** while the previous run's tmux
  session is still alive — long-running agent jobs don't pile up. "Run
  now" checks and returns 409 in that case. Deleting a job removes its
  definition and run history but deliberately leaves a live run's
  session alone.
- The trade-off vs the old systemd timers: nothing fires while web-pi
  itself is down (hence the catch-up above). Job commands run as the
  web-pi user, on the app's socket, per the security model — the terminal
  is the product.

## Pi: dependency & config isolation

pi is a versioned dependency (`@earendil-works/pi-coding-agent` in
`package.json`; the vendored binary is logged at boot), not something
installed on the box. Its config is project-controlled too:

- [`pi/`](pi/) in the repo is the **template** — settings, `mcp.json`,
  skills, extensions; whatever the install should ship to every session.
- The **runtime agent dir** (default `<state dir>/pi-agent`) is
  seeded from it at server boot, **only where absent**: existing files always
  win, so settings pi itself writes and operator edits are never clobbered,
  while template files added by upgrades still land. State only pi writes
  (`auth.json`, `sessions/`) is never in the template.
- Spawned sessions run with `PI_CODING_AGENT_DIR=<runtime dir>` (delivered
  via `tmux new-session -e`, deterministic per session) — they never touch
  your `~/.pi/agent`, in either direction.

Consequences: web-pi sessions don't see credentials already in your global
pi config — `/login` once inside a session (or seed the runtime
`auth.json`); past sessions from `~/.pi/agent/sessions` don't show in the
sidebar unless you point `WEB_PI_SESSIONS_DIR` there.

## Deploying

Container-first:

```sh
docker compose build        # subpath deploy: WEB_PI_BASE=/console docker compose build
docker compose up -d        # loopback :3000, app on webpi-app, state on webpi-state (/state)
```

Front it with TLS — [`deploy/`](deploy/) has:

- `nginx-webpi.conf` — TLS reverse proxy with the WebSocket upgrade map
  (upstream is the published loopback port). One proxy hop, so the server
  runs with `WEB_PI_TRUST_PROXY=1` (compose sets it; set it yourself for a
  host install behind nginx)
- fail2ban filter + jail watching the nginx access log for failed logins

State (`webpi.db`, `pi-agent/` — pi credentials + sessions) lives on its
own `webpi-state` volume at `/state` (`WEB_PI_STATE_DIR`), outside the
entrypoint-synced `/app` — image syncs can't touch it by construction.
Installs from before the state directory existed (state in `/app` or the
app root) move once by hand; there is deliberately no migration system:

```sh
# container: state sat on the webpi-app volume under /app
docker compose down
docker compose build   # node-owned /state exists only in the NEW image — build first
docker compose run --rm --entrypoint sh webpi -c \
  'mkdir -p /state && mv /app/webpi.db /state/ && mv /app/.pi-agent /state/pi-agent'
docker compose up -d
```

A host install is the same move against the default dir, server stopped:
`mkdir -p ~/.local/state/web-pi && mv <app root>/webpi.db
~/.local/state/web-pi/ && mv <app root>/.pi-agent
~/.local/state/web-pi/pi-agent`. A fresh deploy
needs none of this — just re-run `npm run set-password`.

The old systemd unit is gone: the container *is* the unit (restart policy
+ healthcheck in compose; `ProtectSystem`-style hardening is the container
boundary). The original deployment shape still applies — nginx at a
`/console/` path on a single-purpose box, fail2ban from day one.

### Updating

**pi, in place — no web-pi release needed:**

```sh
docker compose exec webpi npm install @earendil-works/pi-coding-agent@latest
```

Or click **update pi** on `/settings`: the server runs that same
`npm install …@latest` in the app's install dir and shows the captured npm
output and the resulting version. No restart is needed (see below).
Concurrent updates are refused; npm missing from the server's PATH is
reported instead of installed-around. Same caveat below either way.

Stay within the `^1` range web-pi declares (its session-listing and resume
code is written against that major). New sessions pick the new binary up
immediately — pi is exec'd per session, nothing restarts; running sessions
finish on the old one. `/settings` shows the installed version; the boot
log shows the one installed when the server started.
Note: an app-image sync (below) re-pins pi to the lockfile — re-apply
afterwards if you want the newer one. In the **docker dev profile**
`node_modules` is a shadow volume and `npm install` re-runs from the
lockfile on every boot, so an update made in place (button or `exec`) does
not persist there.

**App code:** rebuild + `up -d`. The entrypoint hashes the image's source
tree; on change it syncs app files into the existing volume — anything not
in the image (`apps/`, …) survives untouched. web-pi state isn't in `/app`
at all any more (`webpi-state` volume, above), so a sync can't reach it.
Volumes never re-seed when content hasn't changed.

**Git-owned volume (self-modification, durable local edits):** the named
volume is image-tracked — hand edits survive only until the next image
sync. To own updates with git instead, replace the volume with a checkout:

```sh
docker compose down
# edit compose: volumes: ["/srv/web-pi:/app"] instead of the named volume
git clone <your-fork> /srv/web-pi
docker compose up -d          # entrypoint sees /app/.git and never syncs
```

Updates are then `git pull` + `npm install` + `npm run build` inside the
container, restart to serve — which is also the workflow pi sessions use
when they modify the app on the server (the rollback TODO builds on this).

## Security model

- The terminal **is** the product: anyone with the session cookie can type
  into a shell as the app user. One user, strong password, TLS, fail2ban,
  loopback bind + reverse proxy. Rate limits: 10 login POSTs / 15 min / IP,
  30 WS connections / min / IP (in-memory), where the IP is the socket peer
  or, behind proxies, the `X-Forwarded-For` hop `WEB_PI_TRUST_PROXY`
  selects — never the client-supplied leftmost entry. Password hashing runs
  off the event loop, at most 4 at once (more get 503), so a login flood
  can't stall attached terminals.
- Auth fails closed: no credential file → no login possible.
- **Give web-pi its own hostname.** `WEB_PI_BASE` is for path-mounting on
  a dedicated vhost (`console.example.com/console`), not for riding an
  existing site: on a shared host every same-origin XSS — anywhere on that
  host — reads this app's responses and drives the terminal, and on this
  app a shell is the product. A cookie `Path` is no boundary to
  same-origin scripts.
- **Origin checks:** every non-GET request with a present-but-mismatched
  `Origin` is rejected (403) before anything else runs; requests without
  an `Origin` (curl, API clients) pass. WebSocket upgrades must carry a
  matching `Origin` at all — there is no Origin-free path, so no
  curl/websocat terminals and no cross-site WebSocket hijacking from a
  sibling subdomain (same-site but not same-origin — the defence
  `SameSite=Strict` doesn't provide). The expected origin is derived per
  request from `Host` + `X-Forwarded-Proto`, the latter honoured only when
  `WEB_PI_TRUST_PROXY` trusts it (same right-most-hop selection as the
  rate limits' `X-Forwarded-For` reading). Each proxy hop must *forward*
  the original `X-Forwarded-Proto`, never replace it — nginx behind a
  TLS-terminating front (ALB) must pass `$http_x_forwarded_proto`
  through, not `$scheme`: a replaced proto disagrees with the browser's
  `Origin` and the app fails closed (403s), by design.
- **Security headers** on every response the app itself sends (pages,
  assets, API, redirects, upgrade rejections — host installs get them
  without nginx): CSP `default-src 'self'; script-src 'self'; style-src
  'self' 'unsafe-inline'; connect-src 'self' wss:; frame-ancestors
  'none'` (Astro bundles all scripts as same-origin modules; xterm and
  Lit inject styles at runtime, hence the style exception), plus
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`. The Web Awesome icon glyphs are vendored
  into `public/icons/wa/` and resolved from there client-side — nothing
  loads from the Font Awesome CDN, so the strict CSP holds and no usage
  leaks to a third party.
- Static assets are served from a fixed route table with traversal checks;
  request bodies are size-capped.
- Past-session previews read only file heads (first user message, capped at
  64 KiB per file, 200 files).

## Project shape

- `src/pages`, `src/layouts` — Astro pages (login + app shell), SSR'd
- `src/layouts/Base.astro` — Web Awesome default theme + global styles
  (astro-lit hydration support is imported by each component script —
  import order vs wa-* modules matters, see AGENTS.md)
- `src/components` — web components: `<console-app>`, `<session-sidebar>`,
  `<agent-terminal>` (xterm.js island); each static shell is SSR'd by an
  Astro wrapper (`ConsoleApp.astro`, `AgentTerminal.astro`)
- `src/lib` — shared strict TS: auth (scrypt + sessions + rate limiter),
  tmux helpers, pi session-store parser, scheduled jobs (in-process
  scheduler), wire types,
  typed env schema + reads (`env-schema.ts` / `env.ts`, the `WEB_PI_*` contract)
- `server` — the Node server: Astro SSR (middleware) + assets + REST + WS → node-pty → tmux
- `src/pages/jobs.astro` + `src/components/JobsApp/` — the scheduled-jobs
  page (list/create/edit/run/delete, cron validation)
- `pi/` — the controlled pi agent-dir template (settings, MCPs, skills,
  extensions) seeded into the runtime dir; `tmux.conf` at the root is the
  tmux server config — together they're the shipped "environment config"
- `Dockerfile`, `docker-entrypoint.sh`, `compose.yaml` — image (slim prod
  default + toolchain dev target) and the prod/dev compose services
- `.agents/skills/` — Web Awesome docs as pi skills: `webawesome` (component
  API reference) + `webawesome-design` (layout/theming/tokens), copied
  version-locked from the installed package by `tools/build_webawesome_skills.py`
  — rerun it after bumping `@awesome.me/webawesome`

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
