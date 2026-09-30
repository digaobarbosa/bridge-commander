'use strict';
// ui/js/cardview.js — the card view model every surface draws from: the tile,
// the table row, the archive row, the detail panel and the bulk bar. Pure over
// (card, doc, nowMs), so it imports straight into node (ESM, hence the dynamic
// import, same shape as board-modes.test.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const cv = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'cardview.js')).href);

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

function cardOf(extra) {
  return Object.assign({
    id: 'MNC-7', title: 'fix it', type: 'implementation', owner: 'ada', column: 'backlog',
    labels: ['ui'], attributes: {}, playbook: 'default', thread: [], events: [],
    status: { worker: { id: null, state: 'absent' }, owed: false, unread: false },
  }, extra);
}
function docOf(extra) {
  return Object.assign({
    lieutenants: [{ id: 'ada', name: 'Ada', color: '#112233' }],
    workers: [], projects: [], permissions: [], cards: [],
  }, extra);
}

// ---------- cardContext ----------

test('the card context has the contract shape, read from the card and the doc', async () => {
  const { cardContext } = await cv;
  const c = cardOf({
    column: 'working',
    attributes: { repo: 'bc', branch: 'bc/x', worktree: '/wt/x', prs: [{ url: 'https://gh/p/pull/3', state: 'open' }, { bad: 1 }] },
    status: { worker: { id: 'w1', state: 'working' } },
  });
  const doc = docOf({
    projects: [{ name: 'bc', path: '/repos/bc', added: 'x' }],
    workers: [{ card: 'MNC-7', ref: { harness: 'codex', session: 's' }, branch: 'bc/x' }],
  });
  const ctx = cardContext(c, doc);
  assert.deepStrictEqual(Object.keys(ctx), ['card', 'project', 'worker', 'harness']);
  assert.deepStrictEqual(Object.keys(ctx.card),
    ['id', 'title', 'type', 'owner', 'column', 'labels', 'attributes', 'playbook', 'branch', 'worktree', 'repo', 'prs']);
  assert.strictEqual(ctx.card.branch, 'bc/x');
  assert.strictEqual(ctx.card.worktree, '/wt/x');
  assert.strictEqual(ctx.card.repo, 'bc');
  assert.deepStrictEqual(ctx.card.prs, [{ url: 'https://gh/p/pull/3', state: 'open' }], 'only well-formed PRs');
  assert.deepStrictEqual(ctx.project, { name: 'bc', path: '/repos/bc' });
  assert.deepStrictEqual(ctx.worker, { state: 'working', live: true });
  assert.strictEqual(ctx.harness, 'codex');
});

test('a card with nothing attached has null project, worker and harness', async () => {
  const { cardContext } = await cv;
  const ctx = cardContext(cardOf(), docOf());
  assert.strictEqual(ctx.project, null);
  assert.strictEqual(ctx.worker, null);
  assert.strictEqual(ctx.harness, null);
  assert.deepStrictEqual(ctx.card.prs, []);
});

test('the context is frozen all the way down and never aliases the board', async () => {
  const { cardContext } = await cv;
  const c = cardOf({ attributes: { deep: { x: 1 } } });
  const ctx = cardContext(c, docOf());
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.card) && Object.isFrozen(ctx.card.attributes.deep));
  assert.ok(Object.isFrozen(ctx.card.labels));
  assert.throws(() => { 'use strict'; ctx.card.labels.push('x'); });
  assert.notStrictEqual(ctx.card.attributes, c.attributes, 'a copy: a predicate cannot write into the card');
  assert.deepStrictEqual(c.labels, ['ui']);
});

test('the context feeds when.js predicates', async () => {
  const { cardContext } = await cv;
  const { matches } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'when.js')).href);
  const ctx = cardContext(cardOf({ attributes: { prs: [{ url: 'https://gh/p/pull/3', state: 'open' }] } }), docOf());
  assert.ok(matches({ 'card.column': 'backlog', 'card.labels': 'ui' }, ctx));
  assert.ok(matches({ 'card.prs': { $exists: true } }, ctx));
  assert.ok(!matches({ 'worker.state': 'working' }, ctx));
});

test('a new doc gives a fresh context; the same doc reuses it', async () => {
  const { cardContext } = await cv;
  const c = cardOf();
  const d1 = docOf();
  assert.strictEqual(cardContext(c, d1), cardContext(c, d1));
  const d2 = docOf({ workers: [{ card: 'MNC-7', ref: { harness: 'claude' } }] });
  assert.strictEqual(cardContext(c, d2).harness, 'claude');
});

// ---------- cardFacts ----------

test('owner name, emoji and message count', async () => {
  const { cardFacts } = await cv;
  const f = cardFacts(cardOf({ type: 'plan', thread: [{ author: 'user', text: 'a', ts: ago(1) }, { author: 'Ada', text: 'b', ts: ago(0) }] }), docOf(), NOW);
  assert.strictEqual(f.ownerName, 'Ada');
  assert.strictEqual(f.emoji, '🧠');
  assert.strictEqual(f.messageCount, 2);
  assert.strictEqual(cardFacts(cardOf({ owner: 'ghost' }), docOf(), NOW).ownerName, 'ghost', 'an unknown owner reads as its id');
});

