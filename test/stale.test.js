'use strict';
// The staleness watchdog — the "alive but hung" gap between the three worker
// end-of-life signals: a worker stuck inside a single turn (infinite tool
// loop) is alive (no worker-died), never ends its turn (no worker-stopped),
// and never reaches done. superviseTick notices a live, unpaused worker on a
// Working card with no activity (spawn / turn-end / signal) for
// BC_WORKER_STALE_SECS and fires a worker-stalled card event + QueueItem once
// per window of continued silence (level 1 from the second on); any real
// activity resets the ladder. The ladder test drives a real card.start
// (workers-helper.js); the rest seed a stall-shaped board on the file-backed
// fake harness, where a marker file makes the ref alive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, withOwner, runCli, sleep, LT } = require('./helper');
const { boot, boardOnDisk } = require('./workers-helper');

const TICK = '150';
function fakeSession(dir, session) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ cwd: '/tmp', resumeId: null }) + '\n');
}
async function until(what, fn, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}
function seedBoard(dir, board) {
  const sd = path.join(dir, '.bridge-commander');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify(Object.assign({
    title: 'seeded', seq: 0, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [],
  }, board), null, 2));
}
// One lieutenant + one Working card + one worker whose last activity is
// `ageMs` in the past — the minimal stall-shaped board.
function stallSeed(cardId, ageMs) {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - ageMs).toISOString();
  return {
    lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', chat: [], created: nowIso }],
    cards: [{
      id: cardId, title: 'Slow', type: 'implementation', owner: 'ada', column: 'working',
      labels: [], attributes: { repo: 'proj', session: 'bc-lt-ada:w-' + cardId }, body: '',
      created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
    }],
    workers: [
      { card: cardId, ref: { harness: 'fake', session: 'bc-lt-ada', window: 'w-' + cardId, cwd: '/tmp', resumeId: 'a' },
        worktree: { path: '/tmp/none', tool: 'git' }, branch: 'bc/' + cardId, project: 'proj', spawnedAt: oldIso, done: false },
    ],
  };
}

async function untilItems(s, cardId, kind, n, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === kind && i.card === cardId);
    if (items.length >= n) return items;
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + n + ' ' + kind + ' items (have ' + items.length + ')');
    await sleep(50);
  }
}

test('a live worker silent for 2× BC_WORKER_STALE_SECS stalls twice: level 2, then level 1 naming its last word; a signal resets the ladder; a turn-end clears staleNotified', async () => {
  const { s, teardown } = await boot({ BC_SUPERVISE_INTERVAL_MS: '100', BC_WORKER_STALE_SECS: '1' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Mute', id: 'mute', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/mute/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stalls = async () => (await s.api('GET', '/api/cards/mute')).body.events.filter((e) => e.kind === 'worker-stalled');
    // the worker says one thing, then goes quiet inside a turn (LEN-25's AskUserQuestion)
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'need a ruling: keep the old flag?' });

    await untilItems(s, 'mute', 'worker-stalled', 1);
    let evs = await stalls();
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].level, 2, 'the first stall is the owner\'s');
    await untilItems(s, 'mute', 'worker-stalled', 2);
    evs = await stalls();
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[1].level, 1, 'the second consecutive stall rings the captain');
    assert.match(evs[1].text, /silent for \d+min/);
    assert.match(evs[1].text, /still silent, alert #2/);
    assert.match(evs[1].text, /last said: "need a ruling: keep the old flag\?"/);
    // the drain carries both
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.ok(cli.stdout.includes('alive but silent'), cli.stdout);

    // a signal between ticks resets the escalation: the next stall is level 2 again
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'back — reading the answer' });
    let b = boardOnDisk(s).workers.find((x) => x.card === 'mute');
    assert.ok(!b.staleNotified && !b.staleNotifiedAt && !b.staleHits, 'signal cleared the stale-state');
    await untilItems(s, 'mute', 'worker-stalled', 3);
    evs = await stalls();
    assert.strictEqual(evs[2].level, 2, 'escalation restarted from quiet');

    // the turn-end hook clears staleNotified too, and its last words feed the next alert
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId, text: 'done with the gate, waiting' });
    b = boardOnDisk(s).workers.find((x) => x.card === 'mute');
    assert.ok(!b.staleNotified && !b.staleNotifiedAt, 'turn-end cleared staleNotified');
    assert.strictEqual(b.lastTurnEndText, 'done with the gate, waiting');

    // a signal newer than the turn-end is the last word the level-1 alert quotes
    await sleep(5);
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'need a ruling: keep flag X?' });
    await untilItems(s, 'mute', 'worker-stalled', 5);
    evs = await stalls();
    assert.strictEqual(evs[4].level, 1);
    assert.match(evs[4].text, /last said: "need a ruling: keep flag X\?"/);
    assert.doesNotMatch(evs[4].text, /done with the gate/);
  } finally { await teardown(); }
});

test('a worker within the threshold is left alone', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '3600' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 0)),
  });
  try {
    fakeSession(fdir, 'bc-lt-ada:w-slug');
    await sleep(600); // several ticks
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-stalled').length, 0);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('a DEAD silent worker takes the worker-died path, never worker-stalled (mutual exclusion)', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
    // no fakeSession marker: the window is dead
  });
  try {
    await until('worker-died queue item', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.some((i) => i.kind === 'worker-died' && i.card === 'slug');
    });
    await sleep(600);
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-stalled').length, 0, 'dead is dead — not stalled');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('leaving Working clears staleNotified (mirrors the stopNotified lifecycle)', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  fakeSession(fdir, 'bc-lt-ada:w-slug'); // ALIVE before boot: a
  // first tick that raced ahead of the marker would flag worker-died and never stall.
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
  });
  try {
    await until('worker-stalled fired (flag set)', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.workers[0] && b.workers[0].staleNotified;
    });
    const r = await s.api('POST', '/api/cards/slug/move', { column: 'review', actor: 'agent' });
    assert.strictEqual(r.status, 200);
    const w = (await s.api('GET', '/api/board')).body.workers[0];
    assert.ok(!w.staleNotified, 'the handoff out of Working ends the stale-state');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});
