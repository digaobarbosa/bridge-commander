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
    await cs.installHooks(cwd, 'ws', '/state', 'http://127.0.0.1:1/api/turn-end');
    await cs.installStatusLine(cwd);
    await cs.writeOutputStyle(cwd, 'Concise');
    const s = read(cwd);
    assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls)'] }, 'a key we do not own survives');
    assert.strictEqual(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /turnend-hook\.js' '\/state' 'ws' 'http:\/\/127\.0\.0\.1:1\/api\/turn-end'$/);
    assert.strictEqual(s.hooks.PermissionRequest.length, 1);
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
    await cs.installHooks(cwd, 'bc-a', '/state', '');
    await cs.installHooks(cwd, 'bc-a', '/state', '');
    assert.strictEqual(read(cwd).hooks.Stop.length, 2, 'idempotent, and the foreign hook stays');
    await cs.installHooks(cwd, 'bc-b', '/state', '');
    const stop = read(cwd).hooks.Stop;
    assert.strictEqual(stop.length, 2);
    assert.deepStrictEqual(stop[0], foreign);
    assert.match(stop[1].hooks[0].command, /'bc-b'$/, 'the stale bc entry was replaced');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('installHooks writes ONE PermissionRequest entry pointing at /api/permission, and keeps other tools\' hooks', async () => {
  const cwd = tmpdir('bc-cs-');
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] };
  try {
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, cs.SETTINGS_REL), JSON.stringify({ hooks: { PermissionRequest: [theirs] } }));

    await cs.installHooks(cwd, 'bc-a', '/state', 'http://127.0.0.1:4780/api/turn-end');
    let pr = read(cwd).hooks.PermissionRequest;
    assert.strictEqual(pr.length, 2);
    assert.deepStrictEqual(pr[0], theirs, 'another tool\'s entry survives');
    assert.strictEqual(pr[1].matcher, '*');
    assert.strictEqual(pr[1].hooks.length, 1);
    const h = pr[1].hooks[0];
    assert.strictEqual(h.type, 'command');
    assert.strictEqual(h.timeout, 3600);
    // Live settings files carry this exact command: the path and the shape must not move.
    const script = path.join(__dirname, '..', 'permission-hook.js');
    assert.strictEqual(cs.PERMISSION_HOOK_SCRIPT, script);
    assert.strictEqual(h.command, `node '${script}' '/state' 'bc-a' 'http://127.0.0.1:4780/api/permission'`);

    // Re-install is a no-op; a new session in the same cwd replaces ours only.
    await cs.installHooks(cwd, 'bc-a', '/state', 'http://127.0.0.1:4780/api/turn-end');
    assert.strictEqual(read(cwd).hooks.PermissionRequest.length, 2);
    await cs.installHooks(cwd, 'bc-b', '/state', 'http://127.0.0.1:4781/api/turn-end');
    pr = read(cwd).hooks.PermissionRequest;
    assert.strictEqual(pr.length, 2);
    assert.deepStrictEqual(pr[0], theirs);
    assert.match(pr[1].hooks[0].command, /'bc-b' 'http:\/\/127\.0\.0\.1:4781\/api\/permission'$/);
    assert.strictEqual(read(cwd).hooks.Stop.length, 1, 'the Stop hook is still deduped as before');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('installHooks with no callback URL installs no PermissionRequest hook', async () => {
  const cwd = tmpdir('bc-cs-');
  try {
    await cs.installHooks(cwd, 'bc-a', '/state', '');
    assert.strictEqual(read(cwd).hooks.Stop.length, 1);
    assert.strictEqual(read(cwd).hooks.PermissionRequest, undefined);
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
