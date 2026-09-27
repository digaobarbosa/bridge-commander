'use strict';
// ACP conformance — the port's promises (conformance.test.js) that apply to an
// agent with no terminal, run against the fake ACP agent through the REAL
// detached acp-host. Every case starts its own host in its own stateDir and
// shuts it down after, so no host outlives the suite.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { isHarnessRef, VERBS } = require('../port.js');
const { acpAdapter, stopHost, renderLog } = require('../acp-adapter.js');
const { pidFileFor } = require('../acp-host.js');

const AGENT = path.join(__dirname, 'fake-acp-agent.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// Pointers go to a temp registry, never the real ~/.bridge-commander; a host
// that a failed case leaks still exits on its own.
process.env.BC_ACP_REGISTRY = tmp('bc-acpc-reg-');
process.env.BC_ACP_HOST_IDLE_MS = '60000';
test.after(() => fs.rmSync(process.env.BC_ACP_REGISTRY, { recursive: true, force: true }));

async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const turnEnds = (stateDir, key) => {
  try { return fs.readFileSync(path.join(stateDir, `${key}.turnend.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
function assertCleanRef(ref, harness) {
  assert.ok(isHarnessRef(ref), JSON.stringify(ref));
  assert.strictEqual(ref.harness, harness);
  for (const [k, v] of Object.entries(ref)) assert.notStrictEqual(v, undefined, `key ${k} is undefined`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ref)), ref);
}

const profileFor = (agentDir, env = {}) => ({
  name: 'fakeacp', adapter: 'acp', command: process.execPath, args: [AGENT], env: { FAKE_ACP_DIR: agentDir, ...env },
});

// A stateDir, a cwd and an agent dir; the host is stopped and all removed after.
async function withEnv(fn) {
  const stateDir = tmp('bc-acpc-st-');
  const cwd = tmp('bc-acpc-cwd-');
  const agentDir = tmp('bc-acpc-ag-');
  try {
    return await fn({ stateDir, cwd, agentDir });
  } finally {
    await stopHost(stateDir);
    for (const d of [stateDir, cwd, agentDir]) fs.rmSync(d, { recursive: true, force: true });
  }
}

// A stand-in for the board: /api/turn-end records, /api/permission answers `decide(body)`.
async function withBoard(decide, fn) {
  const turnEndPosts = [];
  const asks = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      if (req.url === '/api/permission') {
        asks.push(b);
        setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(decide(b))); }, 30);
        return;
      }
      if (req.url === '/api/turn-end') turnEndPosts.push(b);
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const callbackUrl = `http://127.0.0.1:${server.address().port}/api/turn-end`;
  try { return await fn({ callbackUrl, turnEndPosts, asks }); } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('acp exposes the seven verbs and its optional ones; paneInput is not offered (no terminal)', () => {
  const h = acpAdapter(profileFor('/tmp'));
  for (const verb of VERBS.concat(['openPane', 'paneSnapshot', 'commands', 'runCommand', 'status', 'brief', 'profileInfo'])) {
    assert.strictEqual(typeof h[verb], 'function', verb);
  }
  for (const verb of ['paneInput', 'adoptWindow', 'panePids']) assert.strictEqual(h[verb], undefined, verb);
  assert.throws(() => acpAdapter({ name: 'x' }), /needs a command/);
});

test('spawn returns a clean ref with the ACP sessionId, delivers the brief as the first turn, and the turn end lands', async () => {
  await withEnv(({ stateDir, cwd, agentDir }) => withBoard(() => ({}), async ({ callbackUrl, turnEndPosts }) => {
    const h = acpAdapter(profileFor(agentDir));
    const heard = [];
    const probe = { harness: 'fakeacp', session: 'acp-shape', window: 'w-c1', cwd };
    const off = h.onTurnEnd(probe, (ev) => heard.push(ev), { stateDir });
    try {
      const ref = await h.spawn(cwd, 'SECRET_BRIEF go', { session: 'bc-shape', window: 'w-c1', stateDir, callbackUrl });
      assertCleanRef(ref, 'fakeacp');
      assert.strictEqual(ref.session, 'acp-shape');
      assert.strictEqual(ref.window, 'w-c1');
      assert.strictEqual(ref.cwd, path.resolve(cwd));
      assert.match(ref.resumeId, /^sess_/);
      await waitFor(() => heard.length === 1 && turnEndPosts.length === 1);
      assert.strictEqual(heard[0].text, 'echo: SECRET_BRIEF go');
      assert.strictEqual(turnEndPosts[0].session, 'acp-shape:w-c1', 'the state key, which the server attributes by');
      assert.strictEqual(turnEndPosts[0].session_id, ref.resumeId);
      assert.strictEqual(fs.readFileSync(h.brief(ref, { stateDir }), 'utf8'), 'SECRET_BRIEF go');
      // the brief never rides argv: not the host's, not the agent's
      const ps = execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' });
      assert.ok(!ps.includes('SECRET_BRIEF'), 'brief not in any argv');
      const plain = await h.spawn(cwd, 'x', { stateDir });
      assert.match(plain.session, /^acp-[0-9a-f]{6}$/);
      assert.ok(!('window' in plain));
      await assert.rejects(h.spawn(cwd, 'x', { session: 'bc-shape', window: 'w-c1', stateDir }), /already exists/);
      await assert.rejects(h.spawn(cwd, 'x', { window: '7', stateDir }), /invalid window name/);
      await assert.rejects(h.spawn(path.join(cwd, 'nope'), 'x', { stateDir }), /does not exist/);
    } finally { off(); }
  }));
});

test('send returns once the prompt is accepted, not when the turn ends; turns stay in order', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const h = acpAdapter(profileFor(agentDir));
    const ref = await h.spawn(cwd, 'SLOW 1500', { session: 'bc-send', stateDir });
    const t0 = Date.now();
    await h.send(ref, 'after the slow one');
    assert.ok(Date.now() - t0 < 1000, 'send did not wait for the turn');
    await waitFor(() => turnEnds(stateDir, 'acp-send').length === 2);
    assert.deepStrictEqual(turnEnds(stateDir, 'acp-send').map((e) => e.text), ['echo: SLOW 1500', 'echo: after the slow one']);
  });
});

test('alive is false after kill and after the agent crashes; send to a dead session throws; kill of nothing is a no-op', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const h = acpAdapter(profileFor(agentDir));
    const nobody = { harness: 'fakeacp', session: 'acp-nobody', cwd };
    assert.strictEqual(await h.alive(nobody), false, 'no host, no session: false');
    await h.kill(nobody);
    await assert.rejects(h.send(nobody, 'hi'), /not alive/);
    const ref = await h.spawn(cwd, 'hi', { session: 'bc-live', stateDir });
    assert.strictEqual(await h.alive(ref), true);
    await h.kill(ref);
    assert.strictEqual(await h.alive(ref), false);
    await h.kill(ref);
    await assert.rejects(h.send(ref, 'hi'), /not alive/);
    const crash = await h.spawn(cwd, 'CRASH', { session: 'bc-crash', stateDir });
    await waitFor(async () => (await h.alive(crash)) === false);
    await assert.rejects(h.send(crash, 'hi'), /not alive/);
    assert.strictEqual(turnEnds(stateDir, 'acp-crash').length, 0, 'a death is not a turn end');
  });
});

