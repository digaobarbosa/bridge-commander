'use strict';
// The boot sweep: one pass per boot ends every worker whose card is not
// Working, spares a record still holding ground, and rings once — not once per
// boot — for a kill it cannot verify.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, sleep } = require('./helper');
const { workerKey, makeRepo, until, cardEvents, rx } = require('./workers-helper');

// The rule only fires on the move, so everything already sitting in the
// registry when a board upgrades to it needs one pass: ~30 records for cards
// long since handed off, and windows whose agent died months ago.
test('the boot sweep ends every worker whose card is not Working — and the orphans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    for (const id of ['handedoff', 'orphan', 'live']) {
      await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
      await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
      await s.api('POST', '/api/cards/' + id + '/worker/done', { outcome: 'done' });
    }
    const marker = (id) => path.join(fdir, workerKey(wsDir, id) + '.json');

    // Fake the board this change inherits: a card handed off with its worker
    // left alive (the old behaviour), and a record whose card is gone entirely.
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'handedoff').column = 'review';
    // the legacy this inherits: the old handoff DID release the worktree, it
    // just left the process running — a record holding no ground any more
    doc.workers.find((w) => w.card === 'handedoff').worktree.released = true;
    doc.cards = doc.cards.filter((c) => c.id !== 'orphan');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    assert.ok(fs.existsSync(marker('handedoff')) && fs.existsSync(marker('orphan')));

    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the handed-off worker is swept', async () => !fs.existsSync(marker('handedoff')));
    await until('the orphan window goes too', async () => !fs.existsSync(marker('orphan')));
    await until('and both records with them', async () => {
      const ws = (await s.api('GET', '/api/board')).body.workers || [];
      return ws.length === 1 && ws[0].card === 'live';
    });
    assert.ok(fs.existsSync(marker('live')), 'a Working card keeps its worker, swept board or not');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The sweep ends processes; it does not touch ground. So the one record it must
