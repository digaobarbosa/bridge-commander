'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('../fake.js');

function tick() {
  return new Promise((r) => setImmediate(r));
}

test.beforeEach(() => fake.reset());

test('spawn creates a live session and emits a turn end', async () => {
  const ref = await fake.spawn('/tmp/x', 'hello');
  assert.strictEqual(ref.harness, 'fake');
  assert.match(ref.session, /^bc-/);
  assert.strictEqual(await fake.alive(ref), true);
  assert.deepStrictEqual(fake.transcript(ref), ['hello']);
});

test('onTurnEnd fires per turn, only after registration, and unsubscribes', async () => {
  const ref = await fake.spawn('/tmp/x', 'p0');
  await tick(); // spawn's own turn end fires before registration — must not be seen
  const events = [];
  const unsub = fake.onTurnEnd(ref, (e) => events.push(e));
  await fake.send(ref, 'm1');
  await fake.send(ref, 'm2');
  await tick();
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event, 'turn-end', 'the TurnEndEvent the real relays emit');
  assert.strictEqual(events[0].session, ref.session);
  unsub();
  await fake.send(ref, 'm3');
  await tick();
  assert.strictEqual(events.length, 2);
});

test('send throws on a dead session', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  fake.kill(ref);
  assert.strictEqual(await fake.alive(ref), false);
  await assert.rejects(() => fake.send(ref, 'hi'), /not alive/);
});

test('resumable: true iff memory would survive a resume', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  assert.strictEqual(await fake.resumable(ref), true);
  fake.kill(ref);
  assert.strictEqual(await fake.resumable(ref), true, 'dead but memory held');
  assert.strictEqual(await fake.resumable({ ...ref, resumeId: 'wrong-id' }), false);
  assert.strictEqual(await fake.resumable({ harness: 'fake', session: 'bc-nobody', cwd: '/x', resumeId: 'z' }), false);
});

test('resume revives with memory when resumeId matches', async () => {
  const ref = await fake.spawn('/tmp/x', 'remember-me');
  await fake.send(ref, 'more');
  fake.kill(ref);
  const ref2 = await fake.resume(ref);
  assert.strictEqual(await fake.alive(ref2), true);
  assert.strictEqual(ref2.resumeId, ref.resumeId);
  assert.deepStrictEqual(fake.transcript(ref2), ['remember-me', 'more']);
});

test('resume without matching memory starts fresh', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  fake.kill(ref);
  const ref2 = await fake.resume({ ...ref, resumeId: 'wrong-id' });
  assert.strictEqual(await fake.alive(ref2), true);
  assert.ok(!('resumeId' in ref2), 'no memory, no id: the next turn-end delivers it, as with a real harness');
  assert.deepStrictEqual(fake.transcript(ref2), []);
});

test('resume on a live session is a no-op returning an equal ref', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  const ref2 = await fake.resume(ref);
  assert.deepStrictEqual(ref2, ref);
});

test('refs are JSON-serializable', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ref)), ref);
});

test('slash commands + status: canned capability verbs (commands/runCommand/status)', async () => {
  const ref = await fake.spawn('/tmp/x', 'hi');
  const cmds = fake.commands();
  assert.deepStrictEqual(cmds.map((c) => c.name), ['/status', '/compact', '/help']);
  for (const c of cmds) assert.ok(c.description, c.name + ' has a description');

  const st = await fake.status(ref);
  assert.deepStrictEqual(st, { model: 'fake-model', contextUsed: 50000, contextWindow: 200000 });

  assert.match(await fake.runCommand(ref, '/status'), /fake-model[\s\S]*50,000 \/ 200,000 tokens \(25%\)/);
  assert.match(await fake.runCommand(ref, '/help'), /\/status[\s\S]*\/compact[\s\S]*\/help/);
  // /compact rides the send path: the literal FULL line (args included) lands
  // in the transcript — pass-through commands forward their arguments
  assert.match(await fake.runCommand(ref, '/compact'), /"\/compact" submitted/);
  assert.match(await fake.runCommand(ref, '/compact focus on the API'), /submitted/);
  assert.deepStrictEqual(fake.transcript(ref), ['hi', '/compact', '/compact focus on the API']);
  await assert.rejects(() => fake.runCommand(ref, '/xyz'), /unknown command/);

  // dead session: status null, /compact refuses (send path throws)
  fake.kill(ref);
  assert.strictEqual(await fake.status(ref), null);
  await assert.rejects(() => fake.runCommand(ref, '/compact'), /not alive/);
  // unknown session: status null too — never a throw
  assert.strictEqual(await fake.status({ harness: 'fake', session: 'bc-ghost', cwd: '/x' }), null);
});

