'use strict';
// server/workers.js in-process: no server, no tmux, no git. A stub harness, a
// stub worktree tool and a fake clock make the end-of-life matrix and the
// races deterministic — the subprocess files (workers-*.test.js) keep the HTTP
// contract; this file pins the rules underneath it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkers, transition, END_OF_LIFE, TRANSITIONS } = require('../server/workers.js');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const key = (ref) => (ref.window ? ref.session + ':' + ref.window : ref.session);

// A harness whose panes are a map: 'up' is alive; anything else is not. A
// `gate(verb, key)` returning a promise holds that call until the test says so.
function stubHarness() {
  let n = 0;
  const h = {
    panes: new Map(), kills: [], sent: [], killFails: new Set(), gate: null,
    async alive(ref) {
      const g = h.gate && h.gate('alive', key(ref));
      if (g) return g;
      return h.panes.get(key(ref)) === 'up';
    },
    async kill(ref) {
      h.kills.push(key(ref));
      if (h.killFails.has(key(ref))) throw new Error('unknown harness: ghost');
      h.panes.delete(key(ref));
    },
    async spawn(cwd, prompt, opts) {
      const ref = { harness: 'stub', session: opts.session, window: opts.window, cwd, resumeId: 'r' + (++n) };
      h.panes.set(key(ref), 'up');
      return ref;
    },
    async resume(ref) { h.panes.set(key(ref), 'up'); return Object.assign({}, ref); },
    async send(ref, text) {
      if (h.panes.get(key(ref)) !== 'up') throw new Error('dead');
      h.sent.push(text);
    },
  };
  return h;
}

// rig() — one board, one lieutenant ("ada"), one project ("proj"), every
// dependency workers.js takes, recorded.
function rig(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wl-'));
  let t = T0;
  const board = { seq: 0, cards: [], workers: [], events: [] };
  const harness = stubHarness();
  const queue = [];
  const hooks = [];
  const releases = [];
  const releaseResult = new Map(); // path -> { released, reason }
  const findCard = (id) => board.cards.find((c) => c.id === id) || null;
  const deps = {
    board: () => board,
    findCard,
    findProject: (name) => (name === 'proj' ? { name: 'proj', path: '/clones/proj' } : null),
    columnTitle: (id) => id,
    harnessFor: () => harness,
    worktrees: {
      create: async (projectPath, cardId) => ({ path: path.join(tmp, 'wt', cardId), tool: 'git' }),
      release: async (rec) => { releases.push(rec.path); return releaseResult.get(rec.path) || { released: true }; },
      toolFor: () => 'git',
    },
    runTeardown: opts.runTeardown || (async () => ({ ok: true, code: 0, output: '', ms: 5 })),
    hookContext: (card) => ({ card: card.id, worktree: '' }),
    fireHooks: async (event, card) => {
      hooks.push({ event, card: card.id });
      if (opts.hookGate) await opts.hookGate;
    },
    mkEvent: (body, defaults) => {
      const ev = { seq: ++board.seq, text: String(body.text || ''), actor: body.actor || 'agent',
        level: body.level || defaults.level || 2 };
      if (body.kind || defaults.kind) ev.kind = body.kind || defaults.kind;
      return ev;
    },
    landEvent: (card, ev) => {
      const live = findCard(card.id);
      if (live) live.events.push(ev);
      else { ev.card = card.id; board.events.push(ev); }
      return ev;
    },
    queuePush: (owner, item) => { queue.push(Object.assign({ owner }, item)); return item; },
    save: () => {},
    clock: () => t,
    planStart: () => ({ impl: harness, branch: 'bc/x', extraArgs: [], brief: () => 'the brief' }),
    ownerSession: (card) => 'bc-lt-' + card.owner,
    workerWindow: (id) => 'w-' + id,
    log: () => {},
    config: { stateDir: tmp, harnessStateDir: tmp, turnendUrl: 'http://127.0.0.1:1/api/turn-end',
      teardownMs: 1000, restartTeardownMs: 500, staleSecs: 30 * 60 },
  };
  const W = createWorkers(deps);

  // addWorker(id, fields) — a card in `column` with a live worker standing on
  // a real (empty) worktree directory.
  function addWorker(id, fields = {}, card = {}) {
    const wt = path.join(tmp, 'wt', id);
    fs.mkdirSync(wt, { recursive: true });
    const c = Object.assign({ id, title: id, type: 'implementation', owner: 'ada', column: 'working',
      attributes: { repo: 'proj', worktree: wt }, events: [], thread: [] }, card);
    board.cards.push(c);
    const w = Object.assign({ card: id, ref: { harness: 'stub', session: 'bc-lt-ada', window: 'w-' + id, resumeId: 'r-' + id },
      worktree: { path: wt, tool: 'git' }, project: 'proj', spawnedAt: new Date(t).toISOString(), done: false }, fields);
    board.workers.push(w);
    harness.panes.set(key(w.ref), 'up');
    return { card: c, w };
  }
  const events = (id) => [...(findCard(id) || { events: [] }).events, ...board.events.filter((e) => e.card === id)];
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { W, board, harness, queue, hooks, releases, releaseResult, addWorker, events, deps, tmp, cleanup,
    advance: (ms) => { t += ms; }, iso: () => new Date(t).toISOString() };
}

