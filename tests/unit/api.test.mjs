// api.test.mjs — request-body schemas for the JSON endpoints
// (src/schemas/api.ts): shape-level acceptance and the exact parse outputs
// the handlers consume, and the 400 text a failure renders as
// (parseZod → firstIssueText, src/lib/web). Domain rules that stay with the domain code (job-name
// regex, cron schedules in jobs.ts) are covered by jobs.test.mjs, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loginBody, loginForm, newSessionBody, jobValidateBody,
  hideBody, unhideBody, updatePiBody, autoUpdateBody,
} from '../../dist-server/src/schemas/api.js';
import { JobSaveSchema } from '../../dist-server/src/schemas/jobs.js';
import { parseZod } from '../../dist-server/src/lib/web/parsing.service.js';
import { firstIssueText } from '../../dist-server/src/lib/web/responses.service.js';

/** The one-line 400 text a failed body renders as. */
const issueText = (schema, v) => {
  const r = parseZod(v, schema);
  assert.equal(r.ok, false, JSON.stringify(v));
  return firstIssueText(r.issues);
};

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

test('JobSaveSchema: normalizes the name, trims, and names each failing field', () => {
  assert.deepEqual(parse(JobSaveSchema, { name: '  Nightly Check ', schedule: ' */5 * * * * ', command: ' true ', extra: 1 }),
    { name: 'nightly-check', schedule: '*/5 * * * *', command: 'true' });
  // the cron *validity* is saveJob's (cron-parser stays server-side)
  assert.equal(ok(JobSaveSchema, { name: 'n', schedule: 'daily 08:00', command: 'true' }), true);
  const cases = [
    [{ name: '!!!', schedule: 's', command: 'c' }, 'name: name is required'],
    [{ name: 'webpi-x', schedule: 's', command: 'c' }, /^name: use letters/],
    [{ name: 'n', schedule: '  ', command: 'c' }, 'schedule: schedule is required'],
    [{ name: 'n', schedule: 'x'.repeat(121), command: 'c' }, /^schedule: schedule is too long/],
    [{ name: 'n', schedule: 'a\nb', command: 'c' }, 'schedule: schedule must be one line'],
    [{ name: 'n', schedule: 's', command: '   ' }, 'command: command is required'],
    [{ name: 'n', schedule: 's', command: 'a\nb' }, 'command: command must be one line'],
    [{ name: 'n', schedule: 's', command: 'x'.repeat(4001) }, /^command: command is too long/],
    [{ name: 5, schedule: 's', command: 'c' }, /^name: /],
  ];
  for (const [input, expected] of cases) {
    const text = issueText(JobSaveSchema, input);
    if (expected instanceof RegExp) assert.match(text, expected, JSON.stringify(input));
    else assert.equal(text, expected, JSON.stringify(input));
  }
});

test('jobValidateBody: one string', () => {
  // validate: '' passes — checkCron reports 'schedule is required' with a 200
  assert.deepEqual(parse(jobValidateBody, { schedule: '' }), { schedule: '' });
  assert.equal(ok(jobValidateBody, {}), false);
  assert.equal(ok(jobValidateBody, { schedule: 5 }), false);
});

test('loginForm: stricter than loginBody — empty fields fail in the browser', () => {
  assert.equal(ok(loginForm, { username: 'u', password: 'p' }), true);
  assert.equal(issueText(loginForm, { username: '', password: 'p' }), 'username: enter your username');
  assert.equal(issueText(loginForm, { username: 'u', password: '' }), 'password: enter your password');
  assert.equal(ok(loginBody, { username: '', password: '' }), true); // the server stays permissive
});

test('hideBody: id must match SESSION_ID_RE; the message names it', () => {
  assert.deepEqual(parse(hideBody, { id: GOOD_ID }), { id: GOOD_ID });
  for (const bad of [{}, { id: '' }, { id: 'has spaces' }, { id: 5 }, { id: 'x'.repeat(65) }]) {
    assert.equal(ok(hideBody, bad), false, JSON.stringify(bad));
  }
  assert.equal(issueText(hideBody, { id: 'has spaces' }), 'id: invalid session id');
});

test('unhideBody: {all:true} or a valid {id}; all wins when both are present', () => {
  assert.deepEqual(parse(unhideBody, { all: true }), { all: true });
  assert.deepEqual(parse(unhideBody, { id: GOOD_ID }), { id: GOOD_ID });
  // both present: all wins, id stripped — the old check's precedence
  assert.deepEqual(parse(unhideBody, { all: true, id: 'garbage!' }), { all: true });
  for (const bad of [{}, { all: 'yes' }, { all: 1 }, { all: false }, { id: 'garbage!' }, { id: 5 }, null]) {
    assert.equal(ok(unhideBody, bad), false, JSON.stringify(bad));
  }
  // a bad id names the field; a shape matching neither branch gets the
  // union's own message (zod's default would only be 'Invalid input')
  assert.equal(issueText(unhideBody, { id: 'garbage!' }), 'id: invalid session id');
  assert.match(issueText(unhideBody, {}), /invalid session id$/);
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

test('autoUpdateBody: one boolean; anything else names the field', () => {
  assert.deepEqual(parse(autoUpdateBody, { enabled: true }), { enabled: true });
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
    assert.equal(ok(autoUpdateBody, bad), false, JSON.stringify(bad));
  }
  assert.equal(issueText(autoUpdateBody, { enabled: 'yes' }), 'enabled: enabled must be a boolean');
});

test('a failed body renders "field: message" (the 400 text)', () => {
  assert.match(issueText(newSessionBody, { name: 5 }), /^name: /);
});
