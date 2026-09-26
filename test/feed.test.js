'use strict';
// Delivery queues — the at-least-once contract: durable per-lieutenant jsonl
// files with a GLOBAL seq; drain re-offers unacked items on every call; only an
// explicit ack commits the cursor. Dedupe is the consumer's job.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, LT } = require('./helper');

function queueDir(s) { return path.join(s.dir, '.bridge-commander', 'queue'); }

test('unacked items re-offer on every drain; ack commits and persists the cursor', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'first' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'second' });

    // both offered, and durable on disk
    let r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2]);
    assert.strictEqual(r.body.head, 2);
    const onDisk = fs.readFileSync(path.join(queueDir(s), LT + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(onDisk.map((e) => e.seq), [1, 2]);

    // drain does NOT advance the cursor: the same items re-offer
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2]);

    // partial ack: only what's past the committed cursor re-offers
    let a = await s.api('POST', '/api/feed/ack', { seq: 1 });
    assert.strictEqual(a.body.ack, 1);
    assert.strictEqual(a.body.lieutenant, LT);
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // full ack: queue drained
    await s.api('POST', '/api/feed/ack', { seq: 2 });
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items, []);

    // the committed cursor is durable (own file under queue/)
    assert.strictEqual(fs.readFileSync(path.join(queueDir(s), LT + '.ack'), 'utf8'), '2');

    // ack never regresses; an unknown seq is rejected
    await s.api('POST', '/api/feed/ack', { seq: 1 });
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items, []); // still committed at 2
    a = await s.api('POST', '/api/feed/ack', { seq: 99 });
    assert.strictEqual(a.status, 400);
    a = await s.api('POST', '/api/feed/ack', {});
    assert.strictEqual(a.status, 400);
  } finally {
    await s.stop();
  }
});

test('queue and ack cursor survive a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const s1 = await startServerWithLieutenant({ dir });
  try {
    await s1.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'one' });
    await s1.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'two' });
    await s1.api('POST', '/api/feed/ack', { seq: 1 });
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const r = await s2.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]); // unacked item re-offered after restart
    // the global seq continues past everything stored
    await s2.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'three' });
    const r2 = await s2.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r2.body.items.map((e) => e.seq), [2, 3]);
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A crash mid-append leaves a torn last line. It used to make the whole queue
// read as empty (pending items vanished) and the whole archive disappear.
test('a torn last line costs that line only: queue, seq and archive survive', async () => {
  const torn = '{"seq":3,"ts":"2026-01-01T00:00:00.000Z","lieu';
  const s = await startServer({
    seed: (dir) => {
      const state = path.join(dir, '.bridge-commander');
      fs.mkdirSync(path.join(state, 'queue'), { recursive: true });
      const item = (seq) => JSON.stringify({ seq, ts: '2026-01-01T00:00:00.000Z', lieutenant: LT, kind: 'message', text: 't' + seq });
      fs.writeFileSync(path.join(state, 'queue', LT + '.jsonl'), item(1) + '\n' + item(2) + '\n' + torn);
      const rec = { ts: '2026-01-01T00:00:00.000Z', actor: 'user', reason: 'killed', card: { id: 'old', title: 'Old' } };
      fs.writeFileSync(path.join(state, 'archive.jsonl'), JSON.stringify(rec) + '\n{"ts":"2026');
    },
  });
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Ada', id: LT });
    let r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2]);
    // the torn item's seq is never reissued, and the next append is its own line
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'after' });
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2, 4]);
    const a = await s.api('GET', '/api/archive');
    assert.deepStrictEqual(a.body.archive.map((x) => x.card.id), ['old']);
  } finally {
    await s.stop();
  }
});

test('the seq is global across lieutenants; drain filters by lieutenant, acks stay per-queue', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'to ada' });      // seq 1
    await s.api('POST', '/api/feedback', { target: 'lieutenant:grace', text: 'to grace' });    // seq 2
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'to ada again' });// seq 3

    // no filter: everything pending, seq-ordered board-wide
    let r = await s.api('GET', '/api/feed');
    assert.deepStrictEqual(r.body.items.map((e) => [e.seq, e.lieutenant]), [[1, LT], [2, 'grace'], [3, LT]]);

    // per-lieutenant drain
    r = await s.api('GET', '/api/feed?lieutenant=grace');
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // two lieutenants: an ack nobody can attribute is refused, it could discard
    // either queue
    assert.strictEqual((await s.api('POST', '/api/feed/ack', { seq: 3 })).status, 400);
    // acking seq 3 commits ada's cursor past seq 1 too (per-queue ascending), but
    // never touches grace's queue
    await s.api('POST', '/api/feed/ack', { seq: 3, lieutenant: LT });
    r = await s.api('GET', '/api/feed');
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // unknown lieutenant filter is a 404, on drain and on ack
    assert.strictEqual((await s.api('GET', '/api/feed?lieutenant=ghost')).status, 404);
    assert.strictEqual((await s.api('POST', '/api/feed/ack', { seq: 2, lieutenant: 'ghost' })).status, 404);
  } finally {
    await s.stop();
  }
});

