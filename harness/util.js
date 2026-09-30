'use strict';
// util — the small helpers more than one harness file needs. Kept free of
// tmux.js so the relays, the statusline and the CLI can load it cheaply.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

// The workspace marker directory (server/statedir.js owns the full story).
const STATE_DIR_NAME = '.bridge-commander';

/**
 * tmuxSession() -> the tmux session this process runs in, '' outside tmux or
 * when tmux cannot answer. A relay runs inside the agent's own pane, so this
 * names that agent's session exactly (the server attributes turn-ends by it).
 */
function tmuxSession() {
  if (!process.env.TMUX) return '';
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * readStdin(timeoutMs?) -> Promise<string> — all of stdin, or what arrived
 * before the timeout. A hook must never hang its agent on a stdin that never ends.
 */
function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    const done = () => { clearTimeout(timer); resolve(data); };
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** findWorkspace(startDir) -> nearest ancestor holding a .bridge-commander/ directory, or null. */
function findWorkspace(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, STATE_DIR_NAME)).isDirectory()) return dir;
    } catch { /* not here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * toEpochSecs(v) -> epoch SECONDS, or null when unparseable. Accepts epoch
 * seconds, epoch millis, a numeric string, or an ISO timestamp — the shapes
 * rate-limit `resets_at` has arrived in.
 */
function toEpochSecs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    const p = Date.parse(v);
    if (!Number.isNaN(p)) return Math.floor(p / 1000);
  }
  return null;
}

/** shellQuote(s) — one POSIX single-quoted word. */
function shellQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

/**
 * stateKey(session, window) — the per-agent key for the state files and the
 * relay's `session` argument. Window-granular agents share their session name,
 * so the `session:window` form keeps them apart (tmux names never contain ':').
 */
function stateKey(session, window) {
  return window ? `${session}:${window}` : session;
}

/**
 * keyOf(ref) — a ref's state key. The port exports this one, so the server,
 * the fake and the adapters can never disagree about the key's shape.
 */
function keyOf(ref) {
  return stateKey(ref.session, ref.window);
}

/**
 * isSpawnableSession(name) — would a spawn accept this tmux session name?
 * `bc-` plus characters tmux never reads as target syntax (no '.' or ':').
 * A founder's foreign session (the tmux it was typed into) fails it, so the
 * server knows to mint a workspace-scoped name before a respawn.
 */
function isSpawnableSession(name) {
  return typeof name === 'string' && /^bc-[A-Za-z0-9_-]+$/.test(name);
}

/**
 * readSessionId(stateDir, key) -> string | null — the resume id the turn-end
 * relay recorded for this agent (refreshed every turn, so it beats the ref's).
 */
function readSessionId(stateDir, key) {
  if (!stateDir) return null;
  try {
    return fs.readFileSync(path.join(stateDir, `${key}.session-id`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * excludeFromGit(dir, entry) — add `entry` to the repo's info/exclude when dir
 * is inside a git repo, so a file we write never dirties someone's worktree.
 * Async so the server never blocks on git; best-effort, never throws.
 */
async function excludeFromGit(dir, entry) {
  try {
    const rel = (await new Promise((resolve, reject) => {
      execFile('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'],
        { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    })).trim();
    const excl = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split('\n').includes(entry)) fs.appendFileSync(excl, entry + '\n');
  } catch {
    // not a git repo — nothing to exclude
  }
}

module.exports = {
  STATE_DIR_NAME, tmuxSession, readStdin, findWorkspace, toEpochSecs,
  shellQuote, stateKey, keyOf, isSpawnableSession, readSessionId, excludeFromGit,
};
