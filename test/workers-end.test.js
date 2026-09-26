'use strict';
// The end of a worker's life: the handoff out of Working kills it and releases
// its worktree, archive is the backstop, and a restart must prove the old pane
// is gone. A kill or release that cannot be verified keeps the record, loudly.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, sleep } = require('./helper');
const { workerKey, git, makeRepo, boot, boardOnDisk, writeFakeTreehouse, writePlaybook, until, cardEvents, rx } = require('./workers-helper');

test('fresh restart after done: refuses over a live session; releases the dead one\'s worktree and reprovisions', async () => {
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
    // keep_worktree: the checkout outlives the handoff, so the RESTART is what
    // releases it — the subject of this test
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Redo', id: 'redo', playbook: 'kept', attributes: { repo: 'proj' },
    }));
    const first = (await s.api('POST', '/api/cards/redo/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/redo/worker/done', { outcome: 'first pass done' });
    // lieutenant hands off, captain sends it back — the card leaves Working
    await s.api('POST', '/api/cards/redo/move', { column: 'review', actor: 'agent' });

    // the old session is still alive and its worktree is right there → never
    // spawned over (the one exception is a done worker whose worktree was
    // already released — it has nothing left to steer)
    let r = await s.api('POST', '/api/cards/redo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /still alive/);

    // the session dies (server restart clears the in-process fake; drop its
    // cross-process marker too), then a fresh start reprovisions
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'redo') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });
    r = await s.api('POST', '/api/cards/redo/start', { harness: 'fake', brief: 'redo it with tests' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // released-then-reprovisioned: the clone still has exactly ONE linked
    // worktree (the release really ran — a second add at the same path would
    // have failed otherwise), and it is the new worker's
    const clone = path.join(wsDir, 'projects', 'proj');
    const wtList = git(clone, 'worktree', 'list').split('\n').filter(Boolean);
    assert.strictEqual(wtList.length, 2, 'clone + exactly one linked worktree:\n' + wtList.join('\n'));
    assert.ok(fs.existsSync(r.body.worker.worktree.path), 'new worktree provisioned');
    assert.strictEqual(r.body.worker.worktree.path, first.worktree.path, 'same deterministic path reused');
    assert.match(JSON.parse(fs.readFileSync(path.join(fdir, workerKey(wsDir, 'redo') + '.json'), 'utf8')).prompt, /redo it with tests/);
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers.filter((w) => w.card === 'redo').length, 1, 'one registry entry per card');
    assert.strictEqual(disk.workers.find((w) => w.card === 'redo').done, false);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A worktree outlived the work: card.start provisions one and nothing gave it
// back until somebody archived the card, so finished cards sat on their
// checkouts. It goes when the card LEAVES WORKING — the handoff, once the
// lieutenant has read the diff in it — with archive as the backstop, and
// `keep_worktree: true` as the exception for a card reworked in place.
test('the handoff releases the worktree — `worker done` leaves it for the lieutenant to read', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Ship it', id: 'goes', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/goes/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/goes/worker/done', { outcome: 'shipped' });
    await sleep(400);
    assert.ok(fs.existsSync(w.worktree.path),
      'done starts the lieutenant\'s half: verifying the work means reading the diff in there');

    // the handoff out of Working is the end of the work — the move answers as
    // soon as the card has left, and the release follows on the timeline
    assert.strictEqual((await s.api('POST', '/api/cards/goes/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('worktree released after the handoff', async () => !fs.existsSync(w.worktree.path));
    const ev = await until('the timeline says the worktree went',
      async () => (await cardEvents(s, 'goes')).find((e) => /worktree released/.test(e.text)));
    assert.match(ev.text, rx(w.worktree.path));
    await until('the attribute stops pointing at a directory that is gone',
      async () => (await s.api('GET', '/api/cards/goes')).body.attributes.worktree === undefined);
    // the clone knows too: a stale registration would block the next add
    assert.strictEqual(git(path.join(s.dir, 'projects', 'proj'), 'worktree', 'list').split('\n').filter(Boolean).length, 1);
  } finally { await teardown(); }
});

// ...and it does NOT wait for it. The release queues behind the per-clone lock,
// which a concurrent `card start` holds across `git fetch` + `git worktree add`
// — seconds, minutes on a big repo. The move used to sit inside that wait with
// the card still visibly in Working, which reads as a frozen board.
test('a concurrent start holding the clone lock does not hold up the move', async () => {
  const { s, teardown } = await boot();
  try {
    const proj = path.join(s.dir, 'projects', 'proj');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Handed off', id: 'handoff', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/handoff/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/handoff/worker/done', { outcome: 'shipped' });

    // a fetch that takes its time, so the lock is provably still held when the
    // move arrives (the fetch fails after it; freshBase falls back to origin/HEAD)
    git(proj, 'config', 'protocol.ext.allow', 'always');
    git(proj, 'remote', 'set-url', 'origin', 'ext::sleep 4');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Next one', id: 'slowstart', attributes: { repo: 'proj' },
    }));
    const starting = s.api('POST', '/api/cards/slowstart/start', { harness: 'fake' });
    await sleep(300); // the start is inside the fetch by now, holding the lock

    const t0 = Date.now();
    const mv = await s.api('POST', '/api/cards/handoff/move', { column: 'review', actor: 'agent' });
    const took = Date.now() - t0;
    assert.strictEqual(mv.status, 200, JSON.stringify(mv.body));
    assert.ok(took < 1500, 'the move answered in ' + took + 'ms — it queued behind the lock');
    assert.strictEqual((await s.api('GET', '/api/cards/handoff')).body.column, 'review');

    assert.strictEqual((await starting).status, 200);
    await until('the release lands once the lock frees', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('`keep_worktree: true` survives the handoff; archiving releases it anyway', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'reworked', ['---', 'keep_worktree: true', '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rework in place', id: 'stays', playbook: 'reworked', attributes: { repo: 'proj' },
    }));
    const k = (await s.api('POST', '/api/cards/stays/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(k.keepWorktree, true);
    await s.api('POST', '/api/cards/stays/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/stays/move', { column: 'review', actor: 'agent' });
    assert.ok(fs.existsSync(k.worktree.path), 'kept: this card is expected to be reworked in place');
    assert.strictEqual((await s.api('GET', '/api/cards/stays')).body.attributes.worktree, k.worktree.path);

    // archive is the backstop, and it never keeps: nothing is left to rework
    assert.strictEqual((await s.api('POST', '/api/cards/stays/archive', { reason: 'killed' })).status, 200);
    await until('worktree released at archive', async () => !fs.existsSync(k.worktree.path));
  } finally { await teardown(); }
});