for (const [label, env] of [['session/load', { FAKE_ACP_LOAD: '1' }], ['session/resume', { FAKE_ACP_RESUME: '1' }]]) {
  test(`resume through ${label} restores memory on the same sessionId`, async () => {
    await withEnv(async ({ stateDir, cwd, agentDir }) => {
      const h = acpAdapter(profileFor(agentDir, env));
      const ref = await h.spawn(cwd, 'remember kiwi', { session: 'bc-mem', window: 'w-m', stateDir });
      await waitFor(() => turnEnds(stateDir, 'acp-mem:w-m').length === 1);
      assert.deepStrictEqual(await h.resume(ref, { stateDir }), ref, 'a live session comes back as it is');
      await h.send(ref, 'CRASH');
      await waitFor(async () => (await h.alive(ref)) === false);
      assert.strictEqual(await h.resumable(ref, { stateDir }), true);
      const back = await h.resume({ ...ref, resumeId: 'sess_stale' }, { stateDir });
      assert.strictEqual(back.resumeId, ref.resumeId, 'the recorded id beats the ref\'s');
      assertCleanRef(back, 'fakeacp');
      assert.strictEqual(await h.alive(back), true);
      await h.send(back, 'RECALL');
      await waitFor(() => turnEnds(stateDir, 'acp-mem:w-m').length === 2);
      assert.strictEqual(turnEnds(stateDir, 'acp-mem:w-m')[1].text, 'history: remember kiwi|CRASH');
    });
  });
}

