'use strict';
// The plugins that ship with the board (plugins/*) and the documented example
// (docs/examples/plugins/*): their manifests load, their `when`s compile, their
// exec lines quote what the card supplies, and the ones that are safe to run
// run for real — local-git against a temp repo with a linked worktree, the
// editor and rfslot commands against fake binaries on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { readManifest, resolveCatalog, writeOverlay, contributions } = require('../server/manifests.js');
const { createPluginHost } = require('../server/plugins.js');
const { planRun, loadPure, shellQuote } = require('../server/commands.js');

const ROOT = path.join(__dirname, '..');
const SHIPPED = path.join(ROOT, 'plugins');
const EXAMPLES = path.join(ROOT, 'docs', 'examples', 'plugins');
const FIX = path.join(__dirname, 'fixtures', 'shipped');
const HOSTILE = "x'; touch PWNED #";

function dirsOf(root) {
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
}
const ALL = [...dirsOf(SHIPPED), ...dirsOf(EXAMPLES)];
const manifestOf = (dir) => readManifest(dir);
const commandOf = (dir, id) => Object.assign({ plugin: path.basename(dir) }, manifestOf(dir).contributes.commands.find((c) => c.id === id));

function tmp(prefix) { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix)); }

/** A bin dir holding fake executables that print their argv, one per line. */
function fakeBin(names) {
  const bin = tmp('bc-shipped-bin-');
  for (const n of names) {
    fs.writeFileSync(path.join(bin, n), '#!/bin/sh\necho "' + n + '"\nfor a in "$@"; do echo "[$a]"; done\necho "owner=$RFSLOT_OWNER"\n', { mode: 0o755 });
  }
  return bin;
}

/** Run a planned exec the way runs.js does: /bin/sh -c, in its cwd, with its env. */
function runPlan(plan, extraPath) {
  const env = Object.assign({}, process.env, plan.env);
  if (extraPath) env.PATH = extraPath + ':' + env.PATH;
  return spawnSync('/bin/sh', ['-c', plan.shell], { cwd: plan.cwd, env, encoding: 'utf8', timeout: 30000 });
}

async function contextFor(card, projects) {
  const { cardContext } = await import(pathToFileURL(path.join(ROOT, 'ui', 'js', 'cardview.js')).href);
  return cardContext(card, { cards: [card], projects: projects || [], workers: [] });
}

test('every shipped and example plugin folder passes readManifest', () => {
  assert.ok(ALL.some((d) => d.endsWith(path.join('plugins', 'github'))), 'github ships');
  for (const dir of ALL) {
    assert.doesNotThrow(() => manifestOf(dir), dir);
    // A server or ui module the manifest names must be there to load.
    const m = manifestOf(dir);
    for (const f of [m.server, m.ui]) if (f) assert.ok(fs.existsSync(path.join(dir, f)), dir + ': ' + f + ' exists');
  }
});

test('every `when` of every shipped and example plugin compiles; menus name a declared command', async () => {
  const { compileWhen } = await loadPure();
  for (const dir of ALL) {
    const c = manifestOf(dir).contributes;
    const ids = new Set(c.commands.map((x) => x.id));
    for (const [slot, entries] of Object.entries(c.menus)) {
      for (const e of entries) {
        assert.doesNotThrow(() => compileWhen(e.when), dir + ' ' + slot + ' ' + e.command);
        assert.ok(ids.has(e.command), dir + ': menu names its own command ' + e.command);
      }
    }
    for (const e of [...c.badges, ...c.sections]) assert.doesNotThrow(() => compileWhen(e.when), dir + ' ' + e.id);
  }
});

test('the `when`s show each command on the cards it is for', async () => {
  const { matches } = await loadPure();
  const whenOf = (dir, cmd) => manifestOf(dir).contributes.menus['card.menu/v1'].find((e) => e.command === cmd).when;
  const project = [{ name: 'app', path: '/p/app' }];
  const bare = await contextFor({ id: 'C-1', column: 'backlog', attributes: {} }, project);
  const full = await contextFor({ id: 'C-2', column: 'review', attributes: {
    repo: 'app', branch: 'feat', worktree: '/w/C-2', prs: [{ url: 'https://github.com/o/r/pull/7', state: 'open' }] } }, project);
  const done = await contextFor({ id: 'C-3', column: 'done', attributes: { repo: 'app', branch: 'feat', worktree: '/w/C-3' } }, project);
  const cases = [
    [path.join(SHIPPED, 'github'), 'github.open-pr'],
    [path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.open'],
    [path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.reveal'],
    [path.join(SHIPPED, 'local-git'), 'local-git.checkout'],
    [path.join(EXAMPLES, 'rfslot'), 'rfslot.deploy'],
  ];
  for (const [dir, cmd] of cases) {
    assert.strictEqual(matches(whenOf(dir, cmd), bare), false, cmd + ' hides on a bare card');
    assert.strictEqual(matches(whenOf(dir, cmd), full), true, cmd + ' shows on a full card');
  }
  // rfslot is for cards in flight only.
  assert.strictEqual(matches(whenOf(path.join(EXAMPLES, 'rfslot'), 'rfslot.deploy'), done), false);
  assert.strictEqual(matches(whenOf(path.join(SHIPPED, 'local-git'), 'local-git.checkout'), done), true);
  // No project known for the card: nowhere to check out.
  const orphan = await contextFor({ id: 'C-4', column: 'working', attributes: { repo: 'gone', branch: 'feat' } }, project);
  assert.strictEqual(matches(whenOf(path.join(SHIPPED, 'local-git'), 'local-git.checkout'), orphan), false);
});

// ---------- acp-agents: claude-acp and codex-acp ----------

test('acp-agents contributes claude-acp and codex-acp as pinned acp profiles that honor model and effort', () => {
  const port = require('../harness/port.js');
  const { loadProfiles } = require('../harness/profiles.js');
  const m = manifestOf(path.join(SHIPPED, 'acp-agents'));
  assert.notStrictEqual(m.enabled, false, 'on by default: nothing else changes for claude or codex');
  const profiles = m.contributes.profiles.map((p) => Object.assign({ plugin: 'acp-agents' }, p));
  assert.deepStrictEqual(profiles.map((p) => p.name), ['claude-acp', 'codex-acp']);
  for (const p of profiles) {
    // an unpinned npx fetch would move under the board every day
    assert.ok(p.args.some((a) => /^@agentclientprotocol\/[a-z-]+@\d+\.\d+\.\d+$/.test(a)), p.name + ' pins its package: ' + p.args);
  }
  assert.ok(profiles[1].args.every((a) => !a.startsWith('@zed-industries/')), 'not the dead codex-acp');

  const before = ['claude', 'codex'].map((n) => port.listHarnesses().find((h) => h.name === n));
  const res = loadProfiles({ profiles, stateDir: tmp('bc-acp-agents-') });
  assert.deepStrictEqual(res, [{ name: 'claude-acp', plugin: 'acp-agents', ok: true }, { name: 'codex-acp', plugin: 'acp-agents', ok: true }]);
  for (const name of ['claude-acp', 'codex-acp']) {
    const impl = port.getHarness(name);
    const info = impl.profileInfo();
    assert.strictEqual(info.adapter, 'acp');
    assert.deepStrictEqual(info.options, ['model', 'effort'], name + ' pins both from the first spawn');
    assert.deepStrictEqual(info.requirements.bins, ['npx']);
    assert.deepStrictEqual(port.splitOptions(impl, { model: 'm', effort: 'high' }), { opts: { model: 'm', effort: 'high' }, ignored: [] });
    assert.strictEqual(typeof impl.interrupt, 'function', name + ' can be interrupted from the board');
  }
  // The ways out of the drawer: the ACP session id IS the CLI's (verified on
  // real sessions), so the plain CLI and the desktop app reopen it.
  const listed = (n) => port.listHarnesses().find((h) => h.name === n);
  assert.strictEqual(listed('claude-acp').handResume, 'claude --resume');
  assert.deepStrictEqual(listed('claude-acp').appResume, { label: 'Claude desktop', url: 'claude://resume?session={id}' });
  assert.strictEqual(listed('codex-acp').handResume, 'codex resume');
  assert.deepStrictEqual(listed('codex-acp').appResume, { label: 'Codex app', url: 'codex://threads/{id}' });
  assert.deepStrictEqual(['claude', 'codex'].map((n) => port.listHarnesses().find((h) => h.name === n)), before,
    'the tmux claude and codex are untouched');
});

// ---------- github: the PR watch belongs to the plugin ----------

function fakeCtx(internal) {
  const ctx = { logs: [], regs: [], plugin: { id: 'github' }, log(m) { ctx.logs.push(m); },
    watchers: { register(spec) { ctx.regs.push(spec); return () => {}; } } };
  if (internal !== undefined) ctx.internal = internal;
  return ctx;
}

test('github server.js registers the PR watch from ctx.internal, and does nothing without it', () => {
  const mod = require(path.join(SHIPPED, 'github', 'server.js'));
  const tick = async () => {};
  const withIt = fakeCtx({ prWatch: { tick }, prWatchIntervalMs: 4321 });
  mod.activate(withIt);
  assert.deepStrictEqual(withIt.regs, [{ id: 'prwatch', intervalMs: 4321, tick }]);

  const without = fakeCtx();
  assert.doesNotThrow(() => mod.activate(without));
  assert.deepStrictEqual(without.regs, []);
  assert.match(without.logs.join('\n'), /no internal PR watch/);
});

test('through the real host: github registers github/prwatch at boot; disabling it stops the PR watch', async () => {
  const run = async (overlay) => {
    const stateDir = tmp('bc-shipped-host-');
    if (overlay) writeOverlay(stateDir, overlay);
    const regs = [];
    const watchers = { register(spec) { regs.push(spec); return () => regs.splice(regs.indexOf(spec), 1); } };
    const tick = async () => {};
    const host = createPluginHost({
      catalog: () => resolveCatalog({ shippedDir: SHIPPED, stateDir }),
      log: () => {}, api: {}, internal: { prWatch: { tick }, prWatchIntervalMs: 120000 }, watchers,
    });
    await host.bootActivate();
    return { host, regs, tick };
  };
  const on = await run();
  assert.deepStrictEqual(on.regs.map((r) => [r.id, r.intervalMs, r.tick === on.tick]), [['github/prwatch', 120000, true]]);
  assert.strictEqual(on.host.status().find((s) => s.id === 'github').active, true);
  await on.host.deactivate('github');
  assert.deepStrictEqual(on.regs, [], 'deactivation unwinds the watcher');

  const off = await run({ plugins: { github: { enabled: false } } });
  assert.deepStrictEqual(off.regs, []);
  // The shipped catalog carries every contribution of this wave.
  const c = contributions(on.host.catalog());
  for (const id of ['github.open-pr', 'open-in-editor.open', 'open-in-editor.reveal', 'local-git.checkout']) {
    assert.ok(c.commands.some((x) => x.id === id), id);
  }
  assert.ok(c.sections.some((s) => s.key === 'section:prs' && s.plugin === 'github'));
});

test('github.open-pr plans a link to the first PR; the GitHub section escapes everything', async () => {
  const dir = path.join(SHIPPED, 'github');
  const ctx = await contextFor({ id: 'C-1', column: 'review', attributes: { prs: [{ url: 'https://github.com/o/r/pull/7', state: 'open' }] } });
  const plan = await planRun(commandOf(dir, 'github.open-pr'), { context: ctx, workspace: '/ws' });
  assert.deepStrictEqual(plan, { kind: 'open', url: 'https://github.com/o/r/pull/7', input: {} });

  const { prsHtml } = await import(pathToFileURL(path.join(dir, 'ui.js')).href);
  const { esc } = await import(pathToFileURL(path.join(ROOT, 'ui', 'js', 'util.js')).href);
  const html = prsHtml({ attributes: { prs: [
    { url: 'https://github.com/o/r/pull/7', state: 'merged' },
    { url: 'https://github.com/o/r/pull/8"><script>x</script>', state: '<b>' },
    { url: 'javascript:alert(1)', state: 'open', number: 9 },
  ] } }, esc);
  assert.match(html, /o\/r #7/);
  assert.match(html, /pr-merged/);
  assert.ok(!html.includes('<script>') && !html.includes('<b>'), 'no raw markup');
  assert.ok(!html.includes('href="javascript:'), 'only web links become hrefs');
  assert.match(html, /#9/);
  assert.match(prsHtml({ attributes: {} }, esc), /No pull requests/);
});

test('repo-link: a card-less link in the topbar and the palette, shown with no card', async () => {
  const dir = path.join(EXAMPLES, 'repo-link');
  const { EMPTY_CONTEXT } = await import(pathToFileURL(path.join(ROOT, 'ui', 'js', 'cardview.js')).href);
  const plan = await planRun(commandOf(dir, 'repo-link.open'), { context: EMPTY_CONTEXT, workspace: '/ws' });
  assert.strictEqual(plan.kind, 'open');
  assert.match(plan.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  const { matches } = await loadPure();
  const menus = manifestOf(dir).contributes.menus;
  assert.deepStrictEqual(Object.keys(menus).sort(), ['palette/v1', 'topbar/v1']);
  for (const e of Object.values(menus).flat()) assert.strictEqual(matches(e.when, EMPTY_CONTEXT), true);
});

// ---------- exec commands: every substitution is one quoted word ----------

test('planRun of every exec command quotes the card values; a hostile branch and path stay literal', async () => {
  const wt = tmp('bc-shipped-wt-');
  const hostileDir = path.join(wt, HOSTILE);
  fs.mkdirSync(hostileDir);
  const card = { id: 'C-9', column: 'working', attributes: { repo: 'app', branch: HOSTILE, worktree: hostileDir } };
  const ctx = await contextFor(card, [{ name: 'app', path: '/p/' + HOSTILE }]);
  const cases = [
    [path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.open', {}, { editor: 'cursor' }],
    [path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.reveal', {}, { editor: 'cursor' }],
    [path.join(SHIPPED, 'local-git'), 'local-git.checkout', { mode: 'detach' }, {}],
    [path.join(EXAMPLES, 'rfslot'), 'rfslot.deploy', { slot: HOSTILE, services: 'emulators app' }, {}],
  ];
  for (const [dir, id, input, config] of cases) {
    const plan = await planRun(commandOf(dir, id), { context: ctx, input, config, workspace: '/ws' });
    assert.strictEqual(plan.kind, 'exec', id + ': ' + JSON.stringify(plan));
    // Strip every quoted word: whatever is left is the template's own text,
    // which must not contain the hostile value.
    const bare = plan.shell.split(shellQuote(HOSTILE)).join('').split(shellQuote(hostileDir)).join('')
      .split(shellQuote('/p/' + HOSTILE)).join('');
    assert.ok(!bare.includes('touch PWNED'), id + ': raw text in ' + plan.shell);
    assert.strictEqual(plan.env.BC_CARD, 'C-9');
    assert.strictEqual(plan.cwd, hostileDir, id + ' runs in the worktree');
  }
  const rf = await planRun(commandOf(path.join(EXAMPLES, 'rfslot'), 'rfslot.deploy'),
    { context: ctx, input: { slot: '2' }, workspace: '/ws' });
  assert.strictEqual(rf.env.RFSLOT_OWNER, 'C-9', 'the lease owner is the card');
  assert.strictEqual(rf.env.BC_INPUT_SERVICES, 'emulators app', 'the services default');
  assert.strictEqual(rf.tracked, true);
});

test('open-in-editor runs for real with the editor swapped for echo: the path arrives as one argument', async () => {
  const wt = tmp('bc-shipped-ed-');
  const dir = path.join(wt, HOSTILE);
  fs.mkdirSync(dir);
  const ctx = await contextFor({ id: 'C-1', column: 'working', attributes: { worktree: dir } });
  const plan = await planRun(commandOf(path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.open'),
    { context: ctx, config: { editor: 'echo' }, workspace: wt });
  const r = runPlan(plan);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, dir + '\n');
  assert.ok(!fs.existsSync(path.join(dir, 'PWNED')) && !fs.existsSync(path.join(wt, 'PWNED')));

  // reveal: `open` on macOS, `xdg-open` elsewhere — both faked, each prints its argv.
  const bin = fakeBin(['open', 'xdg-open']);
  const rev = await planRun(commandOf(path.join(SHIPPED, 'open-in-editor'), 'open-in-editor.reveal'), { context: ctx, workspace: wt });
  const rr = runPlan(rev, bin);
  assert.strictEqual(rr.status, 0, rr.stderr);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  assert.strictEqual(rr.stdout.split('\n')[0], opener);
  assert.match(rr.stdout, new RegExp('^\\[' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]$', 'm'));
});

test('rfslot.deploy runs against a fake rfslot: slot and path are single words, services split, owner is the card', async () => {
  const wt = tmp('bc-shipped-rf-');
  const ctx = await contextFor({ id: 'C-5', column: 'working', attributes: { worktree: wt } });
  const bin = fakeBin(['rfslot']);
  const plan = await planRun(commandOf(path.join(EXAMPLES, 'rfslot'), 'rfslot.deploy'),
    { context: ctx, input: { slot: 'digao-a', services: 'emulators app' }, workspace: wt });
  const r = runPlan(plan, bin);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, [
    'rfslot', '[use]', '[digao-a]', '[--from]', '[' + wt + ']', '[--watch]', 'owner=C-5',
    'rfslot', '[start]', '[digao-a]', '[emulators]', '[app]', 'owner=C-5', ''].join('\n'));
});

// ---------- local-git: a real checkout in a temp repo ----------

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function repoWithWorktree() {
  const root = tmp('bc-shipped-git-');
  const proj = path.join(root, 'proj');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(proj);
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['init', '-q', '-b', 'main', proj]);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'one\n');
  git(proj, 'add', 'a.txt');
  git(proj, ...id, 'commit', '-q', '-m', 'one');
  git(proj, 'branch', 'other');
  git(proj, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
  git(wt, ...id, 'commit', '-q', '-am', 'two');
  return { root, proj, wt, featSha: git(wt, 'rev-parse', 'HEAD') };
}

async function checkoutPlan(r, branch, mode) {
  const ctx = await contextFor({ id: 'C-7', column: 'working', attributes: { repo: 'proj', branch, worktree: r.wt } },
    [{ name: 'proj', path: r.proj }]);
  return planRun(commandOf(path.join(SHIPPED, 'local-git'), 'local-git.checkout'),
    { context: ctx, input: { mode }, workspace: r.root, pluginDir: path.join(SHIPPED, 'local-git') });
}

// How BC provisions a worker: a DETACHED worktree whose branch name is only a
// plan until the worker's first commit creates it.
test('local-git.checkout: a worktree whose branch does not exist yet → detach takes the worktree HEAD; branch mode explains', async () => {
  const r = repoWithWorktree();
  const bcWt = path.join(r.root, 'bc-wt');
  git(r.proj, 'worktree', 'add', '-q', '--detach', bcWt, 'feat');
  fs.writeFileSync(path.join(bcWt, 'b.txt'), 'worker\n');
  git(bcWt, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', 'b.txt');
  git(bcWt, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'worker commit');
  fs.writeFileSync(path.join(bcWt, 'b.txt'), 'uncommitted\n');
  const ctx = await contextFor({ id: 'C-8', column: 'working', attributes: { repo: 'proj', branch: 'bc/C-8', worktree: bcWt } },
    [{ name: 'proj', path: r.proj }]);
  const plan = (mode) => planRun(commandOf(path.join(SHIPPED, 'local-git'), 'local-git.checkout'),
    { context: ctx, input: { mode }, workspace: r.root, pluginDir: path.join(SHIPPED, 'local-git') });
  let out = runPlan(await plan('detach'));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(git(r.proj, 'rev-parse', 'HEAD'), git(bcWt, 'rev-parse', 'HEAD'), 'the project is at the worker\'s commit');
  assert.match(out.stdout, /uncommitted changes; they are not part of this checkout/);
  git(r.proj, 'switch', '-q', 'main');
  out = runPlan(await plan('branch'));
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /bc\/C-8 does not exist yet/);
});

test('local-git.checkout: clean project → detached at the branch commit; dirty → exit 1 with the reason', async () => {
  const r = repoWithWorktree();
  let plan = await checkoutPlan(r, 'feat');
  assert.strictEqual(plan.env.BC_INPUT_MODE, 'detach', 'detach is the default');
  let out = runPlan(plan);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(git(r.proj, 'rev-parse', 'HEAD'), r.featSha);
  assert.strictEqual(spawnSync('git', ['-C', r.proj, 'symbolic-ref', '-q', 'HEAD']).status, 1, 'HEAD is detached');
  assert.match(out.stdout, /detached/);

  git(r.proj, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(r.proj, 'a.txt'), 'local edit\n');
  out = runPlan(await checkoutPlan(r, 'feat'));
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /has uncommitted changes/);
  assert.match(out.stderr, /a\.txt/);
  assert.strictEqual(git(r.proj, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing moved');
  assert.strictEqual(fs.readFileSync(path.join(r.proj, 'a.txt'), 'utf8'), 'local edit\n', 'the edit is untouched');

  // An untracked file is not an uncommitted change: git itself guards it.
  fs.writeFileSync(path.join(r.proj, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(r.proj, 'scratch.txt'), 'x\n');
  out = runPlan(await checkoutPlan(r, 'feat'));
  assert.strictEqual(out.status, 0, out.stderr);
});

test('local-git.checkout mode=branch: refused while a worktree holds the branch; switches when none does', async () => {
  const r = repoWithWorktree();
  let out = runPlan(await checkoutPlan(r, 'feat', 'branch'));
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /checked out in the worktree .*wt/);
  assert.match(out.stderr, /only one place/);
  assert.strictEqual(git(r.proj, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  out = runPlan(await checkoutPlan(r, 'other', 'branch'));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(git(r.proj, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other');

  out = runPlan(await checkoutPlan(r, 'other', 'branch'));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /already on other/);
});

test('local-git.checkout with a hostile branch name fails as git, never as the shell', async () => {
  const r = repoWithWorktree();
  // detach takes the worktree's HEAD, so the name never reaches git there; branch
  // mode hands it to git, which refuses it. Neither runs it as shell.
  for (const mode of ['detach', 'branch']) {
    const out = runPlan(await checkoutPlan(r, HOSTILE, mode));
    if (mode === 'branch') assert.notStrictEqual(out.status, 0);
    for (const d of [r.root, r.proj, r.wt, process.cwd()]) assert.ok(!fs.existsSync(path.join(d, 'PWNED')), mode + ': ' + d);
  }
  // Without a worktree the branch name is the target, and one shaped like an option is refused.
  const ctx = await contextFor({ id: 'C-9', column: 'review', attributes: { repo: 'proj', branch: '--orphan=x' } },
    [{ name: 'proj', path: r.proj }]);
  const opt = runPlan(await planRun(commandOf(path.join(SHIPPED, 'local-git'), 'local-git.checkout'),
    { context: ctx, input: { mode: 'detach' }, workspace: r.root, pluginDir: path.join(SHIPPED, 'local-git') }));
  assert.strictEqual(opt.status, 1);
  assert.match(opt.stderr, /looks like an option|no usable branch/);
});

// ---------- rfslot prepare ----------

function fakeExecFile(result) {
  return (cmd, args, opts, cb) => {
    assert.strictEqual(cmd, 'rfslot');
    assert.deepStrictEqual(args, ['ls']);
    assert.ok(opts.timeout > 0, 'ls runs with a timeout');
    setImmediate(() => (result.error ? cb(result.error, '', '') : cb(null, result.stdout, '')));
  };
}

test('rfslot prepare parses the captured `rfslot ls` and pre-fills the first free or expired slot', async () => {
  const rf = require(path.join(EXAMPLES, 'rfslot', 'server.js'));
  // Captured from a real `rfslot ls` on a machine with one cloud slot.
  const captured = fs.readFileSync(path.join(FIX, 'rfslot-ls.txt'), 'utf8');
  assert.deepStrictEqual(rf.parseLs(captured), [
    { slot: 'digao-a', cloud: true, container: 'suspended', lease: 'expired (digao)', takeable: true }]);
  let logs = [];
  let values = await rf.makePrepare((m) => logs.push(m), fakeExecFile({ stdout: captured }))();
  assert.deepStrictEqual(values, { services: 'emulators app', slot: 'digao-a' });

  // Local slots, printed with rfslot's own printf format: slot1 is leased,
  // slot2 is free but its container is down, slot3's lease expired.
  const local = fs.readFileSync(path.join(FIX, 'rfslot-ls-local.txt'), 'utf8');
  const slots = rf.parseLs(local);
  assert.deepStrictEqual(slots.map((s) => [s.slot, s.lease, s.takeable]), [
    ['1', 'CMD-40 until 2026-09-26 18:00', false], ['2', 'free', true], ['3', 'expired (CMD-12)', true],
    ['4', 'free', true], ['digao-a', 'expired (digao)', true]]);
  values = await rf.makePrepare(() => {}, fakeExecFile({ stdout: local }))();
  assert.strictEqual(values.slot, '3');

  // No rfslot: the defaults, and the reason in the plugin log.
  const enoent = Object.assign(new Error('spawn rfslot ENOENT'), { code: 'ENOENT' });
  logs = [];
  values = await rf.makePrepare((m) => logs.push(m), fakeExecFile({ error: enoent }))();
  assert.deepStrictEqual(values, { services: 'emulators app' });
  assert.match(logs.join('\n'), /not on the server PATH/);

  // Every slot taken: the defaults, and the reason.
  logs = [];
  values = await rf.makePrepare((m) => logs.push(m), fakeExecFile({ stdout: local.split('\n').slice(0, 3).join('\n') }))();
  assert.deepStrictEqual(values, { services: 'emulators app' });
  assert.match(logs.join('\n'), /no slot with a free or expired lease/);

  // activate() hands the prepare to the host under the command's own id.
  const handled = [];
  rf.activate({ log: () => {}, commands: { handle: (id, impl) => handled.push([id, typeof impl.prepare]) } });
  assert.deepStrictEqual(handled, [['rfslot.deploy', 'function']]);
});