test('a worker that never reported done keeps its worktree AND its session through the move', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Moved out from under it', id: 'live', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/live/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/live/move', { column: 'review', actor: 'agent' });
    await sleep(400);
    assert.ok(fs.existsSync(w.worktree.path),
      'a card moved out from under a live or crashed worker: that checkout is still the only copy');
    assert.ok(fs.existsSync(path.join(fdir, workerKey(s.dir, 'live') + '.json')),
      'and so is the conversation in it');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'live'));
  } finally { await teardown(); }
});

test('a dirty worktree survives the handoff, and the timeline says why', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Left work behind', id: 'dirty', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dirty/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(w.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/dirty/worker/done', { outcome: 'done, sort of' });

    await s.api('POST', '/api/cards/dirty/move', { column: 'review', actor: 'agent' });
    const ev = await until('the refusal is on the timeline',
      async () => (await cardEvents(s, 'dirty')).find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /uncommitted changes/); // the reason
    assert.match(ev.text, rx(w.worktree.path)); // the path
    assert.strictEqual(ev.level, 2, 'a refused release is not an alarm');
    assert.ok(fs.existsSync(path.join(w.worktree.path, 'unsaved.txt')), 'nothing was discarded');
    assert.strictEqual((await s.api('GET', '/api/cards/dirty')).body.attributes.worktree, w.worktree.path);
  } finally { await teardown(); }
});

// A worktree is created DETACHED and the branch is cut inside it, so a run that
// commits without cutting one is referenced by this HEAD and nothing else —
// removing it would drop the commits. Same rule as the dirty check, same reason.
test('commits on a HEAD no ref holds keep the worktree, exactly like uncommitted changes', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'no-branch', ['---', 'branch: false', '---', 'read only', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Committed on detached HEAD', id: 'dangling', playbook: 'no-branch', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dangling/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(git(w.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
    fs.writeFileSync(path.join(w.worktree.path, 'notes.md'), 'findings\n');
    git(w.worktree.path, 'add', '.');
    git(w.worktree.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
    const sha = git(w.worktree.path, 'rev-parse', 'HEAD');
    await s.api('POST', '/api/cards/dangling/worker/done', { outcome: 'committed, no branch' });

    await s.api('POST', '/api/cards/dangling/move', { column: 'review', actor: 'agent' });
    const ev = await until('the refusal is on the timeline',
      async () => (await cardEvents(s, 'dangling')).find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /no branch or tag holds/);
    assert.match(ev.text, rx(sha.slice(0, 8)));
    assert.strictEqual(git(w.worktree.path, 'rev-parse', 'HEAD'), sha, 'the commit is still reachable');
  } finally { await teardown(); }
});

test('archiving a card whose worktree is already gone is a no-op, not an error', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Twice released', id: 'twice', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/twice/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/twice/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/twice/move', { column: 'review', actor: 'agent' });
    await until('released at the handoff', async () => !(await s.api('GET', '/api/cards/twice')).body.attributes.worktree);
    assert.ok(!fs.existsSync(w.worktree.path));

    const r = await s.api('POST', '/api/cards/twice/archive', { reason: 'killed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await sleep(400);
    const evs = (await s.api('GET', '/api/board')).body.events.filter((e) => e.card === 'twice');
    assert.deepStrictEqual(evs.filter((e) => /worktree/.test(e.text)), [], 'nothing happened, nothing said');
  } finally { await teardown(); }
});

