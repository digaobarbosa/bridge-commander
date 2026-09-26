'use strict';
// Unit tests for the tmux-free parts of harness/codex-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../codex-tmux.js');
const { isHarnessRef } = require('../port.js');
const { mockTmux } = require('./tmux-mock.js');

test('a codex ref is a valid HarnessRef with and without the (late-adopted) resumeId', () => {
  // Born WITHOUT resumeId — codex assigns the thread-id and the first notify
  // delivers it — so the bare shape must already round-trip the board state.
  const born = { harness: 'codex', session: 'bc-ab12cd', cwd: '/tmp/x' };
  assert.ok(isHarnessRef(born));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(born)), born);
  const adopted = { ...born, resumeId: '019f49a7-81f4-7ad3-822d-3acf8cf81ed6', window: 'w-card-7' };
  assert.ok(isHarnessRef(adopted));
});

test('resumable: ref.resumeId, else the relay-recorded session-id file, else false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  try {
    const ref = { harness: 'codex', session: 'bc-x1', cwd: '/tmp' };
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'no id anywhere');
    assert.strictEqual(await codex.resumable({ ...ref, resumeId: 'thread-1' }, { stateDir: dir }), true, 'ref carries the id');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), 'thread-recorded\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), true, 'recorded thread-id counts');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), '\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'blank record is no id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// status() resolves its thread-id the same way resume() does — the recorded
// session-id file it passes stateDir for, then the ref. Without that plumbing
// a codex lieutenant that never adopted a resumeId shows a blank context bar.
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

test('resumable for a window-granular ref reads the session:window keyed record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  try {
    const ref = { harness: 'codex', session: 'bc-lt-a', window: 'w-card-7', cwd: '/tmp' };
    // a record under the bare session name belongs to the LIEUTENANT, not this worker
    fs.writeFileSync(path.join(dir, 'bc-lt-a.session-id'), 'thread-lieutenant\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'never reads the cohabited session record');
    fs.writeFileSync(path.join(dir, 'bc-lt-a:w-card-7.session-id'), 'thread-worker\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn validates the window name before touching tmux: numeric or hostile names refused', async () => {
  // Same rule as claude (shared tmux-session.js plumbing): tmux parses a
  // numeric window "name" in a target as a window INDEX.
  for (const window of ['123', '7', '-w', 'w:x', 'w.x', '']) {
    await assert.rejects(
      codex.spawn('/tmp', 'hi', { session: 'bc-t', window }),
      /invalid window name/,
      `window "${window}" must be refused`);
  }
});

// Same guarantee as claude-tmux.test.js: the brief must never ride on the
// command line — a worker's own broad pattern-kill (against its own argv)
// could freeze or kill itself. Mock tmux.js (tmux-mock.js) and check exactly
// what got typed: the launch line (typed at launch) must be brief-free; the
// brief must show up ONLY in the later verified-submit (composer) call.
test('spawn never puts the brief on the launch line — it is typed into the composer after settle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state2-'));
  const mock = mockTmux({ readyTail: 'OpenAI Codex (v1.0.0)\nYOLO mode\n› ' });
  const brief = 'SECRET_BRIEF_MARKER: do the thing, then do the other thing.\nmulti-line too.';
  try {
    const ref = await codex.spawn(dir, brief, { session: 'bc-argvtest2', stateDir });
    assert.strictEqual(ref.harness, 'codex');

    const launchCall = mock.calls.find((c) => c.fn === 'sendLiteral');
    assert.ok(launchCall, 'the launch line must have been typed');
    assert.doesNotMatch(launchCall.args[1], /SECRET_BRIEF_MARKER/, 'launch line must not carry the brief');
    assert.match(launchCall.args[1], /codex --dangerously-bypass-approvals-and-sandbox/);

    const submitCall = mock.calls.find((c) => c.fn === 'submit');
    assert.ok(submitCall, 'the brief must have been delivered via verified submit');
    assert.strictEqual(submitCall.args[1], brief, 'the exact brief text is what gets typed into the composer');
    assert.ok(mock.calls.indexOf(submitCall) > mock.calls.indexOf(launchCall), 'brief delivery happens AFTER launch');

    // no tmux/tryTmux/sendKey call anywhere carries the brief either
    for (const c of mock.calls) {
      if (c.fn === 'submit') continue;
      assert.ok(!JSON.stringify(c.args).includes('SECRET_BRIEF_MARKER'),
        `${c.fn}(${JSON.stringify(c.args)}) must not carry the brief`);
    }

    // the prompt file (source of truth) still gets the exact brief
    const promptFile = path.join(stateDir, 'bc-argvtest2.prompt');
    assert.strictEqual(fs.readFileSync(promptFile, 'utf8'), brief);
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('slash commands: the shared trio only — codex has NO /autocompact (config scope, not a command)', async () => {
  const names = codex.commands().map((c) => c.name);
  assert.deepStrictEqual(names, ['/status', '/compact', '/help']);
  const ref = { harness: 'codex', session: 'bc-cmd', cwd: '/tmp' };
  await assert.rejects(() => codex.runCommand(ref, '/autocompact 80'), /unknown command \/autocompact/);
});

// Bug A: codex spawn used to return after the brief was typed without looking
// again, and its settle had no fatal screens — so a login picker or the update
// modal could be reported as a running session. Both halves are pinned here.
const CODEX_READY = 'OpenAI Codex (v0.155.1)\nYOLO mode\n› ';
const CODEX_LOGIN = '  Welcome to Codex\n\n  Sign in with ChatGPT to use Codex as part of your paid plan\n'
  + '  or connect an API key for usage-based billing\n\n› 1. Sign in with ChatGPT\n  2. Provide your own API key\n';

test('codex spawn refuses to report success over a screen that is waiting for a person', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  // settle sees the UI, then the pane turns into the login picker: only the
  // post-brief look can catch it
  const mock = mockTmux({ readyTail: [CODEX_READY, CODEX_LOGIN] });
  try {
    await assert.rejects(
      () => codex.spawn(dir, 'a brief', { session: 'bc-cx-verify', stateDir }),
      (e) => {
        assert.match(e.message, /needs a person/);
        assert.match(e.message, /Sign in with ChatGPT/, 'the screen rides back on the failure');
        return true;
      });
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a codex launch that can never come up ends the wait at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  const mock = mockTmux({ readyTail: '$ codex --dangerously-bypass-approvals-and-sandbox\nzsh: command not found: codex\n$ ' });
  try {
    await assert.rejects(
      () => codex.spawn(dir, 'a brief', { session: 'bc-cx-missing', stateDir }),
      /could not start[\s\S]*command not found: codex/);
    assert.strictEqual(mock.calls.filter((c) => c.fn === 'capture').length, 1, 'first look, not 90 of them');
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