// ---------- the end-of-life matrix ----------

// One row per case the five endings disagree on. `setup` shapes the worker and
// the world; `expect` is what the ending did: kills attempted, releases run,
// card-archived hooks fired, and whether the record survived.
const MATRIX = [
  { name: 'handoff: done, killed, released → record goes', trigger: 'handoff', column: 'review',
    worker: { done: true }, expect: { kills: 1, releases: 1, hooks: 0, kept: false } },
  { name: 'handoff: done, killed, release REFUSED → record kept (last handle on the work)', trigger: 'handoff', column: 'review',
    worker: { done: true }, refuse: true, expect: { kills: 1, releases: 1, hooks: 0, kept: true } },
  { name: 'handoff: done, killed, release could not run (no clone) → record kept', trigger: 'handoff', column: 'review',
    worker: { done: true, project: 'vanished' }, card: { attributes: { repo: 'vanished' } },
    expect: { kills: 1, releases: 0, hooks: 0, kept: true } },
  { name: 'handoff: done, kill FAILS → released anyway, record kept', trigger: 'handoff', column: 'review',
    worker: { done: true }, killFails: true, expect: { kills: 1, releases: 1, hooks: 0, kept: true } },
  { name: 'handoff: keep_worktree → nothing ends', trigger: 'handoff', column: 'review',
    worker: { done: true, keepWorktree: true }, expect: { kills: 0, releases: 0, hooks: 0, kept: true } },
  { name: 'handoff: never reported done → nothing ends', trigger: 'handoff', column: 'review',
    worker: { done: false }, expect: { kills: 0, releases: 0, hooks: 0, kept: true } },
  { name: 'handoff: ground already released, release cannot run → record goes (nothing left to hold)', trigger: 'handoff', column: 'review',
    worker: { done: true, project: 'vanished' }, card: { attributes: { repo: 'vanished' } }, releasedGround: true,
    expect: { kills: 1, releases: 0, hooks: 0, kept: false } },
  { name: 'archive: never done, keep_worktree, release REFUSED → killed, hooks, record goes anyway', trigger: 'archive',
    worker: { done: false, keepWorktree: true }, refuse: true, offBoard: true,
    expect: { kills: 1, releases: 1, hooks: 1, kept: false } },
  { name: 'archive: kill FAILS → hooks and release still run, record kept', trigger: 'archive',
    worker: { done: true }, killFails: true, offBoard: true, expect: { kills: 1, releases: 1, hooks: 1, kept: true } },
  { name: 'merge: done → killed, hooks, released, record goes', trigger: 'merge', column: 'review',
    worker: { done: true }, expect: { kills: 1, releases: 1, hooks: 1, kept: false } },
  { name: 'restart: done, killed, released → record goes', trigger: 'restart', column: 'review',
    worker: { done: true, keepWorktree: true }, expect: { kills: 1, releases: 1, hooks: 0, kept: false } },
  { name: 'restart: release REFUSED → record kept', trigger: 'restart', column: 'review',
    worker: { done: true }, refuse: true, expect: { kills: 1, releases: 1, hooks: 0, kept: true } },
  { name: 'restart: kill FAILS → no release at all, record kept', trigger: 'restart', column: 'review',
    worker: { done: true }, killFails: true, expect: { kills: 1, releases: 0, hooks: 0, kept: true } },
  { name: 'sweep: on board out of Working, unreleased ground → killed, never released, record kept', trigger: 'sweep', column: 'review',
    worker: { done: true }, expect: { kills: 1, releases: 0, hooks: 0, kept: true } },
  { name: 'sweep: on board, ground already released → killed, record goes', trigger: 'sweep', column: 'review',
    worker: { done: true }, releasedGround: true, expect: { kills: 1, releases: 0, hooks: 0, kept: false } },
  { name: 'sweep: card still Working → spared', trigger: 'sweep', column: 'working',
    worker: { done: false }, expect: { kills: 0, releases: 0, hooks: 0, kept: true } },
  { name: 'sweep: on board, never reported done → spared', trigger: 'sweep', column: 'review',
    worker: { done: false }, expect: { kills: 0, releases: 0, hooks: 0, kept: true } },
  { name: 'sweep: off board, unreleased ground → killed, record goes', trigger: 'sweep',
    worker: { done: true }, offBoard: true, expect: { kills: 1, releases: 0, hooks: 0, kept: false } },
  { name: 'sweep: off board, first failed kill → record kept', trigger: 'sweep',
    worker: { done: true }, killFails: true, offBoard: true, expect: { kills: 1, releases: 0, hooks: 0, kept: true } },
  { name: 'sweep: off board, kill failed before and fails again → ABANDONED, record goes', trigger: 'sweep',
    worker: { done: true, killFailed: 'earlier' }, killFails: true, offBoard: true,
    expect: { kills: 1, releases: 0, hooks: 0, kept: false, abandoned: true } },
];

