Pi should be a dependency and this project should keep it up to date and control the pi config / mcps / skills / extensions when deployed/installed (dev should not alter any global config).

tmux is also effectively a dependency and tmux config is certainly vital to a successful deployment - handle as much in-project as we can.

apps folder that contains git submodules

update pi button

console is an app

Top menu with all apps



deploy whole project not just dist to server, so you can do AI dev including self-modification right on server

rollback capability if you fuck up - a panic endpoint that is protected from modification and lets you pick a git commit and rebuild, give basic feedback.

Don't load fontawesome icons from fontawesome - everything in-project

group sessions by app
ignore pi sessions not related to this project or one of its apps

new app button

delete app button

session management tools
session search
delete session

self-naming sessions

Zed editor as a webapp
side-tab bar lets you open a given app
  pi
  zed
  terminal  
  app preview

max what we can get out of xterm and tmux - scroll wheel scrolling up the terminal instead of being interpreted as up arrow would be good

"cron" management (systemd backend)
  See jobs
  Open sessions - same functionality as main page
  
Better auth

DB backend (pi-durable supplies this?)

when it stabilises, build on pi-durable (is tmux still necessary with this?)

Make app a PWA

typed env vars - env.schema in astro.config.mjs → import from 'astro:env/server'

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

Human:
make sidebar much nicer - rebuild step by step, maybe
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill
