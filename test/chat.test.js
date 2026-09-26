'use strict';
// Chat: lieutenant say (main chat and card thread), captain feedback. Each
// lieutenant has its own main chat; a card thread's interlocutor is the owning
// lieutenant. The "owes a reply" signal is card.status.owed (status.test.js).
//
// Lieutenant main chat lives in an append-only file, not in board.json:
// <state>/chat/<lieutenant>.jsonl, one message per line, the way archive.jsonl
// and the delivery queues are written. board.json carries NO chat at all; the
// server holds the newest CHAT_TAIL per lieutenant in memory (read from the
// file at boot) and that is what GET /api/board ships. Older history pages
// backwards over GET /api/chat. Card threads are untouched — they stay on the
// board and die with their card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

const TAIL = 50;
function stateDir(dir) { return path.join(dir, '.bridge-commander'); }
function chatFile(dir, lt) { return path.join(stateDir(dir), 'chat', lt + '.jsonl'); }
function readLog(dir, lt) {
  return fs.readFileSync(chatFile(dir, lt), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function readBoardFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'board.json'), 'utf8'));
}
function tmpWorkspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-chatlog-')); }

// A board.json in the OLD shape: chat inline on the lieutenant.
function seedBoardWithChat(dir, messages) {
  fs.mkdirSync(stateDir(dir), { recursive: true });
  fs.writeFileSync(path.join(stateDir(dir), 'board.json'), JSON.stringify({
    title: 'seeded', seq: 0,
    lieutenants: [{ id: LT, name: 'Ada', color: '#58b6ff', prefix: 'ADA', cardSeq: 0, chat: messages, created: '2026-01-01T00:00:00.000Z' }],
    cards: [], events: [], labels: [], reads: {}, kinds: {}, projects: [], workers: [], line: null,
  }, null, 2));
}
function fakeMessages(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ author: i % 2 ? 'Ada' : 'user', text: 'msg ' + (i + 1),
      ts: new Date(Date.parse(from || '2026-01-01T00:00:00.000Z') + i * 1000).toISOString() });
  }
  return out;
}

test('lieutenant say to its main chat lands in lieutenant.chat and rings a level-1 event', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: 'hello there' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const lt = board.lieutenants[0];
    assert.strictEqual(lt.chat.length, 1);
    // an unidentified caller signs as `agent` — the author is never inferred from the target
    assert.strictEqual(lt.chat[0].author, 'agent');
    assert.strictEqual(lt.chat[0].text, 'hello there');
    // a main-chat lieutenant message doubles as a level-1 board event
    const ev = board.events.filter((e) => e.level === 1 && e.text === 'hello there');
    assert.strictEqual(ev.length, 1);

    // empty text rejected; unknown lieutenant 404
    assert.strictEqual((await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: '  ' })).status, 400);
    assert.strictEqual((await s.api('POST', '/api/message', { target: 'lieutenant:ghost', text_md: 'x' })).status, 404);
  } finally {
    await s.stop();
  }
});

test('lieutenant say to a card thread appends to card.thread, sets threadStart, no board event, no chat log', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Chatty' }));
    const r = await s.api('POST', '/api/message', { target: 'card:chatty', text: 'per-card reply' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const card = board.cards[0];
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'agent'); // unidentified: not the owner's name either
    assert.strictEqual(card.threadStart, card.thread[0].ts);
    // card-thread messages do not hit the board stream (only the lieutenant-joined event is there)
    assert.deepStrictEqual(board.events.filter((e) => e.text !== 'lieutenant Ada joined the bridge'), []);

    // stored on the card, so it dies with the card — never in the lieutenant log
    assert.deepStrictEqual(readBoardFile(s.dir).cards[0].thread.map((m) => m.text), ['per-card reply']);
    assert.ok(!fs.existsSync(chatFile(s.dir, LT)));

    // unknown card target is a 404
    const bad = await s.api('POST', '/api/message', { target: 'card:ghost', text: 'x' });
    assert.strictEqual(bad.status, 404);
  } finally {
    await s.stop();
  }
});

