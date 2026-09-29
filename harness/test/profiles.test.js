'use strict';
// profiles — a harness is an adapter family plus a profile. What a derived
// JSON profile may say, how it merges over its base, and the secret rule: a
// value from the environment never reaches argv, the launch line typed into
// tmux, spawn-args, or `ps`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn: spawnProc } = require('node:child_process');
const { mockTmux } = require('./tmux-mock.js');
const port = require('../port.js');
const { resolveProfile, loadProfiles, expandEnv } = require('../profiles.js');
const claude = require('../claude-tmux.js');
const codex = require('../codex-tmux.js');

const READY = '⏵⏵ auto mode on (shift+tab to cycle)\n❯ ';
const BASES = { claude: claude.profile, codex: codex.profile };
const SECRET = 'sk-SECRET-7f3a9c';

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ---------- resolveProfile ----------

test('extends: the JSON overlays data on its base, and the behaviour stays the base\'s', () => {
  const p = resolveProfile({
    name: 'deepseek', extends: 'claude',
    env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_API_KEY}' },
    contextWindows: { deepseek: 128000 },
    requirements: { rootBypass: false },
    installHint: 'install claude, then export DEEPSEEK_API_KEY',
  }, BASES);
  assert.strictEqual(p.name, 'deepseek');
  assert.strictEqual(p.extends, 'claude');
  assert.strictEqual(p.launch, claude.profile.launch, 'the launch line is claude\'s');
  assert.strictEqual(p.settle.label, 'deepseek', 'errors name the profile the captain picked');
  assert.strictEqual(p.settle.readyRe, claude.profile.settle.readyRe);
  assert.deepStrictEqual(p.contextWindows[0], ['deepseek', 128000], 'derived windows come first');
  assert.ok(p.contextWindows.some(([n]) => n === 'opus'), 'the base windows remain');
  assert.deepStrictEqual(p.requirements, { bins: ['claude'], tmux: true, rootBypass: false });
  assert.strictEqual(p.installHint, 'install claude, then export DEEPSEEK_API_KEY');
  assert.strictEqual(claude.profile.name, 'claude', 'the base is not mutated');
  assert.deepStrictEqual(claude.profile.env, undefined);
});

test('an unknown base, a missing extends and an unknown field fail loudly', () => {
  assert.throws(() => resolveProfile({ name: 'x', extends: 'nope' }, BASES), /extends unknown profile "nope"/);
  assert.throws(() => resolveProfile({ name: 'x' }, BASES), /needs "extends"/);
  assert.throws(() => resolveProfile({ name: 'x', extends: 'claude', launch: 'rm -rf /' }, BASES), /unknown field "launch"/);
  assert.throws(() => resolveProfile({ name: 'X Y', extends: 'claude' }, BASES), /name must match/);
  assert.throws(() => resolveProfile({ name: 'x', extends: 'claude', adapter: 'ssh' }, BASES), /adapter must be/);
  assert.throws(() => resolveProfile({ name: 'x', adapter: 'acp' }, BASES), /needs a command/);
});

test('a literal secret is rejected; a secret-named key must be a ${NAME} reference', () => {
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'CLIENT_SECRET']) {
    assert.throws(() => resolveProfile({ name: 'x', extends: 'claude', env: { [k]: 'sk-literal' } }, BASES),
      /looks like a secret/, k);
  }
  assert.throws(() => resolveProfile({ name: 'x', extends: 'claude', env: { URL: 'https://${HOST}/v1' } }, BASES),
    /exactly \$\{NAME\}/, 'no interpolation inside a literal');
  const ok = resolveProfile({ name: 'x', extends: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${K}', MODEL: 'deepseek-chat' } }, BASES);
  assert.deepStrictEqual(ok.env, { ANTHROPIC_AUTH_TOKEN: '${K}', MODEL: 'deepseek-chat' });
});

// ---------- expandEnv ----------

test('expandEnv: the first source that has the name wins; a missing one is named, never blank', () => {
  const r = expandEnv({ A: '${X}', B: '${Y}', C: 'literal', D: '${NOPE}' },
    [{ X: 'from-env' }, { X: 'from-file', Y: 'file-only' }]);
  assert.deepStrictEqual(r.env, { A: 'from-env', B: 'file-only', C: 'literal' });
  assert.deepStrictEqual(r.missing, ['NOPE']);
});

