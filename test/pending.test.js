'use strict';
// ui/js/pending.js — the optimistic-send list behind the chat's pending
// bubble. The contract: a sent message lives here from POST 200 until its
// server echo lands in the thread; pendingFor() reconciles on every render so
// there is never a paint with both the pending bubble and the real one. The
// module is DOM-free, so it imports straight into Node.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'pending.js')).href);

test('send → pending exists; echo lands in the doc → exactly the real message remains', async () => {
  const { addPending, pendingFor } = await mod;
  const target = 'lieutenant:ada';
  addPending(target, 'hello there', []);
  // the beat between the 200 and the echo: the pending entry is the message
  let thread = [];
  assert.strictEqual(pendingFor(target, thread).length, 1);
  assert.strictEqual(pendingFor(target, thread)[0].text, 'hello there');
  // the broadcast replaces the doc, now carrying the echo → pending reconciles
  // away in the same render; the merged feed holds exactly one bubble (the
  // real one: 1 thread message + 0 pending)
  thread = [{ author: 'user', text: 'hello there', ts: '2026-07-25T12:00:00Z' }];
  assert.strictEqual(pendingFor(target, thread).length, 0);
  // and it stays gone on subsequent renders
  assert.strictEqual(pendingFor(target, thread).length, 0);
});

test('reconciliation matches the echo, not other traffic', async () => {
  const { addPending, pendingFor } = await mod;
  const target = 'lieutenant:tan';
  addPending(target, 'ping', []);
  // a lieutenant message with the same text is NOT the echo; neither is a
  // different captain message
  const thread = [
    { author: 'Ada', text: 'ping', ts: 't1' },
    { author: 'user', text: 'other', ts: 't2' },
  ];
  assert.strictEqual(pendingFor(target, thread).length, 1);
  thread.push({ author: 'user', text: 'ping', ts: 't3' });
  assert.strictEqual(pendingFor(target, thread).length, 0);
});

test('attachments-only send reconciles by attachment ids', async () => {
  const { addPending, pendingFor } = await mod;
  const target = 'card:shippy';
  addPending(target, '', [{ id: 'att-1', name: 'shot.png' }, { id: 'att-2', name: 'log.txt' }]);
  // a USER message carrying only one of the ids is not it
  let thread = [{ author: 'user', text: '', attachments: [{ id: 'att-1' }], ts: 't1' }];
  assert.strictEqual(pendingFor(target, thread).length, 1);
  thread = [{ author: 'user', text: '', attachments: [{ id: 'att-1' }, { id: 'att-2' }], ts: 't2' }];
  assert.strictEqual(pendingFor(target, thread).length, 0);
});

test('pending is keyed by target — no leaking across threads; send order kept', async () => {
  const { addPending, pendingFor } = await mod;
  addPending('lieutenant:a', 'first', []);
  addPending('card:x', 'elsewhere', []);
  addPending('lieutenant:a', 'second', []);
  const a = pendingFor('lieutenant:a', []);
  assert.deepStrictEqual(a.map((p) => p.text), ['first', 'second']);
  assert.ok(a[0].seq < a[1].seq);
  assert.deepStrictEqual(pendingFor('card:x', []).map((p) => p.text), ['elsewhere']);
  assert.strictEqual(pendingFor('lieutenant:other', []).length, 0);
});
