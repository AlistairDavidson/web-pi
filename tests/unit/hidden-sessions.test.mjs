// hidden-sessions.test.mjs — hide/unhide writes answer DatabaseUpdateResult
// (src/lib/hidden-sessions.ts via db.ts databaseUpdate): success carries the
// row count, and a failing db is a database_error result, never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb } from '../../dist-server/src/lib/db.js';
import { HiddenSessions } from '../../dist-server/src/lib/hidden-sessions.js';

const A = '019f4706-0000-7000-8000-00000000000a';
const B = '019f4706-0000-7000-8000-00000000000b';

function freshDb() {
  return new StateDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-hidden-')), 'webpi.db'));
}

test('hide / unhide / unhideAll succeed with database_update results', () => {
  const hidden = new HiddenSessions(freshDb());
  assert.deepEqual(hidden.hide(A), { ok: true, resultType: 'database_update', data: { changes: 1 } });
  assert.equal(hidden.hide(B).ok, true);
  assert.equal(hidden.has(A), true);
  assert.equal(hidden.size, 2);
  assert.deepEqual(hidden.unhide(A), { ok: true, resultType: 'database_update', data: { changes: 1 } });
  assert.equal(hidden.has(A), false);
  assert.equal(hidden.unhideAll().ok, true);
  assert.equal(hidden.size, 0);
});

test('a db that cannot open answers database_error — no throw', () => {
  // A path under a regular file: mkdir of its parent fails inside the write.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-hidden-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  const hidden = new HiddenSessions(new StateDb(path.join(file, 'webpi.db')));
  for (const r of [hidden.hide(A), hidden.unhide(A), hidden.unhideAll()]) {
    assert.equal(r.ok, false);
    assert.equal(r.resultType, 'database_update');
    assert.equal(r.errorCode, 'database_error');
    assert.match(r.errorMessage, /^could not save hidden state: /);
  }
});
