// auth.test.mjs — unit tests for the session model in src/lib/auth.ts:
// two expiry clocks (sliding idle + absolute cap from login), the
// cookie-refresh decision, and persistence — tokens live in the state db
// as sha256 hashes (auth_sessions), survive a restart (a new Auth on the
// same db), and are revoked by a password change. Runs against the
// compiled server output (`npm run test:unit` compiles first) with
// node:test mock timers driving Date.now — TTLs (and the renewal-write
// throttle) are constructor-injectable for exactly this. Each test gets
// its own temp db.
// The e2e runner never loads it: playwright.config.ts pins testMatch to
// '**/*.spec.ts', so node:test files under tests/unit/ are test:unit
// territory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Auth, setCredential } from '../../dist-server/src/lib/auth.js';
import { StateDb } from '../../dist-server/src/lib/db.js';

function freshDb() {
  return new StateDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-auth-unit-')), 'webpi.db'));
}

/** newSession() answers a Result; the token is what a browser gets. */
function login(auth) {
  const r = auth.newSession();
  assert.equal(r.ok, true, r.errorMessage);
  return r.data.token;
}

test('alive() reports liveness but never slides — the WS sweep’s peek', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const tok = login(auth);
  assert.equal(auth.alive(tok), true);   // live
  assert.equal(auth.alive('nope'), false); // unknown
  // Peeking all the way through the idle window must NOT renew: the
  // token dies exactly where it would with no contact at all — the
  // WS keepalive sweep can never extend a terminal's life.
  t.mock.timers.setTime(999);
  assert.equal(auth.alive(tok), true);   // last moment of the window
  t.mock.timers.setTime(1001);
  assert.equal(auth.alive(tok), false);  // dead (exp < now) — no slide from alive()
  // The peek is pure too: the row is still there (valid() cleans up).
  assert.equal(auth.valid(tok), false);
  // dropAll kills every token's liveness at once (log out everywhere).
  const a = login(auth);
  const b = login(auth);
  assert.equal(auth.dropAll().ok, true);
  assert.equal(auth.alive(a), false);
  assert.equal(auth.alive(b), false);
});

test('valid() slides the idle window on use', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const tok = login(auth);
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

test('valid() throttles renewal writes: the expiry only moves once it would move by renewWriteMs', t => {
  t.mock.timers.enable({ now: 0 });
  const db = freshDb();
  const auth = new Auth(db, { idleMs: 10_000, absoluteMs: 100_000, renewWriteMs: 1000 });
  const tok = login(auth);
  const expiry = () => db.stmt('SELECT expires_at AS e FROM auth_sessions').get().e;
  assert.equal(expiry(), 10_000);
  t.mock.timers.setTime(500);
  assert.equal(auth.valid(tok), true);
  assert.equal(expiry(), 10_000);        // would move 500 ms — no write
  t.mock.timers.setTime(1000);
  assert.equal(auth.valid(tok), true);
  assert.equal(expiry(), 11_000);        // moves 1000 ms — written
});

test('the absolute cap kills a constantly-renewed token at created+absoluteMs', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  const tok = login(auth);
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
  const db = freshDb();
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  const idle = login(auth);
  const kept = login(auth);
  t.mock.timers.setTime(500);
  assert.equal(auth.valid(kept), true);  // exp → 1500
  t.mock.timers.setTime(1000);
  assert.equal(auth.valid(kept), true);  // exp → 2000 (renewed under it)
  t.mock.timers.setTime(1501);           // `idle` is idle-expired; `kept` was
  const fresh = login(auth);             // renewed at 1000 → dead-purge keeps it
  assert.equal(db.stmt('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 2, 'the dead row was purged');
  assert.equal(auth.valid(idle), false);
  assert.equal(auth.valid(kept), true);
  assert.equal(auth.valid(fresh), true);
});

test('cookieRefresh() re-arms the Max-Age only after half the idle window', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 10_000, renewWriteMs: 0 });
  const tok = login(auth);                // login sent the cookie (cookie_at 0)
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
  assert.ok(auth.cookieRefresh(tok));          // 701 ms since cookie_at 501
});

test('cookieRefresh() never answers for unknown or dead tokens', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  assert.equal(auth.cookieRefresh('no-such-token'), null);
  assert.equal(auth.cookieRefresh(undefined), null);
  const tok = login(auth);
  t.mock.timers.setTime(3000);                  // past the absolute cap
  assert.equal(auth.valid(tok), false);
  assert.equal(auth.cookieRefresh(tok), null);
});

test('drop() and dropAll() end tokens immediately', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const a = login(auth);
  const b = login(auth);
  assert.deepEqual(auth.drop(a), { ok: true, resultType: 'database_update', data: { changes: 1 } });
  assert.equal(auth.valid(a), false);
  assert.equal(auth.valid(b), true);
  assert.equal(auth.dropAll().ok, true);
  assert.equal(auth.valid(b), false);
});

test('tokens survive a restart: a new Auth on the same db accepts them; drops reach across instances', () => {
  const db = freshDb();
  const before = new Auth(db);
  const tok = login(before);
  const other = login(before);
  const after = new Auth(new StateDb(db.file)); // a fresh process: new connection, nothing in memory
  assert.equal(after.valid(tok), true);
  assert.equal(after.alive(other), true);
  after.drop(tok);
  assert.equal(before.valid(tok), false);
  after.dropAll();
  assert.equal(before.valid(other), false);
});

test('the db holds sha256(token), never the token itself', () => {
  const db = freshDb();
  const tok = login(new Auth(db));
  const rows = db.stmt('SELECT token_hash FROM auth_sessions').all();
  assert.deepEqual(rows.map(r => r.token_hash), [crypto.createHash('sha256').update(tok).digest('hex')]);
  assert.equal(fs.readFileSync(db.file).includes(Buffer.from(tok)), false, 'the raw token is not in the file');
});

test('setCredential revokes every session; reads fail closed when the db is gone', () => {
  const db = freshDb();
  const auth = new Auth(db);
  setCredential(db, 'u', 'password-one');
  const tok = login(auth);
  assert.equal(auth.valid(tok), true);
  setCredential(db, 'u', 'password-two'); // a password change
  assert.equal(auth.valid(tok), false);
  assert.equal(auth.alive(tok), false);

  // A state db that can never open: lookups authenticate nobody, and a
  // login reports the failure instead of minting a token it can't keep.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-auth-unit-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  const broken = new Auth(new StateDb(path.join(file, 'webpi.db')));
  assert.equal(broken.valid(tok), false);
  assert.equal(broken.alive(tok), false);
  const minted = broken.newSession();
  assert.equal(minted.ok, false);
  assert.equal(minted.errorCode, 'database_error');
  assert.equal(broken.drop(tok).errorCode, 'database_error');
});
