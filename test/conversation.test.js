'use strict';
// server/conversation.js in-process: identify (who is calling), say (what an
// utterance sets in motion) and pass (the line), against a plain board object
// and recording fakes for the queue, the chat log and the clock. The route-level
// behaviour is driven over HTTP in chat/line/identity tests; this pins the
// decision table itself.
const test = require('node:test');
const assert = require('node:assert');
const { createConversation, parseTarget, CAPTAIN } = require('../server/conversation.js');

const ref = (session, window, extra) => Object.assign({ harness: 'fake', session, cwd: '/ws' }, window ? { window } : null, extra);

// ada and grace are window-granular (their `lt` window); the founder is a
// session-granular teleport not yet adopted; bob has no session at all.
function world() {
  const board = {
    lieutenants: [
      { id: 'ada', name: 'Ada', ref: ref('bc-ada', 'lt', { resumeId: 'sid-ada' }) },
      { id: 'grace', name: 'Grace', ref: ref('bc-grace', 'lt', { resumeId: 'sid-grace' }) },
      { id: 'founder', name: 'Founder', ref: Object.assign(ref('main'), { cwd: '/founder' }) },
      { id: 'bob', name: 'Bob', ref: null },
    ],
    cards: [{ id: 'ADA-1', owner: 'ada', thread: [] }],
    workers: [{ card: 'ADA-1', ref: ref('bc-ada', 'w-ADA-1', { resumeId: 'sid-worker' }) }],
    events: [],
    line: null,
  };
  const queue = [];
  const chats = {};
  const conv = createConversation({
    board: () => board,
    now: () => '2026-09-26T00:00:00.000Z',
    queuePush: (lt, rec) => { const it = Object.assign({ seq: queue.length + 1, lieutenant: lt }, rec); queue.push(it); return it; },
    chatAppend: (id, msg) => { (chats[id] = chats[id] || []).push(msg); return msg; },
    mkEvent: (body, d) => ({ text: body.text, actor: body.actor, level: body.level || d.level, kind: body.kind || d.kind }),
  });
  return { board, queue, chats, conv };
}

const who = (r) => (r.kind === 'lieutenant' ? 'lt:' + r.lt.id : r.kind === 'worker' ? 'worker:' + r.worker.card : 'none');

test('parseTarget: lieutenant and card targets, nothing else', () => {
  assert.deepStrictEqual(parseTarget('lieutenant:ada'), { kind: 'lieutenant', id: 'ada' });
  assert.deepStrictEqual(parseTarget('card:MON-14'), { kind: 'card', id: 'MON-14' });
  assert.deepStrictEqual(parseTarget('card:a:b'), { kind: 'card', id: 'a:b' });
  for (const bad of ['line', 'card:', 'lieutenant:', 'ada', '', null, undefined]) assert.strictEqual(parseTarget(bad), null, String(bad));
});

test('identify: a worker window is never its lieutenant', () => {
  const { conv, board } = world();
  const table = [
    [{ session: 'bc-ada', window: 'lt' }, 'lt:ada'],
    [{ session: 'bc-ada', window: 'w-ADA-1' }, 'worker:ADA-1'],
    [{ session: 'bc-ada', window: 'w-GONE' }, 'none'], // a stale worker is still not the lieutenant
    [{ session: 'bc-ada', window: 'zsh' }, 'none'], // a window-granular lieutenant lives in its own window
    [{ session: 'bc-ada' }, 'lt:ada'], // an older bc-axi sends the session only
    [{ session: 'main', window: 'claude' }, 'lt:founder'], // session-granular: any non-worker window
    [{ session: 'main', window: 'w-FOO' }, 'none'],
    [{ session: 'bc-nobody', window: 'lt' }, 'none'],
    [{ sessionId: 'sid-worker' }, 'worker:ADA-1'],
    [{ sessionId: 'sid-grace', session: 'bc-ada', window: 'w-ADA-1' }, 'lt:grace'], // the conversation id wins
    [{ key: 'bc-grace:lt' }, 'lt:grace'],
    [{ key: 'bc-ada:w-ADA-1', session: 'bc-ada' }, 'worker:ADA-1'],
    [{ key: 'bc-ada:w-GONE', session: 'bc-ada', sessionId: 'x' }, 'none'],
    [{ sessionId: 'new', cwd: '/founder' }, 'lt:founder'], // the one lieutenant with no resumeId, by cwd
    [{ sessionId: 'new', cwd: '/elsewhere' }, 'none'],
    [{}, 'none'],
  ];
  for (const [caller, want] of table) assert.strictEqual(who(conv.identify(caller)), want, JSON.stringify(caller));
  const w = conv.identify({ session: 'bc-ada', window: 'w-ADA-1' });
  assert.strictEqual(w.card, board.cards[0]);
  assert.strictEqual(w.owner.id, 'ada');
});

