'use strict';
// Conformance — ONE suite, run against every tmux profile (claude, codex) and,
// where the case applies, the fake. What the port promises is checked here
// once; each profile's own test file keeps only facts about its CLI.
//
// The tmux profiles run on harness/test/tmux-mock.js: no tmux process, every
// call recorded, and the pane shows whatever screens the case hands it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mockTmux } = require('./tmux-mock.js');
const { isHarnessRef, VERBS } = require('../port.js');

const SUBJECTS = [
  {
    name: 'claude',
    impl: require('../claude-tmux.js'),
    idAtBirth: true,
    extra: ['/autocompact', '/output-style'],
    ready: '⏵⏵ auto mode on (shift+tab to cycle)\n❯ ',
    // the consent modal --dangerously-skip-permissions raises: "No, exit" preselected
    modal: '  WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept',
    modalRe: /Yes, I accept/,
    fatal: '$ claude --dangerously-skip-permissions\n'
      + '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n$ ',
    fatalRe: /root\/sudo/,
  },
  {
    name: 'codex',
    impl: require('../codex-tmux.js'),
    idAtBirth: false,
    extra: [],
    ready: 'OpenAI Codex (v0.155.1)\nYOLO mode\n› ',
    modal: '  Sign in with ChatGPT to use Codex as part of your paid plan\n\n› 1. Sign in with ChatGPT\n  2. Provide your own API key',
    modalRe: /Sign in with ChatGPT/,
    fatal: '$ codex --dangerously-bypass-approvals-and-sandbox\nzsh: command not found: codex\n$ ',
    fatalRe: /command not found: codex/,
  },
];
const fake = require('../fake.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
// A cwd + stateDir pair, removed after fn.
async function withDirs(fn) {
  const cwd = tmpdir('bc-conf-cwd-');
  const stateDir = tmpdir('bc-conf-state-');
  try { return await fn(cwd, stateDir); } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
async function withMock(screens, fn, extra = {}) {
  const mock = mockTmux({ readyTail: screens, ...extra });
  try { return await fn(mock); } finally { mock.restore(); }
}
const launches = (mock) => mock.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]);
// A ref's keys must be real: `undefined` values do not survive JSON and read
// as a different shape to anyone comparing refs.
function assertCleanRef(ref, harness) {
  assert.ok(isHarnessRef(ref), JSON.stringify(ref));
  assert.strictEqual(ref.harness, harness);
  for (const [k, v] of Object.entries(ref)) assert.notStrictEqual(v, undefined, `key ${k} is undefined`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ref)), ref);
}

test('every subject exposes the seven verbs and the optional ones the server uses', () => {
  for (const impl of [...SUBJECTS.map((x) => x.impl), fake]) {
    for (const verb of VERBS.concat(['openPane', 'paneSnapshot', 'paneInput', 'commands', 'runCommand', 'status', 'adoptWindow'])) {
      assert.strictEqual(typeof impl[verb], 'function', verb);
    }
  }
});

