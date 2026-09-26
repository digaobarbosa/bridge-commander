'use strict';
// server/store.js in-process: a temp board.json, a counting publish, the real
// setImmediate. The HTTP surface (routes answering through the store) is
// covered by every route test; this pins the door itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-store-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tick = () => new Promise((r) => setImmediate(r));

// A store over a fresh file; `published` counts board pushes, `logs` what it said.
function open(opts = {}) {
  const file = path.join(fs.mkdtempSync(path.join(ROOT, 'b-')), 'board.json');
  const out = { file, published: 0, logs: [] };
  out.store = createStore(Object.assign({
    file,
    normalize: (doc) => Object.assign({ seq: 0, cards: [], events: [] }, doc),
    fresh: () => ({ title: 'fresh', seq: 0, cards: [], events: [] }),
    kinds: () => ({ handoff: { emoji: '👀', level: 1 } }),
    now: () => '2026-09-26T00:00:00.000Z',
    publish: () => { out.published++; if (opts.publishThrows) throw new Error('socket gone'); },
    log: (m) => out.logs.push(m),
  }, opts.deps || {}));
  out.board = out.store.load();
  return out;
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a burst of changes in one tick is saved each time and pushed ONCE', async () => {
  const s = open();
  for (let i = 0; i < 5; i++) s.store.mutate((b) => { b.title = 'n' + i; });
  s.store.commit();
  s.store.broadcast();
  assert.strictEqual(s.published, 0, 'the push is deferred off the caller');
  assert.strictEqual(onDisk(s.file).title, 'n4', 'each change is on disk before mutate returns');
  await tick();
  assert.strictEqual(s.published, 1, 'seven calls, one rebuild of the served board');

  // the next tick is a new burst
  s.store.mutate((b) => { b.title = 'later'; });
  await tick();
  assert.strictEqual(s.published, 2);
});

test('a refused change writes nothing and pushes nothing, sync or async', async () => {
  const s = open();
  s.store.mutate((b) => { b.title = 'kept'; });
  await tick();
  const before = fs.readFileSync(s.file, 'utf8');
  const published = s.published;

  const r = s.store.mutate(() => ({ error: 'no', code: 409 }));
  assert.deepStrictEqual(r, { error: 'no', code: 409 }, 'the refusal comes back as it was');
  const ra = await s.store.mutate(async () => ({ error: 'later no', code: 404 }));
  assert.strictEqual(ra.code, 404);
  assert.throws(() => s.store.mutate(() => { throw new Error('boom'); }), /boom/);
  await tick();

  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), before, 'board.json untouched');
  assert.strictEqual(s.published, published, 'no push for a change that did not happen');
});

test('an async change is committed when it settles, and its result comes back', async () => {
  const s = open();
  const r = await s.store.mutate(async (b) => {
    await tick();
    b.title = 'after an await';
    return { ok: true, n: 7 };
  });
  assert.deepStrictEqual(r, { ok: true, n: 7 });
  assert.strictEqual(onDisk(s.file).title, 'after an await');
  const again = createStore({
    file: s.file, normalize: (d) => d, fresh: () => ({}), kinds: () => ({}), now: () => '', publish: () => {},
  });
  assert.strictEqual(again.load().title, 'after an await', 'a reload reads what was committed');
});

test('save is atomic: a write that fails leaves the old board.json whole and no temp file', async () => {
  const s = open();
  s.store.mutate((b) => { b.title = 'good'; });
  assert.ok(!fs.existsSync(s.file + '.tmp'), 'the temp file is renamed away');
  const good = fs.readFileSync(s.file, 'utf8');

  // A directory where the temp file goes makes the write itself throw.
  fs.mkdirSync(s.file + '.tmp');
  try {
    assert.throws(() => s.store.mutate((b) => { b.title = 'lost'; }), /EISDIR|directory/);
  } finally { fs.rmdirSync(s.file + '.tmp'); }
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), good, 'the old board is still whole');
  await tick();
  assert.strictEqual(s.published, 1, 'the failed save announced nothing');
});

test('serialize decides what lands on disk; save stamps `updated`', () => {
  const s = open({ deps: { serialize: (b) => Object.assign({}, b, { scratch: undefined }) } });
  s.store.mutate((b) => { b.scratch = 'memory only'; });
  const disk = onDisk(s.file);
  assert.strictEqual(disk.scratch, undefined);
  assert.strictEqual(disk.updated, '2026-09-26T00:00:00.000Z');
  assert.strictEqual(s.board.scratch, 'memory only', 'the live board keeps it');
});

test('cardEvent mints the next seq, lands it on the card and marks the card changed', () => {
  const s = open();
  const card = { id: 'c1', events: [], updated: 'never' };
  const a = s.store.cardEvent(card, { text: 'moved', actor: 'lt' }, { kind: 'handoff' });
  assert.deepStrictEqual(a, { seq: 1, ts: '2026-09-26T00:00:00.000Z', level: 1, text: 'moved', actor: 'lt', kind: 'handoff' },
    'the kind map sets the level');
  const b = s.store.cardEvent(card, { text: 'x', level: 2, kind: '  custom  ' });
  assert.strictEqual(b.seq, 2);
  assert.strictEqual(b.kind, 'custom', 'an unknown kind is kept as a token');
  assert.strictEqual(b.level, 2);
  assert.strictEqual(card.events.length, 2);
  assert.strictEqual(card.updated, '2026-09-26T00:00:00.000Z');

  const ev = s.store.boardEvent({ text: 'board-level' }, { level: 1 });
  assert.strictEqual(ev.seq, 3);
  assert.strictEqual(ev.level, 1, 'the caller default applies when the kind says nothing');
  assert.deepStrictEqual(s.board.events, [ev]);
});

test('a push that throws is logged, not a crash', async () => {
  const s = open({ publishThrows: true });
  s.store.commit();
  await tick();
  assert.strictEqual(s.published, 1);
  assert.match(s.logs.join('\n'), /board broadcast failed: socket gone/);
  s.store.commit();
  await tick();
  assert.strictEqual(s.published, 2, 'the next change still pushes');
});
