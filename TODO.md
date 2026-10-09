apps folder that contains git submodules

browser hardening (DESIGN_REVIEW 1.2):
- Origin check on the WS upgrade and every non-GET request: expected origin derived from Host + X-Forwarded-Proto (honour WEB_PI_TRUST_PROXY); present-and-mismatched → 403 / destroy socket. Plain HTTP requests without Origin (curl etc.) pass; WS upgrades REQUIRE an Origin header (browser clients only — no curl/websocat terminals)
- security headers on every response from the app itself (not nginx, so host/Docker installs both get them): CSP default-src 'self'; script-src 'self' (no inline scripts exist); style-src 'self' 'unsafe-inline' (xterm + Lit inject styles); connect-src 'self' wss:; frame-ancestors 'none' + X-Frame-Options DENY + X-Content-Type-Options nosniff + Referrer-Policy same-origin
- vendor the wa-icon glyphs in-project (registerIconLibrary from local files) — prerequisite for the strict CSP, and kills the CDN usage leak (subsumes the old 'Don't load fontawesome icons' item)
- README: WEB_PI_BASE stays (path-mounting on a dedicated vhost), but drop the 'ride an existing site' advice — own hostname, and warn that same-origin XSS on the host = shell

session lifecycle + graceful shutdown (DESIGN_REVIEW 1.3/1.4):
- track WebSockets per token (Map<token, Set<ws>> fed by the upgrade handler); POST /logout closes them — terminal gets a final "signed out" message, then the socket closes
- expiry model: sliding 7 d idle (as now) + 30 d absolute cap from login (Map<token, {exp, created}>) + cookie Max-Age refreshed on authed responses so browser and server agree; stolen token dies within 30 d even under constant use
- "log out everywhere" button on /settings: clears every token, closes every socket (recovery after suspected cookie theft)
- SIGTERM/SIGINT handler: stop accepting connections, send a new 'restart' WS message then close each socket, exit after drain with a short deadline (clients show "server restarting — reconnecting" and the existing backoff reattach lands back on the session)

sqlite landed (webpi.db: auth + hidden-sessions, node:sqlite, no WAL; under WEB_PI_STATE_DIR) — remaining: absorb job bookkeeping when the in-process scheduler lands

in-process job scheduler (DESIGN_REVIEW 3.1) — replaces systemd user units:
- drop systemd jobs.ts (unit files, systemctl, systemd-analyze); scheduler runs inside the server, keeping the run-inside-tmux behaviour (runs open on the shared socket — works in container, host, and the future two-container split)
- persistence: last-fired per job in the webpi.db state db (job_runs table — the DB exists now); on boot, compare last-fired against the schedule window and fire missed runs (systemd Persistent=true equivalent)
- cron-syntax validation moves in-app (small parser dep like cron-parser, or a restricted syntax we validate ourselves) — systemd-analyze is gone with systemd
- supercronic considered and rejected: same availability as in-process (dies with the container), no catch-up, plus crontab-rewrite/HUP coordination and an extra binary per install shape

deployment docs (DESIGN_REVIEW 2/3.1): document VPS/Docker as the recommended shape and single-EC2-with-Docker for AWS; say nothing about ECS (single-host-only note where deploy is discussed). No ECS-specific code — the SIGTERM handler and state dir arrive via the other TODOs anyway

/api/state perf: title cache keyed by (path, mtime) + async fs.promises scan — today the sidebar poll stats every session file and synchronously reads up to 200×64 KiB per open tab per 15 s, stalling the event loop (~40 ms @ 638 files on SSD, seconds on network storage) and freezing terminal traffic with it

update pi button, auto-update setting

privilege split: serving vs working (DESIGN_REVIEW 1.1) — before apps and self-modification are built on top:
- compose default becomes two containers sharing a tmux socket dir: web (uid A / node — code from the image, immutable: drop the --chown on /opt/web-pi; owns web state: auth, hidden-sessions, jobs.json → sqlite later; serves HTTP/WS; only ATTACHES to tmux) + workspace (uid B — runs the tmux server and every pi session; project checkouts and pi state/pi-agent on volumes)
- bookworm ships tmux 3.3a — meets the 3.3+ server-access bar for admitting uid A's clients to uid B's socket; verify it actually works for the uid pair
- the state-dir TODO above partitions by owner at split time: web state rides with uid A, pi-agent (provider credentials + sessions) rides with uid B
- wrinkle to design: web reads pi's session store for the sidebar/resume — sessions volume must be uid-A-readable (shared group) though uid B writes it; the scheduler TODO already fires onto the shared socket, unaffected
- README documents the two-unix-user equivalent for host installs (web-pi + web-pi-work, shared group, server-access) — same guarantees without Docker
- effect: a prompt injection in pi can no longer rewrite the server, replace auth.json, or plant persistence; self-modification becomes "pi edits a workspace checkout, the web-side apply step builds and swaps"

management page (replaces the panic-endpoint idea) — rollback AND applying changes in one place:
- the one unmodifiable part of the software: programmatic enforcement — the apply step rejects any patch that changes it from within the container; it can only be modified in the original project
- whole page, designed after the split lands (its "protected from modification" property is exactly what the split makes enforceable); handles picking a git commit, rebuilding, swapping, basic feedback

Don't load fontawesome icons from fontawesome - everything in-project (superseded by browser hardening above)

group sessions by app
ignore pi sessions not related to this project or one of its apps
console is an app
scheduler is an app
Top menu with all apps
new app
rename app
set app icon
delete app
console sidebar for when in other apps (in which case maybe console isn't an app)

self-naming sessions

Zed editor as a webapp
side-tab bar lets you open a given app
  pi
  zed
  terminal  
  app preview
generalise pi -> any agent

Better auth

when it stabilises, maybe build on pi-durable (is tmux still necessary with this?)

validation-enhancer
zod, astro/zod

app management mcp
how to build an app skills

grab soothing-booking's approach to APIs and error handling

low priority xterm official addons:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)

  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
  skip: attach (our WS JSON protocol is richer: attach modes, resize, errors, status), canvas (deprecated, removed in xterm 6)

  search addon + ctrl+F bar (wa-input cluster in terminal toolbar, NOT the session sidebar - 15s innerHTML poll eats state) server backfill via `tmux capture-pane -S -5000 -p` written to WS on attach so resumed sessions have searchable scrollback
  
  serialize - "download transcript" / "copy output" button, zero server changes; maybe e2e assertions on terminal state 

registry deploy flow - CI builds/pushes the image on tag, `docker compose pull` for boxes that shouldn't build

npm publish packaging - bin/files/prepublishOnly build so `npm i -g web-pi` is a real deploy channel

deploy polish (DESIGN_REVIEW 3.2): make the base path one documented value across README, nginx conf and the fail2ban filter (filter hard-codes POST /webpi/login with a NOTE to hand-adjust) — e.g. nginx sets a var, filter docs point at it

tmux sessions die with container restarts (sidebar resume covers it) - accept + document, or supervise tmux separately so it outlives the server process. NOTE: the privilege split resolves this — tmux moves to the workspace container, so web restarts/deploys no longer kill sessions; only workspace-container restarts do

installation instructions / script for agents / actual scripts

playwright
fuzz based integration testing


Human:
make sidebar much nicer - rebuild step by step
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill
