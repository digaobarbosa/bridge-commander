'use strict';
// plugins/core-checks — the checks bridge-commander itself needs, declared as a
// shipped plugin and run through server/checks.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const manifests = require('../server/manifests.js');
const { createChecks } = require('../server/checks.js');

const DIR = path.join(__dirname, '..', 'plugins', 'core-checks');

test('core-checks validates and declares the five checks at their phases and severities', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  const m = manifests.validateManifest(raw, 'core-checks');
  assert.strictEqual(manifests.readManifest(DIR).id, 'core-checks');
  const got = m.contributes.checks.map((c) => [c.id, c.bin ? 'bin' : 'exec', c.phase, c.severity]);
  assert.deepStrictEqual(got, [
    ['tmux', 'bin', 'init', 'error'],
    ['git', 'bin', 'init', 'error'],
    ['git-identity', 'exec', 'init', 'warn'],
    ['gh', 'bin', 'boot', 'warn'],
    ['treehouse', 'bin', 'boot', 'warn'],
  ]);
  for (const c of m.contributes.checks) assert.ok(c.hint && c.title, c.id + ' has a hint and a title');
  assert.match(m.contributes.checks[0].hint, /brew install tmux/);
  assert.match(m.contributes.checks[0].hint, /apt install tmux/);
  assert.match(m.contributes.checks[4].hint, /optional; git worktree is used otherwise/);
});

test('core-checks is discovered as a shipped plugin with no error', () => {
  const found = manifests.discover({}).find((p) => p.id === 'core-checks');
  assert.ok(found && found.manifest && !found.error, JSON.stringify(found));
  assert.strictEqual(found.source, 'shipped');
});

test('core-checks runs through createChecks: a missing tmux is an error with its hint', async () => {
  const m = manifests.readManifest(DIR);
  const c = createChecks({
    which: (n) => (n === 'git' ? '/usr/bin/git' : null),
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  for (const chk of m.contributes.checks) c.register(c.fromManifest(chk, { plugin: m.id, dir: DIR }));
  const init = await c.run('init');
  const byId = Object.fromEntries(init.map((r) => [r.id, r]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['git', 'git-identity', 'tmux']);
  assert.deepStrictEqual([byId.tmux.ok, byId.tmux.severity], [false, 'error']);
  assert.match(byId.tmux.fix, /brew install tmux/);
  assert.strictEqual(byId.git.ok, true);
  assert.deepStrictEqual([byId['git-identity'].ok, byId['git-identity'].severity], [false, 'warn']);
  assert.match(byId['git-identity'].fix, /git config --global user.name/);
  const boot = await c.run('boot');
  assert.deepStrictEqual(boot.map((r) => r.id).sort(), ['gh', 'treehouse']);
});