test('status counts a cross-process (marker-file) session as live', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-status-'));
  process.env.BC_FAKE_STATE = dir;
  try {
    fs.writeFileSync(path.join(dir, 'bc-far.json'), JSON.stringify({ cwd: '/tmp', resumeId: null }) + '\n');
    const ref = { harness: 'fake', session: 'bc-far', cwd: '/tmp' };
    assert.deepStrictEqual(await fake.status(ref),
      { model: 'fake-model', contextUsed: 50000, contextWindow: 200000 });
    assert.match(await fake.runCommand(ref, '/status'), /fake-model/);
  } finally {
    delete process.env.BC_FAKE_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kill ends a session for good; idempotent; file-backed marker removed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-kill-'));
  process.env.BC_FAKE_STATE = dir;
  try {
    const ref = await fake.spawn('/tmp/x', 'hi', { session: 'bc-kill-me' });
    const marker = path.join(dir, 'bc-kill-me.json');
    assert.ok(fs.existsSync(marker), 'spawn wrote the marker');
    fake.kill(ref);
    assert.strictEqual(await fake.alive(ref), false);
    assert.ok(!fs.existsSync(marker), 'kill removed the marker (cross-process alive flips false)');
    fake.kill(ref); // idempotent — dead ref is a no-op
    await assert.rejects(() => fake.send(ref, 'nope'), /not alive/);
  } finally {
    delete process.env.BC_FAKE_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The fake models tmux's session/window granularity, because that is what the
// lieutenant/worker cohabitation actually rides on (server supervision tests
// depend on this fidelity — see test/supervise.test.js).
test('session-granular kill takes the whole session; window-granular kill takes one window', async () => {
  const lt = await fake.spawn('/tmp/x', 'lt', { session: 'bc-s' });
  const w1 = await fake.spawn('/tmp/x', 'w1', { session: 'bc-s', window: 'w-1' });
  const w2 = await fake.spawn('/tmp/x', 'w2', { session: 'bc-s', window: 'w-2' });
  fake.kill(w1);
  assert.strictEqual(await fake.alive(w1), false);
  assert.strictEqual(await fake.alive(w2), true, 'a sibling window is untouched');
  fake.kill(lt); // no window: the whole tmux session, every window with it
  assert.strictEqual(await fake.alive(w2), false);
});

test('a session-granular ref reads alive while ANY window of its session lives', async () => {
  const lt = await fake.spawn('/tmp/x', 'lt', { session: 'bc-s' });
  const w = await fake.spawn('/tmp/x', 'w', { session: 'bc-s', window: 'w-1' });
  fake.kill(lt); // session-granular: kills everything…
  assert.strictEqual(await fake.alive(lt), false);
  await fake.resume(w); // …one window back up
  assert.strictEqual(await fake.alive(w), true);
  assert.strictEqual(await fake.alive(lt), true,
    'the session-granular ref answers for whichever window has focus — the corpse-masking bug');
});

test('adoptWindow re-keys the SAME live agent to session:window, and is idempotent', async () => {
  const ref = await fake.spawn('/tmp/x', 'charter', { session: 'bc-s' });
  const moved = await fake.adoptWindow(ref, 'lt');
  assert.deepStrictEqual(moved, { ...ref, window: 'lt' });
  assert.strictEqual(await fake.alive(moved), true);
  assert.deepStrictEqual(fake.transcript(moved), ['charter'], 'memory follows the agent — never restarted');
  assert.deepStrictEqual(await fake.adoptWindow(moved, 'lt'), moved, 'idempotent');
});

// The fake reads the resume id the way the tmux adapters do — the relay's
// record in stateDir first, the ref second — and records it the way the relay
// does, so server code exercising resume-vs-relaunch sees the real rule.
test('resumable/resume honour opts.stateDir: the recorded id wins over a stale ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-sid-'));
  try {
    const ref = await fake.spawn('/tmp/x', 'p', { session: 'bc-sid', stateDir });
    await tick();
    assert.strictEqual(fs.readFileSync(path.join(stateDir, 'bc-sid.session-id'), 'utf8').trim(), ref.resumeId,
      'the emitted turn-end was recorded like the relay records it');
    fake.kill(ref);
    const stale = { harness: 'fake', session: 'bc-sid', cwd: '/tmp/x' }; // e.g. a ref that lost its id
    assert.strictEqual(await fake.resumable(stale), false, 'without stateDir only the ref can answer');
    assert.strictEqual(await fake.resumable(stale, { stateDir }), true);
    const back = await fake.resume(stale, { stateDir });
    assert.strictEqual(back.resumeId, ref.resumeId);
    assert.deepStrictEqual(fake.transcript(back), ['p'], 'memory came back');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('BC_FAKE_TURNEND_POST=1 POSTs each turn end to opts.callbackUrl', async () => {
  const http = require('node:http');
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.BC_FAKE_TURNEND_POST = '1';
  try {
    const callbackUrl = 'http://127.0.0.1:' + server.address().port + '/api/turn-end';
    const ref = await fake.spawn('/tmp/x', 'p', { session: 'bc-post', callbackUrl });
    for (let i = 0; i < 50 && got.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].session, 'bc-post');
    assert.strictEqual(got[0].session_id, ref.resumeId);
    assert.strictEqual(got[0].event, 'turn-end');
    assert.strictEqual(got[0].text, 'fake turn 1');
  } finally {
    delete process.env.BC_FAKE_TURNEND_POST;
    server.close();
  }
});
