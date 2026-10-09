// e2e.spec.ts — integration tests against the real built app:
// Astro SSR pages, wa-* components upgraded client-side, auth, the
// sidebar's pi-session fixtures, and the full terminal round trip
// (xterm → WS → node-pty → tmux → back).
// Runs serially (workers: 1) — see playwright.config.ts.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { WebSocket as NodeWebSocket } from 'ws';
import { MARKER, PASSWORD, TMUX_SOCKET, USERNAME, UUIDV7_SIBLINGS, WORKSPACE } from './env';

const FIXTURE_A = '11111111-1111-1111-1111-111111111111';
const FIXTURE_B = '22222222-2222-2222-2222-222222222222';

/** Terminal sizing invariants, evaluated in the page:
 *  - the app shell is viewport-locked: the terminal never makes the page
 *    taller than the viewport (no page scrollbar);
 *  - the rendered rows fill .terminal-container (the xterm screen reaches the bottom
 *    of the box within one cell row) — i.e. the terminal tracks the
 *    available space, not its own previously rendered size. */
async function waitForTerminalFitted(page: Page, timeout = 5000): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('agent-terminal');
    const box = document.querySelector('agent-terminal .terminal-container');
    const screen = document.querySelector('agent-terminal .terminal-container .xterm-screen');
    if (!el || !box || !screen) return false;
    const rows = (el as unknown as { terminal?: { rows: number } }).terminal?.rows ?? 0;
    if (rows <= 0) return false;
    const b = box.getBoundingClientRect();
    const s = screen.getBoundingClientRect();
    const cellH = s.height / rows;
    return document.documentElement.scrollHeight <= window.innerHeight + 1
      && b.height - s.height <= cellH + 1;
  }, null, { timeout });
}

/** The browser terminal's current cols/rows. */
async function termDims(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const t = (document.querySelector('agent-terminal') as unknown as { terminal: { cols: number; rows: number } })
      .terminal;
    return { cols: t.cols, rows: t.rows };
  });
}

/** Wait until the terminal's buffer contains `text`.
 *  Asserts on the buffer, not the DOM: the WebGL renderer draws rows to a
 *  canvas, so .terminal-container has no text nodes to assert on. */
async function waitForTermText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    marker => {
      const el = document.querySelector('agent-terminal') as unknown as
        | { terminal?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined } } } }
        | null;
      const buf = el?.terminal?.buffer.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true).includes(marker)) return true;
      }
      return false;
    },
    text,
    { timeout }
  );
}

async function termRows(page: Page): Promise<number> {
  return (await termDims(page)).rows;
}

async function signIn(page: Page): Promise<void> {
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', PASSWORD);
  await page.click('wa-button:has-text("sign in")');
}

/** Lands on the signed-in console. The first call signs in through the
 *  real login form; later calls reuse that session cookie — every
 *  POST /login spends the per-IP budget (10 / 15 min) that the last test
 *  exhausts on purpose. */
let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie = (await page.context().cookies()).find(c => c.name === 'webpi_session') ?? null;
  }
  await page.waitForSelector('session-sidebar .nav');
}

test('unauthenticated / serves the login page with upgraded wa-* controls', async ({ page }) => {
  await page.goto('/');
  // No redirect for unauthenticated / — the server rewrites to login SSR.
  expect(page.url()).toMatch(/\/$/);
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await expect(page.locator('wa-input#password input[type=password]')).toHaveCount(1);
  await expect(page.locator('wa-button:has-text("sign in")')).toHaveCount(1);
  // The layout's SSR'd <wa-toast> must also upgrade client-side (AGENTS.md:
  // SSR ≠ client) — its create() only exists after the component defines.
  await page.waitForFunction(() => {
    const t = document.querySelector('wa-toast');
    return !!t && typeof (t as HTMLElement & { create?: unknown }).create === 'function';
  });
});

