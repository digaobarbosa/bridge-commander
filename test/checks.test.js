'use strict';
// server/checks.js — startup checks: bin on PATH, exec in the plugin folder,
// hint -> fix, run(phase) with timings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChecks, which } = require('../server/checks.js');

function tmp() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bc-checks-')); }

test('which: a pure PATH scan finds executables, skips non-executables and dirs', () => {
  const a = tmp(), b = tmp();
  fs.writeFileSync(path.join(a, 'tool'), 'not executable');
  fs.mkdirSync(path.join(a, 'dirtool'));
  fs.writeFileSync(path.join(b, 'tool'), '#!/bin/sh\n');
  fs.chmodSync(path.join(b, 'tool'), 0o755);
  const env = { PATH: [a, '', b].join(path.delimiter) };
  assert.strictEqual(which('tool', env), path.join(b, 'tool'));
  assert.strictEqual(which('dirtool', env), null);
  assert.strictEqual(which('nope', env), null);
  assert.strictEqual(which('', env), null);
  assert.strictEqual(which(path.join(b, 'tool'), { PATH: '' }), path.join(b, 'tool'));
});

test('fromManifest bin: ok names the path; missing turns the hint into fix', async () => {
  const found = { tmux: '/usr/bin/tmux' };
  const c = createChecks({ which: (n) => found[n] || null });
  c.register(c.fromManifest({ id: 'tmux', phase: 'init', bin: 'tmux', severity: 'error', hint: 'install tmux' }, { plugin: 'core' }));
  c.register(c.fromManifest({ id: 'th', phase: 'init', bin: 'treehouse', hint: 'optional' }, { plugin: 'core' }));
  const res = await c.run('init');
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.strictEqual(byId.tmux.ok, true);
  assert.match(byId.tmux.message, /\/usr\/bin\/tmux/);
  assert.strictEqual(byId.tmux.fix, null);
  assert.strictEqual(byId.tmux.severity, 'error');
  assert.strictEqual(byId.tmux.plugin, 'core');
  assert.strictEqual(byId.th.ok, false);
  assert.strictEqual(byId.th.severity, 'warn'); // the default
  assert.strictEqual(byId.th.fix, 'optional');
  assert.strictEqual(byId.th.title, 'th');
  for (const r of res) assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
});

test('fromManifest exec: runs /bin/sh in the plugin folder; exit 0 = ok, first line = message', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'marker'), 'x');
  const c = createChecks();
  c.register(c.fromManifest({ id: 'here', phase: 'boot', exec: 'test -f marker && echo "  " && echo found it && echo second' }, { plugin: 'p', dir }));
  c.register(c.fromManifest({ id: 'fails', phase: 'boot', exec: 'echo broken >&2; exit 3', hint: 'fix it' }, { plugin: 'p', dir }));
  c.register(c.fromManifest({ id: 'silent', phase: 'boot', exec: 'exit 4' }, { plugin: 'p', dir }));
  c.register(c.fromManifest({ id: 'slow', phase: 'boot', exec: 'sleep 5', timeoutMs: 100 }, { plugin: 'p', dir }));
  const byId = Object.fromEntries((await c.run('boot')).map((r) => [r.id, r]));
  assert.deepStrictEqual([byId.here.ok, byId.here.message], [true, 'found it']);
  assert.deepStrictEqual([byId.fails.ok, byId.fails.message, byId.fails.fix], [false, 'broken', 'fix it']);
  assert.deepStrictEqual([byId.silent.ok, byId.silent.message], [false, 'exited 4']);
  assert.deepStrictEqual([byId.slow.ok, byId.slow.message], [false, 'timed out']);
});

test('exec goes through the injected runner with the plugin dir as cwd', async () => {
  const calls = [];
  const c = createChecks({ exec: async (cmd, opts) => { calls.push([cmd, opts.cwd]); return { code: 0, stdout: 'Ada\nada@x', stderr: '' }; } });
  c.register(c.fromManifest({ id: 'ident', phase: 'init', exec: 'git config user.name' }, { plugin: 'core', dir: '/plug' }));
  const [r] = await c.run('init');
  assert.deepStrictEqual(calls, [['git config user.name', '/plug']]);
  assert.strictEqual(r.message, 'Ada');
});

test('run(phase) picks the phase; a throwing or hanging check fails without sinking the rest', async () => {
  const logs = [];
  const c = createChecks({ log: (m) => logs.push(m), timeoutMs: 50 });
  c.register({ id: 'ok', plugin: 'x', phase: 'boot', run: () => ({ ok: true, message: 'fine' }) });
  c.register({ id: 'throws', plugin: 'x', phase: 'boot', run: async () => { throw new Error('kaput'); } });
  c.register({ id: 'hangs', plugin: 'x', phase: 'boot', run: () => new Promise(() => {}) });
  c.register({ id: 'later', plugin: 'x', phase: 'card-start', severity: 'error', run: () => ({ ok: false, fix: 'do x' }) });
  const boot = await c.run('boot');
  assert.deepStrictEqual(boot.map((r) => [r.id, r.ok]), [['ok', true], ['throws', false], ['hangs', false]]);
  assert.strictEqual(boot[1].message, 'kaput');
  assert.match(boot[2].message, /no answer/);
  assert.ok(logs.some((m) => /x\/throws/.test(m)));
  const later = await c.run('card-start');
  assert.deepStrictEqual(later.map((r) => [r.id, r.ok, r.fix, r.severity]), [['later', false, 'do x', 'error']]);
  assert.strictEqual((await c.run()).length, 4);
});

test('register refuses bad shapes and duplicates per plugin; dispose removes', async () => {
  const c = createChecks();
  assert.throws(() => c.register({ plugin: 'p', run: () => ({}) }), /id required/);
  assert.throws(() => c.register({ id: 'a', plugin: 'p' }), /run must be a function/);
  assert.throws(() => c.register({ id: 'a', plugin: 'p', severity: 'fatal', run: () => ({}) }), /severity/);
  const dispose = c.register({ id: 'a', plugin: 'p', run: () => ({ ok: true }) });
  c.register({ id: 'a', plugin: 'q', run: () => ({ ok: true }) }); // same id, other plugin: fine
  assert.throws(() => c.register({ id: 'a', plugin: 'p', run: () => ({}) }), /already registered/);
  dispose();
  assert.deepStrictEqual((await c.run('boot')).map((r) => r.plugin), ['q']);
});
