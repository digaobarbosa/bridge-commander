'use strict';
// acp-host — run in-process against the fake ACP agent: the host's own rules
// (prompt serialization, turn ends, the permission relay, child death, close)
// with the HTTP side injected.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { createHost, socketPathFor, permissionUrl, pickOption } = require('../acp-host.js');
const { createRpc } = require('../acp-rpc.js');

const AGENT = path.join(__dirname, 'fake-acp-agent.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// One host + stateDir + agent dir per case; every agent is killed after.
async function withHost(deps, fn) {
  const stateDir = tmp('bc-acph-state-');
  const agentDir = tmp('bc-acph-agent-');
  const cwd = tmp('bc-acph-cwd-');
  const posts = [];
  const host = createHost({ stateDir, postTurnEnd: async (url, ev) => { posts.push({ url, ev }); }, ...deps });
  const spawnParams = (key, env = {}, extra = {}) => ({
    key, harness: 'fakeacp', command: process.execPath, args: [AGENT], cwd, callbackUrl: 'http://127.0.0.1:9/api/turn-end',
    env: { FAKE_ACP_DIR: agentDir, ...env }, mode: 'new', ...extra,
  });
  try {
    return await fn({ host, stateDir, agentDir, cwd, posts, spawnParams });
  } finally {
    await Promise.all([...host.sessions.values()].map((s) => host.stop(s)));
    await host.close();
    for (const d of [stateDir, agentDir, cwd]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('pure helpers: permission URL from the callback origin, option picking, a short socket path', () => {
  assert.strictEqual(permissionUrl('http://127.0.0.1:4321/api/turn-end'), 'http://127.0.0.1:4321/api/permission');
  assert.strictEqual(permissionUrl(''), null);
  assert.strictEqual(permissionUrl('not a url'), null);
  const opts = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
  assert.strictEqual(pickOption(opts, 'allow'), 'a');
  assert.strictEqual(pickOption(opts, 'deny'), 'r');
  assert.strictEqual(pickOption(opts, null), 'r', 'no decision rejects');
  assert.strictEqual(pickOption([{ optionId: 'aa', kind: 'allow_always' }], 'allow'), 'aa');
  assert.strictEqual(pickOption([{ optionId: 'aa', kind: 'allow_always' }], 'deny'), null);
  assert.strictEqual(socketPathFor('/s'), '/s/acp-host.sock');
  const deep = '/' + 'x'.repeat(120);
  assert.ok(Buffer.byteLength(socketPathFor(deep)) <= 104, 'a deep stateDir still gets a socket that fits');
  assert.strictEqual(socketPathFor(deep), socketPathFor(deep), 'stable per stateDir');
});

test('spawn delivers the brief as the first turn; the turn end is recorded and posted with the turn text', async () => {
  await withHost({}, async ({ host, stateDir, posts, spawnParams }) => {
    const info = await host.handle('spawn', spawnParams('acp-a:w-1', {}, { prompt: 'the brief' }));
    assert.match(info.sessionId, /^sess_/);
    assert.strictEqual(info.alive, true);
    await waitFor(() => posts.length === 1);
    const ev = posts[0].ev;
    assert.strictEqual(posts[0].url, 'http://127.0.0.1:9/api/turn-end');
    assert.strictEqual(ev.session, 'acp-a:w-1');
    assert.strictEqual(ev.harness, 'fakeacp');
    assert.strictEqual(ev.event, 'turn-end');
    assert.strictEqual(ev.session_id, info.sessionId);
    assert.strictEqual(ev.tmux_session, '');
    assert.strictEqual(ev.stop_reason, 'end_turn');
    assert.strictEqual(ev.text, 'echo: the brief', 'the chunks concatenated');
    assert.strictEqual(fs.readFileSync(path.join(stateDir, 'acp-a:w-1.session-id'), 'utf8').trim(), info.sessionId);
    assert.deepStrictEqual(lines(path.join(stateDir, 'acp-a:w-1.turnend.jsonl')).map((e) => e.text), ['echo: the brief']);
    const log = lines(path.join(stateDir, 'acp-a:w-1.acp.jsonl'));
    assert.ok(log.some((e) => e.kind === 'update' && e.update.sessionUpdate === 'available_commands_update'));
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'acp-a:w-1.acp-state.json'), 'utf8'));
    assert.deepStrictEqual(state.commands.map((c) => c.name), ['review', 'web']);
    assert.deepStrictEqual(state.usage, { used: 100, size: 1000 });
  });
});

test('turn text is capped like the relay caps it', async () => {
  await withHost({}, async ({ host, posts, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-cap', {}, { prompt: 'y'.repeat(800) }));
    await waitFor(() => posts.length === 1);
    assert.strictEqual(posts[0].ev.text.length, require('../turnend-relay.js').TEXT_MAX);
  });
});

test('prompts are serialized per session: the second waits for the first stopReason', async () => {
  await withHost({}, async ({ host, stateDir, posts, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-q', {}, { prompt: 'SLOW 300' }));
    const r = await host.handle('prompt', { key: 'acp-q', text: 'second' });
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.queued, 1, 'queued behind the running turn');
    await waitFor(() => posts.length === 2);
    const kinds = lines(path.join(stateDir, 'acp-q.acp.jsonl')).filter((e) => e.kind === 'prompt' || e.kind === 'turn-end').map((e) => e.kind + ':' + (e.text || e.stopReason));
    assert.deepStrictEqual(kinds, ['prompt:SLOW 300', 'turn-end:end_turn', 'prompt:second', 'turn-end:end_turn']);
  });
});

test('permission: the body is permission-hook\'s, allow picks allow_once, deny picks reject_once', async () => {
  const asks = [];
  let decision = 'allow';
  const postPermission = async (url, body) => { asks.push({ url, body }); return { reply: { decision } }; };
  await withHost({ postPermission }, async ({ host, cwd, posts, spawnParams }) => {
    const info = await host.handle('spawn', spawnParams('acp-p', {}, { prompt: 'PERMISSION' }));
    await waitFor(() => posts.length === 1);
    assert.strictEqual(posts[0].ev.text, 'permission: opt-allow');
    assert.strictEqual(asks[0].url, 'http://127.0.0.1:9/api/permission');
    const b = asks[0].body;
    assert.deepStrictEqual(Object.keys(b).sort(), ['cwd', 'permission_mode', 'session', 'session_id', 'tmux_session', 'tool_input', 'tool_name', 'ts'].sort());
    assert.strictEqual(b.session, 'acp-p');
    assert.strictEqual(b.session_id, info.sessionId);
    assert.strictEqual(b.cwd, cwd);
    assert.strictEqual(b.tool_name, 'Run echo hi', 'the tool call\'s title, merged from its earlier tool_call update');
    assert.deepStrictEqual(b.tool_input, { command: 'echo hi' });
    decision = 'deny';
    await host.handle('prompt', { key: 'acp-p', text: 'PERMISSION' });
    await waitFor(() => posts.length === 2);
    assert.strictEqual(posts[1].ev.text, 'permission: opt-reject');
  });
});

test('permission: no decision rejects, and a server that is away is asked again until it answers', async () => {
  let calls = 0;
  const postPermission = async () => {
    calls++;
    if (calls === 1) return { reply: null }; // the server's cap answered null
    if (calls === 2) return { unreachable: true }; // BC restarting
    return { reply: { decision: 'allow' } };
  };
  await withHost({ postPermission, sleep: () => new Promise((r) => setTimeout(r, 5)) }, async ({ host, posts, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-pn', {}, { prompt: 'PERMISSION' }));
    await waitFor(() => posts.length === 1);
    assert.strictEqual(posts[0].ev.text, 'permission: opt-reject', 'a null decision is never an approval');
    await host.handle('prompt', { key: 'acp-pn', text: 'PERMISSION' });
    await waitFor(() => posts.length === 2);
    assert.strictEqual(calls, 3);
    assert.strictEqual(posts[1].ev.text, 'permission: opt-allow');
  });
});

test('a pending permission is answered cancelled when the turn is cancelled', async () => {
  const postPermission = (url, body, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ reply: null })));
  await withHost({ postPermission }, async ({ host, stateDir, posts, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-pc', {}, { prompt: 'PERMISSION' }));
    const log = path.join(stateDir, 'acp-pc.acp.jsonl');
    await waitFor(() => lines(log).some((e) => e.kind === 'permission' && e.status === 'asked'));
    await host.handle('cancel', { key: 'acp-pc' });
    await waitFor(() => posts.length === 1);
    assert.strictEqual(posts[0].ev.stop_reason, 'cancelled');
    assert.ok(lines(log).some((e) => e.kind === 'permission' && e.status === 'cancelled'));
  });
});

test('an agent that dies mid-turn is not alive, emits no turn end, and refuses prompts', async () => {
  await withHost({}, async ({ host, stateDir, posts, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-c', {}, { prompt: 'CRASH' }));
    await waitFor(async () => (await host.handle('info', { key: 'acp-c' })).alive === false);
    assert.strictEqual(posts.length, 0);
    const exit = lines(path.join(stateDir, 'acp-c.acp.jsonl')).find((e) => e.kind === 'exit');
    assert.strictEqual(exit.code, 3);
    await assert.rejects(Promise.resolve().then(() => host.handle('prompt', { key: 'acp-c', text: 'hi' })), /not alive/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'acp-c.acp-state.json'), 'utf8')).alive, false);
  });
});

