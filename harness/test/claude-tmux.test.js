'use strict';
// claude facts only — the port's promises are in conformance.test.js, the
// screens in settle-screens.test.js, the style list in output-style.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../claude-tmux.js');
const { mockTmux } = require('./tmux-mock.js');

const READY = '⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ';

async function launchLines(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const mock = mockTmux({ readyTail: READY });
  try {
    await fn(cwd, stateDir);
    return mock.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]);
  } finally {
    mock.restore();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('launch line: no ghost-text suggestions, bypass permissions, and the resume id minted at birth', async () => {
  let ref;
  const [line] = await launchLines(async (cwd, stateDir) => {
    ref = await claude.spawn(cwd, 'go', { session: 'bc-cl', stateDir, installHooks: false, extraArgs: ['--model', 'opus'] });
  });
  assert.match(ref.resumeId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(line,
    `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions --session-id ${ref.resumeId} '--model' 'opus'`);
});

test('resume line: `--resume <id>` with a known id, a bare claude without one', async () => {
  const lines = await launchLines(async (cwd, stateDir) => {
    await claude.resume({ harness: 'claude', session: 'bc-cr', cwd, resumeId: 'uuid-9' }, { stateDir, installHooks: false });
    await claude.resume({ harness: 'claude', session: 'bc-cr2', cwd }, { stateDir, installHooks: false });
  });
  assert.strictEqual(lines[0], 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions --resume uuid-9');
  assert.strictEqual(lines[1], 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions');
});

// --allow-root is the ONLY thing that puts IS_SANDBOX=1 on a launch line: it is
// the guard claude itself checks, and it is never switched off on our own say-so.
test('IS_SANDBOX rides the launch line only when the caller asked for it (and only as root)', async () => {
  const plain = await launchLines((cwd, stateDir) => claude.spawn(cwd, 'go', { session: 'bc-sbx', stateDir, installHooks: false }));
  const asked = await launchLines((cwd, stateDir) => claude.spawn(cwd, 'go', { session: 'bc-sbx', stateDir, installHooks: false, allowRoot: true }));
  assert.doesNotMatch(plain[0], /IS_SANDBOX/);
  if (typeof process.getuid === 'function' && process.getuid() === 0) assert.match(asked[0], /^IS_SANDBOX=1 /);
  else assert.doesNotMatch(asked[0], /IS_SANDBOX/, 'off root the consent is inert');
});

test('spawn installs the Stop hook in the cwd unless told not to', async () => {
  let cwdSeen;
  await launchLines(async (cwd, stateDir) => {
    cwdSeen = cwd;
    await claude.spawn(cwd, 'go', { session: 'bc-hook', stateDir, callbackUrl: 'http://127.0.0.1:1/api/turn-end' });
    const s = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(s.hooks.Stop[0].hooks[0].command, /turnend-hook\.js' '[^']+' 'bc-hook' 'http:\/\/127\.0\.0\.1:1\/api\/turn-end'$/);
    await claude.spawn(cwd, 'go', { session: 'bc-hook2', stateDir, installHooks: false });
    const again = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(again.hooks.Stop[0].hooks[0].command, /'bc-hook'/, 'installHooks:false leaves the existing hook alone');
  });
  assert.ok(cwdSeen);
});

test('slash commands: /autocompact is a pass-through typed into the session', async () => {
  const mock = mockTmux({ readyTail: READY });
  try {
    // alive() reads `agent` in the pane only when the window exists
    const tmuxMod = require('../tmux.js');
    tmuxMod.tmuxRead = async (...args) => (args[0] === 'display-message' ? 'claude' : '');
    const reply = await claude.runCommand({ harness: 'claude', session: 'bc-ac', cwd: '/tmp' }, '/autocompact 80');
    assert.match(reply, /"\/autocompact 80" submitted to bc-ac/);
    assert.strictEqual(mock.calls.find((c) => c.fn === 'submit').args[1], '/autocompact 80');
  } finally { mock.restore(); }
});
