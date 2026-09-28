'use strict';
// server/delivery.js in-process: a temp queue dir, a fake send, a fake clock.
// The HTTP surface is covered by feed.test.js; the real harness wake by wake.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDelivery } = require('../server/delivery.js');

// A delivery over dir with a recording send. `reachable` false = no session.
function open(dir, opts = {}) {
  const sends = [];
  const clock = { t: 1_000_000 };
  const d = createDelivery(Object.assign({
    dir,
    clock: () => clock.t,
    log: () => {},
    send: (lt, text) => {
      if (opts.reachable === false) return false;
      sends.push({ lt, text });
      return opts.fail ? Promise.reject(new Error('pane gone')) : Promise.resolve();
    },
  }, opts.extra || {}));
  return { d, sends, clock };
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-delivery-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
function tmpDir() { return fs.mkdtempSync(path.join(ROOT, 'q-')); }
const tick = () => new Promise((r) => setImmediate(r));

test('push is write-ahead with a global seq; only ack removes', () => {
  const dir = tmpDir();
  const { d } = open(dir);
  assert.strictEqual(d.push('ada', { kind: 'message', text: 'a' }).seq, 1);
  assert.strictEqual(d.push('bob', { kind: 'message', text: 'b' }).seq, 2);
  assert.strictEqual(d.push('ada', { kind: 'message', text: 'c' }).seq, 3);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ada.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
  assert.deepStrictEqual(d.pending().map((i) => i.seq), [1, 2, 3]);

  // drain serves, never removes
  assert.deepStrictEqual(d.drain('ada').items.map((i) => i.seq), [1, 3]);
  assert.deepStrictEqual(d.drain('ada').items.map((i) => i.seq), [1, 3]);

  // ack: scoped to the caller's own queue, per-queue cursor, durable, never regresses
  assert.strictEqual(d.ack('bob', 3).code, 409);
  assert.strictEqual(d.ack('ada', 99).code, 400);
  assert.deepStrictEqual(d.ack('ada', 1), { ok: true, lieutenant: 'ada', ack: 1 });
  assert.deepStrictEqual(d.pending('ada').map((i) => i.seq), [3]);
  assert.deepStrictEqual(d.ack('ada', 3), { ok: true, lieutenant: 'ada', ack: 3 });
  assert.deepStrictEqual(d.ack('ada', 1), { ok: true, lieutenant: 'ada', ack: 3 }, 're-acking an acked seq is a no-op');
  assert.strictEqual(d.ack('bob', 1).code, 409, 'an acked seq still belongs to its queue');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ada.ack'), 'utf8'), '3');
  assert.deepStrictEqual(d.pending().map((i) => i.seq), [2]);
});

test('reboot: a torn last line costs that line only, and its seq is never reissued', () => {
  const dir = tmpDir();
  const first = open(dir).d;
  first.push('ada', { kind: 'message', text: 'one' });
  first.push('ada', { kind: 'message', text: 'two' });
  // the crash: seq 3 half-written
  fs.appendFileSync(path.join(dir, 'ada.jsonl'), '{"seq":3,"ts":"2026-01-01T00:00:00.000Z","lieut');

  const { d } = open(dir);
  assert.strictEqual(d.head(), 3);
  assert.deepStrictEqual(d.pending('ada').map((i) => i.text), ['one', 'two']);
  assert.strictEqual(d.push('ada', { kind: 'message', text: 'four' }).seq, 4);
  // the next append did not glue onto the torn line
  assert.deepStrictEqual(open(dir).d.pending('ada').map((i) => i.seq), [1, 2, 4]);
});

test('reboot: the seq continues past the cursors, not only past readable items', () => {
  const dir = tmpDir();
  const first = open(dir).d;
  for (let i = 0; i < 3; i++) first.push('ada', { kind: 'message', text: 'm' + i });
  first.drain('ada');
  first.ack('ada', 3);
  // every item line lost, the cursors survive: a reissued 1..3 would read as acked
  fs.writeFileSync(path.join(dir, 'ada.jsonl'), '');
  const { d } = open(dir);
  const it = d.push('ada', { kind: 'message', text: 'new' });
  assert.strictEqual(it.seq, 4);
  assert.deepStrictEqual(d.pending('ada').map((i) => i.seq), [4]);
});

test('owed: queued until drained, seen until acked, cleared by the ack', () => {
  const dir = tmpDir();
  const { d } = open(dir);
  assert.strictEqual(d.owed('card:x'), null, 'never delivered: not owed');
  d.push('ada', { kind: 'message', target: 'card:x', text: 'please' });
  d.push('ada', { kind: 'worker-signal', card: 'x', text: 'not a captain message' });
  assert.strictEqual(d.owed('card:x'), 'queued');
  assert.strictEqual(d.drain('ada').seen, true);
  assert.strictEqual(d.drain('ada').seen, false, 'nothing new served: the cursor stays');
  assert.strictEqual(d.owed('card:x'), 'seen');
  d.ack('ada', 2);
  assert.strictEqual(d.owed('card:x'), null);
  // the index survives a reboot
  d.push('ada', { kind: 'message', target: 'lieutenant:ada', text: 'status?' });
  assert.strictEqual(open(dir).d.owed('lieutenant:ada'), 'queued');
  assert.strictEqual(open(dir).d.owed('card:x'), null);
});

test('wake: one per burst, re-armed by drain, ack, TTL, a new session, or a failed send', async () => {
  const dir = tmpDir();
  const { d, sends, clock } = open(dir, { extra: { wakeTtlMs: 1000 } });
  d.push('ada', { kind: 'message', text: 'a' });
  d.push('ada', { kind: 'message', text: 'b' });
  assert.deepStrictEqual(sends.map((s) => s.text), ['[bridge-commander] 1 pending item(s) — run: bc-axi drain']);

  d.drain('ada');
  d.push('ada', { kind: 'message', text: 'c' });
  assert.strictEqual(sends.length, 2);
  assert.match(sends[1].text, /3 pending item\(s\)/);

  d.ack('ada', 3);
  assert.strictEqual(d.nudge('ada'), false, 'nothing pending, nothing to wake');
  d.push('ada', { kind: 'message', text: 'd' });
  assert.strictEqual(sends.length, 3);

  // sent is not delivered: past the TTL the same pending item wakes again
  assert.strictEqual(d.nudge('ada'), false);
  clock.t += 1001;
  assert.strictEqual(d.nudge('ada'), true);
  d.resetNudge('ada');
  assert.strictEqual(d.nudge('ada'), true);
  assert.strictEqual(sends.length, 5);
});

test('wake: a failed send re-arms; an unreachable lieutenant is not marked woken', async () => {
  const failing = open(tmpDir(), { fail: true });
  failing.d.push('ada', { kind: 'message', text: 'a' });
  assert.strictEqual(failing.sends.length, 1);
  await tick();
  failing.d.push('ada', { kind: 'message', text: 'b' });
  assert.strictEqual(failing.sends.length, 2, 'the failure cleared the flag');

  const down = open(tmpDir(), { reachable: false });
  down.d.push('ada', { kind: 'message', text: 'a' });
  assert.strictEqual(down.d.nudge('ada'), false);
  assert.strictEqual(down.d.pending('ada').length, 1, 'the queue keeps it either way');
});

test('forget: a retired lieutenant leaves no queue, cursor or owed behind', () => {
  const dir = tmpDir();
  const { d } = open(dir);
  d.push('ada', { kind: 'message', target: 'lieutenant:ada', text: 'bye' });
  d.drain('ada');
  d.ack('ada', 1);
  d.push('ada', { kind: 'message', target: 'lieutenant:ada', text: 'again' });
  d.forget('ada');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(d.pending(), []);
  assert.strictEqual(d.owed('lieutenant:ada'), null);
  assert.strictEqual(d.push('bob', { kind: 'message', text: 'x' }).seq, 3, 'the seq never goes back');
});

test('hush: after an interrupt no wake goes out until a NEW item arrives; the order stays pending', async () => {
  const { d, sends, clock } = open(tmpDir());
  d.push('ada', { kind: 'message', text: 'run the long thing' });
  assert.strictEqual(sends.length, 1);
  await tick();
  d.hush('ada');
  clock.t += 10 * 60 * 1000; // far past the wake TTL
  assert.strictEqual(d.nudge('ada'), false, 'a turn-end or sweep re-nudge does not restart the stopped turn');
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(d.pending('ada').map((i) => i.text), ['run the long thing'], 'still unacked');
  d.push('ada', { kind: 'message', text: 'now something else' });
  assert.strictEqual(sends.length, 2, 'the next captain message wakes it again');
  d.hush('ada');
  d.resetNudge('ada'); // a new session owes a drain
  clock.t += 10 * 60 * 1000;
  assert.strictEqual(d.nudge('ada'), true);
});

test('wake: once every item is drained, one reminder per drain and no TTL re-fire pile-up', async () => {
  const { d, sends, clock } = open(tmpDir());
  d.push('ada', { kind: 'message', text: 'long job' });
  await tick();
  clock.t += 10 * 60 * 1000;
  assert.strictEqual(d.nudge('ada'), true, 'undrained: the TTL heartbeat still heals a lost wake');
  d.drain('ada'); // the turn started and read it
  assert.strictEqual(d.nudge('ada'), true, 'one reminder after the drain');
  await tick();
  for (let i = 0; i < 5; i++) { clock.t += 10 * 60 * 1000; assert.strictEqual(d.nudge('ada'), false); }
  assert.strictEqual(sends.length, 3);
  d.push('ada', { kind: 'message', text: 'a new order' });
  assert.strictEqual(sends.length, 4, 'an unread item wakes again');
});