test('API routes stay guarded without a session', async ({ request }) => {
  expect((await request.get('/api/state')).status()).toBe(401);
  expect((await request.get('/api/jobs')).status()).toBe(401);
  // Unknown API paths are 401 too — never the login page.
  expect((await request.get('/api/nope')).status()).toBe(401);
  expect((await request.post('/api/session/hide', { data: { id: FIXTURE_A } })).status()).toBe(401);
  expect((await request.post('/api/session/unhide', { data: { id: FIXTURE_A } })).status()).toBe(401);
});

test('bad credentials show the danger callout', async ({ page }) => {
  await page.goto('/login');
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', 'wrong-password');
  await page.click('wa-button:has-text("sign in")');
  await expect(page.locator('wa-callout#error:not(.hidden)')).toContainText('invalid credentials');
});

test('login lands on the console with fixture sessions in the sidebar', async ({ page }) => {
  await login(page);
  await expect(page.locator('console-app wa-page')).toHaveCount(1);
  await expect(page.locator('agent-terminal .terminal-container .xterm')).toHaveCount(1);

  // The WebGL renderer is lazy-imported as an async chunk; once it loads,
  // xterm swaps its DOM rows for canvas rendering (the addon mounts >1
  // canvas, so assert presence, not an exact count). Headless Chromium has
  // SwiftShader WebGL, so the renderer should engage.
  await page.waitForFunction(
    () => document.querySelectorAll('agent-terminal .terminal-container canvas').length > 0,
    null, { timeout: 10_000 }
  );

  const nav = page.locator('session-sidebar .nav');
  await expect(nav).toContainText('fix the login bug in auth module');
  await expect(nav).toContainText('refactor the tmux helpers');
  await expect(nav).toContainText('deploy checklist review');
  // Sessions grouped by cwd: two groups across the five fixtures.
  await expect(nav.locator('li.group')).toHaveCount(2);
});

test('new session: created, attached, terminal round-trips input', async ({ page }) => {
  await login(page);

  await page.fill('wa-input#new-name input', 'itest-live');
  await page.click('wa-button#new-btn');
  await expect(page.locator('session-sidebar li[data-live="itest-live"]')).toHaveCount(1);

  // WS attach → tmux → banner from the session command appears in xterm.
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached');

  // Full loop: keystrokes in xterm → WS → pty → tmux → output rendered.
  // $((41+1)) distinguishes the shell's evaluated output (TYPIST_42) from
  // the locally echoed command line (which contains the expression).
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type('echo TYPIST_$((41+1))\n');
  await waitForTermText(page, 'TYPIST_42', 10_000);
});

test('resume a past session from the sidebar', async ({ page }) => {
  await login(page);
  await page.click(`session-sidebar li[data-resume="${FIXTURE_A}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });
  await waitForTermText(page, MARKER);
});

test('resuming sessions whose ids share a prefix gives each its own tmux session', async ({ page }) => {
  // pi ids are UUIDv7: the first 8 hex chars are a timestamp, so sessions
  // started close together share them. Regression: resume named its tmux
  // session r-<first 8 chars> and reused it, attaching the second resume
  // to the first one's running pi.
  const [one, two] = UUIDV7_SIBLINGS;
  await login(page);
  await page.click(`session-sidebar li[data-resume="${one}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: r-${one}`, { timeout: 20_000 });
  await page.click(`session-sidebar li[data-resume="${two}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: r-${two}`, { timeout: 20_000 });

  const names = execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
    { encoding: 'utf8' }).split('\n');
  expect(names).toContain(`r-${one}`);
  expect(names).toContain(`r-${two}`);
});

test('a paste bigger than one WebSocket frame reaches the session whole', async ({ page }) => {
  test.setTimeout(60_000);
  // > the server's 1 MiB maxPayload: only arrives if the client chunks it.
  const size = 1_200_000;
  const out = `${WORKSPACE}/paste.out`;
  await login(page);
  await page.fill('wa-input#new-name input', 'itest-paste');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);

  // Raw mode + no echo on the pane's tty so head sees the paste byte for
  // byte (a canonical-mode line is capped at 4 KiB by the kernel, which
  // would make this a test of the tty rather than of web-pi).
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type(`stty raw -echo; echo RAW_$((40+2)); head -c ${size} > ${out}; stty sane\n`);
  await waitForTermText(page, 'RAW_42');
  await page.evaluate(n => {
    const el = document.querySelector('agent-terminal') as unknown as { terminal: { paste(d: string): void } };
    el.terminal.paste('x'.repeat(n));
  }, size);

  await expect.poll(() => {
    try { return fs.statSync(out).size; } catch { return -1; }
  }, { timeout: 30_000 }).toBe(size);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-paste');
});

