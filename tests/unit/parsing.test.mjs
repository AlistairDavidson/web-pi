// parsing.test.mjs — src/lib/web/parsing.service.ts: request parsing and
// zod validation as Results (a node:test port of soothing-booking's
// parsing.service tests), including the two bugs fixed there —
// parseAndValidateFailureToErrors used to fall through its switch and
// return no message, and ValidationResult aliased the parse types.
// Statuses go through failureResponse (responses.service.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  parseAndValidateAPIRequest, parseAndValidateFailureToErrors, parseAndValidateFormPost,
  parseFileUpload, parseZod,
} from '../../dist-server/src/lib/web/parsing.service.js';
import { failureResponse, jsonResponse } from '../../dist-server/src/lib/web/responses.service.js';

const TestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email('Invalid email'),
});

const jsonRequest = (body) => new Request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const formRequest = (data) => new Request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
});

test('JSON: a valid body parses to the schema output', async () => {
  const r = await parseAndValidateAPIRequest(jsonRequest({ name: 'Alice', email: 'alice@example.com' }), TestSchema);
  assert.deepEqual(r, { ok: true, resultType: 'validation', data: { name: 'Alice', email: 'alice@example.com' } });
});

test('JSON: invalid syntax is invalid_json (400 "Invalid JSON")', async () => {
  const r = await parseAndValidateAPIRequest(new Request('http://localhost/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  }), TestSchema);
  assert.equal(r.errorCode, 'invalid_json');
  const res = failureResponse(r);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
});

test('JSON: a failed schema is validation_failure with the first issue per field (400)', async () => {
  const r = await parseAndValidateAPIRequest(jsonRequest({ name: '', email: 'nope' }), TestSchema);
  assert.equal(r.errorCode, 'validation_failure');
  assert.deepEqual(r.issues, { name: 'Name is required', email: 'Invalid email' });
  const res = failureResponse(r);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(),
    { error: 'name: Name is required', code: 'validation_failure', issues: r.issues });
});

test('form-urlencoded bodies parse and validate the same way', async () => {
  const good = await parseAndValidateAPIRequest(formRequest({ name: 'Bob', email: 'bob@example.com' }), TestSchema);
  assert.equal(good.ok, true);
  assert.deepEqual(good.data, { name: 'Bob', email: 'bob@example.com' });
  const bad = await parseAndValidateAPIRequest(formRequest({ name: '', email: '' }), TestSchema);
  assert.equal(bad.errorCode, 'validation_failure');
});

test('other content types — and none — are unsupported_content_type (415)', async () => {
  const plain = await parseAndValidateAPIRequest(new Request('http://localhost/test', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello',
  }), TestSchema);
  assert.equal(plain.errorCode, 'unsupported_content_type');
  assert.equal(failureResponse(plain).status, 415);
  const none = new Request('http://localhost/test', { method: 'POST', body: 'hello' });
  none.headers.delete('content-type'); // a string body defaults to text/plain
  assert.equal((await parseAndValidateAPIRequest(none, TestSchema)).errorCode, 'unsupported_content_type');
  const form = new FormData();
  form.append('name', 'Alice');
  const multipart = await parseAndValidateAPIRequest(new Request('http://localhost/test', { method: 'POST', body: form }), TestSchema);
  assert.equal(multipart.errorCode, 'unsupported_content_type');
});

test('application/json with a charset parameter is still JSON', async () => {
  const r = await parseAndValidateAPIRequest(new Request('http://localhost/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
  }), TestSchema);
  assert.equal(r.ok, true);
});

test('every failure response is JSON and no-store', async () => {
  const failures = [
    await parseAndValidateAPIRequest(new Request('http://localhost/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
    }), TestSchema),
    await parseAndValidateAPIRequest(new Request('http://localhost/test', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '',
    }), TestSchema),
    await parseAndValidateAPIRequest(jsonRequest({ name: '' }), TestSchema),
  ];
  for (const r of failures) {
    const res = failureResponse(r);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('parseZod keeps only the first issue per field; root issues key on ""', () => {
  const r = parseZod({ value: '' }, z.object({ value: z.string().min(3, 'Too short').max(5, 'Too long') }));
  assert.deepEqual(r.issues, { value: 'Too short' });
  const root = parseZod(5, z.object({}));
  assert.deepEqual(Object.keys(root.issues), ['']);
});

test('parseAndValidateFailureToErrors: issues for validation, a distinct message per parse code', async () => {
  const invalid = await parseAndValidateFormPost(formRequest({ name: '', email: 'nope' }), TestSchema);
  assert.deepEqual(parseAndValidateFailureToErrors(invalid),
    { errorMessage: '', issues: { name: 'Name is required', email: 'Invalid email' } });

  const notAForm = await parseAndValidateFormPost(jsonRequest({ name: 'Alice' }), TestSchema);
  assert.equal(notAForm.errorCode, 'unsupported_content_type');
  const contentType = parseAndValidateFailureToErrors(notAForm);
  assert.match(contentType.errorMessage, /'unsupported content type'/);
  assert.deepEqual(contentType.issues, {});

  const formData = parseAndValidateFailureToErrors({ ok: false, resultType: 'parse_request', errorCode: 'invalid_form_data' });
  assert.match(formData.errorMessage, /'invalid form data'/);
  assert.notEqual(formData.errorMessage, contentType.errorMessage);
});

test('parseFileUpload: one failure per code, then the file', async () => {
  const options = { maxSize: 10, allowedMimeTypes: ['image/png'] };
  const upload = (file) => {
    const form = new FormData();
    if (file) form.append('file', file);
    return new Request('http://localhost/up', { method: 'POST', body: form });
  };
  assert.equal((await parseFileUpload(jsonRequest({}), options)).errorCode, 'no_file_provided');
  assert.equal((await parseFileUpload(upload(null), options)).errorCode, 'no_file_provided');
  const big = await parseFileUpload(upload(new File(['x'.repeat(11)], 'a.png', { type: 'image/png' })), options);
  assert.equal(big.errorCode, 'file_too_large');
  const kind = await parseFileUpload(upload(new File(['x'], 'a.txt', { type: 'text/plain' })), options);
  assert.equal(kind.errorCode, 'unsupported_file_type');
  const ok = await parseFileUpload(upload(new File(['png'], 'a.png', { type: 'image/png' })), options);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.buffer.toString(), 'png');
});

test('jsonResponse: status, JSON body, content-type, no-store, extra headers', async () => {
  const res = jsonResponse({ ok: true }, 201, { 'Set-Cookie': 'a=b' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), 'a=b');
  assert.deepEqual(await res.json(), { ok: true });
});
