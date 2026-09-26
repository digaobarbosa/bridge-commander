'use strict';
// Event append (card and board level), levels, seq ordering, notifications/read state.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, withOwner, LT, sleep } = require('./helper');

test('card events: default level 2, explicit level 1, open kind tokens, monotonic seq', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Evented' }));

    let r = await s.api('POST', '/api/cards/evented/events', { text: 'quiet note' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 2); // card events default to timeline-only
    assert.strictEqual(r.body.event.kind, undefined); // no kind given: none stored
    const seq1 = r.body.event.seq;

    r = await s.api('POST', '/api/cards/evented/events', { text: 'ring the bell', level: 1, kind: 'alert' });
    assert.strictEqual(r.body.event.level, 1);
    assert.strictEqual(r.body.event.kind, 'alert');
    assert.strictEqual(r.body.event.seq, seq1 + 1); // global monotonic seq

    // a kind is an open token: unknown kinds are stored as-is (opaque)
    r = await s.api('POST', '/api/cards/evented/events', { text: 'weird', kind: 'bogus' });
    assert.strictEqual(r.body.event.kind, 'bogus');
    assert.strictEqual(r.body.event.level, 2); // not in the kinds map: level falls back

    // text is required
    r = await s.api('POST', '/api/cards/evented/events', { text: '  ' });
    assert.strictEqual(r.status, 400);

    const card = (await s.api('GET', '/api/cards/evented')).body;
    assert.strictEqual(card.events.length, 4); // birth event + 3 appended
  } finally {
    await s.stop();
  }
});

test('wakeOwner queues the event to the card owner without ringing the captain', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Paged' }));

    let r = await s.api('POST', '/api/cards/paged/events',
      { text: 'the gate needs a decision', kind: 'pipeline', actor: 'runner', wakeOwner: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 2); // waking the owner is not a captain bell

    // on the timeline
    const card = (await s.api('GET', '/api/cards/paged')).body;
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.kind, 'pipeline');
    assert.strictEqual(ev.text, 'the gate needs a decision');

    // in the owner's queue, carrying card, event kind and text
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    const item = items.find((i) => i.kind === 'card-event');
    assert.ok(item, items.map((i) => i.kind).join(','));
    assert.strictEqual(item.card, 'paged');
    assert.strictEqual(item.eventKind, 'pipeline');
    assert.strictEqual(item.text, 'the gate needs a decision');

    // and NOT in the captain's notifications
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.items.length, 0);

    // without the flag: timeline only, no new queue item
    await s.api('POST', '/api/cards/paged/events', { text: 'quiet' });
    const after = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.strictEqual(after.filter((i) => i.kind === 'card-event').length, 1);
  } finally {
    await s.stop();
  }
});

test('board-level events default to level 1', async () => {
  const s = await startServerWithLieutenant();
  try {
    let r = await s.api('POST', '/api/events', { text: 'board-wide notice' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 1);
    r = await s.api('POST', '/api/events', { text: 'quiet one', level: 2 });
    assert.strictEqual(r.body.event.level, 2);
    r = await s.api('POST', '/api/events', { text: '' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('notifications: level-1 slice of the unified stream, read state persists per user', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Noisy' })); // level-2 birth event
    await s.api('POST', '/api/cards/noisy/events', { text: 'important', level: 1 });
    await s.api('POST', '/api/events', { text: 'board alert' }); // level 1

    let r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.items.length, 2); // only level-1 events
    assert.strictEqual(r.body.unread, 2);
    // newest first; the card event carries its card reference
    assert.strictEqual(r.body.items[0].text, 'board alert');
    assert.strictEqual(r.body.items[1].card, 'noisy');

    // mark one seq read
    const seq = r.body.items[1].seq;
    await s.api('POST', '/api/notifications/read', { seqs: [seq] });
    r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 1);

    // mark all read
    await s.api('POST', '/api/notifications/read', { all: true });
    r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 0);

    // read state is per user
    r = await s.api('GET', '/api/notifications?user=other');
    assert.strictEqual(r.body.unread, 2);
  } finally {
    await s.stop();
  }
});

test('thread read markers are stored per user and target', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Readable' }));
    let r = await s.api('POST', '/api/read', { target: 'card:readable', ts: '2026-01-01T00:00:00.000Z' });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', '/api/read', { target: 'lieutenant:' + LT });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', '/api/read', { target: 'bogus' });
    assert.strictEqual(r.status, 400);

    const board = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(board.reads.user.threads['card:readable'], '2026-01-01T00:00:00.000Z');
    assert.ok(board.reads.user.threads['lieutenant:' + LT]);
  } finally {
    await s.stop();
  }
});