// ---------- loadProfiles ----------

test('loadProfiles: registers a derived profile, records failures, never throws', () => {
  const logs = [];
  const res = loadProfiles({
    profiles: [
      { name: 'claude', builtin: true, plugin: 'claude' },
      { name: 'lp-derived', extends: 'claude', plugin: 'lp' },
      { name: 'lp-derived', extends: 'claude', plugin: 'lp2' },
      { name: 'codex', extends: 'claude', plugin: 'evil' },
      { name: 'lp-bad', extends: 'nope', plugin: 'lp' },
      { name: 'lp-literal', extends: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'sk-x' }, plugin: 'lp' },
      { name: 'lp-chain', extends: 'lp-derived', plugin: 'lp' },
    ],
    log: (m) => logs.push(m),
  });
  const by = (n, i = 0) => res.filter((r) => r.name === n)[i];
  assert.deepStrictEqual(by('claude'), { name: 'claude', plugin: 'claude', ok: true, builtin: true });
  assert.deepStrictEqual(by('lp-derived'), { name: 'lp-derived', plugin: 'lp', ok: true });
  assert.match(by('lp-derived', 1).error, /duplicate profile/);
  assert.match(by('codex').error, /duplicate profile "codex"/, 'a plugin cannot take over a built-in');
  assert.match(by('lp-bad').error, /extends unknown profile/);
  assert.match(by('lp-literal').error, /looks like a secret/);
  assert.strictEqual(by('lp-chain').ok, true, 'a derived profile can be a base');
  assert.strictEqual(logs.length, 4, 'every failure is logged');

  const impl = port.getHarness('lp-derived');
  assert.strictEqual(impl.profileInfo().name, 'lp-derived');
  assert.strictEqual(port.profileOf('lp-derived').extends, 'claude');
  const listed = port.listHarnesses().find((h) => h.name === 'lp-derived');
  // same binary, same transcripts: a derived profile resumes by hand like its base
  assert.deepStrictEqual(listed, { name: 'lp-derived', adapter: 'tmux', plugin: 'lp', handResume: 'claude --resume' });
});

test('an acp profile without the acp adapter records a clear error instead of crashing', () => {
  let hasAcp = true;
  try { require.resolve('../acp-adapter.js'); } catch { hasAcp = false; }
  const [r] = loadProfiles({ profiles: [{ name: 'lp-acp', adapter: 'acp', command: 'npx', args: ['x'], plugin: 'lp' }] });
  if (hasAcp) assert.strictEqual(typeof r.ok, 'boolean');
  else assert.deepStrictEqual(r, { name: 'lp-acp', plugin: 'lp', ok: false, error: 'acp adapter not available' });
});

test('an acp profile may declare model and effort as options; nothing else, and never a tmux one', () => {
  const acp = { name: 'lp-opt', adapter: 'acp', command: 'npx', args: ['x'] };
  assert.deepStrictEqual(resolveProfile({ ...acp, options: ['model', 'effort'] }, BASES).options, ['model', 'effort']);
  assert.strictEqual(resolveProfile(acp, BASES).options, undefined, 'undeclared: learned from a session');
  assert.throws(() => resolveProfile({ ...acp, options: ['permissionMode'] }, BASES), /may only list "model" and "effort"/);
  assert.throws(() => resolveProfile({ ...acp, options: 'model' }, BASES), /may only list/);
  assert.throws(() => resolveProfile({ name: 'lp-t', extends: 'claude', options: ['model'] }, BASES), /options is for acp profiles/);
});

test('an acp profile may name its ways out: a by-hand resume prefix and a desktop app link', () => {
  const acp = { name: 'lp-out', adapter: 'acp', command: 'npx' };
  const app = { label: 'Codex app', url: 'codex://threads/{id}' };
  const p = resolveProfile({ ...acp, handResume: 'codex resume', appResume: app }, BASES);
  assert.strictEqual(p.handResume, 'codex resume');
  assert.deepStrictEqual(p.appResume, app);
  assert.throws(() => resolveProfile({ ...acp, handResume: 'codex resume; rm -rf ~' }, BASES), /handResume must be/);
  assert.throws(() => resolveProfile({ ...acp, appResume: { label: 'x', url: 'codex://threads/' } }, BASES), /appResume must be/);
  assert.throws(() => resolveProfile({ ...acp, appResume: { url: 'codex://threads/{id}' } }, BASES), /appResume must be/);
  assert.throws(() => resolveProfile({ name: 'lp-t2', extends: 'claude', appResume: app }, BASES), /appResume is for acp profiles/);
});