for (const row of MATRIX) {
  test('end-of-life matrix — ' + row.name, async () => {
    const r = rig();
    try {
      const { card, w } = r.addWorker('c1', row.worker, Object.assign({ column: row.column || 'working' }, row.card || {}));
      if (row.card && row.card.attributes) card.attributes.worktree = w.worktree.path;
      if (row.releasedGround) { w.worktree.released = true; delete card.attributes.worktree; }
      if (row.refuse) r.releaseResult.set(w.worktree.path, { released: false, reason: 'worktree has uncommitted changes' });
      if (row.killFails) r.harness.killFails.add(key(w.ref));
      if (row.offBoard) r.board.cards = r.board.cards.filter((c) => c !== card);

      if (row.trigger === 'sweep') await r.W.sweep();
      else await r.W.end(card, row.trigger);

      assert.strictEqual(r.harness.kills.length, row.expect.kills, 'kills');
      assert.strictEqual(r.releases.length, row.expect.releases, 'releases');
      assert.strictEqual(r.hooks.filter((h) => h.event === 'card-archived').length, row.expect.hooks, 'card-archived hooks');
      assert.strictEqual(!!r.W.find('c1'), row.expect.kept, row.expect.kept ? 'record kept' : 'record dropped');
      const abandoned = r.events('c1').some((e) => /ABANDONED/.test(e.text));
      assert.strictEqual(abandoned, !!row.expect.abandoned, 'ABANDONED event');
      if (!row.expect.kept) {
        const live = r.board.cards.find((c) => c.id === 'c1');
        if (live) assert.strictEqual(live.attributes.session, 'bc-lt-ada:w-c1', 'a dropped record stamps its address');
      }
    } finally { r.cleanup(); }
  });
}

test('END_OF_LIFE covers exactly the five endings; an unknown one throws', async () => {
  assert.deepStrictEqual(Object.keys(END_OF_LIFE).sort(), ['archive', 'handoff', 'merge', 'restart', 'sweep']);
  const r = rig();
  try {
    const { card } = r.addWorker('c1');
    await assert.rejects(() => r.W.end(card, 'retire'), /unknown end-of-life trigger/);
  } finally { r.cleanup(); }
});