for (const sub of SUBJECTS) {
  const h = sub.impl;
  const n = sub.name;

  test(`${n}: spawn validates the window name before touching tmux`, async () => {
    // tmux parses a numeric window "name" in a target as a window INDEX.
    for (const window of ['123', '7', '-w', 'w:x', 'w.x', '']) {
      await assert.rejects(h.spawn('/tmp', 'hi', { session: 'bc-t', window }), /invalid window name/, `window "${window}"`);
    }
  });

  // A brief in argv is visible to `ps` for the session's life, and an agent's
  // own broad pattern-kill (against its own argv) could freeze or kill itself.
  test(`${n}: spawn never puts the brief on the launch line — it is typed into the composer after settle`, async () => {
    await withDirs((cwd, stateDir) => withMock(sub.ready, async (mock) => {
      const brief = 'SECRET_BRIEF_MARKER: do the thing.\nmulti-line too.';
      await h.spawn(cwd, brief, { session: 'bc-argv', stateDir });
      const launch = mock.calls.find((c) => c.fn === 'sendLiteral');
      const submit = mock.calls.find((c) => c.fn === 'submit');
      assert.doesNotMatch(launch.args[1], /SECRET_BRIEF_MARKER/);
      assert.strictEqual(submit.args[1], brief);
      assert.ok(mock.calls.indexOf(submit) > mock.calls.indexOf(launch), 'brief after launch');
      for (const c of mock.calls) {
        if (c.fn !== 'submit') assert.ok(!JSON.stringify(c.args).includes('SECRET_BRIEF_MARKER'), c.fn);
      }
      assert.strictEqual(fs.readFileSync(path.join(stateDir, 'bc-argv.prompt'), 'utf8'), brief, 'the prompt file is the source of truth');
    }));
  });

  test(`${n}: spawn returns a clean ref — resumeId only when known at birth, window only when asked`, async () => {
    await withDirs((cwd, stateDir) => withMock(sub.ready, async () => {
      const ref = await h.spawn(cwd, 'go', { session: 'bc-shape', stateDir, installHooks: false });
      assertCleanRef(ref, n);
      assert.strictEqual(ref.cwd, path.resolve(cwd));
      assert.ok(!('window' in ref));
      assert.strictEqual('resumeId' in ref, sub.idAtBirth);
      const w = await h.spawn(cwd, 'go', { session: 'bc-shape', window: 'w-1', stateDir, installHooks: false });
      assert.strictEqual(w.window, 'w-1');
      assertCleanRef(w, n);
    }));
  });

  // The success path is the one nobody re-reads: a settle can match a screen
  // that only looks like the UI, and the brief then lands in a menu.
  test(`${n}: spawn refuses to report success over a screen that is waiting for a person`, async () => {
    await withDirs((cwd, stateDir) => withMock([sub.ready, sub.modal], async () => {
      await assert.rejects(() => h.spawn(cwd, 'a brief', { session: 'bc-modal', stateDir, installHooks: false }),
        (e) => { assert.match(e.message, sub.modalRe, 'the screen rides back on the failure'); return true; });
      assert.ok(!fs.existsSync(path.join(stateDir, 'bc-modal.prompt')), 'no prompt file left for a session that never was');
    }));
  });

  test(`${n}: a launch that can never come up ends the wait at once, with the pane attached`, async () => {
    await withDirs((cwd, stateDir) => withMock(sub.fatal, async (mock) => {
      await assert.rejects(() => h.spawn(cwd, 'a brief', { session: 'bc-fatal', stateDir, installHooks: false }),
        (e) => { assert.match(e.message, /could not start/); assert.match(e.message, sub.fatalRe); return true; });
      assert.strictEqual(mock.calls.filter((c) => c.fn === 'capture').length, 1, 'the first look, not 90 of them');
    }));
  });

  test(`${n}: resumable — ref.resumeId, else the relay's record, never a blank one or a sibling's`, async () => {
    await withDirs(async (_cwd, dir) => {
      const ref = { harness: n, session: 'bc-x1', cwd: '/tmp' };
      assert.strictEqual(await h.resumable(ref, { stateDir: dir }), false);
      assert.strictEqual(await h.resumable({ ...ref, resumeId: 'id-1' }, { stateDir: dir }), true);
      fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), '\n');
      assert.strictEqual(await h.resumable(ref, { stateDir: dir }), false, 'blank record is no id');
      fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), 'id-recorded\n');
      assert.strictEqual(await h.resumable(ref, { stateDir: dir }), true);
      // a window-granular worker never reads the record of the session it cohabits
      const w = { ...ref, window: 'w-card-7' };
      assert.strictEqual(await h.resumable(w, { stateDir: dir }), false);
      fs.writeFileSync(path.join(dir, 'bc-x1:w-card-7.session-id'), 'id-worker\n');
      assert.strictEqual(await h.resumable(w, { stateDir: dir }), true);
    });
  });

  test(`${n}: resume prefers the recorded id over the ref's and replays the spawn's flags`, async () => {
    await withDirs((cwd, stateDir) => withMock(sub.ready, async (mock) => {
      const ref = await h.spawn(cwd, 'go', { session: 'bc-rs', stateDir, installHooks: false, extraArgs: ['--model', 'm-1'] });
      fs.writeFileSync(path.join(stateDir, 'bc-rs.session-id'), 'id-recorded\n');
      const before = launches(mock).length;
      const back = await h.resume({ ...ref, resumeId: 'id-stale' }, { stateDir, installHooks: false });
      const line = launches(mock).slice(before).join('\n');
      assert.strictEqual(back.resumeId, 'id-recorded');
      assert.match(line, /id-recorded/);
      assert.doesNotMatch(line, /id-stale/);
      assert.match(line, /'--model' 'm-1'/, 'a revival is not a demotion to the default model');
      assertCleanRef(back, n);
    }));
  });

  test(`${n}: resume with no recoverable id comes back fresh, with NO resumeId key`, async () => {
    await withDirs((cwd, stateDir) => withMock(sub.ready, async () => {
      const back = await h.resume({ harness: n, session: 'bc-noid', window: 'lt', cwd }, { stateDir, installHooks: false });
      assert.ok(!('resumeId' in back), JSON.stringify(back));
      assert.strictEqual(back.window, 'lt');
      assertCleanRef(back, n);
    }));
  });

  test(`${n}: alive throws when tmux cannot be read, and is false when tmux says the pane is gone`, async () => {
    const ref = { harness: n, session: 'bc-lt', window: 'w-card', cwd: '/tmp' };
    await withMock(sub.ready, async () => {
      await assert.rejects(() => h.alive(ref), /tmux/);
    }, { readFails: true });
    await withMock(sub.ready, async () => {
      assert.strictEqual(await h.alive(ref), false);
    });
  });

  test(`${n}: send to a dead session throws; kill of a missing one is a no-op`, async () => {
    await withMock(sub.ready, async (mock) => {
      const ref = { harness: n, session: 'bc-dead', cwd: '/tmp' };
      await assert.rejects(() => h.send(ref, 'hi'), /not alive/);
      await h.kill(ref);
      await h.kill({ ...ref, window: 'w-1' });
      assert.ok(!mock.calls.some((c) => /^kill-/.test(String(c.args[0]))), 'nothing to kill, nothing killed');
    });
  });

  test(`${n}: commands — the shared trio, then the profile's own; /help lists them; unknown throws untouched`, async () => {
    await withMock(sub.ready, async (mock) => {
      assert.deepStrictEqual(h.commands().map((c) => c.name), ['/status', '/compact', '/help'].concat(sub.extra));
      const ref = { harness: n, session: 'bc-cmd', cwd: '/tmp' };
      const help = await h.runCommand(ref, '/help');
      for (const c of h.commands()) assert.ok(help.includes(c.name + ' — '), c.name);
      await assert.rejects(() => h.runCommand(ref, '/nope'), /unknown command \/nope/);
      await assert.rejects(() => h.runCommand(ref, '/status', { stateDir: tmpdir('bc-conf-st-') }), /no status for bc-cmd/);
      assert.deepStrictEqual(mock.calls.filter((c) => c.fn === 'submit' || c.fn === 'sendLiteral'), [], 'nothing typed');
    });
  });
}