test('a dropped socket reconnects to the same session; a session that ends is not retried', async ({ page }) => {
  await login(page);
  await page.fill('wa-input#new-name input', 'itest-reconnect');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-reconnect');

  // Drop the socket the way a proxy idle cut does: closed under the
  // component, with no 'exit' from the server first.
  await page.evaluate(() =>
    (document.querySelector('agent-terminal') as unknown as { websocket: WebSocket }).websocket.close());
  await expect(page.locator('.terminal-status')).toContainText('reconnecting');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-reconnect', { timeout: 10_000 });
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type('echo BACK_$((40+2))\n');
  await waitForTermText(page, 'BACK_42');

  // The session itself ending arrives as the server's 'exit': reported,
  // never reconnected (that would also loop two tabs bumping each other).
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'itest-reconnect']);
  await expect(page.locator('.terminal-status.info')).toContainText('detached: itest-reconnect');
  await page.waitForTimeout(2500); // longer than the first reconnect backoff
  await expect(page.locator('.terminal-status.info')).toContainText('detached: itest-reconnect');
});

test('malformed requests and frames are rejected without taking the server down', async ({ page }) => {
  await login(page);
  // In-page fetch, not page.request: Playwright's API client doesn't send
  // the Secure session cookie over the suite's plain-http origin.
  const status = (method: string, url: string, body?: string): Promise<number> =>
    page.evaluate(async ([m, u, b]) => (await fetch(u!, {
      method: m!, headers: { 'Content-Type': 'application/json' }, ...(b === undefined ? {} : { body: b }),
    })).status, [method, url, body] as const);

  // A bad %-escape in a path segment threw out of the request handler and
  // killed the process; now it's a 400.
  expect(await status('DELETE', '/api/jobs/%E0')).toBe(400);
  expect(await status('POST', '/api/jobs/%E0/run')).toBe(400);
  // JSON bodies must be objects.
  expect(await status('POST', '/api/session/hide', '[]')).toBe(400);
  expect(await status('POST', '/api/new', '"just a string"')).toBe(400);

  // Junk WS frames — before and after attaching (`null` and a data-less
  // input each used to crash the server) — are dropped; the socket lives on.
  expect(await status('POST', '/api/new', '{"name":"itest-junk"}')).toBe(200);
  const junk = ['null', '[]', '"x"', 'not json', '{"type":"input"}', '{"type":"input","data":5}',
    '{"type":"resize","cols":"wide"}', '{"type":"attach","mode":"live"}', '{"type":"attach","mode":"resume","id":7}'];
  const stillOpen = await page.evaluate(async frames => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    for (const f of frames) ws.send(f);
    ws.send(JSON.stringify({ type: 'attach', mode: 'live', target: 'itest-junk' }));
    await new Promise<void>(resolve => {
      ws.onmessage = ev => { if ((JSON.parse(ev.data as string) as { type: string }).type === 'attached') resolve(); };
    });
    for (const f of frames) ws.send(f);
    await new Promise(r => setTimeout(r, 300));
    const open = ws.readyState === WebSocket.OPEN;
    ws.close();
    return open;
  }, junk);
  expect(stillOpen).toBe(true);
  expect(await status('GET', '/api/state')).toBe(200);
});

