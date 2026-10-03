# pi/ — the controlled pi agent-dir template

Everything in this directory is copied into the **runtime agent dir**
(default `<app root>/.pi-agent`, or `WEB_PI_AGENT_DIR` / `PI_CODING_AGENT_DIR`)
on every server boot — template files overwrite their runtime counterparts,
so this repo is the source of truth for pi's config. Files only pi itself
writes (`auth.json`, `sessions/`, caches, …) are never in the template and
are left alone in the runtime dir.

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