test('say: (caller, target) -> author, queue item, line holder', () => {
  const W = { session: 'bc-ada', window: 'w-ADA-1' };
  const table = [
    // from                          target               author            queued to/kind                 line after
    [CAPTAIN, 'card:ADA-1', 'user', ['ada', 'message'], null],
    [CAPTAIN, 'line', 'user', ['ada', 'message', 'line'], null], // nobody spoke: the founding lieutenant holds it
    [CAPTAIN, 'lieutenant:grace', 'user', ['grace', 'message'], null],
    [{ session: 'bc-ada', window: 'lt' }, 'card:ADA-1', 'Ada', null, null], // the owner on its own card
    [W, 'card:ADA-1', 'worker ADA-1', ['ada', 'worker-said'], null],
    [{ session: 'bc-grace', window: 'lt' }, 'card:ADA-1', 'Grace', ['ada', 'worker-said'], null],
    [{}, 'card:ADA-1', 'agent', ['ada', 'worker-said'], null],
    [{ session: 'bc-ada', window: 'lt' }, 'lieutenant:ada', 'Ada', null, 'ada'],
    [{ session: 'bc-grace', window: 'lt' }, 'lieutenant:ada', 'Grace', ['ada', 'peer-message'], null],
    [W, 'lieutenant:ada', 'worker ADA-1', ['ada', 'peer-message'], null],
    [{}, 'lieutenant:grace', 'agent', null, 'grace'],
  ];
  for (const [caller, target, author, queued, line] of table) {
    const { conv, board, queue } = world();
    const from = caller === CAPTAIN ? CAPTAIN : conv.identify(caller);
    const label = JSON.stringify(caller) + ' -> ' + target;
    const r = conv.say(from, target, 'hello', []);
    assert.ok(r.ok, label + ': ' + r.error);
    assert.strictEqual(r.message.author, author, label);
    assert.deepStrictEqual(queue.map((it) => [it.lieutenant, it.kind].concat(it.via ? [it.via] : [])), queued ? [queued] : [], label);
    assert.strictEqual(r.item, queued ? queue[0] : null, label);
    assert.strictEqual(board.line, line, label);
  }
});

test('say: the thread append, the event, and the refusals', () => {
  const { conv, board, chats, queue } = world();
  // a card thread is touched: updated + threadStart, attachments ride the item
  const atts = [{ id: 'a1', name: 'x.png', mime: 'image/png', path: '/tmp/x.png' }];
  let r = conv.say(CAPTAIN, 'card:ADA-1', 'look', atts);
  const card = board.cards[0];
  assert.strictEqual(card.thread.length, 1);
  assert.deepStrictEqual(card.thread[0].attachments, atts);
  assert.strictEqual(card.threadStart, card.thread[0].ts);
  assert.ok(card.updated);
  assert.deepStrictEqual(queue[0].attachments, atts);
  // a main-chat post lands in the chat log and rings a level-1 event
  r = conv.say(conv.identify({ session: 'bc-grace', window: 'lt' }), 'lieutenant:grace', 'PR is up', [], { kind: 'pr' });
  assert.strictEqual(chats.grace.length, 1);
  assert.deepStrictEqual(board.events.map((e) => [e.text, e.actor, e.level, e.kind]), [['PR is up', 'Grace', 1, 'pr']]);
  // explicit author wins over the caller
  r = conv.say(conv.identify({}), 'card:ADA-1', 'x', [], { author: 'ci-bot' });
  assert.strictEqual(r.message.author, 'ci-bot');
  // refusals
  assert.deepStrictEqual(conv.say(conv.identify({}), 'card:GHOST', 'x', []), { error: 'unknown target: card:GHOST', code: 404 });
  assert.deepStrictEqual(conv.say(CAPTAIN, 'lieutenant:ada', '  ', []), { error: 'text or attachments required', code: 400 });
  const empty = world();
  empty.board.lieutenants = [];
  assert.strictEqual(empty.conv.say(CAPTAIN, 'line', 'anyone?', []).code, 404);
});

test('pass: moves the line and delivers the note, signed by the caller', () => {
  const { conv, board, queue } = world();
  const r = conv.pass(conv.identify({ session: 'bc-ada', window: 'lt' }), 'grace', ' he wants the deploy ');
  assert.ok(r.ok);
  assert.strictEqual(board.line, 'grace');
  assert.deepStrictEqual([queue[0].lieutenant, queue[0].kind, queue[0].from, queue[0].text], ['grace', 'line-passed', 'Ada', 'he wants the deploy']);
  assert.strictEqual(board.events[0].text, 'the line passed to Grace: he wants the deploy');
  assert.strictEqual(conv.pass(conv.identify({}), 'ada', '').item.from, 'user'); // nobody identified: the captain
  assert.strictEqual(conv.pass(conv.identify({}), 'ada', '', { actor: 'Ops' }).item.from, 'Ops');
  assert.deepStrictEqual(conv.pass(conv.identify({}), 'ghost', 'x'), { error: 'unknown lieutenant: ghost', code: 404 });
  assert.strictEqual(conv.lineHolder().lieutenant.id, 'ada');
});
