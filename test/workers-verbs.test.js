'use strict';
// The verbs of a running worker: signal, done, send, resume, and the turn-end
// hook resolving to worker refs. Each one wakes the owning lieutenant through
// the durable queue; none of them moves the card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/layout.js');
const { workerKey, git, makeRepo, boot, boardOnDisk, writePlaybook } = require('./workers-helper');

test('worker signal + done: card events, owner queue items, prs auto-populated, card does NOT move', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Ship it', id: 'ship', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/ship/start', { harness: 'fake' });
    const wsArgs = ['--workspace', s.dir, '--port', String(s.port)];

    // signal via the CLI verb (positional text)
    let r = await runCli(['worker', 'signal', 'ship', 'branch created, tests green', ...wsArgs]);
    assert.strictEqual(r.code, 0, r.stderr);
    let card = (await s.api('GET', '/api/cards/ship')).body;
    const sig = card.events[card.events.length - 1];
    assert.strictEqual(sig.kind, 'signal');
    assert.strictEqual(sig.level, 2);
    assert.strictEqual(sig.text, 'branch created, tests green');

    // done via the CLI verb; PR URL in the outcome populates prs (state open)
    r = await runCli(['worker', 'done', 'ship', '--outcome',
      'shipped: https://github.com/acme/proj/pull/7 checks green', ...wsArgs]);
    assert.strictEqual(r.code, 0, r.stderr);
    card = (await s.api('GET', '/api/cards/ship')).body;
    assert.strictEqual(card.column, 'working', 'done does NOT move the card — the lieutenant hands off');
    assert.deepStrictEqual(card.attributes.prs, [{ url: 'https://github.com/acme/proj/pull/7', state: 'open' }]);
    const done = card.events[card.events.length - 1];
    assert.strictEqual(done.kind, 'worker-done');
    assert.match(done.text, /shipped:/);

    // both landed as durable queue items for the owner, in order
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.includes('worker-signal'), kinds.join(','));
    assert.ok(kinds.includes('worker-done'), kinds.join(','));
    const doneItem = items.find((i) => i.kind === 'worker-done');
    assert.strictEqual(doneItem.card, 'ship');
    assert.match(doneItem.text, /pull\/7/);

    // registry entry marked done (supervision stops watching it)
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].done, true);
    assert.match(disk.workers[0].outcome, /checks green/);

    // empty signal text rejected
    assert.strictEqual((await s.api('POST', '/api/cards/ship/worker/signal', { text: '  ' })).status, 400);
  } finally { await teardown(); }
});

test('investigation: the playbook carries the report contract, no branch; done attaches the report artifact', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why-slow', type: 'investigation', playbook: 'investigation',
      attributes: { repo: 'proj' }, body: 'Find out why the dashboard takes 30s.',
    }));
    const r = await s.api('POST', '/api/cards/why-slow/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined, 'investigations have no branch');
    const card0 = r.body.card;
    assert.strictEqual(card0.attributes.branch, undefined);

    const rec = JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, 'why-slow') + '.json'), 'utf8'));
    assert.match(rec.prompt, /a report, not a change/);
    assert.match(rec.prompt, /reports\/why-slow\.md/);
    assert.doesNotMatch(rec.prompt, /git checkout -b/);
    assert.doesNotMatch(rec.prompt, /\{\{/);

    // card.start already auto-attached the brief itself, ahead of the report
    const briefFile = path.join(s.dir, '.bridge-commander', 'harness', workerKey(s.dir, 'why-slow') + '.prompt');
    assert.deepStrictEqual(card0.attributes.artifacts, [{ uri: 'file://' + briefFile, label: 'brief', type: 'markdown' }]);

    // the worker writes the report, then reports done → auto-attached artifact
    const report = path.join(s.dir, '.bridge-commander', 'reports', 'why-slow.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '# Findings\nIt was DNS.\n');
    await s.api('POST', '/api/cards/why-slow/worker/done', { outcome: 'report written: it was DNS' });
    const card = (await s.api('GET', '/api/cards/why-slow')).body;
    assert.deepStrictEqual(card.attributes.artifacts, [
      { uri: 'file://' + briefFile, label: 'brief', type: 'markdown' },
      { uri: 'file://' + report, label: 'report' },
    ]);
    // and the artifact is servable through the artifact preview endpoint
    const art = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent('file://' + report));
    assert.strictEqual(art.status, 200);
    assert.match(art.body.content, /It was DNS/);
  } finally { await teardown(); }
});

