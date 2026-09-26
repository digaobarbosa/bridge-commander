'use strict';
// layout — where things live in a workspace, and what the names in it look
// like. Node built-ins only, zero deps; shared by the server, the bc-axi CLI
// and the tests, so the two sides can never disagree about a path.
//
//   <ws>/.bridge-commander/          the state dir (+ the legacy-name migration)
//   <ws>/lieutenants/<id>/README.md  a lieutenant's charter
//   bc-<disc>-lt-<id>                a lieutenant's tmux session (+ worker windows)
//   ids                              one shape for every id a path is built from

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ---------- ids ----------
// The id shape the whole board uses: lieutenant, project, playbook, hook,
// schedule. Starts with a word character, so no id can be `..`, empty, or a
// leading `-` or `.`, and every path built from one stays where it was built.
const ID_RE = /^[\w][\w.-]*$/;
/** isId(s) -> true when `s` is a legal board id. */
function isId(s) { return typeof s === 'string' && ID_RE.test(s); }

// ---------- the state dir ----------
// Canonical state-dir names + one-shot rename migrations from the pre-rename
// product name (bridge-command → bridge-commander).
//
// Every migration is idempotent and non-destructive: it renames ONLY when the
// new dir is absent and the legacy dir exists. Re-runs are no-ops, and a
// both-present install always prefers the new dir (no second, destructive
// rename). The `bc-` / `BC_*` abbreviations are a separate namespace and never
// appear here.
const STATE_DIR_NAME = '.bridge-commander';
const LEGACY_STATE_DIR_NAME = '.bridge-command';

// Rename <ws>/.bridge-command → <ws>/.bridge-commander when safe. Returns the
// new path if a rename happened, else null. Optional `isLive(legacyDir)` guards
// against renaming a state dir out from under a running legacy server — when it
// returns true the rename is skipped.
function migrateStateDir(ws, isLive) {
  const nu = path.join(ws, STATE_DIR_NAME);
  const old = path.join(ws, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(nu) || !fs.existsSync(old)) return null;
  if (typeof isLive === 'function' && isLive(old)) return null;
  fs.renameSync(old, nu);
  return nu;
}

// A directory qualifies as a workspace only if it holds a REAL state dir — one
// with config.json OR board.json. A bare `.bridge-commander/` (e.g. the harness
// state home `~/.bridge-commander/` that holds only `harness/`) does NOT count,
// so upward discovery never adopts $HOME as a phantom workspace. Checks both the
// new and legacy state-dir names.
function isWorkspace(dir) {
  for (const name of [STATE_DIR_NAME, LEGACY_STATE_DIR_NAME]) {
    const sd = path.join(dir, name);
    if (fs.existsSync(path.join(sd, 'config.json')) ||
        fs.existsSync(path.join(sd, 'board.json'))) return true;
  }
  return false;
}

// Resolve the workspace state dir: prefer the new name, accept the legacy one,
// default to the new name for a fresh install.
function resolveStateDir(ws) {
  const nu = path.join(ws, STATE_DIR_NAME);
  if (fs.existsSync(nu)) return nu;
  const old = path.join(ws, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(old)) return old;
  return nu;
}

// harnessStateDir(stateDir) — where the harness keeps its per-agent files
// (prompts, session ids, turn-end logs): inside the workspace, never the
// harness's global last-resort dir, so two boards on one machine never share
// it. BC_HARNESS_STATE stays an explicit override. The server binds the port
// to it and the CLI installs its hooks against it — one rule for both.
function harnessStateDir(stateDir) {
  return process.env.BC_HARNESS_STATE || path.join(stateDir, 'harness');
}

// Home last-resort dir holds the captain.md seed and the harness fallback state.
// Same non-destructive rule. `home` defaults to os.homedir() (override for tests).
function migrateHomeStateDir(home) {
  const base = home || os.homedir();
  const nu = path.join(base, STATE_DIR_NAME);
  const old = path.join(base, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(nu) || !fs.existsSync(old)) return null;
  fs.renameSync(old, nu);
  return nu;
}

// ---------- onboarding ----------
// The steps the board remembers, in order. A re-run reads the step and resumes
// from it instead of starting the conversation over. The server validates a
// step against this list and the CLI walks it, so it lives here, between them.
const ONBOARDING_STEPS = ['board-up', 'tools', 'project', 'checklist', 'done'];

// ---------- the charter ----------
// The charter is the one thing on a lieutenant the board stored but never used:
// prose an agent reads at launch. So it lives where the agent already looks —
// `lieutenants/<id>/README.md` in the workspace, the lieutenant's standing
// memory file — and not in board.json. One path, shared by the server (which
// reads it into the launch prompt) and the CLI (which writes it from
// --charter-file and shows its first line in `lieutenant list`).
function charterPath(workspace, id) {
  return path.join(workspace, 'lieutenants', String(id), 'README.md');
}
function readCharter(workspace, id) {
  try { return fs.readFileSync(charterPath(workspace, id), 'utf8').trim(); }
  catch (e) { return ''; }
}
function writeCharter(workspace, id, text) {
  const file = charterPath(workspace, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, /\n$/.test(text) ? text : text + '\n');
  return file;
}

// ---------- session names ----------
// Workspace-scoped session naming (docs/api/overview.md, harness port:
// "spawned session names are unique per workspace"). Two boards on one machine
// must never collide on tmux session names, so every generated name carries a
// workspace discriminator: the ASCII slug of the workspace basename (truncated)
// plus a short hash of the absolute workspace path. Deterministic — the same
// workspace always yields the same names across restarts.
//
// tmux session names cannot contain dots or colons; everything emitted here is
// [A-Za-z0-9-] only, so emoji or any non-ASCII in a workspace or id never
// reach tmux.

// workspaceDisc(workspace) -> short stable discriminator for the workspace.
// Symlinked paths resolve to one canonical form so the same board gets the
// same discriminator no matter how it was addressed.
function workspaceDisc(workspace) {
  let abs = path.resolve(workspace);
  try { abs = fs.realpathSync(abs); } catch (e) { /* not on disk yet — hash the resolved form */ }
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 6);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 12).replace(/-+$/, '');
  return slug ? slug + '-' + hash : hash;
}

function safe(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '-'); }

function lieutenantSession(workspace, id) {
  return 'bc-' + workspaceDisc(workspace) + '-lt-' + safe(id);
}

// workerWindow(cardId) -> tmux window name for a card's worker inside its
// owning lieutenant's session (papercut #8). The 'w-' prefix guarantees the
// name can never read as a bare number, which tmux would parse as a window
// INDEX instead of a name. No workspace discriminator: the enclosing
// lieutenant session already carries it, and card ids are unique per board.
function workerWindow(cardId) {
  return 'w-' + safe(cardId);
}

// LIEUTENANT_WINDOW — the window a lieutenant lives in inside its OWN session.
// A lieutenant cohabits that session with its worker windows, so its ref must
// be window-granular too: a session-granular ref kills the whole session on
// revive (every worker with it) and reads liveness off whichever window has
// focus (a busy worker masks a dead lieutenant). Same name for every
// lieutenant — the session name already identifies which one.
const LIEUTENANT_WINDOW = 'lt';

module.exports = {
  ID_RE, isId,
  STATE_DIR_NAME, LEGACY_STATE_DIR_NAME,
  migrateStateDir, resolveStateDir, migrateHomeStateDir, isWorkspace, harnessStateDir,
  ONBOARDING_STEPS,
  charterPath, readCharter, writeCharter,
  workspaceDisc, lieutenantSession, workerWindow, LIEUTENANT_WINDOW,
};