test('attached session opens at the browser terminal\'s size, not 80x24', async ({ page }) => {
  await login(page);

  // The client sends {attach} then {resize} back-to-back on WS open; the
  // server must carry that size across its async tmux lookup and spawn the
  // pty at it (regression: resize was dropped pre-spawn, so the session
  // opened 80x24 in the corner of a larger browser terminal).
  await page.fill('wa-input#new-name input', 'itest-openfit');
  await page.click('wa-button#new-btn');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });
  await waitForTerminalFitted(page);

  const dims = await termDims(page);
  expect(dims.cols).toBeGreaterThan(100); // default viewport is far wider than 80

  const pane = execFileSync('tmux',
    ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', 'itest-openfit:0.0', '#{pane_width}x#{pane_height}'],
    { encoding: 'utf8' }).trim();
  const [w, h] = pane.split('x').map(Number) as [number, number];
  expect(w).toBe(dims.cols);
  // tmux's status line takes one row of the attached client.
  expect(h).toBeGreaterThanOrEqual(dims.rows - 1);
});

test('terminal fills the available space and refits when it shrinks', async ({ page }) => {
  await login(page);

  // Attach so the status bar is in its final state before measuring.
  await page.fill('wa-input#new-name input', 'itest-fill');
  await page.click('wa-button#new-btn');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });

  // At load the terminal must fill the viewport-height box without
  // pushing the page past the viewport.
  await waitForTerminalFitted(page);
  const rowsBefore = await termRows(page);

  // Shrink the viewport: the available space drops, so the box must shrink
  // and the terminal must refit to fewer rows — still filling the box.
  await page.setViewportSize({ width: 1280, height: 500 });
  await waitForTerminalFitted(page);
  expect(await termRows(page)).toBeLessThan(rowsBefore);
});

// jobs (scheduled jobs, systemd user units): the suite must pass both
// with and without a reachable `systemctl --user` (CI containers and
// Docker deploys have none). What runs everywhere is the degraded-mode
// contract: the /jobs page shows an explanatory notice and the API
// answers 200/503 — never a stack of 500s. On a host with a working user
// session (e.g. a dev box) degraded mode isn't reachable — the server
// would find systemctl usable — so the test skips there; full CRUD needs
// the real backend. To force degraded mode on such a host, point
// WEB_PI_SYSTEMCTL at a stub binary when booting the server.
const systemdUserSession = (() => {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

test('jobs page degrades to a notice when systemctl --user is absent', async ({ page, request }) => {
  test.skip(systemdUserSession, 'systemd user session present — degraded mode not reachable');
  expect((await request.get('/api/jobs')).status()).toBe(401);

  await login(page);
  await expect(page.locator('wa-button#nav-jobs')).toHaveCount(1);

  // Authenticated calls go through the page, not page.request — the
  // API client doesn't send the Secure session cookie over the suite's
  // plain-http origin (AGENTS.md).
  const api = (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> =>
    page.evaluate(async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json: unknown = null;
      try { json = await r.json(); } catch { /* not json */ }
      return { status: r.status, body: json };
    }, { method, path, body });

  const r = await api('GET', '/api/jobs');
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ available: false, jobs: [] });

  await page.goto('/jobs');
  await expect(page.locator('wa-callout#jobs-degraded:not(.hidden)')).toBeVisible();
  await expect(page.locator('wa-callout#jobs-degraded')).toContainText('systemctl --user');
  await expect(page.locator('wa-button#jobs-new.hidden')).toHaveCount(1);

  const validate = await api('POST', '/api/jobs/validate', { schedule: 'daily 08:00' });
  expect(validate.status).toBe(200);
  const check = validate.body as { valid: boolean; validatedBy: string };
  expect(check.valid).toBe(true);
  expect(['basic', 'systemd-analyze']).toContain(check.validatedBy);

  // Mutations degrade to 503 (not 500) while the backend is unusable.
  expect((await api('POST', '/api/jobs', { name: 'itest-job', schedule: 'daily 08:00', command: 'true' })).status).toBe(503);
  expect((await api('POST', '/api/jobs/itest-job/run')).status).toBe(503);
  expect((await api('DELETE', '/api/jobs/itest-job')).status).toBe(503);
});

