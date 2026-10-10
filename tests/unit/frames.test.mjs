// frames.test.mjs — the WS client-frame gate (parseClientMsg + the zod
// schemas ClientMsg is z.infer'd from, src/schemas/frames.ts). The accepted /
// rejected surface must match the hand-rolled parseClientMsg it replaced
// exactly: malformed frames answer null (the caller drops them), they are
// never thrown on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMsg } from '../../dist-server/src/schemas/frames.js';

test('accepts each frame shape, stripping unknown extra keys', () => {
  assert.deepEqual(parseClientMsg('{"type":"input","data":"hi"}'), { type: 'input', data: 'hi' });
  // extra keys tolerated (stripped) — the old checks only read known fields
  assert.deepEqual(parseClientMsg('{"type":"input","data":"hi","junk":1}'), { type: 'input', data: 'hi' });
  assert.deepEqual(parseClientMsg('{"type":"input","data":""}'), { type: 'input', data: '' });
  assert.deepEqual(parseClientMsg('{"type":"resize","cols":120,"rows":40}'), { type: 'resize', cols: 120, rows: 40 });
  // fractional sizes are numbers — clamping is downstream business
  assert.deepEqual(parseClientMsg('{"type":"resize","cols":1.5,"rows":40.5}'),
    { type: 'resize', cols: 1.5, rows: 40.5 });
  assert.deepEqual(parseClientMsg('{"type":"attach","mode":"live","target":"dev"}'),
    { type: 'attach', mode: 'live', target: 'dev' });
  assert.deepEqual(parseClientMsg('{"type":"attach","mode":"resume","id":"019f4706-0000-7000-8000-000000000001"}'),
    { type: 'attach', mode: 'resume', id: '019f4706-0000-7000-8000-000000000001' });
  // a stray id on live / target on resume is ignored; mode decides
  assert.deepEqual(parseClientMsg('{"type":"attach","mode":"live","target":"dev","id":"x"}'),
    { type: 'attach', mode: 'live', target: 'dev' });
});

test('rejects non-objects, bad JSON, unknown types and mistyped fields — null, never a throw', () => {
  const junk = [
    'not json', '', 'null', '[]', '"x"', '5', 'true', '{}',
    '{"type":"nope"}', '{"type":5}', '{"type":null}',
    '{"type":"input"}', '{"type":"input","data":5}', '{"type":"input","data":null}',
    '{"type":"resize","cols":"wide"}', '{"type":"resize","cols":120}', '{"type":"resize","rows":40}',
    '{"type":"resize","cols":"120","rows":40}',
    '{"type":"attach","mode":"live"}', '{"type":"attach","mode":"resume"}',
    '{"type":"attach","mode":"resume","id":7}', '{"type":"attach","mode":"other","target":"t"}',
    '{"type":"attach","target":"t"}',
  ];
  for (const f of junk) {
    assert.doesNotThrow(() => parseClientMsg(f), f);
    assert.equal(parseClientMsg(f), null, f);
  }
});

test('input frames carry 64 KiB paste chunks (the hot path)', () => {
  const data = 'x'.repeat(65536);
  const msg = parseClientMsg(JSON.stringify({ type: 'input', data }));
  assert.deepEqual(msg, { type: 'input', data });
  assert.equal(msg && msg.type === 'input' && msg.data.length === 65536, true);
});
