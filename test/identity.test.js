'use strict';
// Caller identity: a worker is a WINDOW inside its lieutenant's tmux SESSION
// (names.js — workerWindow), so bc-axi sends both and the server resolves them
// through ONE resolver (server/conversation.js identify). A worker must never
// be taken for its lieutenant: its say wakes the owner, its drain is empty,
// its ack is refused. Driven end to end through bc-axi with a stub tmux.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, runCli } = require('./helper');

function makeRepo(root) {
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}

// A stub tmux on PATH that answers `display-message` the way the real one
// does for a pane in `session`, window `window` (window '' = an older answer
// carrying the session only).
function tmuxAs(root, session, window) {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  const out = window ? session + '\\n' + window : session;
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nprintf \'' + out + '\\n\'\n');
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { TMUX: '/tmp/stub,1,0', TMUX_PANE: '%1', PATH: bin + ':' + process.env.PATH };
}

test('a worker is identified by its window: its say wakes the owner, its drain/ack never touch the owner\'s queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-identity-'));
  const repo = makeRepo(root);
  const s = await startServer({ env: {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  } });
  const cli = (args, env) => runCli([...args, '--workspace', s.dir, '--port', String(s.port)], env);
  try {
    assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
    // Grace lives in the `lt` window of bc-grace; her workers are windows beside it.
    const ref = { harness: 'fake', session: 'bc-grace', cwd: s.dir, window: 'lt' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref })).status, 200);
    const card = (await s.api('POST', '/api/cards',
      { title: 'Two voices', owner: 'grace', playbook: 'default', attributes: { repo: 'proj' } })).body.card;
    const started = await s.api('POST', '/api/cards/' + card.id + '/start', { harness: 'fake' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const w = (await s.api('GET', '/api/board')).body.workers.find((x) => x.card === card.id);
    assert.deepStrictEqual([w.ref.session, w.ref.window], ['bc-grace', 'w-' + card.id]);

    const worker = tmuxAs(root, 'bc-grace', 'w-' + card.id);
    const grace = tmuxAs(root, 'bc-grace', 'lt');
    const pending = async () => (await s.api('GET', '/api/feed?lieutenant=grace')).body.items;
    const textFile = path.join(root, 'say.txt');
    const before = (await pending()).length;

    // The worker says on its card: stamped as the worker, and the owner is WOKEN.
    fs.writeFileSync(textFile, 'which base should I rebase on?');
    let r = await cli(['say', 'card:' + card.id, '--text-file', textFile], worker);
    assert.strictEqual(r.code, 0, r.stderr);
    let thread = (await s.api('GET', '/api/cards/' + card.id)).body.thread;
    assert.strictEqual(thread[thread.length - 1].author, 'worker ' + card.id);
    let items = await pending();
    assert.strictEqual(items.length, before + 1, 'the worker\'s say queues for the owner');
    const said = items[items.length - 1];
    assert.strictEqual(said.kind, 'worker-said');
    assert.strictEqual(said.author, 'worker ' + card.id);

    // The owner answering from her own window is the owner: no self-wake.
    fs.writeFileSync(textFile, 'rebase on main');
    r = await cli(['say', 'card:' + card.id, '--text-file', textFile], grace);
    assert.strictEqual(r.code, 0, r.stderr);
    thread = (await s.api('GET', '/api/cards/' + card.id)).body.thread;
    assert.strictEqual(thread[thread.length - 1].author, 'Grace');
    assert.strictEqual((await pending()).length, before + 1);

    // The worker's drain is empty — the lieutenant's queue is not its to read…
    r = await cli(['drain', '--json'], worker);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '', 'a worker drains nothing');
    // …and its ack is refused, so it can never discard the owner's items.
    r = await cli(['ack', String(said.seq)], worker);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /worker has no delivery queue/);
    assert.strictEqual((await pending()).length, before + 1, 'nothing was acked');

    // The lieutenant, from her own window, drains and acks her queue.
    r = await cli(['drain', '--json'], grace);
    const mine = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(mine.some((it) => it.seq === said.seq));
    r = await cli(['ack', String(said.seq)], grace);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /lieutenant=grace/);

    // An older bc-axi (session only) still resolves to the lieutenant.
    r = await cli(['line', 'pass', 'grace', '--note', 'yours'], tmuxAs(root, 'bc-grace', ''));
    assert.strictEqual(r.code, 0, r.stderr);
    items = await pending();
    assert.strictEqual(items[items.length - 1].kind, 'line-passed');
    assert.strictEqual(items[items.length - 1].from, 'Grace');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turn-end: a worker hook POST never resolves as the lieutenant whose session it shares', async () => {
  const s = await startServer({ env: { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' } });
  try {
    const ref = { harness: 'fake', session: 'bc-grace', cwd: s.dir, window: 'lt' };
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref });
    // A stale worker (no record) posting from its window: acknowledged, attributed to nobody.
    let r = await s.api('POST', '/api/turn-end', { session_id: 'abc', session: 'bc-grace:w-GRA-9', tmux_session: 'bc-grace' });
    assert.strictEqual(r.body.lieutenant, null);
    // The lieutenant's own window adopts its conversation id.
    r = await s.api('POST', '/api/turn-end', { session_id: 'lt-1', session: 'bc-grace:lt', tmux_session: 'bc-grace' });
    assert.strictEqual(r.body.lieutenant, 'grace');
    const lt = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === 'grace');
    assert.strictEqual(lt.ref.resumeId, 'lt-1');
  } finally {
    await s.stop();
  }
});
