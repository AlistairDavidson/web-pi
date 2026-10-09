// sessions-cache.spec.ts — unit-level pins on the /api/state scan's title
// cache (src/lib/sessions.ts): a warm scan re-opens nothing, each half of
// the (mtime, size) cache key invalidates on its own, and entries for
// gone files leave the cache (pruning). Runs against the compiled
// dist-server artifact (like tests/state-dir.spec.ts and global-setup): a
// non-page Playwright spec — no browser, no login, own tmp store, so the
// serial suite's shared login budget is untouched. The module-level title
// cache persists across the calls within this spec — exactly the property
// under test; each spec file runs in its own worker process, so the
// fs.promises.open spy below never leaks into other specs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const A_ID = 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb';

test('title cache: warm scan re-opens nothing; mtime and size each invalidate alone; gone files prune', async () => {
  const { promises: fsp } = await import('node:fs');
  const { listSessions } = await import(pathToFileURL(
    path.join(ROOT, 'dist-server', 'src', 'lib', 'sessions.js')).href);

  // Count the module's file reads through the fs.promises object this
  // process shares with the compiled module (sessions.ts reads via
  // fsp.open, so a property swap here sees every read; readdir/stat stay
  // real — only the bounded per-file reads are what the cache skips).
  const realOpen = fsp.open;
  let opens = 0;
  (fsp as { open: typeof fsp.open }).open =
    async (...args: Parameters<typeof fsp.open>) => {
      opens++;
      return realOpen(...args);
    };
  try {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-sessions-cache-'));
    const scope = path.join(store, 'proj');
    fs.mkdirSync(scope);
    const nameA = `2026-10-02T13-00-00_${A_ID}.jsonl`;
    const nameB = `2026-10-02T13-01-00_${B_ID}.jsonl`;
    const header = (id: string): string =>
      JSON.stringify({ type: 'session', id, timestamp: '2026-10-02T13:00:00.000Z', cwd: '/tmp/cache-unit' });

    // Whole-second mtimes (utimes round-trips integer seconds exactly) so
    // each cache-key half can be isolated deterministically — the
    // coarse-mtime case the size half exists for.
    const T = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    fs.writeFileSync(path.join(scope, nameA), [
      header(A_ID),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'first task alpha' } }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(scope, nameB), [
      header(B_ID),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'second task beta' } }),
    ].join('\n') + '\n');
    fs.utimesSync(path.join(scope, nameA), new Date(T), new Date(T));
    fs.utimesSync(path.join(scope, nameB), new Date(T - 1000), new Date(T - 1000));

    // Cold scan: newest-first, one bounded open per file.
    const first = await listSessions(store);
    expect(first.map(s => s.title)).toEqual(['first task alpha', 'second task beta']);
    expect(opens).toBe(2);

    // Warm scan: everything served from the cache — zero opens. The pin
    // the e2e suite cannot express: identical responses there pass with
    // or without a cache behind them.
    const second = await listSessions(store);
    expect(second).toEqual(first);
    expect(opens).toBe(2);

    // Size leg: append to A, then re-pin A's mtime to the SAME whole
    // second — same mtime, grown file. Only the size half of the key
    // differs → exactly one re-open (an mtime-only key would serve the
    // cached entry and the stale title would stay).
    fs.appendFileSync(path.join(scope, nameA),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'appended gamma' } }) + '\n');
    fs.utimesSync(path.join(scope, nameA), new Date(T), new Date(T));
    const third = await listSessions(store);
    expect(third.find(s => s.id === A_ID)?.title).toBe('first task alpha'); // first user message wins
    expect(opens).toBe(3);

    // Mtime leg: rewrite B with a same-length title ('beta' → 'betx')
    // and bump the mtime to a different whole second — same size, new
    // mtime. Only the mtime half differs → exactly one re-open (a
    // size-only key would serve the stale title).
    fs.writeFileSync(path.join(scope, nameB), [
      header(B_ID),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'second task betx' } }),
    ].join('\n') + '\n');
    fs.utimesSync(path.join(scope, nameB), new Date(T), new Date(T));
    const fourth = await listSessions(store);
    expect(fourth.find(s => s.id === B_ID)?.title).toBe('second task betx');
    expect(opens).toBe(4);

    // Prune: drop the scope and rescan — entries for gone files must
    // leave the cache. Then re-create A's exact (path, mtime, size) with
    // different same-length content: a cache that failed to prune would
    // hit the stale entry (zero opens, old title); the pruned cache
    // re-opens and sees the new content.
    fs.rmSync(scope, { recursive: true, force: true });
    expect(await listSessions(store)).toEqual([]);
    fs.mkdirSync(scope);
    fs.writeFileSync(path.join(scope, nameA), [
      header(A_ID),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'first task alphX' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'appended gammX' } }),
    ].join('\n') + '\n');
    fs.utimesSync(path.join(scope, nameA), new Date(T), new Date(T));
    const fifth = await listSessions(store);
    expect(fifth.find(s => s.id === A_ID)?.title).toBe('first task alphX');
    expect(opens).toBe(5);
  } finally {
    (fsp as { open: typeof fsp.open }).open = realOpen;
  }
});
