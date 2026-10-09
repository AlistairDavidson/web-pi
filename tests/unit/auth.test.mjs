// auth.test.mjs — unit tests for the session expiry model in
// src/lib/auth.ts (two clocks: sliding idle + absolute cap from login)
// and the cookie-refresh decision. Runs against the compiled server
// output (`npm run test:unit` compiles first) with node:test mock timers
// driving Date.now — TTLs are constructor-injectable for exactly this.
// The e2e runner never loads it: playwright.config.ts pins testMatch to
// '**/*.spec.ts', so node:test files under tests/unit/ are test:unit
// territory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth } from '../../dist-server/src/lib/auth.js';
import { StateDb } from '../../dist-server/src/lib/db.js';

// Never opened: the session-token APIs don't touch the db (only
// verify()/configured() read the credential, and not under test here).
const db = new StateDb('/tmp/webpi-auth-unit.db');

test('alive() reports liveness but never slides — the WS sweep’s peek', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 100_000 });
  const tok = auth.newSession();
  assert.equal(auth.alive(tok), true);   // live
  assert.equal(auth.alive('nope'), false); // unknown
  // Peeking all the way through the idle window must NOT renew: the
  // token dies exactly where it would with no contact at all — the
  // WS keepalive sweep can never extend a terminal's life.
  t.mock.timers.setTime(999);
  assert.equal(auth.alive(tok), true);   // last moment of the window
  t.mock.timers.setTime(1001);
  assert.equal(auth.alive(tok), false);  // dead (exp < now) — no slide from alive()
  // The peek is pure too: the entry is still there (valid() cleans up).
  assert.equal(auth.valid(tok), false);
  // dropAll kills every token's liveness at once (log out everywhere).
  const a = auth.newSession();
  const b = auth.newSession();
  auth.dropAll();
  assert.equal(auth.alive(a), false);
  assert.equal(auth.alive(b), false);
});

test('valid() slides the idle window on use', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 100_000 });
  const tok = auth.newSession();
  t.mock.timers.setTime(999);
  assert.equal(auth.valid(tok), true);   // inside the first window
  t.mock.timers.setTime(1998);
  assert.equal(auth.valid(tok), true);   // renewed at 999 → exp 1999
  t.mock.timers.setTime(2998);
  assert.equal(auth.valid(tok), true);   // renewed at 1998 → exp 2998
  t.mock.timers.setTime(3999);
  assert.equal(auth.valid(tok), false);  // 1001 ms idle since the last renewal
  t.mock.timers.setTime(4000);
  assert.equal(auth.valid(tok), false);  // stays dead once rejected
});

test('the absolute cap kills a constantly-renewed token at created+absoluteMs', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 2000 });
  const tok = auth.newSession();
  t.mock.timers.setTime(900);
  assert.equal(auth.valid(tok), true);   // exp → 1900
  t.mock.timers.setTime(1800);
  assert.equal(auth.valid(tok), true);   // exp → 2800, still under the cap
  t.mock.timers.setTime(1900);
  assert.equal(auth.valid(tok), true);   // exp → 2900, would slide forever…
  t.mock.timers.setTime(2000);
  assert.equal(auth.valid(tok), false);  // …except created(0) + 2000 <= now
  t.mock.timers.setTime(2100);
  assert.equal(auth.valid(tok), false);
});

test('newSession() purges sessions dead on either clock', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 2000 });
  const idle = auth.newSession();
  const kept = auth.newSession();
  t.mock.timers.setTime(500);
  assert.equal(auth.valid(kept), true);  // exp → 1500
  t.mock.timers.setTime(1000);
  assert.equal(auth.valid(kept), true);  // exp → 2000 (renewed under it)
  t.mock.timers.setTime(1501);           // `idle` is idle-expired; `kept` was
  const fresh = auth.newSession();       // renewed at 1000 → dead-purge keeps it
  assert.equal(auth.valid(idle), false);
  assert.equal(auth.valid(kept), true);
  assert.equal(auth.valid(fresh), true);
});

test('cookieRefresh() re-arms the Max-Age only after half the idle window', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 10_000 });
  const tok = auth.newSession();          // login sent the cookie (cookieAt 0)
  assert.equal(auth.cookieRefresh(tok), null); // fresh — no header yet
  t.mock.timers.setTime(499);
  assert.equal(auth.valid(tok), true);
  assert.equal(auth.cookieRefresh(tok), null); // under half the window
  t.mock.timers.setTime(501);
  assert.equal(auth.valid(tok), true);
  const header = auth.cookieRefresh(tok);
  assert.match(header, /^webpi_session=/);
  assert.match(header, /Max-Age=1\b/);         // idleMs, in seconds
  assert.match(header, /SameSite=Strict/);
  t.mock.timers.setTime(700);
  assert.equal(auth.cookieRefresh(tok), null); // just re-armed at 501
  t.mock.timers.setTime(1202);
  assert.equal(auth.valid(tok), true);
  assert.ok(auth.cookieRefresh(tok));          // 701 ms since cookieAt 501
});

test('cookieRefresh() never answers for unknown or dead tokens', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 2000 });
  assert.equal(auth.cookieRefresh('no-such-token'), null);
  assert.equal(auth.cookieRefresh(undefined), null);
  const tok = auth.newSession();
  t.mock.timers.setTime(3000);                  // past the absolute cap
  assert.equal(auth.valid(tok), false);
  assert.equal(auth.cookieRefresh(tok), null);
});

test('drop() and dropAll() end tokens immediately', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 100_000 });
  const a = auth.newSession();
  const b = auth.newSession();
  auth.drop(a);
  assert.equal(auth.valid(a), false);
  assert.equal(auth.valid(b), true);
  auth.dropAll();
  assert.equal(auth.valid(b), false);
});