test('a release that lands clears the card pointer and marks the record released', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1', { done: true, keepWorktree: false }, { column: 'review' });
    r.harness.killFails.add(key(w.ref)); // record kept, so its state stays readable
    await r.W.end(card, 'handoff');
    assert.strictEqual(card.attributes.worktree, undefined);
    assert.strictEqual(w.worktree.released, true);
    assert.ok(r.events('c1').some((e) => e.text === 'worktree released: ' + w.worktree.path));
  } finally { r.cleanup(); }
});

test('a restart runs the previous teardown on the SHORT budget; the handoff on the long one', async () => {
  const budgets = [];
  const r = rig({ runTeardown: async (cmd, ctx, o) => { budgets.push([cmd, ctx.worktree, o.timeoutMs]); return { ok: true, code: 0, output: '', ms: 1 }; } });
  try {
    const a = r.addWorker('a', { done: true, teardown: 'compose down' }, { column: 'review' });
    const b = r.addWorker('b', { done: true, teardown: 'compose down' }, { column: 'review' });
    await r.W.end(a.card, 'restart');
    await r.W.end(b.card, 'handoff');
    assert.deepStrictEqual(budgets, [['compose down', a.w.worktree.path, 500], ['compose down', b.w.worktree.path, 1000]]);
  } finally { r.cleanup(); }
});

// ---------- transitions ----------

test('transition: every event clears its row; set writes, undefined deletes; unknown events throw', () => {
  const w = { done: true, outcome: 'x', flagged: true, stopNotified: true, staleNotified: true, staleNotifiedAt: 'a',
    staleHits: 2, paused: 'p', killFailed: 'k', expectExit: true, pauseReason: 'r', lastTurnEndText: 't', lastSignalText: 's' };
  transition(w, 'revive', { done: false });
  assert.deepStrictEqual(w, { done: false });
  assert.throws(() => transition({}, 'resurrect'), /unknown worker transition/);
  assert.strictEqual(transition(null, 'signal'), null, 'no record is a no-op');
  const v = { a: 1 };
  transition(v, 'turn-end', { a: undefined, b: 2 });
  assert.deepStrictEqual(v, { b: 2 });
  // Every activity resets the stall ladder (the DNA's "worker stall").
  for (const ev of ['turn-end', 'signal', 'done', 'revive', 'pause', 'leave']) {
    for (const k of ['staleNotified', 'staleNotifiedAt', 'staleHits']) assert.ok(TRANSITIONS[ev].includes(k), ev + ' clears ' + k);
  }
});

test('resume and send-reopen reset the SAME flags', async () => {
  const r = rig();
  try {
    const dirty = { done: true, outcome: 'o', flagged: true, stopNotified: true, staleHits: 1, paused: 'p',
      killFailed: 'k', lastTurnEndText: 'done: shipped', lastSignalText: 'PR open' };
    const a = r.addWorker('a', Object.assign({}, dirty));
    a.card.column = 'backlog';
    r.harness.panes.delete(key(a.w.ref)); // dead: resumable
    const b = r.addWorker('b', Object.assign({}, dirty), { column: 'review' }); // alive: reopenable
    assert.ok((await r.W.start(a.card, { resume: true })).resumed);
    assert.ok((await r.W.send(b.card, { text: 'one more thing' })).ok);
    const flags = (w) => Object.keys(w).filter((k) => k in dirty).sort();
    assert.deepStrictEqual(flags(a.w), ['done']);
    assert.deepStrictEqual(flags(b.w), ['done']);
    assert.strictEqual(a.w.done, false);
    assert.strictEqual(b.w.done, false);
    assert.strictEqual(b.card.column, 'working', 'the reopen re-enters Working');
  } finally { r.cleanup(); }
});

// ---------- supervision on a fake clock ----------

