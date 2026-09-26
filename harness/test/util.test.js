'use strict';
// harness/util.js — the helpers the relays, statusline, status reader and CLI share.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const u = require('../util.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('findWorkspace: walks up to the nearest .bridge-commander/; null when none', () => {
  const root = tmpdir('bc-util-find-');
  try {
    fs.mkdirSync(path.join(root, '.bridge-commander'), { recursive: true });
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(u.findWorkspace(deep), root);
    assert.strictEqual(u.findWorkspace('/'), null);
    assert.strictEqual(u.findWorkspace(''), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('toEpochSecs: seconds, millis, numeric strings and ISO all land in seconds; junk is null', () => {
  assert.strictEqual(u.toEpochSecs('2026-01-01T00:00:00Z'), Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000));
  assert.strictEqual(u.toEpochSecs(1700000000000), 1700000000);
  assert.strictEqual(u.toEpochSecs(1700000000), 1700000000);
  assert.strictEqual(u.toEpochSecs('1700000000'), 1700000000);
  assert.strictEqual(u.toEpochSecs('nonsense'), null);
  assert.strictEqual(u.toEpochSecs(null), null);
});

test('stateKey and readSessionId: window-granular keys, blank records are no id', () => {
  const dir = tmpdir('bc-util-sid-');
  try {
    assert.strictEqual(u.stateKey('bc-a', undefined), 'bc-a');
    assert.strictEqual(u.stateKey('bc-a', 'w-1'), 'bc-a:w-1');
    assert.strictEqual(u.readSessionId(dir, 'bc-a:w-1'), null, 'no file');
    fs.writeFileSync(path.join(dir, 'bc-a:w-1.session-id'), '\n');
    assert.strictEqual(u.readSessionId(dir, 'bc-a:w-1'), null, 'blank file');
    fs.writeFileSync(path.join(dir, 'bc-a:w-1.session-id'), 'uuid-1\n');
    assert.strictEqual(u.readSessionId(dir, 'bc-a:w-1'), 'uuid-1');
    assert.strictEqual(u.readSessionId(undefined, 'bc-a:w-1'), null, 'no state dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shellQuote survives single quotes', () => {
  assert.strictEqual(u.shellQuote("it's"), "'it'\\''s'");
});

test('excludeFromGit: adds the entry once inside a repo, and is a quiet no-op outside one', async () => {
  const repo = tmpdir('bc-util-git-');
  const plain = tmpdir('bc-util-plain-');
  try {
    execFileSync('git', ['init', '-q', repo]);
    await u.excludeFromGit(repo, '.claude/settings.local.json');
    await u.excludeFromGit(repo, '.claude/settings.local.json');
    const excl = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.strictEqual(excl.split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
    await u.excludeFromGit(plain, 'x'); // must not throw
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
