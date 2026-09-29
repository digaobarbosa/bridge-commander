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

const READY = '⏵⏵ auto mode on (shift+tab to cycle)\n❯ ';
const PREFIX = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude';

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

test('launch line: no ghost-text suggestions, auto permission mode, and the resume id minted at birth', async () => {
  let ref;
  const [line] = await launchLines(async (cwd, stateDir) => {
    ref = await claude.spawn(cwd, 'go', { session: 'bc-cl', stateDir, installHooks: false, extraArgs: ['--model', 'opus'] });
  });
  assert.match(ref.resumeId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(line, `${PREFIX} --permission-mode 'auto' --session-id ${ref.resumeId} '--model' 'opus'`);
});

// The launch line is the whole contract with claude about permissions: bypass
// is the old skip-everything flag, every other mode keeps claude's prompts so
// the PermissionRequest hook can relay them to the board.
test('the launch line carries the permission mode; bypass is the only skip-permissions launch', async () => {
  const spawnLine = async (opts) => (await launchLines((cwd, stateDir) =>
    claude.spawn(cwd, 'go', { session: 'bc-mode', stateDir, installHooks: false, ...opts })))[0];
  for (const mode of ['default', 'acceptEdits', 'auto']) {
    const line = await spawnLine({ permissionMode: mode });
    assert.match(line, new RegExp(`claude --permission-mode '${mode}' --session-id `));
    assert.doesNotMatch(line, /dangerously/);
  }
  const bypass = await spawnLine({ permissionMode: 'bypass', extraArgs: ['--model', 'opus'] });
  assert.match(bypass, /claude --dangerously-skip-permissions --session-id \S+ '--model' 'opus'$/);
  assert.doesNotMatch(bypass, /--permission-mode/);
});

test('resume line: `--resume <id>` with a known id, a bare claude without one', async () => {
  const lines = await launchLines(async (cwd, stateDir) => {
    await claude.resume({ harness: 'claude', session: 'bc-cr', cwd, resumeId: 'uuid-9' }, { stateDir, installHooks: false });
    await claude.resume({ harness: 'claude', session: 'bc-cr2', cwd }, { stateDir, installHooks: false });
  });
  assert.strictEqual(lines[0], `${PREFIX} --permission-mode 'auto' --resume uuid-9`);
  assert.strictEqual(lines[1], `${PREFIX} --permission-mode 'auto'`);
});

// An agent never comes back looser than it was born.
test('resume replays the spawn\'s permission mode, and opts wins over the record', async () => {
  const lines = await launchLines(async (cwd, stateDir) => {
    const ref = { harness: 'claude', session: 'bc-mode', cwd, resumeId: 'u-1' };
    const resume = (opts) => claude.resume(ref, { stateDir, installHooks: false, ...opts });
    await claude.spawn(cwd, 'go', { session: 'bc-mode', stateDir, installHooks: false, permissionMode: 'acceptEdits' });
    await resume({});
    await resume({ permissionMode: 'default' });
    await claude.spawn(cwd, 'go', { session: 'bc-mode', window: 'w', stateDir, installHooks: false, permissionMode: 'bypass' });
    await claude.resume({ ...ref, window: 'w' }, { stateDir, installHooks: false });
    // A record from before permission modes (flags only) resumes in the default mode.
    fs.writeFileSync(path.join(stateDir, 'bc-mode.spawn-args'), JSON.stringify({ args: ['--model', 'opus'] }));
    await resume({});
  });
  assert.match(lines[1], /claude --permission-mode 'acceptEdits' --resume u-1$/);
  assert.match(lines[2], /claude --permission-mode 'default' --resume u-1$/);
  assert.match(lines[4], /claude --dangerously-skip-permissions --resume u-1$/);
  assert.match(lines[5], /claude --permission-mode 'auto' --resume u-1 '--model' 'opus'$/);
});

// --allow-root is the ONLY thing that puts IS_SANDBOX=1 on a launch line: it is
// the guard claude itself checks, and it is never switched off on our own say-so.
// It only matters in bypass: no other mode trips claude's uid-0 refusal.
test('IS_SANDBOX rides the launch line only when the caller asked for it (and only as root, in bypass)', async () => {
  const line = async (opts) => (await launchLines((cwd, stateDir) =>
    claude.spawn(cwd, 'go', { session: 'bc-sbx', stateDir, installHooks: false, ...opts })))[0];
  assert.doesNotMatch(await line({ permissionMode: 'bypass' }), /IS_SANDBOX/);
  assert.doesNotMatch(await line({ allowRoot: true }), /IS_SANDBOX/, 'auto mode never needs it');
  const asked = await line({ allowRoot: true, permissionMode: 'bypass' });
  if (typeof process.getuid === 'function' && process.getuid() === 0) assert.match(asked, /^IS_SANDBOX=1 /);
  else assert.doesNotMatch(asked, /IS_SANDBOX/, 'off root the consent is inert');
});

test('spawn installs the Stop and PermissionRequest hooks in the cwd unless told not to', async () => {
  let cwdSeen;
  await launchLines(async (cwd, stateDir) => {
    cwdSeen = cwd;
    await claude.spawn(cwd, 'go', { session: 'bc-hook', stateDir, callbackUrl: 'http://127.0.0.1:1/api/turn-end' });
    const s = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(s.hooks.Stop[0].hooks[0].command, /turnend-hook\.js' '[^']+' 'bc-hook' 'http:\/\/127\.0\.0\.1:1\/api\/turn-end'$/);
    assert.match(s.hooks.PermissionRequest[0].hooks[0].command,
      /permission-hook\.js' '[^']+' 'bc-hook' 'http:\/\/127\.0\.0\.1:1\/api\/permission'$/);
    await claude.spawn(cwd, 'go', { session: 'bc-hook2', stateDir, installHooks: false });
    const again = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(again.hooks.Stop[0].hooks[0].command, /'bc-hook'/, 'installHooks:false leaves the existing hook alone');
    assert.match(again.hooks.PermissionRequest[0].hooks[0].command, /'bc-hook'/);
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