// MNC-114 — the handoff is the worker's DEATH. Your review is the standing-room
// column and the captain is the bottleneck, so every card waiting there used to
// pin one idle agent process for the whole wait, answering nothing: rework after
// a handoff is a fresh start by the DNA's own rule.
test('the handoff kills the worker: no window, no record, and the card keeps the run\'s address', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Handed off for good', id: 'dies', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dies/start', { harness: 'fake' })).body.worker;
    const marker = path.join(fdir, workerKey(s.dir, 'dies') + '.json');
    assert.ok(fs.existsSync(marker), 'the window is up while the card is Working');
    const resumeId = JSON.parse(fs.readFileSync(marker, 'utf8')).resumeId;
    assert.ok(resumeId);

    await s.api('POST', '/api/cards/dies/worker/done', { outcome: 'shipped' });
    await sleep(300);
    assert.ok(fs.existsSync(marker), 'done alone never kills it — the lieutenant still has questions');

    assert.strictEqual((await s.api('POST', '/api/cards/dies/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('the worker window is gone', async () => !fs.existsSync(marker));
    await until('and so is its registry record',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'dies'));
    const ev = await until('the timeline says the worker was closed',
      async () => (await cardEvents(s, 'dies')).find((e) => /worker .* closed/.test(e.text)));
    assert.strictEqual(ev.level, 2, 'an expected death is not an alarm');

    // what outlives the record: the card's own address for the run, so the
    // transcript stays readable long after the window is gone
    const card = (await s.api('GET', '/api/cards/dies')).body;
    assert.strictEqual(card.attributes.session, workerKey(s.dir, 'dies'));
    assert.strictEqual(card.attributes.resumeId, resumeId);

    // and it rides the archive snapshot, which is where forensics look
    assert.strictEqual((await s.api('POST', '/api/cards/dies/archive', { reason: 'merged' })).status, 200);
    const arch = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'dies');
    assert.strictEqual(arch.card.attributes.resumeId, resumeId);
    assert.ok(!fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

// Archiving straight out of Working takes the other order: archiveCard freezes
// the card into the snapshot synchronously, while the kill and the drop are
// detached and land when there is no card left to stamp. The address has to be
// on the card BEFORE the freeze, or the transcript is unfindable afterwards.
test('a card archived straight out of Working still carries the run\'s address into the snapshot', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Killed mid-flight', id: 'midair', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/midair/start', { harness: 'fake' })).body.worker;
    const marker = path.join(fdir, workerKey(s.dir, 'midair') + '.json');
    const resumeId = JSON.parse(fs.readFileSync(marker, 'utf8')).resumeId;
    assert.ok(resumeId);

    assert.strictEqual((await s.api('POST', '/api/cards/midair/archive', { reason: 'killed' })).status, 200);
    const arch = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'midair');
    assert.strictEqual(arch.card.attributes.session, workerKey(s.dir, 'midair'));
    assert.strictEqual(arch.card.attributes.resumeId, resumeId);

    // and the archive is still the backstop for everything the handoff would
    // have done: the window goes, its record with it, and the ground after
    await until('the window is gone', async () => !fs.existsSync(marker));
    await until('and its registry record',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'midair'));
    await until('and the worktree released', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

// Both ways back into a finished worker name the same way out — a fresh worker —
// instead of failing somewhere deep inside the harness on a session that is gone.
test('after the handoff, resume and worker send both refuse and point at a fresh start', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'No way back', id: 'noback', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/noback/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/noback/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/noback/move', { column: 'review', actor: 'agent' });
    await until('the record is gone',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'noback'));
    // the record goes with the window; the worktree follows behind the clone lock
    await until('and the worktree with it', async () => !fs.existsSync(w.worktree.path));

    const send = await s.api('POST', '/api/cards/noback/worker/send', { text: 'one more thing' });
    assert.strictEqual(send.status, 404, JSON.stringify(send.body));
    assert.match(send.body.error, /no worker bound to card noback/);
    assert.match(send.body.error, /card start noback/);

    const res = await s.api('POST', '/api/cards/noback/start', { resume: true });
    assert.match(res.body.error, /nothing to resume/);
    assert.match(res.body.error, /card start noback/);

    // and the way out both refusals name really is one
    const fresh = await s.api('POST', '/api/cards/noback/start', { harness: 'fake' });
    assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
    assert.ok(fs.existsSync(fresh.body.worker.worktree.path), 'a new worktree, at the same deterministic path');
    assert.strictEqual((await s.api('GET', '/api/cards/noback')).body.column, 'working');
  } finally { await teardown(); }
});

// The exceptions are the worktree release's, and for the same reason: a card
// reworked in place needs the conversation as much as the checkout.
test('`keep_worktree: true` keeps the worker alive through the handoff, worktree and all', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    writePlaybook(s, 'reworked', ['---', 'keep_worktree: true', '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rework in place', id: 'kept', playbook: 'reworked', attributes: { repo: 'proj' },
    }));
    const k = (await s.api('POST', '/api/cards/kept/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/kept/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/kept/move', { column: 'review', actor: 'agent' });
    await sleep(400);
    const marker = path.join(fdir, workerKey(s.dir, 'kept') + '.json');
    assert.ok(fs.existsSync(marker), 'the session is half of what keep_worktree keeps');
    assert.ok(fs.existsSync(k.worktree.path));
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'kept'));

    // and a send still reopens it in place — the whole point of the exception
    const send = await s.api('POST', '/api/cards/kept/worker/send', { text: 'one more pass' });
    assert.strictEqual(send.status, 200, JSON.stringify(send.body));
    assert.strictEqual((await s.api('GET', '/api/cards/kept')).body.column, 'working');
  } finally { await teardown(); }
});

