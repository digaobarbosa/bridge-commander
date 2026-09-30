'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { validateSession, captureManaged, publicSessions } = require('../server/sessions');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');
const { createWorkers } = require('../server/workers');
const ID = '01a0f3a1-c6e7-7472-96ed-d029b815d305';
const ID2 = '01a0f3a1-c6e7-7472-96ed-d029b815d306';
const session = (cwd, extra = {}) => ({ provider: 'codex', id: ID, cwd, host: os.hostname(), surface: 'app', ...extra });
const quiet = { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' };

test('conversation identity is provider + host + exact UUID; malformed identity cannot be guessed', () => {
  const valid = validateSession(session('/tmp'));
  assert.equal(valid.session.id, ID);
  for (const change of [{ provider: 'unknown' }, { id: 'latest' }, { cwd: 'relative' }, { host: '' }, { surface: 'desktop' }]) {
    assert.equal(validateSession(session('/tmp', change)).code, 400);
  }
  assert.notEqual(validateSession(session('/tmp', { host: 'another-machine' })).session.key, valid.session.key);
});

test('managed history survives worker removal, repeated captures preserve a selected prior session', () => {
  const card = { attributes: {} };
  const w = { ref: { harness: 'codex', resumeId: ID, cwd: '/tmp', session: 'bc-ada', window: 'w-1' } };
  captureManaged(card, w);
  w.ref.resumeId = ID2;
  captureManaged(card, w);
  assert.equal(card.sessions.length, 2);
  card.currentSession = card.sessions[0].key;
  captureManaged(card, w);
  assert.equal(card.currentSession, card.sessions[0].key);
  assert.equal(card.sessions[1].origin, 'managed');
  assert.equal(card.sessions[1].harness, 'codex');
  assert.deepEqual(card.sessions[1].tmux, { session: 'bc-ada', window: 'w-1' });
  const entries = publicSessions(card);
  assert.equal(entries[0].local, true);
  assert.equal(entries[0].cwdAvailable, true);
  assert.equal(publicSessions(card, 'remote')[0].local, false);
});

test('worker turn-end and drop preserve exact identity before the registry entry disappears', async () => {
  const card = { id: 'task', column: 'review', attributes: {}, sessions: [] };
  const w = { card: card.id, ref: { harness: 'codex', cwd: '/tmp', session: 'bc-task' } };
  const board = { cards: [card], workers: [w] };
  const workers = createWorkers({ board: () => board, findCard: () => card, save() {},
    rememberSession: captureManaged });
  await workers.turnEnd(w, { sid: ID });
  assert.equal(card.sessions[0].id, ID);
  assert.equal(card.sessions[0].origin, 'managed');
  workers.drop(card, w);
  assert.equal(board.workers.length, 0);
  assert.equal(card.sessions[0].id, ID);
  const external = { id: 'external', execution: 'external', attributes: { worktree: '/tmp/user-checkout' } };
  assert.deepEqual(await workers.end(external, 'archive'), { spared: true });
});

test('API companion sync deduplicates, changes stages without workers, validates atomically and keeps archived links', async () => {
  const s = await startServerWithLieutenant({ env: quiet });
  try {
    const payload = { title: 'Session task', owner: LT, session: session(s.dir), summary: 'Plan agreed', stage: 'planning' };
    let r = await s.api('POST', '/api/sessions/sync', payload);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.card.id;
    assert.equal(r.body.card.execution, 'external');
    assert.equal(r.body.session.local, true);
    assert.equal(r.body.session.cwdAvailable, true);
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, stage: 'implementation', summary: 'Building', nextAction: 'Run tests' });
    assert.equal(r.body.card.id, id);
    assert.equal(r.body.card.column, 'working');
    assert.equal((await s.api('GET', '/api/board')).body.workers.length, 0);
    const before = (await s.api('GET', '/api/cards/' + id)).body;
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, stage: 'wrong', summary: 'Must not land' });
    assert.equal(r.status, 400);
    assert.deepEqual((await s.api('GET', '/api/cards/' + id)).body, before);
    r = await s.api('POST', '/api/cards/' + id + '/start', {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /external session/);
    r = await s.api('POST', '/api/cards/' + id + '/move', { column: 'review', actor: 'user' });
    assert.equal(r.status, 200);
    r = await s.api('POST', '/api/sessions/sync', { card: id, session: session(s.dir, { id: ID2, provider: 'claude', surface: 'cli' }) });
    assert.equal(r.body.card.sessions.length, 2);
    r = await s.api('PATCH', '/api/cards/' + id, { currentSession: before.currentSession });
    assert.equal(r.status, 200);
    r = await s.api('PATCH', '/api/cards/' + id, { currentSession: 'wrong', title: 'Must not land' });
    assert.equal(r.status, 400);
    assert.equal((await s.api('GET', '/api/cards/' + id)).body.title, 'Session task');
    await s.api('POST', '/api/cards/' + id + '/archive', {});
    const archived = (await s.api('GET', '/api/archive')).body.archive[0].card;
    assert.equal(archived.sessions.length, 2);
    assert.equal(archived.sessions[0].local, true);
    assert.equal(archived.currentSession, before.currentSession);
    r = await s.api('POST', '/api/sessions/sync', payload);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /archived card/);
  } finally { await s.stop(); }
});

