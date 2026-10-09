# AGENTS.md

Notes for coding agents working in this repo. Overview + architecture: see
README.md.

## Testing

`npm run test:unit` — node:test units in `tests/unit/` against the
compiled `dist-server` — `npm run build` first (tsc-only is enough:
`tsc -p tsconfig.server.json && npm run test:unit`).

`npm run test:e2e` — Playwright integration tests (chromium; browser must
exist in ~/.cache/ms-playwright). Fully hermetic: the config boots
`dist-server/server/main.js` against a `/tmp/web-pi-itest` workspace (own
state db, fixture pi sessions, dedicated `webpi-itest` tmux socket, a
deterministic `cmd.sh` session command). Tests must stay serial
(workers: 1): they share the per-IP login rate-limit budget and the tmux
socket, and the rate-limit test must run last. `login()` signs in through
the form once and reuses that cookie, which keeps the suite inside the
budget (10 / 15 min), so use it in new tests rather than signing in again.
For authenticated API calls use in-page `fetch` (`page.evaluate`), not
`page.request`: Playwright's API client doesn't send the `Secure` session
cookie over the suite's plain-http origin. Build first (`npm run build`)
or let global-setup do it when dist/ is missing.

## node:sqlite

The state db (`src/lib/db.ts`) uses the built-in `node:sqlite`, which
still prints a one-line `ExperimentalWarning: SQLite is an experimental
feature…` the first time it loads in a process. **This warning is
expected** — it appears in the server's boot log, `set-password` output
and e2e webServer/test stderr, and means nothing is wrong. Don't add
suppression for it.

## Web Awesome (wa-*) components: SSR imports ≠ client imports

Astro frontmatter imports are **server-only**. Importing
`@awesome.me/webawesome/dist/components/<name>/<name>.js` in frontmatter SSRs
the component (astro-lit, declarative shadow DOM) but does **not** ship its JS
to the browser. The page will *look* fine, but the element never upgrades:
form controls lose form association (submit/Enter do nothing), `.value` is
missing, toggles are dead. This broke the login page once — caught only by
end-to-end testing.

**Rule:** every SSR'd `wa-*` component must *also* be imported in a
client-side `<script>` (see `src/pages/login.astro` for both halves, and
`src/components/ConsoleApp/ConsoleApp.astro` + `console-app.ts` for the
same split inside an Astro component wrapper). The client script must
import `@awesome.me/astro-lit/dsd-polyfill.js` and
`hydration-support.js` **before** any wa-* module — if the SSR'd element
defines first, Lit renders a second copy next to the declarative-shadow-
DOM content (everything appears twice; layout doubles in height). After
adding a `wa-*` element to a page, verify it
upgrades in a real browser (headless Chromium via the playwright install in
`~/projects/validation-enhancer` works), not just in the SSR HTML.

## UI conventions

- New UI goes on Web Awesome components/utilities/tokens, not hand-rolled
  HTML/CSS (`.agents/skills/webawesome*` are the references). The app's
  identity lives in the `:root` semantic-token overrides in
  `src/styles/console.css` — extend those rather than adding hex/px literals.
- `console.css` is unlayered on purpose (must win over @layer'd Web Awesome
  styles) and is the only sanctioned place for hex colors.
- The session sidebar re-renders via `innerHTML` on a 15s poll — preserve
  transient state (e.g. input value/focus) in `render()`, and don't put
  stateful components (e.g. `wa-details`) in it.
- `agent-terminal` sizes itself with a `ResizeObserver` on `.terminal-container`; new
  layout around it must keep the box able to resize for any reason, not just
  window resizes.

## Fleet merge process

Fleet work lands on `task/*` branches (one per worker, all cut from the same
base). Integration is ONE BRANCH AT A TIME, reviewed as a staged whole —
never a blind merge commit:

1. Pick the next branch by dependency/conflict order, not launch order
   (plumbing before features that build on it; docs consolidation last).
2. `git merge --no-ff --no-commit <branch>` — the entire merged change sits
   STAGED on main with nothing committed (equivalent to merging, then
   undoing the commit so the whole change is staged). Resolve conflicts
   keeping BOTH branches' intent, and wire up junctions the workers designed
   to meet (they leave each other explicitly-marked hooks — read their
   comments).
3. Verify the merged tree before review: `npm ci` if the lockfile moved,
   `npm run build`, `npm run test:unit` (if the branch added one),
   `npm run test:e2e`.
4. Present the change as aspects with reviewer notes; the human edits and
   discusses the staged change until satisfied. Then it lands as ONE commit
   per branch on main (the granular history stays on the `task/*` ref),
   and the next branch starts at step 1.