test('without load or resume, resumable is false and resume opens a fresh session', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const h = acpAdapter(profileFor(agentDir));
    const ref = await h.spawn(cwd, 'remember kiwi', { session: 'bc-nomem', stateDir });
    await waitFor(() => turnEnds(stateDir, 'acp-nomem').length === 1);
    await h.kill(ref);
    assert.strictEqual(await h.resumable(ref, { stateDir }), false, 'an id is known, but the agent cannot restore it');
    const back = await h.resume(ref, { stateDir });
    assertCleanRef(back, 'fakeacp');
    assert.notStrictEqual(back.resumeId, ref.resumeId);
    await h.send(back, 'RECALL');
    await waitFor(() => turnEnds(stateDir, 'acp-nomem').length === 2);
    assert.strictEqual(turnEnds(stateDir, 'acp-nomem')[1].text, 'history:');
  });
});

test('permission round-trip against /api/permission: allow, then deny, with permission-hook\'s body', async () => {
  let decision = 'allow';
  await withEnv(({ stateDir, cwd, agentDir }) => withBoard(() => ({ decision }), async ({ callbackUrl, asks, turnEndPosts }) => {
    const h = acpAdapter(profileFor(agentDir));
    const ref = await h.spawn(cwd, 'PERMISSION', { session: 'bc-perm', window: 'w-p', stateDir, callbackUrl });
    await waitFor(() => turnEndPosts.length === 1);
    assert.strictEqual(turnEndPosts[0].text, 'permission: opt-allow');
    assert.strictEqual(asks.length, 1);
    assert.strictEqual(asks[0].session, 'acp-perm:w-p');
    assert.strictEqual(asks[0].session_id, ref.resumeId);
    assert.strictEqual(asks[0].tool_name, 'Run echo hi');
    assert.deepStrictEqual(asks[0].tool_input, { command: 'echo hi' });
    assert.strictEqual(asks[0].tmux_session, '');
    decision = 'deny';
    await h.send(ref, 'PERMISSION');
    await waitFor(() => turnEndPosts.length === 2);
    assert.strictEqual(turnEndPosts[1].text, 'permission: opt-reject');
    const pane = await h.paneSnapshot(ref);
    assert.match(pane, /permission.*Run echo hi.*allowed/);
    assert.match(pane, /permission.*Run echo hi.*denied/);
  }));
});

test('the host survives the process that started it exiting; a fresh adapter finds the session with no stateDir', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const script = `
      const { acpAdapter } = require(${JSON.stringify(path.join(__dirname, '..', 'acp-adapter.js'))});
      const h = acpAdapter(JSON.parse(process.argv[1]));
      h.spawn(process.argv[2], 'first', { session: 'bc-orphan', window: 'w-o', stateDir: process.argv[3] })
        .then((ref) => { process.stdout.write(JSON.stringify({ ref, pid: process.pid })); process.exit(0); },
              (e) => { process.stderr.write(e.stack); process.exit(1); });`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(profileFor(agentDir)), cwd, stateDir], { encoding: 'utf8' }));
    const hostPid = parseInt(fs.readFileSync(pidFileFor(stateDir), 'utf8'), 10);
    assert.notStrictEqual(hostPid, out.pid);
    assert.throws(() => process.kill(out.pid, 0), 'the parent is gone');
    const h = acpAdapter(profileFor(agentDir)); // a new instance: no memo, and alive() takes no opts
    assert.strictEqual(await h.alive(out.ref), true);
    await h.send(out.ref, 'still here');
    await waitFor(() => turnEnds(stateDir, 'acp-orphan:w-o').length === 2);
    assert.strictEqual(turnEnds(stateDir, 'acp-orphan:w-o')[1].text, 'echo: still here');
    await h.kill(out.ref);
    assert.strictEqual(await h.alive(out.ref), false);
  });
});

