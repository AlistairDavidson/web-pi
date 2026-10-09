apps folder that contains git submodules

deployment docs (DESIGN_REVIEW 2/3.1): document VPS/Docker as the recommended shape and single-EC2-with-Docker for AWS; say nothing about ECS (single-host-only note where deploy is discussed). No ECS-specific code — the SIGTERM handler and state dir arrive via the other TODOs anyway

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

winston logging and some kind of observability

Human:
make sidebar much nicer - rebuild step by step
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill
