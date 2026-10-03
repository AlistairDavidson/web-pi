# AGENTS.md

Notes for coding agents working in this repo. Overview + architecture: see
README.md.

## Testing

`npm run test:e2e` — Playwright integration tests (chromium; browser must
exist in ~/.cache/ms-playwright). Fully hermetic: the config boots
`dist-server/server/main.js` against a `/tmp/web-pi-itest` workspace (own
auth file, fixture pi sessions, dedicated `web-pi-itest` tmux socket, a
deterministic `cmd.sh` session command). Tests must stay serial
(workers: 1): they share the per-IP login rate-limit budget and the tmux
socket, and the rate-limit test must run last. Build first (`npm run build`)
or let global-setup do it when dist/ is missing.

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