test('hide: session leaves the sidebar, manage dialog restores it', async ({ page }) => {
  await login(page);
  const row = page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`);
  await expect(row).toContainText('refactor the tmux helpers');

  // The row action asks for confirmation before hiding.
  await row.locator('wa-button[data-hide]').click();
  const confirm = page.locator('wa-dialog#confirm-hide');
  await expect(confirm.locator('#confirm-hide-title')).toContainText('refactor the tmux helpers');
  await confirm.locator('wa-button#confirm-hide-ok').click();

  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);
  await expect(page.locator('session-sidebar #session-list')).not.toContainText('refactor the tmux helpers');

  // "N hidden — manage" appears; the dialog (outside the poll-rendered
  // sidebar) lists the hidden session and unhides it.
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toContainText('1 hidden');
  await page.click('session-sidebar wa-button#manage-hidden');
  const dialog = page.locator('wa-dialog#hidden-dialog');
  await expect(dialog.locator('.hidden-row .t-name')).toContainText('refactor the tmux helpers');
  await dialog.locator('wa-button[data-unhide]').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(1);
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toHaveCount(0);
});

test('hide persists across reload in the sqlite state db', async ({ page }) => {
  await login(page);
  await page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"] wa-button[data-hide]`).click();
  await page.locator('wa-dialog#confirm-hide wa-button#confirm-hide-ok').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);

  await page.reload();
  await page.waitForSelector('session-sidebar .nav');
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toContainText('1 hidden');

  // The state db carries the id (hide ≠ delete: the fixture session file
  // is untouched).
  const db = new DatabaseSync(`${WORKSPACE}/webpi.db`);
  const hidden = db.prepare('SELECT session_id FROM sessions WHERE hidden_at IS NOT NULL').all() as Array<{ session_id: string }>;
  db.close();
  expect(hidden.map(r => r.session_id)).toContain(FIXTURE_B);
  expect(fs.existsSync(`${WORKSPACE}/sessions/alpha/2026-10-02T10-00-00_${FIXTURE_B}.jsonl`)).toBe(true);

  // Tidy via unhide-all so later tests see a clean list.
  await page.click('session-sidebar wa-button#manage-hidden');
  await page.locator('wa-dialog#hidden-dialog wa-button#unhide-all').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(1);
});

test('search filters the past-session list and survives the poll re-render', async ({ page }) => {
  await login(page);
  const search = page.locator('wa-input#session-search input');

  // Title match: one row, one cwd group, count badge follows.
  await search.fill('login bug');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
  await expect(page.locator('session-sidebar li[data-resume]')).toContainText('fix the login bug');
  await expect(page.locator('session-sidebar li.group')).toHaveCount(1);
  await expect(page.locator('session-sidebar #sessions-count')).toHaveText('1');

  // cwd match and the empty state.
  await search.fill('/srv');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
  await expect(page.locator('session-sidebar li[data-resume]')).toContainText('deploy checklist review');
  await search.fill('zzz-no-match');
  await expect(page.locator('session-sidebar li.empty')).toContainText('no sessions match');

  // Escape clears.
  await search.press('Escape');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(5);

  // A state poll re-render (the 15s interval, forced here) must not eat
  // the search box: value, focus and caret are restored.
  await search.fill('tmux');
  await page.keyboard.press('ArrowLeft'); // caret mid-string, not at the end
  const caretBefore = await page.evaluate(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretBefore).toBe(3);
  await page.evaluate(() =>
    (document.querySelector('console-app') as unknown as { loadState(): Promise<void> }).loadState());
  await page.waitForFunction(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    const native = wa.shadowRoot?.querySelector('input') ?? null;
    // Focus inside an open shadow root retargets document.activeElement to
    // the host, so accept either the host or the inner input being focused.
    return native != null && native.value === 'tmux'
      && (document.activeElement === wa || wa.shadowRoot?.activeElement === native);
  });
  const caretAfter = await page.evaluate(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretAfter).toBe(caretBefore);
  // The filter is still applied after the re-render.
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
});