test('syncing a regular card preserves managed lifecycle and durable history across a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-session-restart-'));
  let s = await startServerWithLieutenant({ dir, env: quiet });
  try {
    const created = await s.api('POST', '/api/cards', withOwner({ title: 'Managed task' }));
    const id = created.body.card.id;
    let r = await s.api('POST', '/api/sessions/sync', { card: id, session: session(dir), stage: 'implementation', summary: 'Working in original session' });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.column, 'backlog', 'checkpoint never moves a managed card');
    const key = r.body.card.currentSession;
    await s.stop();
    s = await startServerWithLieutenant({ dir, env: quiet });
    r = await s.api('POST', '/api/sessions/sync', { session: session(dir), summary: 'Resumed' });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.id, id);
    assert.equal(r.body.card.currentSession, key);
    assert.equal(r.body.card.sessions.length, 1);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('managed worker links are captured at boot, adopt turn-end identity and freeze before archive', async () => {
  const s = await startServerWithLieutenant({ env: quiet, seed(dir) {
    const state = path.join(dir, '.bridge-commander');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'board.json'), JSON.stringify({ cards: [{
      id: 'managed', owner: LT, title: 'Managed worker', column: 'working', type: 'implementation', attributes: {},
    }], workers: [{ card: 'managed', paused: true, ref: { harness: 'claude',
      session: 'bc-session-test-' + process.pid, window: 'worker', cwd: dir, resumeId: ID } }] }));
  } });
  try {
    let card = (await s.api('GET', '/api/cards/managed')).body;
    assert.equal(card.sessions[0].origin, 'managed');
    assert.equal(card.sessions[0].provider, 'claude');
    const synced = await s.api('POST', '/api/sessions/sync', {
      session: session(s.dir, { provider: 'claude', surface: 'cli' }), stage: 'planning' });
    assert.equal(synced.status, 200);
    assert.equal(synced.body.card.id, 'managed', 'a regular worker sync does not create a companion duplicate');
    assert.equal(synced.body.card.column, 'working');
    const other = await s.api('POST', '/api/cards', withOwner({ title: 'Other task' }));
    const redirected = await s.api('POST', '/api/sessions/sync', { card: other.body.card.id,
      session: session(s.dir, { provider: 'claude', surface: 'cli' }) });
    assert.equal(redirected.status, 409);
    assert.match(redirected.body.error, /managed session belongs to card managed/);
    assert.equal((await s.api('GET', '/api/cards/' + other.body.card.id)).body.sessions, undefined);
    const status = await s.api('GET', '/api/cards/managed/sessions');
    assert.equal(status.status, 200);
    assert.equal(status.body.worker.live, false);
    const turn = await s.api('POST', '/api/turn-end', {
      session: 'bc-session-test-' + process.pid + ':worker', session_id: ID2, cwd: s.dir });
    assert.equal(turn.status, 200);
    card = (await s.api('GET', '/api/cards/managed')).body;
    assert.equal(card.sessions.length, 2);
    assert.equal(card.sessions.find((v) => v.key === card.currentSession).id, ID2);
    const archive = await s.api('POST', '/api/cards/managed/archive', {});
    assert.equal(archive.status, 200);
    const frozen = (await s.api('GET', '/api/archive')).body.archive[0].card;
    assert.equal(frozen.sessions.length, 2);
    assert.equal(frozen.sessions.find((v) => v.key === frozen.currentSession).id, ID2);
  } finally { await s.stop(); }
});