// ---------- the port registry ----------

test('listHarnesses: sorted, fake only where tests ask for it; defaultHarness; splitOptions', () => {
  const had = { s: process.env.BC_FAKE_STATE, l: process.env.BC_LIST_FAKE };
  delete process.env.BC_FAKE_STATE; delete process.env.BC_LIST_FAKE;
  try {
    const names = port.listHarnesses().map((h) => h.name);
    assert.deepStrictEqual(names, [...names].sort());
    assert.ok(names.includes('claude') && names.includes('codex'));
    assert.ok(!names.includes('fake'));
    process.env.BC_LIST_FAKE = '1';
    assert.deepStrictEqual(port.listHarnesses().find((h) => h.name === 'fake'), { name: 'fake', adapter: 'fake' });
  } finally {
    if (had.s === undefined) delete process.env.BC_FAKE_STATE; else process.env.BC_FAKE_STATE = had.s;
    if (had.l === undefined) delete process.env.BC_LIST_FAKE; else process.env.BC_LIST_FAKE = had.l;
  }
  assert.strictEqual(port.defaultHarness(), 'claude');
  const noOpts = { profileInfo: () => ({ options: ['model'] }) };
  assert.deepStrictEqual(port.splitOptions(noOpts, { model: 'm', effort: 'high', x: '' }), { opts: { model: 'm' }, ignored: ['effort'] });
  assert.deepStrictEqual(port.splitOptions({}, { model: 'm' }), { opts: {}, ignored: ['model'] }, 'no profileInfo, no options');
});

// ---------- typed options ----------

test('modelArgs: claude spells --model/--effort, codex -m and the reasoning-effort config key', () => {
  assert.deepStrictEqual(claude.profile.modelArgs({ model: 'opus', effort: 'high' }), ['--model', 'opus', '--effort', 'high']);
  assert.deepStrictEqual(claude.profile.modelArgs({ effort: 'low' }), ['--effort', 'low']);
  assert.deepStrictEqual(codex.profile.modelArgs({ model: 'gpt-6', effort: 'high' }), ['-m', 'gpt-6', '-c', 'model_reasoning_effort=high']);
  assert.deepStrictEqual(codex.profile.modelArgs({}), []);
  for (const h of [claude, codex]) assert.deepStrictEqual(h.profileInfo().options, ['model', 'effort']);
});

const CODEX_READY = 'OpenAI Codex (v0.155.1)\nYOLO mode\n› ';
async function withLaunches(profileImpl, fn) {
  const cwd = tmpdir('bc-prof-cwd-');
  const stateDir = tmpdir('bc-prof-state-');
  const mock = mockTmux({ readyTail: profileImpl === codex ? CODEX_READY : READY });
  try {
    await fn(cwd, stateDir, mock);
    return mock;
  } finally {
    mock.restore();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
const lines = (mock) => mock.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]);

test('typed options ride the profile\'s own flags and a resume replays them from spawn-args', async () => {
  const mock = await withLaunches(codex, async (cwd, stateDir) => {
    const ref = await codex.spawn(cwd, 'go', { session: 'bc-typed', stateDir, model: 'gpt-6', effort: 'high' });
    const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'bc-typed.spawn-args'), 'utf8'));
    assert.strictEqual(rec.model, 'gpt-6');
    assert.strictEqual(rec.effort, 'high');
    await codex.resume({ ...ref, resumeId: 't-1' }, { stateDir });
  });
  const [spawnLine, resumeLine] = lines(mock);
  for (const l of [spawnLine, resumeLine]) {
    assert.match(l, /'-m' 'gpt-6' '-c' 'model_reasoning_effort=high'/);
    assert.doesNotMatch(l, /--effort/, 'claude\'s flag never reaches codex');
  }
});