test('commands, runCommand, status and profileInfo read what the agent advertised', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const h = acpAdapter(profileFor(agentDir, { FAKE_ACP_MODEL: '1' }));
    assert.deepStrictEqual(h.profileInfo().options, [], 'no model option known before a session');
    const ref = await h.spawn(cwd, 'hi', { session: 'bc-cmd', stateDir, model: 'fake-large' });
    await waitFor(() => turnEnds(stateDir, 'acp-cmd').length === 1);
    const info = h.profileInfo();
    assert.strictEqual(info.adapter, 'acp');
    assert.deepStrictEqual(info.options, ['model']);
    assert.deepStrictEqual(info.requirements, { bins: [process.execPath], tmux: false, rootBypass: false });
    assert.deepStrictEqual(h.commands(ref).map((c) => c.name), ['/status', '/help', '/review', '/web']);
    assert.deepStrictEqual(await h.status(ref, { stateDir }), { contextUsed: 100, contextWindow: 1000, model: 'fake-large' });
    const help = await h.runCommand(ref, '/help', { stateDir });
    for (const c of h.commands(ref)) assert.ok(help.includes(c.name + ' — '), c.name);
    assert.match(await h.runCommand(ref, '/status', { stateDir }), /fake-large/);
    assert.match(await h.runCommand(ref, '/review now', { stateDir }), /submitted/);
    await waitFor(() => turnEnds(stateDir, 'acp-cmd').length === 2);
    assert.strictEqual(turnEnds(stateDir, 'acp-cmd')[1].text, 'echo: /review now', 'a pass-through is the literal line as a prompt');
    await assert.rejects(h.runCommand(ref, '/nope', { stateDir }), /unknown command \/nope/);
    const fresh = { harness: 'fakeacp', session: 'acp-none', cwd };
    assert.strictEqual(await h.status(fresh, { stateDir }), null);
    await assert.rejects(h.runCommand(fresh, '/status', { stateDir }), /no status for acp-none/);
    await assert.rejects(h.spawn(cwd, 'x', { stateDir, effort: 'high' }), /does not support effort/);
  });
});

test('openPane streams the event log as change-detected text frames', async () => {
  await withEnv(async ({ stateDir, cwd, agentDir }) => {
    const h = acpAdapter(profileFor(agentDir));
    const ref = await h.spawn(cwd, 'PLAN please', { session: 'bc-pane', stateDir });
    const frames = [];
    const feed = h.openPane(ref, { onFrame: (f) => frames.push(f), intervalMs: 30 });
    try {
      await waitFor(() => frames.some((f) => /turn ended/.test(f)));
      await h.send(ref, 'second');
      await waitFor(() => frames.some((f) => /echo: second/.test(f)));
      const last = frames[frames.length - 1];
      assert.match(last, /› .*PLAN please/);
      assert.match(last, /\[x\] read the code/);
      assert.match(last, /echo: PLAN please/);
      for (let i = 1; i < frames.length; i++) assert.notStrictEqual(frames[i], frames[i - 1], 'identical frames are skipped');
    } finally { feed.close(); }
    assert.strictEqual(await h.paneSnapshot(ref, { lines: 1 }).then((t) => t.split('\n').length), 1);
  });
});

test('renderLog: tool calls update in place, thoughts and messages merge, exits are named', () => {
  const up = (u) => ({ kind: 'update', update: u });
  const text = renderLog([
    { kind: 'prompt', text: 'go' },
    up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm ' } }),
    up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ok' } }),
    up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.js', kind: 'edit', status: 'pending' }),
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } }),
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: '/w/a.js', newText: 'x' }] }),
    { kind: 'exit', code: 1, signal: null },
  ]).replace(/\x1b\[[0-9;]*m/g, '');
  assert.deepStrictEqual(text.split('\n'), ['› go', 'hmm ok', '⚙ Edit a.js [completed] (edit)', '    ± /w/a.js', 'Done', '[agent exited code 1]']);
});