// The bell includes unseen lieutenant card-thread replies: level-1 events UNION
// lieutenant-authored thread messages, cleared by reading (card open / mark-all),
// never double-counting lieutenant main-chat messages, never surfacing level-2.

test('lieutenant card-thread reply notifies unread; the captain\'s own message never does', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Convo' })); // level-2 birth event only
    await s.api('POST', '/api/feedback', { target: 'card:convo', text: 'how is it going?' });
    await s.api('POST', '/api/message', { target: 'card:convo', text: 'halfway there' });

    const r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 1);
    const replies = r.body.items.filter((e) => e.kind === 'reply');
    assert.strictEqual(replies.length, 1); // the lieutenant reply, not the captain's message
    const it = replies[0];
    // shaped like an event item for the drawer: ts/text/actor/card/cardTitle/read + kind
    assert.strictEqual(it.text, 'halfway there');
    assert.strictEqual(it.actor, 'Ada'); // the owning lieutenant is the interlocutor
    assert.strictEqual(it.card, 'convo');
    assert.strictEqual(it.cardTitle, 'Convo');
    assert.strictEqual(it.level, 1);
    assert.strictEqual(it.read, false);
    assert.ok(it.ts);
    assert.ok(!r.body.items.some((e) => e.text === 'how is it going?'), 'captain message absent');
  } finally {
    await s.stop();
  }
});

test('opening the card (thread read marker) clears reply notifications', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Openable' }));
    await s.api('POST', '/api/message', { target: 'card:openable', text: 'status update' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 1);

    await s.api('POST', '/api/read', { target: 'card:openable' }); // what opening the card sends
    const r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 0);
    assert.strictEqual(r.body.items.find((e) => e.kind === 'reply').read, true); // still listed, read

    // a NEW reply after the read notifies again
    await s.api('POST', '/api/message', { target: 'card:openable', text: 'another update' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 1);
  } finally {
    await s.stop();
  }
});

test('mark-all clears unseen replies too, per user', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Marked' }));
    await s.api('POST', '/api/cards/marked/events', { text: 'ring', level: 1 });
    await s.api('POST', '/api/message', { target: 'card:marked', text: 'reply too' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 2);

    await s.api('POST', '/api/notifications/read', { all: true });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 0);
    // read state is per user: another user still sees both unseen
    assert.strictEqual((await s.api('GET', '/api/notifications?user=other')).body.unread, 2);
  } finally {
    await s.stop();
  }
});

test('lieutenant main-chat message rides its level-1 event once — never doubled as a reply', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'board-wide word' });
    const r = await s.api('GET', '/api/notifications');
    const hits = r.body.items.filter((e) => e.text === 'board-wide word');
    assert.strictEqual(hits.length, 1); // the free-form level-1 event, exactly once
    assert.notStrictEqual(hits[0].kind, 'reply');
    assert.strictEqual(r.body.items.filter((e) => e.kind === 'reply').length, 0);
    assert.strictEqual(r.body.unread, 1);
  } finally {
    await s.stop();
  }
});

test('level-2 stays timeline-only; items come newest first across events and replies', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Ordered' }));
    await s.api('POST', '/api/cards/ordered/events', { text: 'quiet note', level: 2 });
    await s.api('POST', '/api/cards/ordered/events', { text: 'loud note', level: 1 });
    await sleep(5); // items interleave by ts (replies carry no seq): keep it unambiguous
    await s.api('POST', '/api/message', { target: 'card:ordered', text: 'then a reply' });

    const r = await s.api('GET', '/api/notifications');
    assert.ok(!r.body.items.some((e) => e.text === 'quiet note'), 'level 2 never notifies');
    assert.deepStrictEqual(r.body.items.map((e) => e.text), ['then a reply', 'loud note']);
  } finally {
    await s.stop();
  }
});
