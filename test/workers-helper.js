'use strict';
// Shared fixtures for the workers-*.test.js files: a real throwaway git repo, a
// fake-harness board booted on it (BC_FAKE_STATE, BC_WORKTREE_TOOL=git), and the
// small polling and matching helpers the tests share.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, sleep, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/layout.js');

// A worker's harness key/address: a WINDOW inside the owning lieutenant's
// session (papercut #8) — `session:window`, the form marker files and
// turn-end payloads carry.
function workerKey(dir, cardId) {
  return lieutenantSession(dir, LT) + ':' + workerWindow(cardId);
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(root, name = 'srcrepo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}

// One temp tree per boot: fake-harness state + source repo + workspace.
async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  const r = await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, repo, fdir, teardown };
}

function boardOnDisk(s) {
  return JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
}

// The fetch was real and landed in the clone the board registered; the
// checkout read a DIFFERENT clone's `origin/<branch>`. treehouse keeps one pool
// per repository per machine, so which clone backs it is decided by whoever
// asked for it first — often a checkout in another workspace entirely. When the
// two agreed the start looked fine, which is why this was intermittent.
//
// The fake pool below is exactly that shape: worktrees cut from a SECOND clone
// that is behind and never fetches.
function writeFakeTreehouse(root, poolClone) {
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const pool = path.join(root, 'pool');
  fs.mkdirSync(pool, { recursive: true });
  const sh = [
    '#!/bin/sh',
    'set -e',
    'POOL=' + JSON.stringify(pool),
    'CLONE=' + JSON.stringify(poolClone),
    'case "$1" in',
    '  --version) echo "fake-treehouse 0.0.0" ;;',
    '  get)',
    '    slot="$POOL/1"',
    '    if [ ! -d "$slot" ]; then',
    // the pool leaves a worktree on ITS clone's stale tip — never the board's
    '      git -C "$CLONE" worktree add -q -d "$slot" origin/main >&2',
    '    fi',
    '    echo "$slot" ;;',
    // `treehouse return` can refuse — a held pool lockfile, a treehouse that
    // has dropped off PATH. The marker lets a test ask for that answer.
    '  return)',
    '    if [ -f "$POOL/.refuse" ]; then echo "pool lock held by another process" >&2; exit 3; fi',
    '    : ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'treehouse'), sh, { mode: 0o755 });
  return bin;
}

// Drops a playbook file into the workspace, as a workspace author would.
function writePlaybook(s, id, text) {
  const dir = path.join(s.dir, '.bridge-commander', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.md'), text);
  return id;
}

// Polls fn until it answers truthy, or throws naming what never happened.
async function until(what, fn, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}

const cardEvents = async (s, id) => ((await s.api('GET', '/api/cards/' + id)).body.events || []);

const rx = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

module.exports = { workerKey, git, makeRepo, boot, boardOnDisk, writeFakeTreehouse, writePlaybook, until, cardEvents, rx };