test('the stall ladder: level 2 after one window, quiet inside the next, level 1 quoting the last word, reset by a signal', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1');
    const stalls = () => r.queue.filter((i) => i.kind === 'worker-stalled');
    r.advance(29 * MIN);
    assert.strictEqual(await r.W.tick(), false, 'inside the window: nothing');
    r.advance(2 * MIN);
    assert.strictEqual(await r.W.tick(), true);
    assert.strictEqual(stalls().length, 1);
    let ev = card.events.filter((e) => e.kind === 'worker-stalled').pop();
    assert.strictEqual(ev.level, 2, 'the first stall is the lieutenant\'s');
    assert.match(ev.text, /alive but silent for 31min/);

    w.lastTurnEndText = 'thinking about the migration';
    w.lastTurnEnd = new Date(T0).toISOString(); // older than the window: not activity
    r.advance(10 * MIN);
    await r.W.tick();
    assert.strictEqual(stalls().length, 1, 'one alert per window of silence');
    r.advance(21 * MIN);
    await r.W.tick();
    assert.strictEqual(stalls().length, 2);
    ev = card.events.filter((e) => e.kind === 'worker-stalled').pop();
    assert.strictEqual(ev.level, 1, 'the second rings the captain');
    assert.match(ev.text, /alert #2; last said: "thinking about the migration"/);

    r.W.signal(card, { text: 'tests green' });
    assert.strictEqual(w.staleHits, undefined, 'a signal resets the ladder');
    r.advance(31 * MIN);
    await r.W.tick();
    assert.strictEqual(card.events.filter((e) => e.kind === 'worker-stalled').pop().level, 2, 'and the next stall starts quiet');
  } finally { r.cleanup(); }
});

test('a dead worker without done is flagged once: worker-died + hook, never a stall', async () => {
  const r = rig();
  try {
    const { w } = r.addWorker('c1');
    r.harness.panes.delete(key(w.ref));
    r.advance(2 * 30 * MIN);
    await r.W.tick();
    await r.W.tick();
    assert.deepStrictEqual(r.queue.map((i) => i.kind), ['worker-died']);
    assert.deepStrictEqual(r.hooks.map((h) => h.event), ['worker-died']);
    assert.strictEqual(w.flagged, true);
  } finally { r.cleanup(); }
});

// ---------- races, made deterministic ----------

test('race: a merge that ends the worker during the tick\'s alive() read is not a death', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1');
    const held = deferred();
    r.harness.gate = (verb) => { r.harness.gate = null; return held.promise; }; // hold the tick's read only
    const ticking = r.W.tick();
    await r.W.end(card, 'merge'); // kills and drops while the read is in flight
    assert.strictEqual(r.W.find('c1'), undefined);
    held.resolve(false); // the read comes back: dead
    await ticking;
    assert.ok(!r.queue.some((i) => i.kind === 'worker-died'), 'no worker-died for a worker the board ended');
    assert.ok(!w.flagged);
  } finally { r.cleanup(); }
});

test('race: a pause landing during the tick\'s alive() read is not a death', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1');
    const held = deferred();
    r.harness.gate = () => { r.harness.gate = null; return held.promise; };
    const ticking = r.W.tick();
    assert.ok((await r.W.pause(card, {})).ok);
    held.resolve(false);
    await ticking;
    assert.ok(!r.queue.some((i) => i.kind === 'worker-died'));
    assert.ok(w.paused && !w.flagged);
  } finally { r.cleanup(); }
});

test('race: a restart that binds the card during the handoff teardown keeps its fresh checkout', async () => {
  const held = deferred();
  const r = rig({ runTeardown: () => held.promise });
  try {
    const { card, w } = r.addWorker('c1', { done: true, teardown: 'compose down' }, { column: 'review' });
    const ending = r.W.end(card, 'handoff');
    await new Promise((res) => setImmediate(res)); // the kill landed; the teardown is running
    const newer = { card: 'c1', ref: { harness: 'stub', session: 'bc-lt-ada', window: 'w-c1' },
      worktree: { path: w.worktree.path, tool: 'git' }, project: 'proj', done: false };
    r.board.workers = [newer]; // a restart released, dropped and re-cut the same path
    held.resolve({ ok: true, code: 0, output: '', ms: 1 });
    const out = await ending;
    assert.strictEqual(out.release, null, 'the release stands down');
    assert.deepStrictEqual(r.releases, [], 'nothing was released under the new worker');
    assert.strictEqual(r.W.find('c1'), newer);
  } finally { r.cleanup(); }
});