test('turn-end resolves worker refs (before lieutenant adoption), hook payload is ground truth', async () => {
  const { s, teardown } = await boot();
  try {
    // a resumeId-less lieutenant ref — the adoption candidate a worker POST must NOT land on
    await s.api('PATCH', '/api/lieutenants/' + LT, { ref: { harness: 'fake', session: 'lt-tmux', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Turns', id: 'turns', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/turns/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window; // what the worker's hook posts

    // match by the worker's resumeId
    let r = await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual(r.body.worker, 'turns');
    assert.strictEqual(r.body.lieutenant, null);

    // match by the session:window key; a CHANGED session_id is adopted as ground truth
    r = await s.api('POST', '/api/turn-end', { session: key, session_id: 'uuid-after-resume' });
    assert.strictEqual(r.body.worker, 'turns');
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].ref.resumeId, 'uuid-after-resume');
    assert.strictEqual(disk.workers[0].turns, 2);
    assert.ok(disk.workers[0].lastTurnEnd);
    // the lieutenant was never touched (no mis-adoption)
    assert.strictEqual(disk.lieutenants[0].ref.resumeId, undefined);
  } finally { await teardown(); }
});

test('worker turn-end without done on a Working card wakes the owner (worker-stopped), once per stop', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Wedged', id: 'wedged', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/wedged/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stopItems = async () => (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === 'worker-stopped' && i.card === 'wedged');

    // first stop: QueueItem + level-2 card event; the card does NOT move
    let r = await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual(r.body.worker, 'wedged');
    assert.strictEqual((await stopItems()).length, 1);
    const card = (await s.api('GET', '/api/cards/wedged')).body;
    assert.strictEqual(card.column, 'working');
    const ev = card.events.find((e) => e.kind === 'worker-stopped');
    assert.ok(ev, 'worker-stopped event on the card');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /stopped without reporting done/);

    // every further stop is a stop of its own (CMD-26: re-sent, stopped again
    // in silence, and the owner never heard) — the second turn-end posts again
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2);
    assert.strictEqual(
      (await s.api('GET', '/api/cards/wedged')).body.events.filter((e) => e.kind === 'worker-stopped').length, 2);

    // a signal in between changes nothing about that: the next stop notifies
    await s.api('POST', '/api/cards/wedged/worker/signal', { text: 'steered — back at it' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 3);

    // the drain hint names the stop and the session:window to peek
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /WORKER STOPPED — card wedged/);
    assert.match(cli.stdout, new RegExp('tmux attach -t ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // after done, turn-ends only bump counters — never a worker-stopped item
    await s.api('POST', '/api/cards/wedged/worker/done', { outcome: 'finished for real' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 3);
  } finally { await teardown(); }
});

test('a worker that stops, is re-sent, and stops again with no signal in between rings twice (hook → event → drain)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Twice', id: 'twice', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/twice/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stopItems = async () => (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === 'worker-stopped' && i.card === 'twice');

    // stop #1: the Stop hook POSTs, the owner gets one item
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 1);
    // the lieutenant re-sends; the worker ends its turn again saying nothing
    const sent = await s.api('POST', '/api/cards/twice/worker/send', { text: 'finish the gate' });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2, 'the second stop is a second item');
    const evs = (await s.api('GET', '/api/cards/twice')).body.events.filter((e) => e.kind === 'worker-stopped');
    assert.strictEqual(evs.length, 2, 'two worker-stopped events on the card');
    // the drain carries both stops
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((cli.stdout.match(/WORKER STOPPED — card twice/g) || []).length, 2);
  } finally { await teardown(); }
});

test('card start --resume reincarnates a dead recorded worker in the same worktree', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Crashy', id: 'crashy', attributes: { repo: 'proj' } }));
    const first = (await s.api('POST', '/api/cards/crashy/start', { harness: 'fake' })).body.worker;
    const cardBefore = (await s.api('GET', '/api/cards/crashy')).body;
    assert.strictEqual(cardBefore.attributes.artifacts.length, 1, 'brief attached on the fresh spawn');
    const briefUri = cardBefore.attributes.artifacts[0].uri;
    assert.strictEqual(cardBefore.attributes.artifacts[0].label, 'brief');

    // simulate worker-died state: the supervision loop would have flagged it
    // (BC state is on disk; here we drive the resume path directly)
    let r = await s.api('POST', '/api/cards/nope/start', { resume: true });
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/cards/crashy/start', { resume: true, harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.resumed, true);
    const w = r.body.worker;
    assert.strictEqual(w.ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(w.ref.window, workerWindow('crashy'));
    assert.strictEqual(w.worktree.path, first.worktree.path, 'same worktree — context preserved');
    assert.strictEqual(w.done, false);
    const cardAfter = (await s.api('GET', '/api/cards/crashy')).body;
    assert.strictEqual(cardAfter.column, 'working');

    // idempotent: resume re-attaches the SAME brief uri, no duplicate entry
    assert.deepStrictEqual(cardAfter.attributes.artifacts, [{ uri: briefUri, label: 'brief', type: 'markdown' }]);

    // resume with no recorded worker refuses
    await s.api('POST', '/api/cards', withOwner({ title: 'Fresh', id: 'fresh', attributes: { repo: 'proj' } }));
    r = await s.api('POST', '/api/cards/fresh/start', { resume: true });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /nothing to resume/);
  } finally { await teardown(); }
});