// Multi-lieutenant queue isolation: a lieutenant drains ONLY its own queue.
// Regression for the cross-drain bug where a second lieutenant's startup drain
// received another lieutenant's captain message and replied into its chat.
// Identity is the caller's tmux session (ref.session); the CLI passes it as
// ?session=, the server resolves it to that one lieutenant.
test('session-scoped drain and ack isolate each lieutenant to its own queue', async () => {
  const s = await startServer();
  try {
    const cmd = { harness: 'fake', session: 'bc-cmd', cwd: '/tmp' };
    const mon = { harness: 'fake', session: 'bc-mon', cwd: '/tmp' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'commander', id: 'commander', ref: cmd })).status, 200);
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica', ref: mon })).status, 200);

    // captain messages ONLY commander's main chat
    assert.strictEqual((await s.api('POST', '/api/feedback', { target: 'lieutenant:commander', text: 'Oi' })).status, 200);

    // Monica's drain (by her session) sees nothing — not commander's item
    const monDrain = await s.api('GET', '/api/feed?session=bc-mon');
    assert.strictEqual(monDrain.status, 200);
    assert.strictEqual(monDrain.body.items.length, 0, 'Monica must not drain commander\'s queue');

    // commander's drain (by its session) gets exactly its own item
    const cmdDrain = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(cmdDrain.status, 200);
    assert.strictEqual(cmdDrain.body.items.length, 1);
    assert.strictEqual(cmdDrain.body.items[0].text, 'Oi');
    assert.strictEqual(cmdDrain.body.items[0].lieutenant, 'commander');

    // an unresolved session (non-lieutenant caller / stale ref) drains NOTHING,
    // never every queue — draining-all here is what enabled cross-lieutenant
    // ack wipes
    const ghost = await s.api('GET', '/api/feed?session=bc-ghost');
    assert.strictEqual(ghost.status, 200);
    assert.strictEqual(ghost.body.items.length, 0);

    // explicit --lieutenant still scopes
    const byId = await s.api('GET', '/api/feed?lieutenant=monica');
    assert.strictEqual(byId.body.items.length, 0);

    // raw API with no identity at all is a read-only peek at every queue
    const all = await s.api('GET', '/api/feed');
    assert.strictEqual(all.body.items.length, 1);

    const seq = cmdDrain.body.items[0].seq;
    // ack ownership: Monica (by session) must NOT be able to commit commander's seq
    const steal = await s.api('POST', '/api/feed/ack', { seq, session: 'bc-mon' });
    assert.strictEqual(steal.status, 409, 'a lieutenant must not ack another\'s queue');
    // nor may a session that is no lieutenant, nor a caller with no identity
    assert.strictEqual((await s.api('POST', '/api/feed/ack', { seq, session: 'bc-ghost' })).status, 403);
    assert.strictEqual((await s.api('POST', '/api/feed/ack', { seq })).status, 400);
    // commander's item is still pending — nothing was discarded
    const stillThere = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(stillThere.body.items.length, 1);
    // commander acks its own seq — that works
    const own = await s.api('POST', '/api/feed/ack', { seq, session: 'bc-cmd' });
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.body.lieutenant, 'commander');
    const drained = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(drained.body.items.length, 0);
  } finally {
    await s.stop();
  }
});

// The words a drain prints are the server's (feedtext.js): each served item
// carries its head and next-action hint, rendered against the card as it
// stands at drain time — never written into the queue itself.
test('drained items carry head and hint, rendered against the live card', async () => {
  const s = await startServerWithLieutenant();
  try {
    const id = (await s.api('POST', '/api/cards', { title: 'Wire it', owner: LT })).body.card.id;
    await s.api('POST', '/api/feedback', { target: 'card:' + id, text: 'how is it going?' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'hello' });

    let items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.strictEqual(items[0].head, 'captain message on card ' + id + ' "Wire it" [backlog]');
    assert.strictEqual(items[0].hint, 'reply on the thread: bc-axi say card:' + id + ' --text-file <f|->');
    assert.strictEqual(items[1].head, 'captain message (your main chat)');
    assert.match(items[1].hint, /bc-axi say lieutenant:ada/);

    // the unidentified peek gets the same words
    items = (await s.api('GET', '/api/feed')).body.items;
    assert.strictEqual(items[0].head, 'captain message on card ' + id + ' "Wire it" [backlog]');

    // rendered at drain time: a renamed card reads renamed, and the queue on
    // disk holds only what was delivered
    await s.api('PATCH', '/api/cards/' + id, { title: 'Wire it twice' });
    items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.match(items[0].head, /"Wire it twice"/);
    const onDisk = fs.readFileSync(path.join(queueDir(s), LT + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(onDisk.every((it) => !('head' in it) && !('hint' in it)), 'nothing presentational is stored');

    // a card that left the board says so
    await s.api('POST', '/api/cards/' + id + '/archive', { actor: 'user' });
    items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.strictEqual(items[0].head, 'captain message on card ' + id + ' (not on the board — archived?)');
  } finally {
    await s.stop();
  }
});