test('race: a worker bound while the merge runs its hooks is ended too', async () => {
  const gate = deferred();
  const r = rig({ hookGate: gate.promise });
  try {
    const { card } = r.addWorker('c1', { done: true }, { column: 'review' });
    const ending = r.W.end(card, 'merge');
    await new Promise((res) => setImmediate(res));
    const late = { card: 'c1', ref: { harness: 'stub', session: 'bc-lt-ada', window: 'w-c1', resumeId: 'late' },
      worktree: { path: '/elsewhere', tool: 'git' }, project: 'proj', done: false };
    r.board.workers = r.board.workers.filter((x) => x.card !== 'c1').concat(late);
    r.harness.panes.set(key(late.ref), 'up');
    gate.resolve();
    await ending;
    assert.strictEqual(r.W.find('c1'), undefined, 'the late binder is gone');
    assert.ok(r.events('c1').some((e) => /the PR merged while it was working/.test(e.text)));
  } finally { r.cleanup(); }
});

test('race: a restart whose record retires mid-flight starts clean instead of refusing', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1', { done: true }, { column: 'review' });
    r.harness.panes.delete(key(w.ref)); // finished and dead: a plain rework restart
    const held = deferred();
    r.harness.gate = () => { r.harness.gate = null; return held.promise; }; // start's liveness read
    const starting = r.W.start(card, {});
    await new Promise((res) => setImmediate(res));
    r.board.workers = []; // the handoff's detached drop lands meanwhile
    held.resolve(false);
    const out = await starting;
    assert.ok(out.worker, JSON.stringify(out));
    assert.strictEqual(r.board.workers.length, 1, 'exactly one record');
    assert.notStrictEqual(out.worker, w);
  } finally { r.cleanup(); }
});

test('a restart whose release is refused keeps the old record and refuses the start', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1', { done: true }, { column: 'review' });
    r.harness.panes.delete(key(w.ref));
    r.releaseResult.set(w.worktree.path, { released: false, reason: 'worktree has uncommitted changes' });
    const out = await r.W.start(card, {});
    assert.strictEqual(out.code, 409);
    assert.match(out.error, /not releasable \(worktree has uncommitted changes\)/);
    assert.deepStrictEqual(r.board.workers, [w]);
  } finally { r.cleanup(); }
});

test('a start never leaves two records: a restart whose release cannot run refuses', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1', { done: true }, { column: 'review' });
    r.harness.panes.delete(key(w.ref));
    r.deps.worktrees.release = async () => { throw new Error('git is on fire'); };
    const out = await r.W.start(card, {});
    assert.strictEqual(out.code, 409);
    assert.match(out.error, /the release could not run/);
    assert.deepStrictEqual(r.board.workers, [w]);
  } finally { r.cleanup(); }
});

test('the kill-failed bell rings once per record; a verified kill re-arms it', async () => {
  const r = rig();
  try {
    const { card, w } = r.addWorker('c1', { done: true }, { column: 'review' });
    r.harness.killFails.add(key(w.ref));
    await r.W.kill(card, w, {});
    await r.W.kill(card, w, {});
    const bells = () => card.events.filter((e) => e.kind === 'worker-kill-failed').length;
    assert.strictEqual(bells(), 1);
    r.harness.killFails.clear();
    assert.deepStrictEqual(await r.W.kill(card, w, {}), { killed: true });
    assert.strictEqual(w.killFailed, undefined);
    r.harness.panes.set(key(w.ref), 'up');
    r.harness.killFails.add(key(w.ref));
    await r.W.kill(card, w, {});
    assert.strictEqual(bells(), 2, 'the next failure is news again');
  } finally { r.cleanup(); }
});

test('turn-end: every stop on a Working card without done notifies; after done only counters move', async () => {
  const r = rig();
  try {
    const { w } = r.addWorker('c1');
    assert.strictEqual((await r.W.turnEnd(w, { sid: 'new-id', text: 'hi' })).stopped, true);
    assert.strictEqual((await r.W.turnEnd(w, {})).stopped, true, 'stopped again = told again');
    assert.strictEqual(w.ref.resumeId, 'new-id', 'the hook payload is ground truth');
    assert.strictEqual(w.lastTurnEndText, 'hi', 'a turn-end with no text keeps the last word');
    w.done = true;
    assert.strictEqual((await r.W.turnEnd(w, {})).stopped, false);
    assert.strictEqual(w.turns, 3);
    assert.strictEqual(r.queue.filter((i) => i.kind === 'worker-stopped').length, 2);
  } finally { r.cleanup(); }
});