test('owed, queued and stale: the corner the tile and the table both draw', async () => {
  const { cardFacts, cornerHtml } = await cv;
  const thread = (msAgo) => [{ author: 'user', text: 'hi', ts: ago(msAgo) }];
  const fresh = cardFacts(cardOf({ thread: thread(1000), status: { owed: true, owedState: 'seen' } }), docOf(), NOW);
  assert.deepStrictEqual([fresh.owed, fresh.stale, fresh.queued], ['seen', false, false]);
  assert.match(cornerHtml(fresh), /tdot/);

  const queued = cardFacts(cardOf({ thread: thread(1000), status: { owed: true, owedState: 'queued' } }), docOf(), NOW);
  assert.strictEqual(queued.queued, true);
  assert.match(cornerHtml(queued), /t-typing queued[^>]*>⏳/);

  const stale = cardFacts(cardOf({ thread: thread(200000), status: { owed: true, owedState: 'seen' } }), docOf(), NOW);
  assert.strictEqual(stale.stale, true, 'three minutes without a reply may be stuck');
  assert.match(cornerHtml(stale), /t-typing stale[^>]*>⚠/);

  const older = cardFacts(cardOf({ status: { owed: true } }), docOf(), NOW);
  assert.strictEqual(older.owed, 'seen', 'an older payload with owed only reads as seen');
});

test('owed beats unread; unread alone shows the dot; nothing shows nothing', async () => {
  const { cardFacts, cornerHtml } = await cv;
  const both = cardFacts(cardOf({ status: { owed: true, owedState: 'seen', unread: true } }), docOf(), NOW);
  assert.ok(!/t-unread/.test(cornerHtml(both)));
  const unread = cardFacts(cardOf({ status: { unread: true } }), docOf(), NOW);
  assert.match(cornerHtml(unread), /t-unread/);
  assert.strictEqual(cornerHtml(cardFacts(cardOf(), docOf(), NOW)), '');
});

test('the worker state is whitelisted before any surface puts it in a class', async () => {
  const { cardFacts } = await cv;
  const f = cardFacts(cardOf({ status: { worker: { id: 'w1', state: 'needs-you' } } }), docOf(), NOW);
  assert.strictEqual(f.workerState, 'needs-you');
  assert.strictEqual(f.workerId, 'w1');
  const evil = cardFacts(cardOf({ status: { worker: { id: 'w1', state: '"><script>' } } }), docOf(), NOW);
  assert.strictEqual(evil.workerState, 'absent');
  assert.strictEqual(evil.workerId, '');
});

test('approvals and the pending order', async () => {
  const { cardFacts, orderHtml } = await cv;
  const doc = docOf({ permissions: [{ id: 1, card: 'MNC-7' }, { id: 2, card: 'MNC-7' }, { id: 3, card: 'other' }] });
  const f = cardFacts(cardOf({ pendingOrder: { kind: 'start-order' } }), doc, NOW);
  assert.strictEqual(f.needsApproval, 2);
  assert.deepStrictEqual(f.pendingOrder, { kind: 'start-order' });
  assert.match(orderHtml(f, 'chip', 'ada'), /⏳ ordered/);
  assert.match(orderHtml(f, 'chip', 'ada'), /start-order sent to ada/);
  assert.match(orderHtml(f, 'mark'), /title="start-order pending">⏳</);
  assert.match(orderHtml(f, 'attr'), /pending<\/span><span class="v">⏳ start-order/);
  assert.strictEqual(orderHtml(cardFacts(cardOf(), doc, NOW), 'chip', 'ada'), '');
  const evil = cardFacts(cardOf({ pendingOrder: { kind: '<b>' } }), doc, NOW);
  assert.ok(!orderHtml(evil, 'attr').includes('<b>'), 'the order kind is escaped');
});

test('canArchive: a live worker refuses, a done one does not, the lease is asked second', async () => {
  const { cardFacts } = await cv;
  const c = cardOf({ column: 'working' });
  const live = docOf({ workers: [{ card: 'MNC-7', branch: 'bc/x', ref: {} }] });
  assert.deepStrictEqual(cardFacts(c, live, NOW).canArchive, { ok: false, reason: 'live worker on bc/x' });
  const done = docOf({ workers: [{ card: 'MNC-7', done: true, ref: {} }] });
  assert.deepStrictEqual(cardFacts(c, done, NOW).canArchive, { ok: true, reason: '' });
  const leased = cardOf({ status: { worker: { id: 'w', state: 'idle' } } });
  assert.deepStrictEqual(cardFacts(leased, docOf(), NOW).canArchive, { ok: false, reason: 'worker idle' });
  // an unknown lease state still refuses: the guard never fails open
  const odd = cardOf({ status: { worker: { id: 'w', state: 'paused' } } });
  assert.strictEqual(cardFacts(odd, docOf(), NOW).canArchive.ok, false);
});