test('signed out, any page URL serves the login page and sign-in returns to it', async ({ page }) => {
  // Regression: /jobs answered a bare "unauthorized" while / and /settings
  // rendered the login page.
  await page.goto('/jobs');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await signIn(page);
  await expect(page.locator('jobs-app .jobs-main')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/jobs');
});

test('unauthenticated /settings serves the login page; settings APIs stay guarded', async ({ page, request }) => {
  await page.goto('/settings');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  expect((await request.get('/api/settings')).status()).toBe(401);
  expect((await request.post('/api/update-pi', { data: {} })).status()).toBe(401);
});

test('settings dashboard shows effective config; update dry-run is check-only', async ({ page }) => {
  await login(page);
  // The console header's gear link is the way in.
  await expect(page.locator('.nav-actions wa-button[href$="/settings"]')).toBeVisible();
  await page.goto('/settings');

  const cfg = page.locator('#config');
  await expect(cfg.locator('.cfg-row')).toHaveCount(12);
  const text = await cfg.innerText();
  expect(text).toContain('web-pi-itest');             // tmux socket (config env)
  expect(text).toContain('cmd.sh');                   // session command
  expect(text).toContain('/tmp/web-pi-itest/sessions'); // sessions dir
  expect(text).toContain('/tmp/web-pi-itest/webpi.db'); // state db path — path only, never contents
  await expect(page.locator('#pi-badge')).toContainText(/pi /);
  await expect(page.locator('#pi-declared')).toContainText('declared');

  // Check-only dry-run through the authed page — installs nothing.
  const dry = await page.evaluate(async () => {
    const r = await fetch('/api/update-pi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":true}',
    });
    return { status: r.status, body: await r.json() };
  });
  expect(dry.status).toBe(200);
  expect(dry.body.ok).toBe(true);
  expect(dry.body.dryRun).toBe(true);
  expect(dry.body.output).toContain('would run');
});

// ---------- browser hardening (DESIGN_REVIEW §1.2) ----------

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' wss:; frame-ancestors 'none'";

/** The four security headers every app-sent response carries. */
function expectSecurityHeaders(headers: Record<string, string>): void {
  expect(headers['content-security-policy']).toBe(CSP);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
}

test('non-GET requests with a foreign Origin are rejected; no Origin behaves normally', async ({ page, request }) => {
  await page.goto('/login'); // establish the suite origin for the page below
  // A present-but-mismatched Origin (sibling subdomain, sandboxed "null")
  // is 403 before auth is even consulted.
  for (const origin of ['https://evil.example', 'https://console.example.com', 'null']) {
    const r = await request.post('/api/session/hide', { headers: { Origin: origin }, data: { id: FIXTURE_A } });
    expect(r.status(), `Origin: ${origin}`).toBe(403);
  }
  // No Origin header at all (curl, API clients) and a matching Origin both
  // reach the normal auth gate — 401 here, this context has no session.
  expect((await request.post('/api/session/hide', { data: { id: FIXTURE_A } })).status()).toBe(401);
  const origin = new URL(page.url()).origin;
  expect((await request.post('/api/session/hide', { headers: { Origin: origin }, data: { id: FIXTURE_A } })).status()).toBe(401);

  // The browser path — a same-origin POST from an authed page — keeps
  // working (the browser attaches the page's own Origin).
  await login(page);
  expect(await page.evaluate(async () =>
    (await fetch('/api/session/unhide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"all":true}',
    })).status)).toBe(200);
});