test('say author defaults to the session-resolved CALLER, not the target lieutenant', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref: { harness: 'fake', session: 'bc-grace', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Cross' })); // owned by Ada

    // Grace (identified by her session) posts on Ada's card → stamped Grace
    let r = await s.api('POST', '/api/message', { target: 'card:cross', text: 'peer input', session: 'bc-grace' });
    assert.strictEqual(r.status, 200);
    let card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[0].author, 'Grace');

    // explicit author still wins over the session
    await s.api('POST', '/api/message', { target: 'card:cross', text: 'as someone else', session: 'bc-grace', author: 'custom' });
    card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[1].author, 'custom');

    // an unresolved session is an unidentified caller: `agent`, never the target's lieutenant
    await s.api('POST', '/api/message', { target: 'card:cross', text: 'anonymous', session: 'bc-nobody' });
    card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[2].author, 'agent');

    // Grace saying into another lieutenant's MAIN chat is stamped Grace too
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: 'handoff note', session: 'bc-grace' });
    const ada = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === LT);
    assert.strictEqual(ada.chat[0].author, 'Grace');
  } finally {
    await s.stop();
  }
});

test('cli: say self-identifies by its tmux session', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref: { harness: 'fake', session: 'bc-grace', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Cli cross' }));
    // stub tmux on PATH answering the caller's session name
    const bin = path.join(s.dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho bc-grace\n');
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);
    const textFile = path.join(s.dir, 'say.txt');
    fs.writeFileSync(textFile, 'hello from grace');
    const r = await runCli(['say', 'card:cli-cross', '--text-file', textFile,
      '--workspace', s.dir, '--port', String(s.port)],
    { TMUX: '/tmp/stub,1,0', PATH: bin + ':' + process.env.PATH });
    assert.strictEqual(r.code, 0, r.stderr);
    const card = (await s.api('GET', '/api/cards/cli-cross')).body;
    assert.strictEqual(card.thread[0].author, 'Grace');
  } finally {
    await s.stop();
  }
});

test('card-thread say by a non-owner queues a worker-said item waking the owner; the identified owner is exempt', async () => {
  const s = await startServerWithLieutenant();
  try {
    // grace owns the card and HAS a session ref (so she can be identified as the owner)
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref: { harness: 'fake', session: 'bc-grace', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', { title: 'Watched', owner: 'grace', id: 'watched' });

    // an unidentified caller (a worker's tmux session resolves to no lieutenant)
    // → durable worker-said item for the owner, on top of the thread message
    let r = await s.api('POST', '/api/message', { target: 'card:watched', text: 'EMERGENCY: the PR looks spurious', session: 'bc-w-nobody' });
    assert.strictEqual(r.status, 200);
    let items = (await s.api('GET', '/api/feed?lieutenant=grace')).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'worker-said');
    assert.strictEqual(items[0].card, 'watched');
    assert.strictEqual(items[0].target, 'card:watched');
    assert.strictEqual(items[0].text, 'EMERGENCY: the PR looks spurious');

    // a peer lieutenant (identified, NOT the owner) also notifies, stamped as itself
    await s.api('POST', '/api/message', { target: 'card:watched', text: 'peer heads-up', session: 'bc-' + LT });
    await s.api('POST', '/api/lieutenants', { name: 'Hopper', id: 'hopper', ref: { harness: 'fake', session: 'bc-hopper', cwd: '/tmp' } });
    await s.api('POST', '/api/message', { target: 'card:watched', text: 'from hopper', session: 'bc-hopper' });
    items = (await s.api('GET', '/api/feed?lieutenant=grace')).body.items;
    const hop = items.find((i) => i.text === 'from hopper');
    assert.ok(hop, 'peer say queued');
    assert.strictEqual(hop.kind, 'worker-said');
    assert.strictEqual(hop.author, 'Hopper');

    // the owner replying on her OWN card thread never self-notifies
    const before = (await s.api('GET', '/api/feed?lieutenant=grace')).body.items.length;
    await s.api('POST', '/api/message', { target: 'card:watched', text: 'on it', session: 'bc-grace' });
    items = (await s.api('GET', '/api/feed?lieutenant=grace')).body.items;
    assert.strictEqual(items.length, before, 'no worker-said for the owner\'s own reply');
    // …but her reply DID land on the thread
    const card = (await s.api('GET', '/api/cards/watched')).body;
    assert.strictEqual(card.thread[card.thread.length - 1].text, 'on it');
  } finally {
    await s.stop();
  }
});