test('canEditOwner follows the server rule: any worker record refuses, done or not', async () => {
  const { cardFacts } = await cv;
  assert.strictEqual(cardFacts(cardOf(), docOf(), NOW).canEditOwner, true);
  const done = docOf({ workers: [{ card: 'MNC-7', done: true, ref: {} }] });
  assert.strictEqual(cardFacts(cardOf(), done, NOW).canEditOwner, false, 'the server 409s while a record exists');
  const leased = cardOf({ status: { worker: { id: 'w', state: 'working' } } });
  assert.strictEqual(cardFacts(leased, docOf(), NOW).canEditOwner, false);
});

test('canEditPlaybook: Backlog only, never a plan', async () => {
  const { cardFacts } = await cv;
  assert.strictEqual(cardFacts(cardOf(), docOf(), NOW).canEditPlaybook, true);
  for (const column of ['working', 'review', 'peer']) {
    assert.strictEqual(cardFacts(cardOf({ column }), docOf(), NOW).canEditPlaybook, false, column);
  }
  assert.strictEqual(cardFacts(cardOf({ type: 'plan' }), docOf(), NOW).canEditPlaybook, false);
});

test('Working gates the context bar and the peek', async () => {
  const { cardFacts } = await cv;
  const st = { contextUsed: 10, contextWindow: 100 };
  const doc = docOf({ workers: [{ card: 'MNC-7', ref: {}, agentStatus: st }] });
  const w = cardFacts(cardOf({ column: 'working' }), doc, NOW);
  assert.strictEqual(w.inWorking, true);
  assert.strictEqual(w.agentStatus, st);
  const r = cardFacts(cardOf({ column: 'review' }), doc, NOW);
  assert.strictEqual(r.inWorking, false);
  assert.strictEqual(r.agentStatus, null);
});

test('a frozen snapshot: archive reason, and nothing live or editable', async () => {
  const { cardFacts, archiveReasonHtml } = await cv;
  const c = cardOf({ column: 'working', status: { worker: { id: 'w', state: 'working' }, owed: true, unread: true }, pendingOrder: { kind: 'x' } });
  const f = cardFacts(c, docOf(), NOW, { reason: 'merged', note: 'https://gh/p/pull/3', ts: ago(0) });
  assert.strictEqual(f.archiveReason, 'merged');
  assert.match(archiveReasonHtml(f), /tv-rsn-merged" title="https:\/\/gh\/p\/pull\/3">🏁 merged/);
  assert.deepStrictEqual([f.workerState, f.owed, f.unread, f.pendingOrder, f.inWorking], ['absent', null, false, null, false]);
  assert.deepStrictEqual([f.canArchive.ok, f.canEditOwner, f.canEditPlaybook], [false, false, false]);
  const k = cardFacts(cardOf(), docOf(), NOW, { reason: 'whatever' });
  assert.strictEqual(k.archiveReason, 'killed', 'anything not merged reads as killed');
  assert.match(archiveReasonHtml(k), /🪦 killed/);
  assert.strictEqual(archiveReasonHtml(cardFacts(cardOf(), docOf(), NOW)), '', 'a live card has no reason');
});

test('session checkpoint shows stage, summary, next action and blocker as escaped text', async () => {
  const { sessionCheckpointHtml } = await cv;
  const c = cardOf({ sessionCheckpoint: { stage: 'review', summary: 'Fixed <worker> & session routing',
    nextAction: 'Run the "resume" check', blocker: '<script>wait for checkout</script>' } });
  const html = sessionCheckpointHtml(c);
  assert.match(html, /Session checkpoint<span>review<\/span>/);
  assert.match(html, /Fixed &lt;worker&gt; &amp; session routing/);
  assert.match(html, /<dt>Next action<\/dt><dd>Run the &quot;resume&quot; check<\/dd>/);
  assert.match(html, /Blocker<\/dt><dd class="checkpoint-blocker">&lt;script&gt;wait for checkout&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'));
  const frozen = JSON.parse(JSON.stringify(c));
  assert.strictEqual(sessionCheckpointHtml(frozen), html, 'archived card renders the same saved checkpoint');
});

test('empty checkpoints disappear and a cleared blocker leaves no stale blocker row', async () => {
  const { sessionCheckpointHtml } = await cv;
  for (const sessionCheckpoint of [undefined, null, {}, { summary: '  ', blocker: '' }, { summary: {} }]) {
    assert.strictEqual(sessionCheckpointHtml(cardOf({ sessionCheckpoint })), '');
  }
  const html = sessionCheckpointHtml(cardOf({ sessionCheckpoint: { summary: 'Ready to continue', nextAction: 'Review', blocker: '' } }));
  assert.match(html, /Ready to continue/);
  assert.match(html, /Next action/);
  assert.ok(!html.includes('Blocker'));
});