test('WS upgrades demand a matching Origin — missing or foreign destroys the socket', async ({ page }) => {
  await login(page);
  const token = (await page.context().cookies()).find(c => c.name === 'webpi_session')?.value ?? '';
  const wsOrigin = new URL(page.url()).origin;

  // Raw ws client from the test process: browsers can't omit or forge
  // Origin, so the gate is only observable from Node.
  const attempt = (headers: Record<string, string>): Promise<'open' | 'rejected'> =>
    new Promise(resolve => {
      const ws = new NodeWebSocket(`${wsOrigin.replace(/^http/, 'ws')}/ws`, { headers });
      let settled = false;
      const settle = (v: 'open' | 'rejected'): void => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* never opened */ }
        resolve(v);
      };
      ws.on('open', () => settle('open'));
      ws.on('error', () => settle('rejected'));
      ws.on('unexpected-response', () => settle('rejected'));
      ws.on('close', () => settle('rejected'));
    });

  // Missing Origin: the endpoint is browser-only — no curl/websocat
  // terminals — so the socket is destroyed, not a polite 4xx.
  expect(await attempt({})).toBe('rejected');
  // Foreign Origin (cross-site WebSocket hijacking) is destroyed too.
  expect(await attempt({ Origin: 'https://evil.example' })).toBe('rejected');
  // A matching Origin without a session gets the 401 handshake, and with
  // the session cookie the upgrade completes.
  expect(await attempt({ Origin: wsOrigin })).toBe('rejected');
  expect(await attempt({ Origin: wsOrigin, Cookie: `webpi_session=${token}` })).toBe('open');
});

test('security headers ride on page, asset and API responses', async ({ request }) => {
  const page = await request.get('/login');
  expect(page.status()).toBe(200);
  expectSecurityHeaders(page.headers());

  // A hashed Astro asset referenced by that page (external module — the
  // CSP's script-src 'self' depends on Astro never inlining scripts).
  const src = (await page.text()).match(/<script[^>]*\bsrc="([^"]+)"/)?.[1];
  expect(src).toBeTruthy();
  const asset = await request.get(src!);
  expect(asset.status()).toBe(200);
  expectSecurityHeaders(asset.headers());

  // An API response (this 401 is itself sent by the app, headers and all).
  const api = await request.get('/api/state');
  expect(api.status()).toBe(401);
  expectSecurityHeaders(api.headers());
});

test('console/jobs/settings load requests nothing off-origin and glyphs render from the app itself', async ({ page }) => {
  await login(page);
  const self = new URL(page.url()).origin;
  const external: string[] = [];
  // Aborting (not just observing) proves the page works without them:
  // under the CSP a CDN icon fetch would fail and the glyph would vanish.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== self) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });

  const glyphsRender = (): Promise<boolean> =>
    page.waitForFunction(() => {
      const icons = [...document.querySelectorAll('wa-icon')];
      return icons.length > 0 && icons.every(i => i.shadowRoot?.querySelector('svg') != null);
    }, null, { timeout: 8000 }).then(() => true, () => false);

  await page.goto('/');
  await page.waitForSelector('session-sidebar .nav');
  expect(await glyphsRender()).toBe(true);
  for (const p of ['/jobs', '/settings']) {
    await page.goto(p);
    expect(await glyphsRender(), `${p} glyphs`).toBe(true);
  }
  expect(external).toEqual([]);
});

test('login rate limit kicks in (10 per 15 min per IP) and ignores a spoofed X-Forwarded-For', async ({ request }) => {
  // Runs last: earlier tests already spent part of the shared budget.
  // Every attempt claims a different client IP. The server runs with
  // WEB_PI_TRUST_PROXY unset (0), so the header must be ignored and every
  // attempt counted against the real peer — regression: the leftmost XFF
  // entry was trusted, so rotating it never hit 429.
  let saw429 = false;
  for (let i = 0; i < 15 && !saw429; i++) {
    const r = await request.post('/login', {
      data: { username: USERNAME, password: 'nope' },
      headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
    });
    if (r.status() === 429) saw429 = true;
  }
  expect(saw429).toBe(true);
});
