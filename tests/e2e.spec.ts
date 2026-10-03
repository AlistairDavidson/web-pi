// e2e.spec.ts — integration tests against the real built app:
// Astro SSR pages, wa-* components upgraded client-side, auth, the
// sidebar's pi-session fixtures, and the full terminal round trip
// (xterm → WS → node-pty → tmux → back).
// Runs serially (workers: 1) — see playwright.config.ts.
import { expect, test, type Page } from '@playwright/test';
import { MARKER, PASSWORD, USERNAME } from './env';

const FIXTURE_A = '11111111-1111-1111-1111-111111111111';

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

async function termRows(page: Page): Promise<number> {
  return page.evaluate(() =>
    (document.querySelector('agent-terminal') as unknown as { terminal: { rows: number } })
      .terminal.rows);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', PASSWORD);
  await page.click('wa-button:has-text("sign in")');
  await page.waitForURL(u => u.pathname === '/');
  await page.waitForSelector('session-sidebar .nav');
}

test('unauthenticated / serves the login page with upgraded wa-* controls', async ({ page }) => {
  await page.goto('/');
  // No redirect for unauthenticated / — the server rewrites to login SSR.
  expect(page.url()).toMatch(/\/$/);
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await expect(page.locator('wa-input#password input[type=password]')).toHaveCount(1);
  await expect(page.locator('wa-button:has-text("sign in")')).toHaveCount(1);
});

test('API routes stay guarded without a session', async ({ request }) => {
  expect((await request.get('/api/state')).status()).toBe(401);
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

  const nav = page.locator('session-sidebar .nav');
  await expect(nav).toContainText('fix the login bug in auth module');
  await expect(nav).toContainText('refactor the tmux helpers');
  await expect(nav).toContainText('deploy checklist review');
  // Sessions grouped by cwd: two groups across the three fixtures.
  await expect(nav.locator('li.group')).toHaveCount(2);
});

test('new session: created, attached, terminal round-trips input', async ({ page }) => {
  await login(page);

  await page.fill('wa-input#new-name input', 'itest-live');
  await page.click('wa-button#new-btn');
  await expect(page.locator('session-sidebar li[data-live="itest-live"]')).toHaveCount(1);

  // WS attach → tmux → banner from the session command appears in xterm.
  const term = page.locator('agent-terminal .terminal-container');
  await expect(term).toContainText(MARKER, { timeout: 20_000 });
  await expect(page.locator('.terminal-status.ok')).toContainText('attached');

  // Full loop: keystrokes in xterm → WS → pty → tmux → output rendered.
  // $((41+1)) distinguishes the shell's evaluated output (TYPIST_42) from
  // the locally echoed command line (which contains the expression).
  await term.click();
  await page.keyboard.type('echo TYPIST_$((41+1))\n');
  await expect(term).toContainText('TYPIST_42', { timeout: 10_000 });
});

test('resume a past session from the sidebar', async ({ page }) => {
  await login(page);
  await page.click(`session-sidebar li[data-resume="${FIXTURE_A}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });
  await expect(page.locator('agent-terminal .terminal-container')).toContainText(MARKER);
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

test('login rate limit kicks in (10 per 15 min per IP)', async ({ request }) => {
  // Runs last: earlier tests already spent part of the shared budget.
  let saw429 = false;
  for (let i = 0; i < 15 && !saw429; i++) {
    const r = await request.post('/login', { data: { username: USERNAME, password: 'nope' } });
    if (r.status() === 429) saw429 = true;
  }
  expect(saw429).toBe(true);
});