test('captain feedback lands in the thread and queues a message item to the owner', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Askable' }));
    const r = await s.api('POST', '/api/feedback', { target: 'card:askable', text: 'please look at this' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.seq, 1);

    const card = (await s.api('GET', '/api/cards/askable')).body;
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'user');

    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.strictEqual(feed.body.items.length, 1);
    assert.strictEqual(feed.body.items[0].kind, 'message');
    assert.strictEqual(feed.body.items[0].lieutenant, LT);
    assert.strictEqual(feed.body.items[0].target, 'card:askable');
    assert.strictEqual(feed.body.items[0].text, 'please look at this');
  } finally {
    await s.stop();
  }
});

test('captain feedback to a lieutenant main chat routes to that lieutenant queue', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:grace', text: 'status?' });
    const ada = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(ada.body.items, []);
    const grace = await s.api('GET', '/api/feed?lieutenant=grace');
    assert.strictEqual(grace.body.items.length, 1);
    assert.strictEqual(grace.body.items[0].target, 'lieutenant:grace');

    const board = (await s.api('GET', '/api/board')).body;
    const g = board.lieutenants.find((l) => l.id === 'grace');
    assert.strictEqual(g.chat.length, 1);
    assert.strictEqual(g.chat[0].author, 'user');
  } finally {
    await s.stop();
  }
});

