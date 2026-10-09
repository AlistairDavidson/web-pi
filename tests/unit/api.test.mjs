// api.test.mjs — request-body schemas for the JSON endpoints
// (src/lib/api.ts): shape-level acceptance and the exact parse outputs the
// handlers consume. Domain rules that stay with the domain code (job-name
// regex, cron schedules in jobs.ts) are covered by jobs.test.mjs, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loginBody, newSessionBody, jobSaveBody, jobValidateBody,
  hideBody, unhideBody, updatePiBody, firstIssue,
} from '../../dist-server/src/lib/api.js';

const ok = (schema, v) => schema.safeParse(v).success;
const parse = (schema, v) => {
  const r = schema.safeParse(v);
  assert.ok(r.success, JSON.stringify(v));
  return r.data;
};

const GOOD_ID = '019f4706-0000-7000-8000-000000000001';

test('loginBody: string username + password, extra keys stripped', () => {
  assert.deepEqual(parse(loginBody, { username: 'u', password: 'p', junk: 1 }),
    { username: 'u', password: 'p' });
  // empty strings are strings — verify() decides those, not the schema
  assert.equal(ok(loginBody, { username: '', password: '' }), true);
  for (const bad of [{}, { username: 'u' }, { password: 'p' },
    { username: 5, password: 'p' }, { username: 'u', password: null }, null, []]) {
    assert.equal(ok(loginBody, bad), false, JSON.stringify(bad));
  }
});

test('newSessionBody: any string name — emptiness is the handler\'s call', () => {
  assert.deepEqual(parse(newSessionBody, { name: '  My Session!' }), { name: '  My Session!' });
  assert.deepEqual(parse(newSessionBody, { name: '' }), { name: '' });
  assert.equal(ok(newSessionBody, {}), false);
  assert.equal(ok(newSessionBody, { name: 5 }), false);
});

test('jobSaveBody / jobValidateBody: three strings / one string', () => {
  assert.deepEqual(parse(jobSaveBody, { name: 'n', schedule: '*/5 * * * *', command: 'true', extra: 1 }),
    { name: 'n', schedule: '*/5 * * * *', command: 'true' });
  assert.equal(ok(jobSaveBody, { name: 'n', schedule: '*/5 * * * *' }), false); // command missing
  assert.equal(ok(jobSaveBody, { name: 5, schedule: 's', command: 'c' }), false);
  // validate: '' passes — checkCron reports 'schedule is required' with a 200
  assert.deepEqual(parse(jobValidateBody, { schedule: '' }), { schedule: '' });
  assert.equal(ok(jobValidateBody, {}), false);
  assert.equal(ok(jobValidateBody, { schedule: 5 }), false);
});

test('hideBody: id must match SESSION_ID_RE; the message names it', () => {
  assert.deepEqual(parse(hideBody, { id: GOOD_ID }), { id: GOOD_ID });
  for (const bad of [{}, { id: '' }, { id: 'has spaces' }, { id: 5 }, { id: 'x'.repeat(65) }]) {
    assert.equal(ok(hideBody, bad), false, JSON.stringify(bad));
  }
  const r = hideBody.safeParse({ id: 'has spaces' });
  assert.ok(!r.success);
  assert.equal(firstIssue(r.error), 'id: invalid session id');
});

test('unhideBody: {all:true} or a valid {id}; all wins when both are present', () => {
  assert.deepEqual(parse(unhideBody, { all: true }), { all: true });
  assert.deepEqual(parse(unhideBody, { id: GOOD_ID }), { id: GOOD_ID });
  // both present: all wins, id stripped — the old check's precedence
  assert.deepEqual(parse(unhideBody, { all: true, id: 'garbage!' }), { all: true });
  for (const bad of [{}, { all: 'yes' }, { all: 1 }, { all: false }, { id: 'garbage!' }, { id: 5 }, null]) {
    assert.equal(ok(unhideBody, bad), false, JSON.stringify(bad));
  }
});

test('updatePiBody: dryRun defaults false; only booleans pass', () => {
  assert.deepEqual(parse(updatePiBody, {}), { dryRun: false });
  assert.deepEqual(parse(updatePiBody, { dryRun: true }), { dryRun: true });
  assert.deepEqual(parse(updatePiBody, { dryRun: false }), { dryRun: false });
  // a truthy non-boolean used to fall through to a REAL update — now a 400
  for (const bad of [{ dryRun: 1 }, { dryRun: 'true' }, { dryRun: null }, { dryRun: [] }]) {
    assert.equal(ok(updatePiBody, bad), false, JSON.stringify(bad));
  }
});

test('firstIssue renders "field: message" for a 400 body', () => {
  const r = newSessionBody.safeParse({ name: 5 });
  assert.ok(!r.success);
  assert.match(firstIssue(r.error), /^name: /);
});
