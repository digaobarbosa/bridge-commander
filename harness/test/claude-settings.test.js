'use strict';
// harness/claude-settings.js — the one writer of .claude/settings.local.json,
// shared by the claude profile and `bc-axi init/open`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cs = require('../claude-settings.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const read = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, cs.SETTINGS_REL), 'utf8'));

test('hook, statusLine and outputStyle share the file without clobbering each other or a stranger', async () => {
  const cwd = tmpdir('bc-cs-');
  try {
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, cs.SETTINGS_REL), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    await cs.installTurnEndHook(cwd, 'ws', '/state', 'http://127.0.0.1:1/api/turn-end');
    await cs.installStatusLine(cwd);
    await cs.writeOutputStyle(cwd, 'Concise');
    const s = read(cwd);
    assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls)'] }, 'a key we do not own survives');
    assert.strictEqual(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /turnend-hook\.js' '\/state' 'ws' 'http:\/\/127\.0\.0\.1:1\/api\/turn-end'$/);
    assert.deepStrictEqual(s.statusLine, { type: 'command', command: "node '" + cs.STATUSLINE_SCRIPT + "'" });
    assert.strictEqual(s.outputStyle, 'Concise');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the Stop hook keeps ONE bc entry: a re-install is idempotent, a new key replaces the stale one', async () => {
  const cwd = tmpdir('bc-cs-');
  try {
    fs.mkdirSync(path.join(cwd, '.claude'));
    const foreign = { hooks: [{ type: 'command', command: 'node their-hook.js' }] };
    fs.writeFileSync(path.join(cwd, cs.SETTINGS_REL), JSON.stringify({ hooks: { Stop: [foreign] } }));
    await cs.installTurnEndHook(cwd, 'bc-a', '/state', '');
    await cs.installTurnEndHook(cwd, 'bc-a', '/state', '');
    assert.strictEqual(read(cwd).hooks.Stop.length, 2, 'idempotent, and the foreign hook stays');
    await cs.installTurnEndHook(cwd, 'bc-b', '/state', '');
    const stop = read(cwd).hooks.Stop;
    assert.strictEqual(stop.length, 2);
    assert.deepStrictEqual(stop[0], foreign);
    assert.match(stop[1].hooks[0].command, /'bc-b'$/, 'the stale bc entry was replaced');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a corrupt settings file is replaced, and the file is kept out of git', async () => {
  const repo = tmpdir('bc-cs-git-');
  try {
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, cs.SETTINGS_REL), '{ not json');
    await cs.installStatusLine(repo);
    assert.ok(read(repo).statusLine);
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.strictEqual(status, '', 'the settings file never dirties the worktree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