// adoptWindow — the migration that pins an already-running session-granular
// agent to its own window. The agent must be RENAMED, never killed.
function stubTryTmux(windows) {
  const tmuxMod = require('../tmux.js');
  const original = tmuxMod.tryTmux;
  const calls = [];
  tmuxMod.tryTmux = async (...args) => {
    calls.push(args);
    if (args[0] === 'has-session') return windows ? '' : null;
    if (args[0] === 'list-windows') {
      if (!windows) return null;
      const f = args[args.indexOf('-F') + 1];
      return windows.map(([i, name]) => (f.includes('window_index') ? i + '\t' + name : name)).join('\n');
    }
    if (args[0] === 'rename-window') return '';
    return null;
  };
  return { calls, restore() { tmuxMod.tryTmux = original; } };
}

for (const sub of SUBJECTS) {
  const h = sub.impl;
  test(`${sub.name}: adoptWindow renames the session's FIRST window, refuses a worker's, and is idempotent`, async () => {
    const ref = { harness: sub.name, session: 'bc-lt-ada', cwd: '/tmp' };
    let stub = stubTryTmux([['0', 'node'], ['1', 'w-card-7']]);
    try {
      assert.deepStrictEqual(await h.adoptWindow(ref, 'lt', ['w-card-7']), { ...ref, window: 'lt' });
      assert.deepStrictEqual(stub.calls.find((c) => c[0] === 'rename-window'), ['rename-window', '-t', '=bc-lt-ada:0', 'lt']);
      assert.ok(!stub.calls.some((c) => /^kill-/.test(c[0])), 'renamed, never killed');
    } finally { stub.restore(); }
    stub = stubTryTmux([['1', 'w-card-7']]); // the agent's own window is gone
    try {
      assert.strictEqual(await h.adoptWindow(ref, 'lt', ['w-card-7']), null);
      assert.ok(!stub.calls.some((c) => c[0] === 'rename-window'));
    } finally { stub.restore(); }
    stub = stubTryTmux(null); // no live session: nothing to rename
    try {
      assert.deepStrictEqual(await h.adoptWindow(ref, 'lt', []), { ...ref, window: 'lt' });
      const done = { ...ref, window: 'lt' };
      assert.strictEqual(await h.adoptWindow(done, 'lt', []), done);
    } finally { stub.restore(); }
  });
}

