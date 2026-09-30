'use strict';
// acp-rpc — JSON-RPC 2.0 over newline-delimited streams, both directions.
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { createRpc, RpcError, ERR } = require('../acp-rpc.js');

// Two peers wired back to back: a's output is b's input and the reverse.
function pair(aOpts = {}, bOpts = {}) {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const a = createRpc({ input: ba, output: ab, ...aOpts });
  const b = createRpc({ input: ab, output: ba, ...bOpts });
  return { a, b, ab, ba };
}

test('a request gets its result; a typed error keeps its code and data', async () => {
  const { a } = pair({}, {
    onRequest(method, params) {
      if (method === 'add') return params.x + params.y;
      if (method === 'auth') throw new RpcError(ERR.AUTH_REQUIRED, 'Authentication required', { methods: ['login'] });
      throw new Error('boom');
    },
  });
  assert.strictEqual(await a.request('add', { x: 2, y: 3 }), 5);
  await assert.rejects(a.request('auth', {}), (e) => {
    assert.strictEqual(e.code, ERR.AUTH_REQUIRED);
    assert.deepStrictEqual(e.data, { methods: ['login'] });
    return true;
  });
  await assert.rejects(a.request('other', {}), (e) => e.code === ERR.INTERNAL && /boom/.test(e.message));
});

test('a peer without onRequest answers method-not-found', async () => {
  const { a } = pair();
  await assert.rejects(a.request('nope'), (e) => e.code === ERR.METHOD_NOT_FOUND);
});

test('both sides may request at once: ids never collide across directions', async () => {
  const { a, b } = pair({ onRequest: (m, p) => 'a:' + p }, { onRequest: (m, p) => 'b:' + p });
  const [x, y] = await Promise.all([a.request('m', 1), b.request('m', 2)]);
  assert.strictEqual(x, 'b:1');
  assert.strictEqual(y, 'a:2');
});

test('notifications carry no id and get no answer', async () => {
  const seen = [];
  const { a, ab } = pair({}, { onNotification: (m, p) => seen.push([m, p]) });
  const written = [];
  ab.on('data', (c) => written.push(String(c)));
  a.notify('session/update', { n: 1 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [['session/update', { n: 1 }]]);
  assert.ok(!JSON.parse(written[0]).id, 'no id on a notification');
});

test('a message split across chunks, several per chunk, and a banner line all parse', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen = [];
  const logs = [];
  createRpc({ input, output, onNotification: (m, p) => seen.push(p.n), log: (m) => logs.push(m) });
  input.write('npx: installed 1 package\n{"jsonrpc":"2.0","method":"x","par');
  input.write('ams":{"n":1}}\n{"jsonrpc":"2.0","method":"x","params":{"n":2}}\n{"jsonrpc":"2.0","method":"x","params":{"n":3}}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [1, 2, 3]);
  assert.match(logs[0], /non-JSON/);
});

test('the input ending rejects every pending request and fires onClose once', async () => {
  let closes = 0;
  const { a, ba } = pair({ onClose: () => closes++ }, { onRequest: () => new Promise(() => {}) });
  const p = a.request('slow');
  ba.end();
  await assert.rejects(p, /connection closed/);
  await assert.rejects(a.request('after'), /connection closed/);
  assert.strictEqual(closes, 1);
  assert.strictEqual(a.closed, true);
});

test('a timeout rejects, and the late answer is dropped', async () => {
  const { a } = pair({}, { onRequest: () => new Promise((r) => setTimeout(() => r('late'), 80)) });
  await assert.rejects(a.request('m', null, { timeoutMs: 20 }), /timed out/);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(a.pendingCount, 0);
});