// never end is the one still HOLDING ground: `card.park` shelves a card to be
// resumed in that very checkout, and a release that REFUSED left an unspent
// `teardown` archive is contracted to retry. Both are on the board, both are
// out of Working, and both used to be swept — losing the only handle on them.
test('the boot sweep spares a worker whose worktree is still unreleased', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    const marker = (id) => path.join(fdir, workerKey(wsDir, id) + '.json');

    // parked: reported done, then its session ended by itself, then shelved.
    // Record AND worktree are kept on purpose — `card start --resume` goes back
    // into that same checkout. (The session has to die outside this server
    // process for park to see it dead, hence the restart.)
    await s.api('POST', '/api/cards', withOwner({ title: 'Shelved', id: 'parked', attributes: { repo: 'proj' } }));
    const pw = (await s.api('POST', '/api/cards/parked/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/parked/worker/done', { outcome: 'shelved' });
    await s.stop();
    fs.rmSync(marker('parked'));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    const pk = await s.api('POST', '/api/cards/parked/park', {});
    assert.strictEqual(pk.status, 200, JSON.stringify(pk.body));

    // handed off with a dirty worktree: the release refused, the record kept
    await s.api('POST', '/api/cards', withOwner({ title: 'Unfinished', id: 'refused', attributes: { repo: 'proj' } }));
    const rw = (await s.api('POST', '/api/cards/refused/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(rw.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/refused/worker/done', { outcome: 'done, sort of' });
    await s.api('POST', '/api/cards/refused/move', { column: 'review', actor: 'agent' });
    await until('the release refused',
      async () => (await cardEvents(s, 'refused')).some((e) => /worktree kept/.test(e.text)));

    // and the record that holds NOTHING: handed off, ground already gone. It is
    // registered last, and the sweep walks the registry in order, so its drop
    // is the proof that the two above were considered and spared.
    await s.api('POST', '/api/cards', withOwner({ title: 'Legacy', id: 'legacy', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/legacy/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/legacy/worker/done', { outcome: 'shipped' });

    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'legacy').column = 'review';
    doc.workers.find((w) => w.card === 'legacy').worktree.released = true;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the sweep retired the record holding no ground',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'legacy'));
    const ws = (await s.api('GET', '/api/board')).body.workers || [];
    assert.ok(ws.some((x) => x.card === 'parked'), 'the parked card keeps its resume handle');
    assert.ok(ws.some((x) => x.card === 'refused'), 'the refused release keeps its last handle');
    assert.ok(fs.existsSync(pw.worktree.path), 'and the parked checkout is untouched');
    assert.ok(fs.existsSync(path.join(rw.worktree.path, 'unsaved.txt')), 'and nothing was discarded');

    // the handle still works: resume goes back into that same checkout
    const r = await s.api('POST', '/api/cards/parked/start', { harness: 'fake', resume: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await s.api('GET', '/api/cards/parked')).body.column, 'working');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The unreleased-worktree carve-out is about the RECORD, never the process. An
// upgraded board carries a card handed off under the old code: it left Working
// with its session still up and a checkout dirty enough that the release would
// have refused. The record is the last handle on that work and stays — the idle
// window it names is exactly what the sweep exists to end, and it goes.
//
// And it goes ONCE. A record the sweep spares is read again at every boot for
// as long as it survives, so a kill that closed nothing must say nothing: the
// alternative is the same "worker closed" line re-landing on a card forever,
// floating it to the top of the board on a restart that changed nothing.
test('the boot sweep ends the window of a spared record and keeps the record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  const file = path.join(wsDir, '.bridge-commander', 'board.json');
  const closings = async (s, id) => (await cardEvents(s, id)).filter((e) => /worker .* closed/.test(e.text));
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    const marker = (id) => path.join(fdir, workerKey(wsDir, id) + '.json');

    // legacy: worked, reported done, left uncommitted work behind — and its
    // window is still up, because the code that handed it off never killed one.
    await s.api('POST', '/api/cards', withOwner({ title: 'Legacy', id: 'legacy', attributes: { repo: 'proj' } }));
    const lw = (await s.api('POST', '/api/cards/legacy/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(lw.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/legacy/worker/done', { outcome: 'done, sort of' });

    // parked: done, its session gone by itself, then shelved to be resumed in
    // that very checkout. Spared too — and nothing is left to close.
    await s.api('POST', '/api/cards', withOwner({ title: 'Shelved', id: 'parked', attributes: { repo: 'proj' } }));
    const pw = (await s.api('POST', '/api/cards/parked/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/parked/worker/done', { outcome: 'shelved' });
    await s.stop();
    fs.rmSync(marker('parked'));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    const pk = await s.api('POST', '/api/cards/parked/park', {});
    assert.strictEqual(pk.status, 200, JSON.stringify(pk.body));

    // two records holding NO ground, registered after the two above. The sweep
    // walks the registry in order and drops them, one per boot — that drop is
    // the proof the spared pair was reached and considered on that same pass.
    for (const id of ['gone1', 'gone2']) {
      await s.api('POST', '/api/cards', withOwner({ title: 'Gone ' + id, id, attributes: { repo: 'proj' } }));
      await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
      await s.api('POST', '/api/cards/' + id + '/worker/done', { outcome: 'shipped' });
    }

    // the old handoff, replayed on disk: out of Working, nothing killed,
    // nothing released. gone2 waits in Working for the SECOND boot.
    await s.stop();
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'legacy').column = 'review';
    for (const id of ['gone1', 'gone2']) doc.workers.find((w) => w.card === id).worktree.released = true;
    doc.cards.find((c) => c.id === 'gone1').column = 'review';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    assert.ok(fs.existsSync(marker('legacy')), 'the legacy window is up going in');

    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the first sweep retired the record holding no ground', async () =>
      ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'gone1'));

    assert.ok(!fs.existsSync(marker('legacy')), 'the idle legacy window is gone');
    assert.strictEqual((await closings(s, 'legacy')).length, 1, 'closing a live pane says so, once');
    assert.strictEqual((await closings(s, 'parked')).length, 0,
      'a pane that was already gone was not closed by anybody');
    let ws = (await s.api('GET', '/api/board')).body.workers || [];
    assert.ok(ws.some((x) => x.card === 'legacy'), 'the record on unreleased ground survives its own kill');
    assert.ok(ws.some((x) => x.card === 'parked'), 'and so does the parked one');
    assert.ok(fs.existsSync(path.join(lw.worktree.path, 'unsaved.txt')), 'the sweep took no ground');
    assert.ok(fs.existsSync(pw.worktree.path), 'from either of them');

    // boot again: both spared records are read a second time, and a second
    // restart of the board must leave no trace on either card
    const before = (await s.api('GET', '/api/cards/legacy')).body.updated;
    await s.stop();
    const doc2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc2.cards.find((c) => c.id === 'gone2').column = 'review';
    fs.writeFileSync(file, JSON.stringify(doc2, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the second sweep retired the next record holding no ground', async () =>
      ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'gone2'));

    assert.strictEqual((await closings(s, 'legacy')).length, 1, 'no second closing of what was closed once');
    assert.strictEqual((await closings(s, 'parked')).length, 0, 'and still nothing on the parked one');
    assert.strictEqual((await s.api('GET', '/api/cards/legacy')).body.updated, before,
      'a boot that changed nothing does not touch the card');
    ws = (await s.api('GET', '/api/board')).body.workers || [];
    assert.ok(ws.some((x) => x.card === 'legacy') && ws.some((x) => x.card === 'parked'),
      'both handles are still there');

    // the handle still works: resume goes back into that same checkout
    const r = await s.api('POST', '/api/cards/parked/start', { harness: 'fake', resume: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await s.api('GET', '/api/cards/parked')).body.column, 'working');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A kill the board cannot verify keeps its record on purpose — that record is
// the only handle on a session that may still be up. But the sweep retries at
// every boot, so without a mark the same dead session would ring the captain's
// level-1 bell on every restart of the board, forever.
test('a kill that cannot be verified rings the bell once, not once per boot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rings once', id: 'bell', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/bell/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/bell/worker/done', { outcome: 'done' });

    // a record the sweep will reach and can never end: out of Working, holding
    // no ground, on a harness this server has no implementation for
    const rig = () => {
      const file = path.join(wsDir, '.bridge-commander', 'board.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.cards.find((c) => c.id === 'bell').column = 'review';
      const w = doc.workers.find((x) => x.card === 'bell');
      w.ref.harness = 'ghost';
      w.worktree.released = true;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    };
    await s.stop(); rig();

    s = await startServerWithLieutenant({ dir: wsDir, env });
    const rang = await until('the first sweep rings the bell',
      async () => (await cardEvents(s, 'bell')).filter((e) => e.kind === 'worker-kill-failed'));
    assert.strictEqual(rang.length, 1);
    assert.strictEqual(rang[0].level, 1);

    // a second boot over the same unreachable session: still refused, still
    // kept — and silent, because the captain has already been told
    await s.stop();
    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the second sweep has had its turn',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'bell'));
    await sleep(400);
    assert.strictEqual((await cardEvents(s, 'bell')).filter((e) => e.kind === 'worker-kill-failed').length, 1,
      'the same dead session does not ring again at every boot');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'bell'),
      'and the record is still kept — the card is on the board, somebody may come back for it');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Keeping an unkillable record protects work somebody may come back for. Once
// the card is off the board nobody is, so the sweep has one terminal path out
// of that state — otherwise the record is immortal and `card start` on it (were
// the card restored) refuses forever.
test('the sweep finally abandons an unkillable record whose card left the board', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    for (const id of ['gonecard', 'stillhere']) {
      await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
      await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
      await s.api('POST', '/api/cards/' + id + '/worker/done', { outcome: 'done' });
    }
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const w of doc.workers) { w.ref.harness = 'ghost'; w.worktree.released = true; }
    doc.cards.find((c) => c.id === 'stillhere').column = 'review';
    doc.cards = doc.cards.filter((c) => c.id !== 'gonecard'); // archived out from under it
    const deadSession = doc.workers.find((x) => x.card === 'gonecard').ref.session + ':w-gonecard';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    // first boot: neither can be ended, both records are kept and both ring
    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('both are still on the registry after one failed sweep', async () => {
      const ws = (await s.api('GET', '/api/board')).body.workers || [];
      return ws.some((x) => x.card === 'gonecard') && ws.some((x) => x.card === 'stillhere');
    });

    // second boot: the one whose card is gone is let go, the other is not
    await s.stop();
    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the abandoned record is dropped',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'gonecard'));
    const ev = (await s.api('GET', '/api/board')).body.events
      .filter((e) => e.card === 'gonecard').find((e) => /ABANDONED/.test(e.text));
    assert.ok(ev, 'the timeline says which session was left running');
    assert.strictEqual(ev.level, 2, 'the bell already rang for this one');
    assert.match(ev.text, rx(deadSession));
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'stillhere'),
      'a card still on the board keeps its handle, however unkillable');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