// The record is the only handle anyone has on a live agent process, so it is
// dropped ONLY by a path that watched the pane go. A kill that cannot be
// verified keeps the record and rings the captain — a session nothing points at
// is worse than the idle one this whole change exists to end.
test('a worker the board cannot kill keeps its record, loudly', async () => {
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
      title: 'Undead', id: 'undead', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/undead/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/undead/worker/done', { outcome: 'done' });

    // a harness this server has no implementation for: the kill throws, so the
    // pane can never be shown to be gone
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((w) => w.card === 'undead').ref.harness = 'ghost';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    assert.strictEqual((await s.api('POST', '/api/cards/undead/move', { column: 'review', actor: 'agent' })).status, 200);
    const ev = await until('the failed kill is on the timeline',
      async () => (await cardEvents(s, 'undead')).find((e) => e.kind === 'worker-kill-failed'));
    assert.strictEqual(ev.level, 1, 'a session nobody can reach is the captain\'s problem');
    assert.match(ev.text, /could NOT be killed/);
    assert.match(ev.text, /unknown harness/);
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'undead'),
      'the record is kept: it is the only thing pointing at that session');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `not released` has to mean exactly that. releaseCardWorktree answers null both
// when it REFUSED nothing (no clone to release against) and from its own
// catch-all — neither is proof the checkout went — so a null must keep the
// record, which is the only handle left on that unreleased ground.
test('a handoff whose release could not run keeps the record', async () => {
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
    await s.api('POST', '/api/cards', withOwner({
      title: 'Nowhere to release', id: 'noclone', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/noclone/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/noclone/worker/done', { outcome: 'shipped' });

    // the clone this worktree belongs to is no longer registered: the release
    // has nothing to release AGAINST, and says so by doing nothing at all
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((x) => x.card === 'noclone').project = 'vanished';
    doc.cards.find((c) => c.id === 'noclone').attributes.repo = 'vanished';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    assert.strictEqual((await s.api('POST', '/api/cards/noclone/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('the window is gone all the same',
      async () => !fs.existsSync(path.join(fdir, workerKey(wsDir, 'noclone') + '.json')));
    await sleep(400);
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'noclone'),
      'the record is the only handle left on ground nothing released');
    assert.ok(fs.existsSync(w.worktree.path), 'and the checkout is still standing');
    assert.strictEqual((await s.api('GET', '/api/cards/noclone')).body.attributes.worktree, w.worktree.path);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `session` and `resumeId` are ONE address. A restart binds a new worker, so it
// rewrites both — a fresh session name beside the previous run's transcript id
// sends forensics to the wrong conversation, and nothing fails to say so.
test('a rework restart replaces the address, resumeId included', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Twice run', id: 'twicerun', attributes: { repo: 'proj' },
    }));
    const first = (await s.api('POST', '/api/cards/twicerun/start', { harness: 'fake' })).body.worker;
    assert.strictEqual((await s.api('GET', '/api/cards/twicerun')).body.attributes.resumeId,
      first.ref.resumeId, 'the address is current from the spawn on');

    await s.api('POST', '/api/cards/twicerun/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/twicerun/move', { column: 'review', actor: 'agent' });
    await until('the handoff ended the worker and dropped its record',
      async () => !fs.existsSync(path.join(fdir, workerKey(s.dir, 'twicerun') + '.json'))
        && ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'twicerun'));
    assert.strictEqual((await s.api('GET', '/api/cards/twicerun')).body.attributes.resumeId,
      first.ref.resumeId, 'and left the ended run as the last address');

    const r2 = await s.api('POST', '/api/cards/twicerun/start', { harness: 'fake' });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    const second = r2.body.worker;
    assert.notStrictEqual(second.ref.resumeId, first.ref.resumeId);
    const card = (await s.api('GET', '/api/cards/twicerun')).body;
    assert.strictEqual(card.attributes.session, workerKey(s.dir, 'twicerun'));
    assert.strictEqual(card.attributes.resumeId, second.ref.resumeId,
      'the card advertises THIS run, not the one before it');
  } finally { await teardown(); }
});

