'use strict';
// codex facts only — the port's promises are in conformance.test.js, the
// screens in settle-screens.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../codex-tmux.js');
const { isHarnessRef } = require('../port.js');
const { mockTmux } = require('./tmux-mock.js');

const READY = 'OpenAI Codex (v0.155.1)\nYOLO mode\n› ';

async function launchLines(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  const mock = mockTmux({ readyTail: READY });
  try {
    await fn(cwd, stateDir);
    return { stateDir, lines: mock.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]) };
  } finally {
    mock.restore();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('a codex ref is a valid HarnessRef with and without the (late-adopted) resumeId', () => {
  const born = { harness: 'codex', session: 'bc-ab12cd', cwd: '/tmp/x' };
  assert.ok(isHarnessRef(born));
  assert.ok(isHarnessRef({ ...born, resumeId: '019f49a7-81f4-7ad3-822d-3acf8cf81ed6', window: 'w-card-7' }));
});

test('launch line: both bypass flags and the notify relay wired to the state dir, key and callback', async () => {
  const { stateDir, lines } = await launchLines((cwd, sd) =>
    codex.spawn(cwd, 'go', { session: 'bc-cx', window: 'w-1', stateDir: sd, callbackUrl: 'http://127.0.0.1:1/api/turn-end', extraArgs: ['--model', 'm'] }));
  const notify = JSON.stringify(['node', path.join(__dirname, '..', 'codex-notify.js'), stateDir, 'bc-cx:w-1', 'http://127.0.0.1:1/api/turn-end']);
  assert.strictEqual(lines[0], 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust '
    + `-c check_for_update_on_startup=false -c 'notify=${notify}' '--model' 'm'`);
});

// codex has no board-relayed approval hook, so a board configured to ask
// permission still launches codex on its bypass flags — spawn and resume alike.
test('permissionMode is ignored: codex keeps its bypass flags in every mode', async () => {
  const { lines } = await launchLines(async (cwd, stateDir) => {
    await codex.spawn(cwd, 'go', { session: 'bc-pm', stateDir, permissionMode: 'default' });
    await codex.resume({ harness: 'codex', session: 'bc-pm', cwd, resumeId: 't-1' }, { stateDir, permissionMode: 'acceptEdits' });
  });
  for (const line of lines) {
    assert.match(line, /--dangerously-bypass-approvals-and-sandbox /);
    assert.doesNotMatch(line, /permission-mode/);
  }
});

test('resume line: `codex resume <thread-id>` with a known id, a bare codex without one', async () => {
  const { lines } = await launchLines(async (cwd, stateDir) => {
    await codex.resume({ harness: 'codex', session: 'bc-cr', cwd, resumeId: 'thread-9' }, { stateDir });
    await codex.resume({ harness: 'codex', session: 'bc-cr2', cwd }, { stateDir });
  });
  assert.match(lines[0], /^codex resume thread-9 --dangerously-bypass-approvals-and-sandbox /);
  assert.match(lines[1], /^codex --dangerously-bypass-approvals-and-sandbox /);
});

// status() resolves its thread-id the same way resume() does — the recorded
// session-id file, then the ref. Without that a codex lieutenant that never
// adopted a resumeId shows a blank context bar.
test('status resolves the thread-id from the recorded session-id, not ref.resumeId alone', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-status-'));
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-rollout-'));
  try {
    const thread = '01a00181-3b6b-7b43-b7e4-2fe0555a190b';
    const day = path.join(sessionsDir, '2026', '08', '20');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-2026-08-20T10-00-00-' + thread + '.jsonl'),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) + '\n'
      + JSON.stringify({ payload: { type: 'token_count',
        info: { last_token_usage: { total_tokens: 140190 }, model_context_window: 258400 } } }) + '\n');

    const ref = { harness: 'codex', session: 'bc-lt-rex', window: 'lt', cwd: '/tmp' };
    assert.strictEqual(await codex.status(ref, { stateDir, sessionsDir }), null, 'no id anywhere yet');
    fs.writeFileSync(path.join(stateDir, 'bc-lt-rex:lt.session-id'), thread + '\n');
    assert.deepStrictEqual(await codex.status(ref, { stateDir, sessionsDir }),
      { model: 'gpt-5.6-sol', contextUsed: 140190, contextWindow: 258400 });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('no /autocompact: codex only has it as a config key, not a command', async () => {
  await assert.rejects(() => codex.runCommand({ harness: 'codex', session: 'bc-cmd', cwd: '/tmp' }, '/autocompact 80'),
    /unknown command \/autocompact/);
});