// ---------- the fake, where the same promises apply ----------
test('fake: spawn returns a clean ref; resume with no memory comes back with NO resumeId key', async () => {
  fake.reset();
  const ref = await fake.spawn('/tmp/x', 'go', { session: 'bc-fshape' });
  assertCleanRef(ref, 'fake');
  assert.ok(typeof ref.resumeId === 'string', 'the fake knows its id at birth, like claude');
  const w = await fake.spawn('/tmp/x', 'go', { session: 'bc-fshape', window: 'w-1' });
  assert.strictEqual(w.window, 'w-1');
  const fresh = await fake.resume({ harness: 'fake', session: 'bc-fnoid', window: 'lt', cwd: '/tmp/x' });
  assert.ok(!('resumeId' in fresh), JSON.stringify(fresh));
  assertCleanRef(fresh, 'fake');
});

test('fake: send to a dead session throws; kill of a missing one is a no-op', async () => {
  fake.reset();
  const ref = await fake.spawn('/tmp/x', 'go', { session: 'bc-fdead' });
  fake.kill(ref);
  await assert.rejects(() => fake.send(ref, 'hi'), /not alive/);
  fake.kill({ harness: 'fake', session: 'bc-nobody', cwd: '/tmp' });
  fake.kill(ref);
});

test('fake: commands — the shared trio; /help lists them; unknown throws; /status of nothing throws', async () => {
  fake.reset();
  assert.deepStrictEqual(fake.commands().map((c) => c.name), ['/status', '/compact', '/help']);
  const ref = { harness: 'fake', session: 'bc-fcmd', cwd: '/tmp' };
  const help = await fake.runCommand(ref, '/help');
  for (const c of fake.commands()) assert.ok(help.includes(c.name + ' — '), c.name);
  await assert.rejects(() => fake.runCommand(ref, '/nope'), /unknown command \/nope/);
  await assert.rejects(() => fake.runCommand(ref, '/status'), /no status for bc-fcmd/);
});
