apps folder that contains git submodules

settings page

postgres container, move state files and auth to that

update pi button, auto-update setting

console is an app

Top menu with all apps

rollback capability if you fuck up - a panic endpoint that is protected from modification and lets you pick a git commit and rebuild, give basic feedback.

Don't load fontawesome icons from fontawesome - everything in-project

group sessions by app
ignore pi sessions not related to this project or one of its apps

new app button

delete app button

self-naming sessions

Zed editor as a webapp
side-tab bar lets you open a given app
  pi
  zed
  terminal  
  app preview

max what we can get out of xterm and tmux - scroll wheel scrolling up the terminal instead of being interpreted as up arrow would be good

Better auth

DB backend (pi-durable supplies this?)

when it stabilises, build on pi-durable (is tmux still necessary with this?)

Make app a PWA

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

push to github so dependabot wakes up (.github/dependabot.yml is wired: npm weekly incl pi ^1, docker base images)

registry deploy flow - CI builds/pushes the image on tag, `docker compose pull` for boxes that shouldn't build

npm publish packaging - bin/files/prepublishOnly build so `npm i -g web-pi` is a real deploy channel

tmux sessions die with container restarts (sidebar resume covers it) - accept + document, or supervise tmux separately so it outlives the server process

wheel-scroll decision: tmux mouse on + pi tuiMode regular gives wheel-scrollback but loses fullscreen pi (tradeoff documented in tmux.conf)

setup instructions / script for agents / actual scripts

Human:
make sidebar much nicer - rebuild step by step
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill
