'use strict';
// bc-axi's plugin verbs against a live board: plugins (list, enable, disable),
// command run, activities, activity log [--follow], checks — and `init
// --onboard` running the enabled plugins' init checks without printing one twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, runCli, until, freePort, retryOnPortClash } = require('./helper');

const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'server', 'recorder');

function seedPlugin(dir, mutate) {
  const dest = path.join(dir, '.bridge-commander', 'plugins', 'recorder');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(FIXTURE, dest, { recursive: true });
  if (mutate) {
    const file = path.join(dest, 'plugin.json');
    fs.writeFileSync(file, JSON.stringify(mutate(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
  }
}

let s;
const cli = (...args) => runCli(['--workspace', s.dir, '--port', String(s.port), ...args]);
test.before(async () => {
  s = await startServerWithLieutenant({ seed: (d) => seedPlugin(d), env: { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' } });
  await until('recorder active', async () =>
    (await s.api('GET', '/api/plugins')).body.plugins.find((p) => p.id === 'recorder' && p.active));
  for (const c of [{ id: 'cli-1', title: 'One' }, { id: 'cli-fail', title: 'Fails', labels: ['failable'] }]) {
    await s.api('POST', '/api/cards', withOwner(c));
  }
});
test.after(async () => { if (s) await s.stop(); });

test('plugins: the list, then disable and enable through the overlay; an unknown id is refused', async () => {
  let r = await cli('plugins');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /^recorder\s+workspace\s+enabled\s+active$/m);
  assert.match(r.stdout, /^core-checks\s+shipped\s+enabled/m);
  r = await cli('plugins', 'disable', 'recorder');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /plugin recorder disabled/);
  assert.match((await cli('plugins')).stdout, /^recorder\s+workspace\s+disabled\s+idle$/m);
  r = await cli('plugins', 'enable', 'recorder');
  assert.match(r.stdout, /plugin recorder enabled/);
  assert.match((await cli('plugins')).stdout, /^recorder\s+workspace\s+enabled\s+active$/m);
  r = await cli('plugins', 'enable', 'nope');
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no plugin "nope"/);
  r = await cli('plugins', '--json');
  assert.ok(JSON.parse(r.stdout).some((p) => p.id === 'recorder'));
});

test('command run: an activity id, then activity log --follow prints it whole and exits 0', async () => {
  let r = await cli('command', 'run', 'recorder.echo', 'cli-1', '--input', 'word=zz');
  assert.strictEqual(r.code, 0, r.stderr);
  const id = /activity (r-[a-z0-9]+-[0-9a-f]{4}) started/.exec(r.stdout)[1];
  r = await cli('activity', 'log', id, '--follow');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /card cli-1\nword zz\n/);
  r = await cli('activities', '--card', 'cli-1');
  assert.match(r.stdout, new RegExp('^' + id + '\\s+ok\\s+.*cli-1\\s+recorder\\.echo', 'm'));
});

test('command run: a failing activity makes --follow exit 1; a link prints its URL; a server command its message', async () => {
  let r = await cli('command', 'run', 'recorder.fail', 'cli-fail');
  const id = /activity (\S+) started/.exec(r.stdout)[1];
  r = await cli('activity', 'log', id, '--follow');
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /about to fail/);
  assert.match(r.stderr, new RegExp('\\[activity ' + id + ' failed: exit 3\\]'));
  r = await cli('command', 'run', 'recorder.link', 'cli-1');
  assert.strictEqual(r.stdout.trim(), 'https://example.com/c/cli-1?t=One');
  r = await cli('command', 'run', 'recorder.greet', 'cli-1', '--input', 'name=Zed');
  assert.strictEqual(r.stdout.trim(), 'hello Zed on cli-1');
  r = await cli('command', 'run', 'recorder.greet', 'cli-1');
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /HTTP 400/);
  r = await cli('command', 'run', 'recorder.fail', 'cli-1');
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /does not apply.*HTTP 403/);
});

test('checks --phase: one line per check, failures with their fix', async () => {
  const r = await cli('checks', '--phase', 'init');
  assert.match(r.stdout, /^⚠ a binary nobody has: bc-definitely-not-a-binary not found on PATH\n {4}fix: install nothing {3}\[recorder\/nope\]$/m);
  const api = (await s.api('GET', '/api/checks?phase=init')).body.checks;
  assert.strictEqual(r.code, api.some((c) => !c.ok && c.severity === 'error') ? 1 : 0);
  const boot = await cli('checks', '--phase', 'boot');
  assert.match(boot.stdout, /^✓ always fine {3}\[recorder\/fine\]$/m);
});

// init --onboard: the plugins' init checks run before anything is written; an
// error-severity failure blocks it, a warning is said once and the run goes on.
function onboardEnv(home) {
  return { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig-none'), GIT_CONFIG_SYSTEM: '/dev/null' };
}

test('init --onboard: an error init check blocks it before the board exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onb-chk-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  try {
    seedPlugin(dir, (m) => {
      m.contributes.checks.push({ id: 'wall', phase: 'init', bin: 'bc-no-such-wall', title: 'the wall', severity: 'error', hint: 'build it' });
      return m;
    });
    const port = await freePort();
    const r = await runCli(['init', '--onboard', '--workspace', dir, '--port', String(port), '--harness', 'fake'], onboardEnv(home));
    assert.strictEqual(r.code, 1, r.stdout);
    assert.match(r.stderr, /first run blocked \(recorder\/wall\)\n\nthe wall: bc-no-such-wall not found on PATH\nfix: build it/);
    assert.ok(!fs.existsSync(path.join(dir, '.bridge-commander', 'board.json')), 'nothing booted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('init --onboard: a warning check is printed once, and git identity is not asked twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onb-warn-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  let port;
  try {
    seedPlugin(dir);
    let r;
    await retryOnPortClash(async () => {
      port = await freePort();
      r = await runCli(['init', '--onboard', '--workspace', dir, '--port', String(port), '--harness', 'fake'], onboardEnv(home));
      let log = '';
      try { log = fs.readFileSync(path.join(dir, '.bridge-commander', 'server.log'), 'utf8'); } catch (e) {}
      if (r.code !== 0 && /EADDRINUSE/.test(log)) throw new Error('EADDRINUSE');
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.strictEqual(r.stderr.split('a binary nobody has').length - 1, 1, r.stderr);
    assert.match(r.stderr, /git has no identity here/);
    assert.doesNotMatch(r.stderr, /git has an identity \(user\.name/, 'core-checks\' identity check is init\'s own, said once');
  } finally {
    if (port) await runCli(['stop', '--workspace', dir, '--port', String(port)]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