test('worker send: delivers into the live worker session + level-2 card event; loud errors when it cannot', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    const wsArgs = ['--workspace', s.dir, '--port', String(s.port)];

    // no worker bound → clear error, API and CLI
    await s.api('POST', '/api/cards', withOwner({ title: 'Steer', id: 'steer', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/steer/worker/send', { text: 'too early' });
    assert.strictEqual(r.status, 404);
    assert.match(r.body.error, /no worker bound/);
    let cli = await runCli(['worker', 'send', 'steer', 'too early', ...wsArgs]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /no worker bound/);

    // live worker → text typed into its window (the fake logs sends), event recorded
    assert.strictEqual((await s.api('POST', '/api/cards/steer/start', { harness: 'fake' })).status, 200);
    const sess = workerKey(s.dir, 'steer');
    cli = await runCli(['worker', 'send', 'steer', 'also fix the flaky test', ...wsArgs]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /sent -> worker /);
    const sends = fs.readFileSync(path.join(fdir, sess + '.sends.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(sends.map((x) => x.text), ['also fix the flaky test']);
    const card = (await s.api('GET', '/api/cards/steer')).body;
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.kind, 'worker-send');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /also fix the flaky test/);

    // empty text rejected
    assert.strictEqual((await s.api('POST', '/api/cards/steer/worker/send', { text: '  ' })).status, 400);
  } finally { await teardown(); }
});

test('worker send reopens a done-but-alive worker: turn re-enters Working, record reset, text delivered', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    // reworked in place: the playbook keeps the worktree, so there is still a
    // checkout for the reopened turn to write in
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Reopen', id: 'reopen', playbook: 'kept', attributes: { repo: 'proj' },
    }));
    assert.strictEqual((await s.api('POST', '/api/cards/reopen/start', { harness: 'fake' })).status, 200);
    const sess = workerKey(s.dir, 'reopen');

    // worker finishes; the lieutenant hands off, so the card leaves Working
    await s.api('POST', '/api/cards/reopen/worker/done', { outcome: 'first pass done' });
    await s.api('POST', '/api/cards/reopen/move', { column: 'review', actor: 'agent' });
    assert.strictEqual(boardOnDisk(s).workers[0].done, true);

    // its session is still alive+idle → a send reopens the turn in place (no 409)
    const r = await s.api('POST', '/api/cards/reopen/worker/send', { text: 'one more pass: add tests' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // the record is reset exactly like a resume; the card is back in Working
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].done, false);
    assert.strictEqual(disk.workers[0].outcome, undefined);
    const card = (await s.api('GET', '/api/cards/reopen')).body;
    assert.strictEqual(card.column, 'working');
    // a level-2 reopen event, then the send event
    const reopened = card.events.find((e) => e.kind === 'started' && /reopened for a new turn/.test(e.text));
    assert.ok(reopened, 'reopen event recorded');
    assert.match(reopened.text, /👀 Your review → 🔨 Working/);
    const sendEv = card.events[card.events.length - 1];
    assert.strictEqual(sendEv.kind, 'worker-send');
    assert.match(sendEv.text, /add tests/);

    // the text really reached the session (the fake logs sends)
    const sends = fs.readFileSync(path.join(fdir, sess + '.sends.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(sends.map((x) => x.text), ['one more pass: add tests']);
  } finally { await teardown(); }
});

test('worker send on a done-but-DEAD worker still 409s and names the resume recipe', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Gone', id: 'gone', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/gone/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/gone/worker/done', { outcome: 'done' });

    // the session dies (restart clears the in-process fake; drop its marker so
    // cross-process alive() flips false) — done stays true on disk
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'gone') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });

    const r = await s.api('POST', '/api/cards/gone/worker/send', { text: 'come back' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /card start gone --resume/);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card start --resume refuses a brief and points at worker send (API + CLI)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Rez', id: 'rez', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/rez/start', { harness: 'fake' });
    const r = await s.api('POST', '/api/cards/rez/start', { resume: true, brief: 'new instructions' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /worker send rez/);
    // the CLI refuses loudly before even reaching the server
    const bf = path.join(s.dir, 'brief.md');
    fs.writeFileSync(bf, 'new instructions');
    const cli = await runCli(['card', 'start', 'rez', '--resume', '--brief-file', bf,
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /worker send rez/);
  } finally { await teardown(); }
});