test('kill calls session/close when the agent advertises it, and is idempotent', async () => {
  await withHost({}, async ({ host, agentDir, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-k', { FAKE_ACP_CLOSE: '1' }));
    assert.deepStrictEqual(await host.handle('kill', { key: 'acp-k' }), { ok: true, existed: true });
    assert.ok(lines(path.join(agentDir, 'calls.jsonl')).some((c) => c.method === 'session/close'));
    assert.deepStrictEqual(await host.handle('kill', { key: 'acp-k' }), { ok: true, existed: false });
    assert.strictEqual((await host.handle('info', { key: 'acp-k' })).alive, false);
  });
});

test('spawn refuses a key already alive, names a login for auth_required, and pins a model through config options', async () => {
  await withHost({}, async ({ host, agentDir, spawnParams }) => {
    await host.handle('spawn', spawnParams('acp-d'));
    await assert.rejects(host.handle('spawn', spawnParams('acp-d')), /already exists/);
    await assert.rejects(host.handle('spawn', spawnParams('acp-auth', { FAKE_ACP_AUTH: '1' })), /requires authentication.*Log in/);
    assert.strictEqual((await host.handle('info', { key: 'acp-auth' })).alive, false, 'a failed spawn leaves no session');
    await assert.rejects(host.handle('spawn', spawnParams('acp-nomodel', {}, { model: 'fake-large' })), /no model option/);
    const info = await host.handle('spawn', spawnParams('acp-m', { FAKE_ACP_MODEL: '1' }, { model: 'fake-large' }));
    assert.strictEqual(info.configOptions[0].currentValue, 'fake-large');
    const set = lines(path.join(agentDir, 'calls.jsonl')).find((c) => c.method === 'session/set_config_option');
    assert.deepStrictEqual({ configId: set.params.configId, value: set.params.value }, { configId: 'model', value: 'fake-large' });
  });
});

test('a command that cannot start fails the spawn with the reason', async () => {
  await withHost({}, async ({ host, spawnParams }) => {
    await assert.rejects(host.handle('spawn', { ...spawnParams('acp-x'), command: '/nonexistent/agent-bin' }), /ENOENT|exited/);
    assert.strictEqual((await host.handle('info', { key: 'acp-x' })).alive, false);
  });
});

test('resume: session/load restores memory without doubling the log; no capability starts fresh', async () => {
  await withHost({}, async ({ host, stateDir, posts, spawnParams }) => {
    const first = await host.handle('spawn', spawnParams('acp-r', { FAKE_ACP_LOAD: '1' }, { prompt: 'remember kiwi' }));
    await waitFor(() => posts.length === 1);
    await host.handle('kill', { key: 'acp-r' });
    const before = lines(path.join(stateDir, 'acp-r.acp.jsonl')).length;
    const back = await host.handle('spawn', spawnParams('acp-r', { FAKE_ACP_LOAD: '1' }, { mode: 'resume', resumeId: first.sessionId }));
    assert.strictEqual(back.sessionId, first.sessionId);
    assert.strictEqual(back.restored, true);
    const after = lines(path.join(stateDir, 'acp-r.acp.jsonl'));
    assert.ok(!after.slice(before).some((e) => e.kind === 'update' && e.update.sessionUpdate === 'agent_message_chunk'), 'the replay is not appended again');
    await host.handle('prompt', { key: 'acp-r', text: 'RECALL' });
    await waitFor(() => posts.length === 2);
    assert.strictEqual(posts[1].ev.text, 'history: remember kiwi');

    const plain = await host.handle('spawn', spawnParams('acp-f', {}, { prompt: 'x' }));
    await host.handle('kill', { key: 'acp-f' });
    const fresh = await host.handle('spawn', spawnParams('acp-f', {}, { mode: 'resume', resumeId: plain.sessionId }));
    assert.notStrictEqual(fresh.sessionId, plain.sessionId);
    assert.strictEqual(fresh.restored, false);
  });
});

test('the socket speaks the same JSON-RPC: ping over a unix socket', async () => {
  await withHost({}, async ({ host, stateDir }) => {
    const sock = await host.listen(socketPathFor(stateDir));
    const conn = net.connect(sock);
    await new Promise((r) => conn.once('connect', r));
    const rpc = createRpc({ input: conn, output: conn });
    const r = await rpc.request('ping', {});
    assert.strictEqual(r.pid, process.pid);
    assert.deepStrictEqual(r.sessions, []);
    conn.end();
  });
});
