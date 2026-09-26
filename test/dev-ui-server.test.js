'use strict';
// dev/ui-server.js — the dev playground: the REAL server booted on a workspace
// seeded from dev/fixtures/, plus fake lieutenants that answer. These tests keep
// the seeding honest and prove the routes the UI's config tabs and ⚡ screen
// call answer, in the shapes the UI reads.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { retryOnPortClash, sleep } = require('./helper');

const { startPlayground } = require(path.join(__dirname, '..', 'dev', 'ui-server.js'));

let pg;
before(async () => { pg = await retryOnPortClash(() => startPlayground({ replyMs: 100 })); });
after(async () => { if (pg) await pg.stop(); });

async function get(p) {
  const r = await fetch(pg.base + p);
  assert.strictEqual(r.status, 200, p);
  return r.headers.get('content-type').includes('json') ? r.json() : r.text();
}
async function post(p, body) {
  const r = await fetch(pg.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function until(what, fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what);
}

test('serves the UI from this worktree', async () => {
  assert.match(await get('/'), /bridge/i);
  await get('/ui/js/main.js');
});

test('the board is the fixture, derived by the real server', async () => {
  const doc = await get('/api/board');
  assert.strictEqual(doc.lieutenants.length, 4);
  assert.ok(doc.kinds['pr-merged'] && doc.kinds.created, 'fixture kinds merged over the built-ins');
  for (const col of ['backlog', 'working', 'review', 'peer']) {
    assert.ok(doc.cards.some((c) => c.column === col), 'a card in ' + col);
  }
  assert.match(doc.cards.find((c) => c.id === 'mega-spec').body, /\S/, 'bodyFile inlined');
  const oauth = doc.cards.find((c) => c.id === 'oauth-token-refresh');
  assert.strictEqual(oauth.status.worker.state, 'working');
  assert.strictEqual(oauth.status.owedState, 'seen', 'owedSeed became a drained queue item');
  assert.strictEqual(doc.cards.find((c) => c.id === 'dashboard-dark-mode').status.worker.state, 'idle', 'expired lease decays');
  const quill = doc.lieutenants.find((l) => l.id === 'quill');
  assert.ok(quill.chatOwed && quill.chatQueued, 'owedSeed became an undrained queue item');
  assert.ok(doc.lieutenants.find((l) => l.id === 'monica').chat.length >= 5, 'chat moved to its log');
  const a = await get('/api/archive?limit=20&offset=20');
  assert.strictEqual(a.archive.length, 20);
  assert.ok(a.total >= 45, 'archive.jsonl seeded (' + a.total + ')');
  const uri = doc.cards.find((c) => c.id === 'mega-spec').attributes.artifacts[0].uri;
  const art = await get('/api/artifact?uri=' + encodeURIComponent(uri));
  assert.match(art.content, /\S/, 'artifact body on disk');
  assert.match(await get('/api/attachments/a77ac0de0002'), /\S/, 'attachment in uploads/');
});

test('the routes the config tabs and the ⚡ screen call answer', async () => {
  const lts = await get('/api/lieutenants?live=1');
  assert.strictEqual(lts.lieutenants.length, 4);
  assert.strictEqual(lts.lieutenants.find((l) => l.id === 'monica').session, 'live', 'fake harness marker = live session');
  const projects = await get('/api/projects?git=1');
  assert.strictEqual(projects.projects[0].name, 'bridge-commander');
  assert.strictEqual(projects.projects[0].missing, false, 'project is a real repo');
  const pb = await get('/api/playbooks');
  assert.ok(pb.items.some((i) => i.id === 'default'), 'items, the shape pbmanager reads');
  assert.ok(pb.reference && pb.reference.placeholders, 'reference present');
  const hooks = await get('/api/hooks');
  assert.deepStrictEqual(hooks.hooks.map((h) => h.name).sort(), ['digest', 'log-archive']);
  const sch = await get('/api/schedules');
  assert.deepStrictEqual(sch.schedules.map((s) => s.name).sort(), ['nightly-digest', 'pr-sweep']);
  const run = await post('/api/hooks/run', { name: 'digest' });
  assert.strictEqual(run.status, 200, JSON.stringify(run.body));
  assert.strictEqual(run.body.run.code, 0, JSON.stringify(run.body));
});

test('a fake lieutenant answers the captain and clears what he owed', async () => {
  const r = await post('/api/feedback', { target: 'lieutenant:rex', text: 'status?' });
  assert.strictEqual(r.status, 200);
  const rex = await until('rex to reply', async () => {
    const lt = (await get('/api/board')).lieutenants.find((l) => l.id === 'rex');
    return lt.chat.at(-1).author === 'Rex' && !lt.chatOwed && lt;
  });
  assert.strictEqual(rex.chat.at(-2).text, 'status?');
});

test('a start-order ends in Working with a worker in a real worktree', async () => {
  const r = await post('/api/cards/refactor-queue-backoff/move', { column: 'working', actor: 'user' });
  assert.strictEqual(r.body.ordered, 'start-order');
  const card = await until('the card to start', async () =>
    (await get('/api/board')).cards.find((c) => c.id === 'refactor-queue-backoff' && c.column === 'working'));
  assert.strictEqual(card.events.at(-1).kind, 'started', JSON.stringify(card.events.slice(-3)));
});