// A pooled lease `treehouse return` refused is STILL HELD by the pool. Taking
// the directory back with git behind its back would report a release that never
// happened: the checkout is gone, the lease is outstanding and unreturnable,
// and the record that was the board's last handle on it is dropped. Refusing is
// the same feature a dirty worktree gets — the ground stays and the timeline
// says why.
test('a pooled lease whose return is refused is KEPT, not taken back with git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-refuse-'));
  try {
    const repo = makeRepo(root);
    const wsDir = path.join(root, 'ws');
    fs.mkdirSync(wsDir);
    // the pool is backed by the board's OWN clone here, which is the case that
    // makes a git fallback silently succeed — treehouse keeps one pool per
    // repository, and it may well be the clone this board registered
    const bin = writeFakeTreehouse(root, path.join(wsDir, 'projects', 'proj'));
    const s = await startServerWithLieutenant({
      dir: wsDir,
      env: {
        BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'treehouse',
        PATH: bin + path.delimiter + process.env.PATH,
        BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
      },
    });
    try {
      assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
      await s.api('POST', '/api/cards', withOwner({
        title: 'Pooled', id: 'leased', attributes: { repo: 'proj' },
      }));
      const r = await s.api('POST', '/api/cards/leased/start', { harness: 'fake' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const w = r.body.worker;
      assert.strictEqual(w.worktree.tool, 'treehouse');
      await s.api('POST', '/api/cards/leased/worker/done', { outcome: 'shipped' });

      fs.writeFileSync(path.join(root, 'pool', '.refuse'), ''); // the pool says no
      await s.api('POST', '/api/cards/leased/move', { column: 'review', actor: 'agent' });

      const ev = await until('the refusal is on the timeline',
        async () => (await cardEvents(s, 'leased')).find((e) => /worktree kept/.test(e.text)));
      assert.match(ev.text, /pool lock held/, 'the reason the pool gave');
      assert.match(ev.text, rx(w.worktree.path));
      assert.ok(fs.existsSync(w.worktree.path), 'the lease was NOT taken back behind treehouse\'s back');
      assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'leased'),
        'and the record is kept as the last handle on it');
      assert.strictEqual((await s.api('GET', '/api/cards/leased')).body.attributes.worktree, w.worktree.path);
    } finally { await s.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The release points read the same pointer the start does, and the same rule
// holds there: the worker RECORD is the ownership claim, a card attribute is
// only a pointer. `card.restore` replays a frozen snapshot verbatim, so a card
// can come back naming ground that has since been handed to somebody else —
// and archiving it must not take that ground back.
test('archiving a card whose stale pointer names another card\'s live checkout keeps it', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Working on it', id: 'onit', attributes: { repo: 'proj' } }));
    const live = (await s.api('POST', '/api/cards/onit/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards', withOwner({ title: 'Back from the dead', id: 'revived', attributes: { repo: 'proj' } }));

    // what a restored snapshot brings back: a pointer with no record behind it,
    // at ground another card's worker is standing on
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'revived').attributes.worktree = live.worktree.path;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    assert.strictEqual((await s.api('POST', '/api/cards/revived/archive', { reason: 'killed' })).status, 200);
    const ev = await until('the refusal is on the board stream', async () =>
      ((await s.api('GET', '/api/board')).body.events || [])
        .filter((e) => e.card === 'revived').find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /onit/, 'the refusal names who holds it');
    assert.match(ev.text, rx(live.worktree.path));
    assert.strictEqual(ev.level, 2);
    assert.ok(fs.existsSync(live.worktree.path), 'the live worker keeps its ground');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'onit'));
    assert.strictEqual((await s.api('GET', '/api/cards/onit')).body.attributes.worktree, live.worktree.path);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A record whose worktree is marked RELEASED has already given that ground
// back, so it has stopped being a claim on it — a pool hands the slot to
// whoever asks next. The record can outlive its release when the kill could not
// be verified, and archiving that card must not take the path back a second
// time, now that somebody else is standing on it.
test('a kept record whose worktree was already released does not take it back', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Standing on it', id: 'liveone', attributes: { repo: 'proj' } }));
    const live = (await s.api('POST', '/api/cards/liveone/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards', withOwner({ title: 'Gave it back', id: 'gaveback', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/gaveback/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/gaveback/worker/done', { outcome: 'shipped' });

    // gaveback's release LANDED (worktree marked released, pointer gone) but its
    // kill could not be verified, so the record was kept — and the ground it
    // names has since been handed to liveone's live worker
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = doc.workers.find((x) => x.card === 'gaveback');
    w.ref.harness = 'ghost';
    w.worktree.path = live.worktree.path;
    w.worktree.released = true;
    delete doc.cards.find((c) => c.id === 'gaveback').attributes.worktree;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    assert.strictEqual((await s.api('POST', '/api/cards/gaveback/archive', { reason: 'killed' })).status, 200);
    const ev = await until('the refusal is on the board stream', async () =>
      ((await s.api('GET', '/api/board')).body.events || [])
        .filter((e) => e.card === 'gaveback').find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /liveone/, 'the refusal names who holds it now');
    assert.match(ev.text, rx(live.worktree.path));
    assert.strictEqual(ev.level, 2);
    assert.ok(fs.existsSync(live.worktree.path), 'the live worker keeps its ground');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'liveone'));
    assert.strictEqual((await s.api('GET', '/api/cards/liveone')).body.attributes.worktree, live.worktree.path);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// alive() answering false does not mean there is nothing left to end. On both
// tmux harnesses it goes false the moment the agent process exits — the window
// it ran in is still standing there at a shell, and the kill is the only thing
// that takes it away. So the kill runs on every path; what the pre-check
// decides is only whether there was a live session to ANNOUNCE the closing of.
test('the handoff still closes the window of a worker whose agent exited by itself', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Walked out', id: 'walkedout', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/walkedout/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/walkedout/worker/done', { outcome: 'shipped' });

    // the agent ends by itself (crash, /exit) — its window stays up at a shell,
    // which is what the marker still being there means
    await s.stop();
    const marker = path.join(fdir, workerKey(wsDir, 'walkedout') + '.json');
    const rec = JSON.parse(fs.readFileSync(marker, 'utf8'));
    rec.exited = true;
    fs.writeFileSync(marker, JSON.stringify(rec, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    assert.ok(fs.existsSync(marker), 'the window is up going in');

    await s.api('POST', '/api/cards/walkedout/move', { column: 'review', actor: 'agent' });
    await until('the handoff retired the record', async () =>
      ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'walkedout'));

    assert.ok(!fs.existsSync(marker), 'the leftover window was really closed');
    assert.ok(!fs.existsSync(w.worktree.path), 'and the ground went with it');
    assert.strictEqual((await cardEvents(s, 'walkedout')).filter((e) => /worker .* closed/.test(e.text)).length, 0,
      'nothing was live to close, so nothing was announced');
    assert.strictEqual((await cardEvents(s, 'walkedout')).filter((e) => e.kind === 'worker-kill-failed').length, 0,
      'and it was not a failure either');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The same rule the archive and the pointer-only start already obey, at the
// third release point: a record that has RELEASED its worktree is no longer the
// claim on that path, so a restart reading it may be looking at a lease the
// pool has since handed to a live worker on another card.
test('a restart does not release the path another card\'s live worker now holds', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Standing on it', id: 'holder', attributes: { repo: 'proj' } }));
    const live = (await s.api('POST', '/api/cards/holder/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards', withOwner({ title: 'Reworked', id: 'redoit', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/redoit/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/redoit/worker/done', { outcome: 'first pass' });

    // redoit's release LANDED but its record was kept, and the ground it still
    // names has since been leased to holder's live worker. keepWorktree keeps
    // the boot sweep off the record — the restart is what reads it next.
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'redoit') + '.json'));
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = doc.workers.find((x) => x.card === 'redoit');
    w.keepWorktree = true;
    w.worktree.path = live.worktree.path;
    w.worktree.released = true;
    const card = doc.cards.find((c) => c.id === 'redoit');
    card.column = 'review';
    delete card.attributes.worktree;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    const r = await s.api('POST', '/api/cards/redoit/start', { harness: 'fake' });
    assert.ok(fs.existsSync(live.worktree.path), 'the live worker keeps its ground');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /holder/, 'the refusal names who holds it now');
    assert.match(r.body.error, rx(live.worktree.path));
    assert.strictEqual((await s.api('GET', '/api/cards/holder')).body.attributes.worktree, live.worktree.path);
    assert.strictEqual((await s.api('GET', '/api/cards/redoit')).body.column, 'review', 'and the card did not start');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The restart is the other path that DROPS a record, so it owes the same proof
// the handoff does — and alive() answering false is not it. A `keep_worktree`
// worker whose agent exited by itself leaves its window standing at a shell:
// nothing on the board would point at it once the record went, and the next
// spawn would collide with it forever.
test('a restart over a worker whose agent exited by itself closes the window first', async () => {
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
    // keep_worktree, so the handoff leaves the worker standing — the one way a
    // record reaches a restart with its window still up
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Walked out', id: 'walkout', playbook: 'kept', attributes: { repo: 'proj' },
    }));
    const first = (await s.api('POST', '/api/cards/walkout/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/walkout/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/walkout/move', { column: 'review', actor: 'agent' });

    // the agent ends by itself; the window it ran in is still there
    await s.stop();
    const marker = path.join(fdir, workerKey(wsDir, 'walkout') + '.json');
    const rec = JSON.parse(fs.readFileSync(marker, 'utf8'));
    rec.exited = true;
    fs.writeFileSync(marker, JSON.stringify(rec, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    const r = await s.api('POST', '/api/cards/walkout/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.notStrictEqual(r.body.worker.ref.resumeId, first.ref.resumeId, 'a fresh run took the window');
    assert.strictEqual((await s.api('GET', '/api/cards/walkout')).body.column, 'working');
    const ws = (await s.api('GET', '/api/board')).body.workers.filter((x) => x.card === 'walkout');
    assert.strictEqual(ws.length, 1, 'one record per card');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The record is dropped only by a path that WATCHED the pane go, and a harness
// that could not look has not watched anything. An alive() that throws is that
// answer — the handoff keeps the record and rings, rather than retiring the
// handle on a session that turns out to still be running.
test('a handoff whose liveness read fails keeps the record and rings once', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Unread', id: 'unread', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/unread/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/unread/worker/done', { outcome: 'shipped' });

    // the harness goes unreadable — not "the pane is gone", but "I could not look"
    await s.stop();
    const marker = path.join(fdir, workerKey(wsDir, 'unread') + '.json');
    const rec = JSON.parse(fs.readFileSync(marker, 'utf8'));
    rec.unreadable = true;
    fs.writeFileSync(marker, JSON.stringify(rec, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    await s.api('POST', '/api/cards/unread/move', { column: 'review', actor: 'agent' });
    const bells = async () => (await cardEvents(s, 'unread')).filter((e) => e.kind === 'worker-kill-failed');
    const bell = await until('the unverified kill rings', async () => (await bells())[0]);
    assert.strictEqual(bell.level, 1);
    assert.match(bell.text, rx(workerKey(wsDir, 'unread')), 'the session to end by hand is named');
    assert.ok(fs.existsSync(marker), 'the session nobody could read is still there');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'unread'),
      'and the only handle on it survives the handoff');
    assert.strictEqual((await bells()).length, 1, 'the bell rings once');

    // …and once tmux answers honestly that the window is gone, the record the
    // unread answer preserved is retired cleanly
    await until('the release landed even though the kill did not', async () =>
      (await cardEvents(s, 'unread')).some((e) => /worktree released/.test(e.text)));
    await s.stop();
    fs.rmSync(marker);
    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the boot sweep retired it now that the answer is an answer', async () =>
      ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'unread'));
    assert.strictEqual((await s.api('GET', '/api/cards/unread')).body.attributes.session,
      workerKey(wsDir, 'unread'), 'the address stays on the card');
    assert.ok(!fs.existsSync(w.worktree.path), 'and the ground went back');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// killCardWorker answers `null` for "there was nothing to do" — the record
// stopped being this card's — and `{killed:false}` for "I could not end that
// pane". Only the second is a reason to refuse a start. The first is routine:
// the handoff's teardown runs detached on a five-minute budget, so a rework
// start issued into that window looks up a record that retires mid-flight, and
// reading that as an unkillable pane sends the lieutenant to close a window
// that closed minutes ago.
test('a restart that races its own record retiring starts instead of refusing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const inFile = path.join(root, 'teardown-in');
  const goFile = path.join(root, 'teardown-go');
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    // the liveness read is two tmux round-trips on the real harness; the
    // registry moves underneath it, which is the whole race
    BC_FAKE_ALIVE_MS: '1500',
  };
  const s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    writePlaybook(s, 'slowdown', ['---',
      'teardown: touch ' + inFile + '; while [ ! -f ' + goFile + ' ]; do sleep 0.05; done',
      '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Raced retire', id: 'racy', playbook: 'slowdown', attributes: { repo: 'proj' },
    }));
    const first = (await s.api('POST', '/api/cards/racy/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/racy/worker/done', { outcome: 'first pass' });

    // the handoff: the window goes at once, the record waits on the teardown
    await s.api('POST', '/api/cards/racy/move', { column: 'review', actor: 'agent' });
    await until('the handoff is inside the teardown', async () => fs.existsSync(inFile));
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'racy'),
      'the record is still there when the restart looks it up');

    // the rework start goes in while the record is still listed…
    const started = s.api('POST', '/api/cards/racy/start', { harness: 'fake' });
    await sleep(200);
    // …and the teardown finishes under it: release lands, record retired
    fs.writeFileSync(goFile, 'x');

    const r = await started;
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.notStrictEqual(r.body.worker.ref.resumeId, first.ref.resumeId, 'a fresh run');
    assert.strictEqual((await s.api('GET', '/api/cards/racy')).body.column, 'working');
    const ws = (await s.api('GET', '/api/board')).body.workers.filter((x) => x.card === 'racy');
    assert.strictEqual(ws.length, 1, 'one record per card');
    assert.ok(fs.existsSync(r.body.worker.worktree.path), 'and it has ground of its own');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The pointer-only state — a card still naming a checkout with no worker record
// behind it — is what a handoff leaves when its release never landed (the board
// restarted mid-release, or the boot sweep retired the record without touching
// ground). The restart releases against that pointer, and the pointer alone has
// to say which TOOL owns the ground: a POOLED lease answered with
// `git worktree remove` is refused forever, and the card can never start again.
test('a restart against a pointer-only POOLED checkout releases it and starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-ptr-'));
  try {
    const repo = makeRepo(root);
    const poolClone = path.join(root, 'poolclone');
    execFileSync('git', ['clone', '-q', repo, poolClone], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bin = writeFakeTreehouse(root, poolClone);
    const wsDir = path.join(root, 'ws');
    fs.mkdirSync(wsDir);
    const env = {
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'treehouse',
      PATH: bin + path.delimiter + process.env.PATH,
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    };
    let s = await startServerWithLieutenant({ dir: wsDir, env });
    try {
      await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
      await s.api('POST', '/api/cards', withOwner({
        title: 'Pooled rework', id: 'poolptr', attributes: { repo: 'proj' },
      }));
      const w = (await s.api('POST', '/api/cards/poolptr/start', { harness: 'fake' })).body.worker;
      assert.strictEqual(w.worktree.tool, 'treehouse');
      await s.api('POST', '/api/cards/poolptr/worker/done', { outcome: 'shipped' });

      // the state a handoff leaves when its release never landed: the window is
      // closed and the record gone, the card still points at the lease
      await s.stop();
      fs.rmSync(path.join(root, 'fake', workerKey(wsDir, 'poolptr') + '.json'));
      const file = path.join(wsDir, '.bridge-commander', 'board.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.cards.find((c) => c.id === 'poolptr').column = 'review';
      doc.workers = doc.workers.filter((x) => x.card !== 'poolptr');
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))
        .cards.find((c) => c.id === 'poolptr').attributes.worktree, w.worktree.path);

      s = await startServerWithLieutenant({ dir: wsDir, env });
      const r = await s.api('POST', '/api/cards/poolptr/start', { harness: 'fake' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await s.api('GET', '/api/cards/poolptr')).body.column, 'working');
    } finally { await s.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A refused release keeps its record ON PURPOSE — that worktree may hold the
// only copy of the work — so the way back into it is still open. The handoff's
// "there is nothing left to reincarnate" is about the record it DROPPED.
test('resume still works after a handoff whose release refused', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Unfinished business', id: 'unfin', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/unfin/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(w.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/unfin/worker/done', { outcome: 'done, sort of' });
    await s.api('POST', '/api/cards/unfin/move', { column: 'review', actor: 'agent' });

    await until('the window is gone all the same', async () => !fs.existsSync(path.join(fdir, workerKey(s.dir, 'unfin') + '.json')));
    await until('the release refused',
      async () => (await cardEvents(s, 'unfin')).some((e) => /worktree kept/.test(e.text)));

    const r = await s.api('POST', '/api/cards/unfin/start', { harness: 'fake', resume: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.worktree.path, w.worktree.path, 'back into the same checkout');
    assert.strictEqual((await s.api('GET', '/api/cards/unfin')).body.column, 'working');
    assert.ok(fs.existsSync(path.join(w.worktree.path, 'unsaved.txt')), 'with the work still in it');
  } finally { await teardown(); }
});

// The restart drops the old record, so it obeys the same verify-then-drop rule
// as the handoff: a pane it cannot show to be gone is a 409, not a second
// worker spawned over a live one that nothing on the board points at.
test('a restart over a pane the board cannot end refuses instead of spawning', async () => {
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
      title: 'Zombie', id: 'zombie', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/zombie/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/zombie/worker/done', { outcome: 'done' });

    // a harness this server has no implementation for: the board can neither
    // read the pane's liveness nor end it, so the handoff kept the record
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((w) => w.card === 'zombie').ref.harness = 'ghost';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    assert.strictEqual((await s.api('POST', '/api/cards/zombie/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('the failed kill is on the timeline',
      async () => (await cardEvents(s, 'zombie')).find((e) => e.kind === 'worker-kill-failed'));

    // the rework move the board teaches — and it must NOT quietly spawn
    const r = await s.api('POST', '/api/cards/zombie/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /could not be ended/);
    assert.match(r.body.error, rx(workerKey(wsDir, 'zombie')));
    assert.match(r.body.error, /by hand/);
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'zombie'),
      'the record stays: it is the only thing pointing at that session');
    assert.notStrictEqual((await s.api('GET', '/api/cards/zombie')).body.column, 'working');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The ring-once mark is about a session the board has stopped being able to
// reach. A worker that has been ALIVE and working since — reopened in place by
// `worker send`, which is how a `keep_worktree` card is reworked — is a
// different story: the next kill it refuses is news, and swallowing it would
// leave the captain with no bell for a live leak.
test('a worker reopened in place rings again when its kill fails a second time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  const file = path.join(wsDir, '.bridge-commander', 'board.json');
  const setHarness = (name) => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((x) => x.card === 'ringagain').ref.harness = name;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  };
  const bells = async (s) => (await cardEvents(s, 'ringagain')).filter((e) => e.kind === 'worker-kill-failed');
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    // keep_worktree: the one card whose worker survives the handoff on purpose,
    // to be reworked in place — so a send still reaches it in review, and the
    // boot sweep leaves it be
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rings again', id: 'ringagain', playbook: 'kept', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/ringagain/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/ringagain/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/ringagain/move', { column: 'review', actor: 'agent' });

    // the board loses its grip on the session: a fresh start cannot end it
    await s.stop(); setHarness('ghost');
    s = await startServerWithLieutenant({ dir: wsDir, env });
    let r = await s.api('POST', '/api/cards/ringagain/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    await until('the first failed kill rings', async () => (await bells(s)).length === 1);

    // the harness answers again, and the lieutenant reopens the turn in place
    await s.stop(); setHarness('fake');
    s = await startServerWithLieutenant({ dir: wsDir, env });
    const send = await s.api('POST', '/api/cards/ringagain/worker/send', { text: 'one more pass' });
    assert.strictEqual(send.status, 200, JSON.stringify(send.body));
    assert.strictEqual((await s.api('GET', '/api/cards/ringagain')).body.column, 'working');
    await s.api('POST', '/api/cards/ringagain/worker/done', { outcome: 'second pass' });
    await s.api('POST', '/api/cards/ringagain/move', { column: 'review', actor: 'agent' });

    // and it goes unreachable again: a NEW failure on a worker that has been
    // alive in between, so the captain hears about it
    await s.stop(); setHarness('ghost');
    s = await startServerWithLieutenant({ dir: wsDir, env });
    r = await s.api('POST', '/api/cards/ringagain/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    await until('the second failed kill rings too', async () => (await bells(s)).length === 2);
    assert.ok((await bells(s)).every((e) => e.level === 1));
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A pointer is not ownership. A frozen snapshot can name a POOLED lease that
// has since been handed to another card, and releasing against it would take a
// live worker's ground out from under it.
test('a start refuses when the worktree its pointer names belongs to another live worker', async () => {
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
    await s.api('POST', '/api/cards', withOwner({ title: 'Holder', id: 'holder', attributes: { repo: 'proj' } }));
    const held = (await s.api('POST', '/api/cards/holder/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards', withOwner({ title: 'Stale pointer', id: 'stale', attributes: { repo: 'proj' } }));

    // what a restored snapshot brings back: a pointer at a checkout that has
    // since been leased to somebody else
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'stale').attributes.worktree = held.worktree.path;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    const r = await s.api('POST', '/api/cards/stale/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /holder/, 'the refusal names who holds it');
    assert.match(r.body.error, rx(held.worktree.path));
    assert.ok(fs.existsSync(held.worktree.path), 'the live worker keeps its ground');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'holder'));
    assert.strictEqual((await s.api('GET', '/api/cards/stale')).body.column, 'backlog');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