test('sync persists Markdown description and reference links, updates it explicitly and preserves absent body', async () => {
  const s = await startServerWithLieutenant({ env: quiet });
  try {
    const description = '## Problem\nResume sessions from every stage.\n\n## Context\nKeep original task ownership.\n\n## References\n' +
      '- [PR](https://github.com/example/project/pull/12)\n- [Slack](https://example.slack.com/archives/CHANNEL/p123)\n' +
      '- [Linear](https://linear.app/example/issue/BC-12)';
    const payload = { title: 'Rich session task', owner: LT, session: session(s.dir), summary: 'Ready for review', body: description };
    let r = await s.api('POST', '/api/sessions/sync', payload);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.card.id;
    assert.equal(r.body.card.body, description);
    assert.equal((await s.api('GET', '/api/cards/' + id)).body.body, description, 'description is saved, not response-only');
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    assert.equal(saved.cards.find((card) => card.id === id).body, description, 'description survives in the board file');
    const events = r.body.card.events.length;
    const updated = description + '\n\n## Progress\nSession navigation tested.';
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, summary: payload.summary, body: updated });
    assert.equal(r.body.card.body, updated);
    assert.equal(r.body.card.events.length, events + 1, 'a body-only change records a sync event');
    assert.equal(r.body.card.events.at(-1).text, 'session description updated');
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, summary: 'Reviewed' });
    assert.equal(r.body.card.body, updated, 'omitting body preserves the existing description');
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, body: 'x'.repeat(20000) });
    assert.equal(r.status, 200, 'the body size boundary is accepted');
    assert.equal(r.body.card.body.length, 20000);
    r = await s.api('POST', '/api/sessions/sync', { session: payload.session, body: '' });
    assert.equal(r.body.card.body, '', 'explicit empty text clears the description');
  } finally { await s.stop(); }
});

test('invalid description is rejected before creating or updating any card', async () => {
  const s = await startServerWithLieutenant({ env: quiet });
  try {
    for (const body of [null, { text: 'not a string' }, 'x'.repeat(20001)]) {
      const r = await s.api('POST', '/api/sessions/sync', { title: 'Must not create', owner: LT, session: session(s.dir), body });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /body must be text up to 20000 characters/);
    }
    assert.equal((await s.api('GET', '/api/board')).body.cards.length, 0);
    const created = await s.api('POST', '/api/sessions/sync', { title: 'Existing task', owner: LT, session: session(s.dir),
      body: 'Keep this description', summary: 'Keep this checkpoint', stage: 'planning' });
    const id = created.body.card.id;
    const before = (await s.api('GET', '/api/cards/' + id)).body;
    for (const body of [false, ['not text'], 'x'.repeat(20001)]) {
      const r = await s.api('POST', '/api/sessions/sync', { session: session(s.dir), body,
        summary: 'Must not land', stage: 'implementation' });
      assert.equal(r.status, 400);
      assert.deepEqual((await s.api('GET', '/api/cards/' + id)).body, before, 'invalid body cannot partially update stage or checkpoint');
    }
  } finally { await s.stop(); }
});

test('explicit managed card body updates preserve its lifecycle; omitted body keeps manual description', async () => {
  const s = await startServerWithLieutenant({ env: quiet });
  try {
    const created = await s.api('POST', '/api/cards', withOwner({ title: 'Managed description', body: 'Captain instructions' }));
    const id = created.body.card.id;
    const before = (await s.api('GET', '/api/cards/' + id)).body;
    let r = await s.api('POST', '/api/sessions/sync', { card: id, session: session(s.dir),
      stage: 'implementation', summary: 'Working in original session' });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.body, 'Captain instructions');
    r = await s.api('POST', '/api/sessions/sync', { card: id, session: session(s.dir), body: 'Captain instructions\n\nProgress: implementation complete' });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.body, 'Captain instructions\n\nProgress: implementation complete');
    assert.equal(r.body.card.column, before.column, 'body sync never moves a managed card');
    assert.equal(r.body.card.execution, before.execution, 'body sync never converts a managed card');
    assert.equal(r.body.card.owner, before.owner);
    assert.equal((await s.api('GET', '/api/board')).body.workers.length, 0, 'body sync launches no worker');
    r = await s.api('POST', '/api/sessions/sync', { session: session(s.dir), nextAction: 'Review the change' });
    assert.equal(r.body.card.body, 'Captain instructions\n\nProgress: implementation complete');
  } finally { await s.stop(); }
});
