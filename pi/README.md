# pi/ — the controlled pi agent-dir template

Everything in this directory is seeded into the **runtime agent dir**
(default `<app root>/.pi-agent`, or `WEB_PI_AGENT_DIR`) at server boot,
**only where the runtime dir doesn't already have the file** — existing
files always win, so config pi itself writes (settings.json) or the
operator customises is never clobbered, while template files added by
upgrades still land. Files only pi itself writes (`auth.json`,
`sessions/`, caches, …) are never in the template.

Spawned pi sessions get `PI_CODING_AGENT_DIR=<runtime dir>` — they never
read or write `~/.pi/agent`. Credentials therefore live per-install:
`/login` once inside a web-pi session, or seed `auth.json` yourself.

Layout mirrors pi's agent directory (`pi docs: configuration.md`):

| Path                    | Purpose                                  |
|-------------------------|------------------------------------------|
| `settings.json`         | pi settings (docs: settings.md)          |
| `mcp.json`              | MCP servers every session can use        |
| `models.json`           | compatible endpoints / model overrides   |
| `AGENTS.md`             | user instructions applied across cwds    |
| `SYSTEM.md` / `APPEND_SYSTEM.md` | replace / extend the system prompt |
| `keybindings.json`      | custom TUI keybindings                   |
| `extensions/`           | extensions shipped to every session      |
| `skills/`               | skills shipped to every session          |
| `prompts/`              | prompt templates (slash commands)        |
| `themes/`               | custom themes                            |

Project-level config (`.pi/` in a session's cwd) still applies on top of
this, per pi's normal precedence — trust prompts included.

## Shipping resources to every session

- **MCP servers** — `mcp.json`:
  `{"mcpServers": {"name": {"command": "…", "args": […]}}}` (pi docs:
  mcp.md). Available in every web-pi session — only add servers whose
  credentials you're happy exposing to everything a session can do.
- **Skills** — `skills/<name>/SKILL.md` (+ supporting files), loaded by
  every session.
- **Extensions** — `extensions/*.js`, loaded as ES modules at startup.
- **Prompt templates** — `prompts/<name>.md`, exposed as slash commands.

The shipped `settings.json` sets `quietStartup: "header"` — trims pi's
boot output to the header line, suited to a browser terminal. Because
seeding is only-if-absent, tuning settings from inside a session
(`/settings`) survives restarts.
