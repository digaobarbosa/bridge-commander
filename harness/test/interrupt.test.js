'use strict';
// interrupt(ref) — the optional verb behind ⏹: stop the running turn, keep the
// session. One test per harness: claude and codex (tmux, one Escape), acp
// (session/cancel through the real host), and the fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const t = require('../tmux.js');

// Patch tmux.js in place (tmux-session.js calls t.foo() at call time): the
// window probe answers from `alive`, and every sendKey is recorded.
// `screens` are handed out one per capture, then the last is held.
function patchTmux({ alive = true, screens = [''] } = {}) {
  const names = ['tryTmux', 'sendKey', 'capture', 'sleep'];
  const original = {};
  for (const n of names) original[n] = t[n];
  const calls = [];
  const left = screens.slice();
  t.tryTmux = async (...args) => (args[0] === 'list-windows' ? (alive ? 'w-card\nw-other' : 'w-other') : null);
  t.sendKey = async (target, key) => { calls.push({ target, key }); };
  t.capture = async () => (left.length > 1 ? left.shift() : left[0]);
  t.sleep = async () => {};
  return { calls, keys: () => calls.map((c) => c.key), restore() { for (const n of names) t[n] = original[n]; } };
}

// A claude screen whose composer box holds `lines` (the first after the ❯).
const RULE = '─'.repeat(40);
const screen = (...lines) => ['  ⎿  $ python3 -c sleep', '✻ Working… (12s)', RULE,
  ...lines.map((l, i) => (i ? '  ' : '❯ ') + l), RULE, '  ⏵⏵ auto mode on'].join('\n');
const WAKE1 = '[bridge-commander] 1 pending item(s) — run: bc-axi drain';
const WAKE2 = '[bridge-commander] 2 pending item(s) — run: bc-axi drain';
const HINT = 'Press up to edit queued messages';

for (const harness of ['claude', 'codex']) {
  test(`${harness}: interrupt sends exactly one Escape to the agent's own pane`, async () => {
    const h = require(`../${harness}-tmux.js`);
    const ref = { harness, session: 'bc-stop', window: 'w-card', cwd: '/tmp' };
    const m = patchTmux();
    try {
      await h.interrupt(ref);
      // One, never two: a second Escape on an idle agent opens claude's Rewind
      // menu, and on codex it arms a backtrack whose Enter rewinds the thread.
      assert.deepStrictEqual(m.calls, [{ target: '=bc-stop:=w-card', key: 'Escape' }]);
    } finally { m.restore(); }
  });

  test(`${harness}: interrupt of a gone pane throws and sends nothing`, async () => {
    const h = require(`../${harness}-tmux.js`);
    const m = patchTmux({ alive: false });
    try {
      await assert.rejects(h.interrupt({ harness, session: 'bc-stop', window: 'w-card', cwd: '/tmp' }), /is gone/);
      assert.deepStrictEqual(m.calls, []);
    } finally { m.restore(); }
  });
}

test('claude: queued wake lines are pulled up and cleared before the Esc, which would submit them', async () => {
  const h = require('../claude-tmux.js');
  const m = patchTmux({ screens: [screen(HINT), screen(WAKE1, WAKE2)] });
  try {
    await h.interrupt({ harness: 'claude', session: 'bc-stop', window: 'w-card', cwd: '/tmp' });
    assert.deepStrictEqual(m.keys(), ['Up', 'C-u', 'BSpace', 'C-u', 'Escape']);
  } finally { m.restore(); }
});

test('claude: a queue holding anyone\'s words is left in the composer, where the Esc does not submit it', async () => {
  const h = require('../claude-tmux.js');
  const m = patchTmux({ screens: [screen(HINT), screen(WAKE1, 'captain: also check the logs')] });
  try {
    await h.interrupt({ harness: 'claude', session: 'bc-stop', window: 'w-card', cwd: '/tmp' });
    assert.deepStrictEqual(m.keys(), ['Up', 'Escape']);
  } finally { m.restore(); }
});

test('claude: no queue, or text being typed, is a plain Esc', async () => {
  const h = require('../claude-tmux.js');
  for (const s0 of [screen(''), screen('half-typed captain text'), 'no composer on screen']) {
    const m = patchTmux({ screens: [s0] });
    try {
      await h.interrupt({ harness: 'claude', session: 'bc-stop', window: 'w-card', cwd: '/tmp' });
      assert.deepStrictEqual(m.keys(), ['Escape'], s0);
    } finally { m.restore(); }
  }
});

test('claude: the nudge pattern matches every line the board types', () => {
  const { NUDGE_RE } = require('../claude-tmux.js');
  const { wakeLine } = require('../../server/delivery.js');
  assert.ok(NUDGE_RE.test(wakeLine(1)) && NUDGE_RE.test(wakeLine(12)));
  assert.ok(NUDGE_RE.test('[bridge-commander] session respawned — run: bc-axi drain'));
  assert.ok(!NUDGE_RE.test('please run: bc-axi drain'));
});

test('acp: interrupt cancels the running turn; the session stays alive and takes the next prompt', async () => {
  const { acpAdapter, stopHost } = require('../acp-adapter.js');
  const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const reg = tmp('bc-acpi-reg-');
  const prevReg = process.env.BC_ACP_REGISTRY;
  process.env.BC_ACP_REGISTRY = reg;
  const stateDir = tmp('bc-acpi-st-');
  const cwd = tmp('bc-acpi-cwd-');
  const agentDir = tmp('bc-acpi-ag-');
  const turnEnds = () => {
    try { return fs.readFileSync(path.join(stateDir, 'acp-int.turnend.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  const waitFor = async (fn) => {
    for (const end = Date.now() + 8000; !fn();) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  try {
    const h = acpAdapter({ name: 'fakeacp', adapter: 'acp', command: process.execPath,
      args: [path.join(__dirname, 'fake-acp-agent.js')], env: { FAKE_ACP_DIR: agentDir } });
    const ref = await h.spawn(cwd, 'HANG', { session: 'bc-int', stateDir });
    await h.interrupt(ref);
    await waitFor(() => turnEnds().length === 1);
    assert.strictEqual(turnEnds()[0].stop_reason, 'cancelled');
    assert.strictEqual(await h.alive(ref), true, 'interrupt is not kill');
    await h.send(ref, 'next');
    await waitFor(() => turnEnds().length === 2);
    assert.strictEqual(turnEnds()[1].text, 'echo: next');
    await h.kill(ref);
    await assert.rejects(h.interrupt(ref), /not alive/);
  } finally {
    await stopHost(stateDir);
    for (const d of [stateDir, cwd, agentDir, reg]) fs.rmSync(d, { recursive: true, force: true });
    if (prevReg === undefined) delete process.env.BC_ACP_REGISTRY; else process.env.BC_ACP_REGISTRY = prevReg;
  }
});

test('fake: interrupt logs to <key>.pane.jsonl for a live session, and throws for a dead one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-int-'));
  const prev = process.env.BC_FAKE_STATE;
  process.env.BC_FAKE_STATE = dir;
  const fake = require('../fake.js');
  try {
    const ref = await fake.spawn(dir, 'brief', { session: 'bc-fint' });
    await fake.interrupt(ref);
    const log = fs.readFileSync(path.join(dir, 'bc-fint.pane.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(log.map((e) => e.event), ['interrupt']);
    assert.strictEqual(await fake.alive(ref), true);
    await fake.kill(ref);
    await assert.rejects(fake.interrupt(ref), /not alive/);
  } finally {
    fake.reset();
    if (prev === undefined) delete process.env.BC_FAKE_STATE; else process.env.BC_FAKE_STATE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