// A lieutenant's pinned effort reaches claude the same way: spelled --effort on
// the spawn, and replayed from spawn-args on a resume that names none.
test('claude spells a typed effort as --effort on spawn and resume', async () => {
  const mock = await withLaunches(claude, async (cwd, stateDir) => {
    const ref = await claude.spawn(cwd, 'go', { session: 'bc-typed-c', stateDir, installHooks: false, effort: 'high' });
    await claude.resume({ ...ref, resumeId: '11111111-2222-3333-4444-555555555555' }, { stateDir });
  });
  const [spawnLine, resumeLine] = lines(mock);
  for (const l of [spawnLine, resumeLine]) {
    assert.match(l, /'--effort' 'high'/);
    assert.doesNotMatch(l, /model_reasoning_effort/, 'codex\'s key never reaches claude');
  }
});

// The settings modal suggests codex's own model names from its models cache.
// Hidden entries stay out, and anything unreadable is null, never a throw.
test('codexModels lists the cache\'s visible slugs with their effort levels, null when unreadable', () => {
  const dir = tmpdir('bc-codex-models-');
  try {
    const f = path.join(dir, 'models_cache.json');
    fs.writeFileSync(f, JSON.stringify({ models: [
      { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-5.5' },
    ] }));
    assert.deepStrictEqual(codex.codexModels(f), [
      { slug: 'gpt-6-astra', efforts: ['low', 'high'] },
      { slug: 'gpt-5.5', efforts: [] },
    ]);
    assert.strictEqual(codex.codexModels(path.join(dir, 'missing.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.strictEqual(codex.codexModels(path.join(dir, 'bad.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- env and secrets ----------

function derived(name, secretsDir) {
  const [r] = loadProfiles({
    profiles: [{ name, extends: 'claude', plugin: 'test',
      env: { ANTHROPIC_BASE_URL: 'https://api.example.test/anthropic', ANTHROPIC_AUTH_TOKEN: '${BC_TEST_SECRET_KEY}' } }],
    stateDir: secretsDir,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return port.getHarness(name);
}

test('a secret never reaches the launch line, spawn-args or any tmux call; the env file is 0600', async () => {
  const wsState = tmpdir('bc-prof-ws-');
  fs.writeFileSync(path.join(wsState, 'secrets.env'), 'BC_TEST_SECRET_KEY=' + SECRET + '\n');
  const h = derived('secret-derived', wsState);
  try {
    let envFile, spawnArgs, ref;
    const mock = await withLaunches(h, async (cwd, stateDir) => {
      ref = await h.spawn(cwd, 'go', { session: 'bc-sec', stateDir, installHooks: false, model: 'deepseek-chat' });
      envFile = path.join(stateDir, 'bc-sec.env');
      spawnArgs = fs.readFileSync(path.join(stateDir, 'bc-sec.spawn-args'), 'utf8');
      assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
      assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp('ANTHROPIC_AUTH_TOKEN=\'' + SECRET + '\''));
      assert.doesNotMatch(spawnArgs, new RegExp(SECRET));
      assert.match(spawnArgs, /\$\{BC_TEST_SECRET_KEY\}/, 'spawn-args keeps the template');

      // A rotated key lands on the next resume: the template is re-expanded.
      fs.writeFileSync(path.join(wsState, 'secrets.env'), 'BC_TEST_SECRET_KEY=sk-ROTATED\n');
      await h.resume(ref, { stateDir, installHooks: false });
      assert.match(fs.readFileSync(envFile, 'utf8'), /sk-ROTATED/);
    });
    assert.strictEqual(ref.harness, 'secret-derived');
    const [line] = lines(mock);
    assert.match(line, /^\( set -a; \. '.*bc-sec\.env'; set \+a; exec env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude /);
    assert.match(line, /'--model' 'deepseek-chat'/);
    for (const c of mock.calls) {
      const flat = JSON.stringify(c.args);
      assert.ok(!flat.includes(SECRET) && !flat.includes('sk-ROTATED'), c.fn + ' carried the secret');
    }
  } finally {
    fs.rmSync(wsState, { recursive: true, force: true });
  }
});

test('a missing secret fails the spawn before any pane exists, naming the variable', async () => {
  const h = derived('secret-missing', tmpdir('bc-prof-empty-'));
  delete process.env.BC_TEST_SECRET_KEY;
  const mock = await withLaunches(h, async (cwd, stateDir) => {
    await assert.rejects(h.spawn(cwd, 'go', { session: 'bc-nosec', stateDir, installHooks: false }),
      /missing \$\{BC_TEST_SECRET_KEY\}.*secrets\.env/);
  });
  assert.ok(!mock.calls.some((c) => c.fn === 'tmux' && c.args[0] === 'new-session'), 'no pane was created');
});

test('a profile without env launches bare and leaves no env file behind', async () => {
  await withLaunches(claude, async (cwd, stateDir) => {
    fs.writeFileSync(path.join(stateDir, 'bc-bare.env'), 'STALE=1\n');
    await claude.spawn(cwd, 'go', { session: 'bc-bare', stateDir, installHooks: false });
    assert.ok(!fs.existsSync(path.join(stateDir, 'bc-bare.env')));
  });
});

// The launch line run for real by a shell, against a stand-in CLI: the value
// reaches the CLI's environment, and no process's argv carries it.
test('the secret reaches the CLI\'s environment and is absent from ps', { skip: process.platform === 'win32' }, async () => {
  const wsState = tmpdir('bc-prof-ps-ws-');
  const bin = tmpdir('bc-prof-bin-');
  const cwd = tmpdir('bc-prof-ps-cwd-');
  const stateDir = tmpdir('bc-prof-ps-state-');
  const out = path.join(bin, 'seen');
  fs.writeFileSync(path.join(wsState, 'secrets.env'), 'BC_TEST_SECRET_KEY=' + SECRET + '\n');
  fs.writeFileSync(path.join(bin, 'claude'),
    '#!/bin/sh\nprintf %s "$ANTHROPIC_AUTH_TOKEN" > "' + out + '.tmp"; mv "' + out + '.tmp" "' + out + '"; sleep 3\n', { mode: 0o755 });
  const h = derived('secret-ps', wsState);
  const mock = mockTmux({ readyTail: READY });
  let child;
  try {
    await h.spawn(cwd, 'go', { session: 'bc-ps', stateDir, installHooks: false });
    mock.restore();
    const [line] = lines(mock);
    child = spawnProc('/bin/sh', ['-c', line], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(fs.readFileSync(out, 'utf8'), SECRET, 'the CLI got the value');
    const ps = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' });
    assert.ok(ps.includes(path.join(bin, 'claude')) || /sleep 3/.test(ps) || ps.includes('claude'), 'ps sees the process tree');
    assert.ok(!ps.includes(SECRET), 'no argv carries the secret');
  } finally {
    mock.restore();
    if (child) child.kill('SIGKILL');
    for (const d of [wsState, bin, cwd, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detectSelf and skillsDir: each profile answers for its own CLI only', () => {
  assert.deepStrictEqual(claude.profile.detectSelf({ CLAUDECODE: '1', CLAUDE_SESSION_ID: 'u-1' }), { resumeId: 'u-1' });
  assert.deepStrictEqual(claude.profile.detectSelf({ CLAUDECODE: '1' }), { resumeId: '' });
  assert.strictEqual(claude.profile.detectSelf({ CODEX_THREAD_ID: 't-1' }), null);
  assert.deepStrictEqual(codex.profile.detectSelf({ CODEX_THREAD_ID: 't-1' }), { resumeId: 't-1' });
  assert.strictEqual(codex.profile.detectSelf({ CLAUDECODE: '1' }), null);
  assert.strictEqual(claude.profile.skillsDir('/h'), path.join('/h', '.claude', 'skills'));
  assert.strictEqual(codex.profile.skillsDir('/h'), path.join('/h', '.codex', 'skills'));
});

// The 👁 drawer's "resume" item reads this from GET /api/plugins; a harness
// without it offers attach only.
test('listHarnesses carries a profile\'s by-hand resume prefix, and only when it has one', () => {
  const byName = Object.fromEntries(port.listHarnesses().map((h) => [h.name, h]));
  assert.strictEqual(byName.claude.handResume, 'claude --resume');
  assert.ok(!('handResume' in byName.codex));
});
