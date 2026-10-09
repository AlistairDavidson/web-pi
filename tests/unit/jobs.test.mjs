// jobs.test.mjs — pure scheduling math for the in-process scheduler
// (src/lib/jobs.ts): next-fire, due-ness, missed-window/catch-up, and
// cron validation. Everything here takes an injected "now" — no wall
// clock, no db, no tmux. Run against the compiled output:
// `npm run test:unit` (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCron, isDue, nextFireMs } from '../../dist-server/src/lib/jobs.js';

/** Local-time epoch ms (cron fields are interpreted in local time). */
const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const MIN = 60_000;

test('nextFireMs returns the next match strictly after the reference', () => {
  const t = L(2026, 10, 9, 10, 0); // exactly on a */5 boundary
  assert.equal(nextFireMs('*/5 * * * *', t), L(2026, 10, 9, 10, 5));
  assert.equal(nextFireMs('*/5 * * * *', t + 1), L(2026, 10, 9, 10, 5));
  assert.equal(nextFireMs('*/5 * * * *', L(2026, 10, 9, 10, 2)), L(2026, 10, 9, 10, 5));
  // day-of-week: Mon..Fri at 09:30
  const mon = L(2026, 10, 5, 9, 30); // a Monday
  assert.equal(nextFireMs('30 9 * * 1-5', mon), L(2026, 10, 6, 9, 30));
  const fri = L(2026, 10, 9, 9, 30); // a Friday
  assert.equal(nextFireMs('30 9 * * 1-5', fri), L(2026, 10, 12, 9, 30)); // skips the weekend
  // month/day boundaries roll over
  assert.equal(nextFireMs('0 8 1 * *', L(2026, 10, 31, 23, 59)), L(2026, 11, 1, 8, 0));
});

test('nextFireMs throws on invalid schedules', () => {
  for (const bad of ['daily 08:00', '99 * * * *', '* * *', '']) {
    assert.throws(() => nextFireMs(bad, L(2026, 10, 9, 10, 0)), undefined, bad);
  }
});

test('isDue: not due before the next fire, due at/after it', () => {
  const ref = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('* * * * *', ref, ref + 59_000), false);
  assert.equal(isDue('* * * * *', ref, ref + MIN), true);
  assert.equal(isDue('* * * * *', ref, ref + 5 * MIN), true);
  // a fire exactly at the reference is spent — never double-counted
  assert.equal(isDue('* * * * *', ref, ref), false);
});

test('isDue: a missed window while the server was down is due (catch-up)', () => {
  // daily at 10:00, last fired yesterday 10:00, now today 11:30 → missed
  const lastFire = L(2026, 10, 8, 10, 0);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 9, 9, 59)), false);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 9, 10, 0)), true);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 12, 18, 0)), true); // many missed → still one boolean
  // fired today already → next due is tomorrow
  const todayFire = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('0 10 * * *', todayFire, L(2026, 10, 9, 23, 59)), false);
});

test('isDue: a never-fired job is referenced by its creation time', () => {
  // created 10:00:00 with an every-minute schedule → due at 10:01
  const created = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('* * * * *', created, created + 30_000), false);
  assert.equal(isDue('* * * * *', created, created + MIN), true);
});

test('checkCron: 5-field cron accepted, other syntax rejected with an error', () => {
  const now = L(2026, 10, 9, 10, 2);
  const good = checkCron('*/5 * * * *', now);
  assert.equal(good.valid, true);
  assert.equal(good.validatedBy, 'cron-parser');
  assert.equal(good.next, '2026-10-09 10:05');
  assert.equal(good.error, null);

  for (const bad of ['daily 08:00', '99 * * * *', '*/5 * * *', '0 8 * * * *', '']) {
    const c = checkCron(bad, now);
    assert.equal(c.valid, false, bad);
    assert.equal(typeof c.error, 'string');
    assert.ok(c.error.length > 0, bad);
    assert.equal(c.next, null);
  }
});