// Main chat log: file storage, boot migration, board tail, paging.
test('boot migration: chat leaves board.json for the file, in order', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const stored = readBoardFile(dir);
    assert.ok(!('chat' in stored.lieutenants[0]), 'no lieutenant on the stored board carries a chat key');
    assert.deepStrictEqual(readLog(dir, LT).map((m) => m.text), msgs.map((m) => m.text),
      'every message that was on the board is in the log, in the original order');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('booting twice appends nothing the second time', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(7));
  let s = await startServer({ dir });
  await s.stop();
  const afterFirst = fs.readFileSync(chatFile(dir, LT));
  s = await startServer({ dir });
  try {
    assert.deepStrictEqual(fs.readFileSync(chatFile(dir, LT)), afterFirst,
      'a second boot doubles nobody\'s history');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/board ships at most the newest 50, newest last', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.strictEqual(chat.length, TAIL);
    assert.strictEqual(chat[0].text, 'msg 71');
    assert.strictEqual(chat[chat.length - 1].text, 'msg 120', 'newest last — the order the pane renders');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sending a message appends exactly one line and rewrites none of the bytes before it', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(60));
  const s = await startServer({ dir });
  try {
    const before = fs.readFileSync(chatFile(dir, LT));
    const r = await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'and now this' });
    assert.strictEqual(r.status, 200);
    const after = fs.readFileSync(chatFile(dir, LT));
    assert.deepStrictEqual(after.subarray(0, before.length), before, 'the bytes before are byte-identical');
    const lines = readLog(dir, LT);
    assert.strictEqual(lines.length, 61, 'exactly one line more');
    assert.strictEqual(lines[60].text, 'and now this');
    // …and the board still carries no chat
    assert.ok(!('chat' in readBoardFile(dir).lieutenants[0]));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a message survives a crash before the next saveBoard — the file is truth', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(3));
  let s = await startServer({ dir });
  await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'said it, then died' });
  s.child.kill('SIGKILL'); // no clean shutdown, no final save
  await new Promise((r) => s.child.once('exit', r));
  s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.strictEqual(chat[chat.length - 1].text, 'said it, then died');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn last line costs that line, not the conversation', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(4);
  seedBoardWithChat(dir, msgs);
  let s = await startServer({ dir }); // migrates the seeded chat into the file
  await s.stop();
  const raw = fs.readFileSync(chatFile(dir, LT), 'utf8');
  fs.writeFileSync(chatFile(dir, LT), raw + JSON.stringify(msgs[0]).slice(0, 20)); // crash mid-append
  s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.deepStrictEqual(chat.map((m) => m.text), msgs.map((m) => m.text), 'every whole line still reads');
    const page = await s.api('GET', '/api/chat?limit=0&target=' + encodeURIComponent('lieutenant:' + LT));
    assert.strictEqual(page.body.messages.length, 4);
    // the file is never repaired — append-only means append-only
    assert.ok(fs.readFileSync(chatFile(dir, LT), 'utf8').startsWith(raw));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/chat pages backwards, and answers past the beginning with an empty list and a 200', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const target = 'lieutenant:' + LT;
    const page = async (before, limit) => s.api('GET', '/api/chat?target=' + encodeURIComponent(target)
      + (before ? '&before=' + encodeURIComponent(before) : '') + (limit == null ? '' : '&limit=' + limit));

    const first = await page(msgs[70].ts, 20); // the page before what the board shipped
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.messages.map((m) => m.text),
      msgs.slice(50, 70).map((m) => m.text), 'oldest-first, strictly older than the cursor');

    // walk the rest of the way back
    let cursor = first.body.messages[0].ts;
    let seen = first.body.messages.length;
    for (;;) {
      const r = await page(cursor, 20);
      assert.strictEqual(r.status, 200);
      if (!r.body.messages.length) break; // past the beginning: empty, never an error
      seen += r.body.messages.length;
      cursor = r.body.messages[0].ts;
    }
    assert.strictEqual(seen, 70, 'the whole history before the board tail, once each');

    // the very first message has nothing before it
    const none = await page(msgs[0].ts, 20);
    assert.strictEqual(none.status, 200);
    assert.deepStrictEqual(none.body.messages, []);

    // limit=0 is the whole conversation; a card target has nothing to page
    const all = await page('', 0);
    assert.strictEqual(all.body.messages.length, 120);
    // ...but only an explicit 0. A limit that does not parse falls back to the
    // default page instead of shipping the entire log.
    for (const bad of ['abc', '']) {
      const r = await page('', bad);
      assert.strictEqual(r.body.messages.length, TAIL, 'limit=' + JSON.stringify(bad) + ' is not "everything"');
    }
    assert.strictEqual((await s.api('GET', '/api/chat?target=card:x')).status, 400);
    assert.strictEqual((await s.api('GET', '/api/chat?target=lieutenant:ghost')).status, 404);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bc-axi thread lieutenant:<id> prints the full conversation, not just the board tail', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const r = await runCli(['thread', 'lieutenant:' + LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /msg 1$/m, 'the first message is there');
    assert.match(r.stdout, /msg 120$/m);
    assert.strictEqual(r.stdout.split('\n').filter((l) => /msg \d+$/.test(l)).length, 120);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a captain message leaves unread / owed / queued exactly as they were', async () => {
  const s = await startServerWithLieutenant();
  try {
    const target = 'lieutenant:' + LT;
    const ltOf = async () => (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === LT);
    const before = await ltOf();
    assert.strictEqual(before.chatOwed, false);
    assert.strictEqual(before.chatQueued, false);

    await s.api('POST', '/api/feedback', { target, text: 'status?' });
    const after = await ltOf();
    assert.strictEqual(after.chatOwed, true, 'the captain is owed a reply');
    assert.strictEqual(after.chatQueued, true, 'and it is sitting undrained in the queue');
    assert.strictEqual(after.chat[after.chat.length - 1].text, 'status?');

    // the lieutenant answers and acks: owed clears on the ACK, as it always did
    const pending = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    await s.api('POST', '/api/message', { target, text_md: 'all good' });
    await s.api('POST', '/api/feed/ack', { seq: pending[pending.length - 1].seq });
    const done = await ltOf();
    assert.strictEqual(done.chatOwed, false);
    assert.strictEqual(done.chatQueued, false);
    assert.strictEqual(done.chat[done.chat.length - 1].text, 'all good');
  } finally { await s.stop(); }
});
