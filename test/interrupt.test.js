'use strict';
// ⏹ interrupt — POST /api/{cards,lieutenants}/:id/interrupt stops the agent's
// running turn through the harness's optional interrupt verb, and the board
// payload carries `busy` + `canInterrupt` so the UI knows when to offer it.
// The fake logs an `interrupt` line to <key>.pane.jsonl, which is how these
// tests see what reached the harness.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithProject, withOwner, until, seedBoard, startServer, runCli, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/layout.js');

async function startWorker(s, id) {
  let r = await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return lieutenantSession(s.dir, LT) + ':' + workerWindow(id);
}
function interrupts(fdir, key) {
  try {
    return fs.readFileSync(path.join(fdir, key + '.pane.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.event === 'interrupt').length;
  } catch { return 0; }
}
async function board(s) { return (await s.api('GET', '/api/board')).body; }
async function workerOf(s, id) { return (await board(s)).workers.find((w) => w.card === id); }

test('card interrupt: stops a busy worker once, lands a level-2 event, and the worker reads idle', async () => {
  const { s, fdir, teardown } = await startServerWithProject({ prefix: 'bc-int-' });
  try {
    const key = await startWorker(s, 'long-task');
    let w = await workerOf(s, 'long-task');
    assert.strictEqual(w.busy, true, 'a worker is busy from its brief until a turn-end');
    assert.strictEqual(w.canInterrupt, true);

    const r = await s.api('POST', '/api/cards/long-task/interrupt', { actor: 'user' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(interrupts(fdir, key), 1);

    w = await workerOf(s, 'long-task');
    assert.strictEqual(w.busy, false, 'the interrupt closes the turn (claude fires no Stop hook for it)');
    const card = (await board(s)).cards.find((c) => c.id === 'long-task');
    const ev = card.events.find((e) => e.kind === 'interrupted');
    assert.ok(ev, 'the timeline shows the interrupt');
    assert.strictEqual(ev.level, 2);
    assert.strictEqual(ev.actor, 'user');

    // A second Escape on an idle agent opens claude's Rewind / codex's backtrack: refused.
    const again = await s.api('POST', '/api/cards/long-task/interrupt', {});
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.idle, true);
    assert.strictEqual(interrupts(fdir, key), 1, 'nothing more reached the harness');
  } finally { await teardown(); }
});

test('a send makes the worker busy again, and its turn-end makes it idle', async () => {
  const { s, teardown } = await startServerWithProject({ prefix: 'bc-int-' });
  try {
    const key = await startWorker(s, 'again');
    await s.api('POST', '/api/turn-end', { session: key });
    assert.strictEqual((await workerOf(s, 'again')).busy, false);
    assert.strictEqual((await s.api('POST', '/api/cards/again/interrupt', {})).status, 409);

    const r = await s.api('POST', '/api/cards/again/worker/send', { text: 'one more thing' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await workerOf(s, 'again')).busy, true);

    await s.api('POST', '/api/turn-end', { session: key });
    assert.strictEqual((await workerOf(s, 'again')).busy, false);
  } finally { await teardown(); }
});

test('lieutenant interrupt: a wake makes it busy; the route reaches its ref; the CLI does the same', async () => {
  const { s, fdir, teardown } = await startServerWithProject({ prefix: 'bc-int-' });
  try {
    // A marker-backed fake session: alive and sendable from the server process.
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'bc-lt-int.json'), '{}');
    let r = await s.api('PATCH', '/api/lieutenants/' + LT, { ref: { harness: 'fake', session: 'bc-lt-int', cwd: '/tmp' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    let lt = (await board(s)).lieutenants.find((l) => l.id === LT);
    assert.strictEqual(lt.busy, false);
    assert.strictEqual(lt.canInterrupt, true);
    assert.strictEqual((await s.api('POST', '/api/lieutenants/' + LT + '/interrupt', {})).status, 409);

    r = await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'write me an essay' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await until('the wake marks the lieutenant busy',
      async () => (await board(s)).lieutenants.find((l) => l.id === LT).busy);

    const cli = await runCli(['interrupt', 'lieutenant:' + LT, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /interrupted -> lieutenant:/);
    assert.strictEqual(interrupts(fdir, 'bc-lt-int'), 1);
    lt = (await board(s)).lieutenants.find((l) => l.id === LT);
    assert.strictEqual(lt.busy, false);
  } finally { await teardown(); }
});

test('harness without interrupt → 501 unsupported, and the payload says it cannot', async () => {
  const { s, teardown } = await startServerWithProject({ prefix: 'bc-int-', env: { BC_FAKE_NO_INTERRUPT: '1' } });
  try {
    await startWorker(s, 'no-stop');
    assert.strictEqual((await workerOf(s, 'no-stop')).canInterrupt, false);
    const r = await s.api('POST', '/api/cards/no-stop/interrupt', {});
    assert.strictEqual(r.status, 501, JSON.stringify(r.body));
    assert.strictEqual(r.body.unsupported, true);
  } finally { await teardown(); }
});

test('nothing to stop → 404; a busy agent whose session is gone → 409', async () => {
  const { s, teardown } = await startServerWithProject({ prefix: 'bc-int-' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Parked', id: 'parked' }));
    let r = await s.api('POST', '/api/cards/parked/interrupt', {});
    assert.strictEqual(r.status, 404);
    assert.match(r.body.error, /not Working/);
    r = await s.api('POST', '/api/cards/never-was/interrupt', {});
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/lieutenants/nobody/interrupt', {});
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/lieutenants/' + LT + '/interrupt', {});
    assert.strictEqual(r.status, 404);
    assert.match(r.body.error, /no live session/);
  } finally { await teardown(); }

  // Seeded: the board typed into this lieutenant, but its session is gone.
  const fdir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bc-int-ghost-'));
  const g = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => seedBoard(dir, { lieutenants: [{ id: 'ghost', name: 'Ghost', color: '#888', prefix: 'GH',
      created: new Date().toISOString(), ref: { harness: 'fake', session: 'bc-ghost', cwd: dir },
      lastInputAt: new Date().toISOString() }] }),
  });
  try {
    const r = await g.api('POST', '/api/lieutenants/ghost/interrupt', {});
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /no live session/);
  } finally { await g.stop(); fs.rmSync(fdir, { recursive: true, force: true }); }
});

test('lieutenant wakes: one reminder per drain, none after an interrupt until the next captain message', async () => {
  // TTL 0: only the drained rule and the hush can hold a wake back here.
  const { s, fdir, teardown } = await startServerWithProject({ prefix: 'bc-int-', env: { BC_WAKE_TTL_MS: '0' } });
  const wakes = () => {
    try { return fs.readFileSync(path.join(fdir, 'bc-lt-wk.sends.jsonl'), 'utf8').split('\n').filter(Boolean).length; }
    catch { return 0; }
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  try {
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'bc-lt-wk.json'), '{}');
    await s.api('PATCH', '/api/lieutenants/' + LT, { ref: { harness: 'fake', session: 'bc-lt-wk', cwd: '/tmp' } });

    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'a long order' });
    await until('the first wake', () => wakes() === 1);
    await s.api('GET', '/api/feed?lieutenant=' + LT); // its turn drains the order
    let r = await s.api('POST', '/api/turn-end', { session: 'bc-lt-wk' });
    assert.strictEqual(r.body.lieutenant, LT, JSON.stringify(r.body));
    await until('one reminder for the unacked order', () => wakes() === 2);
    await s.api('POST', '/api/turn-end', { session: 'bc-lt-wk' });
    await settle();
    assert.strictEqual(wakes(), 2, 'no pile of wake lines for an order it already read');

    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'another long order' });
    await until('an unread order wakes it', () => wakes() === 3);
    r = await s.api('POST', '/api/lieutenants/' + LT + '/interrupt', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await s.api('POST', '/api/turn-end', { session: 'bc-lt-wk' }); // e.g. a harness that reports the stopped turn
    await settle();
    assert.strictEqual(wakes(), 3, 'the pending orders do not restart the stopped turn');
    assert.ok((await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items.length >= 1, 'and stay unacked');

    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'a new order' });
    await until('the next captain message wakes it', () => wakes() === 4);
  } finally { await teardown(); }
});
