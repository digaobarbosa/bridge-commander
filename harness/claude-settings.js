'use strict';
// claude-settings — the ONE writer of <cwd>/.claude/settings.local.json.
//
// Four things live in that file: the Stop hook every turn boundary on the
// board rides on, the PermissionRequest hook that relays claude's permission
// prompts to the board, the statusLine command that feeds the context-window
// sidecar, and the session's outputStyle. The claude profile writes the hooks
// and the style, `bc-axi init/open` the hooks and the statusLine. Two copies
// of this code drifted before (a different indent, a corrupt file one side
// recovered from and the other threw on), and the drift showed up as a
// lieutenant that stopped reporting turn ends — so every writer comes through
// here.
//
// Every write also hides the file from git (info/exclude), so it never dirties
// someone's worktree.

const fs = require('node:fs');
const path = require('node:path');
const { shellQuote, excludeFromGit } = require('./util.js');

const SETTINGS_REL = '.claude/settings.local.json';
const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
const PERMISSION_HOOK_SCRIPT = path.join(__dirname, 'permission-hook.js');
// Claude kills a hook at its timeout and shows its own dialog; an hour leaves the
// captain time to see the board. The hook's own request gives up a little sooner.
const PERMISSION_HOOK_TIMEOUT_S = 3600;
const STATUSLINE_SCRIPT = path.join(__dirname, 'statusline.js');

/**
 * mergeLocalSettings(cwd, mutate) -> file — read-modify-write of the settings
 * file, then the git exclude. A missing, unparseable or non-object file is
 * replaced by {}: there is nothing to preserve in bytes nothing can read, and
 * refusing to write would leave the caller with no hook at all.
 */
async function mergeLocalSettings(cwd, mutate) {
  const file = path.join(cwd, SETTINGS_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    settings = null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  mutate(settings);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  await excludeFromGit(cwd, SETTINGS_REL);
  return file;
}

// upsertHook(settings, event, script, entry) — keep exactly ONE entry in
// settings.hooks[event] whose command runs `script`, equal to `entry`. Other
// tools' entries survive; a stale bc entry (an earlier session in this cwd) is
// replaced. Unchanged when ours is already there verbatim.
function upsertHook(settings, event, script, entry) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const command = entry.hooks[0].command;
  const ours = settings.hooks[event].some((m) =>
    Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command));
  if (ours) return;
  settings.hooks[event] = settings.hooks[event].filter((m) =>
    !(Array.isArray(m.hooks) && m.hooks.some((h) =>
      typeof h.command === 'string' && h.command.includes(script))));
  settings.hooks[event].push(entry);
}

// permissionUrl(callbackUrl) — the turn-end callback's server, path swapped to
// /api/permission. '' without a usable callback: with no server to ask, the
// hook would only delay claude's own dialog.
function permissionUrl(callbackUrl) {
  if (!callbackUrl) return '';
  try { return new URL('/api/permission', callbackUrl).href; } catch { return ''; }
}

/**
 * installHooks(cwd, key, stateDir, callbackUrl) — merge the Stop hook running
 * turnend-hook.js and, with a callback URL, the PermissionRequest hook running
 * permission-hook.js. Idempotent; keeps every other hook, but only ONE bc
 * entry per event: a stale one (an earlier session in this cwd) is replaced.
 */
function installHooks(cwd, key, stateDir, callbackUrl) {
  const command = ['node', shellQuote(HOOK_SCRIPT), shellQuote(stateDir), shellQuote(key)]
    .concat(callbackUrl ? [shellQuote(callbackUrl)] : [])
    .join(' ');
  const permUrl = permissionUrl(callbackUrl);
  return mergeLocalSettings(cwd, (settings) => {
    upsertHook(settings, 'Stop', HOOK_SCRIPT, { hooks: [{ type: 'command', command }] });
    if (!permUrl) return;
    const permCommand = 'node ' + [PERMISSION_HOOK_SCRIPT, stateDir, key, permUrl].map(shellQuote).join(' ');
    upsertHook(settings, 'PermissionRequest', PERMISSION_HOOK_SCRIPT, {
      matcher: '*',
      hooks: [{ type: 'command', command: permCommand, timeout: PERMISSION_HOOK_TIMEOUT_S }],
    });
  });
}

/**
 * installStatusLine(cwd) — point claude's statusLine at statusline.js, which
 * tees the real context window and rate limits into the sidecar the board
 * reads. Never ~/.claude/settings.json: that would repaint every claude.
 */
function installStatusLine(cwd) {
  const command = 'node ' + shellQuote(STATUSLINE_SCRIPT);
  return mergeLocalSettings(cwd, (settings) => {
    settings.statusLine = { type: 'command', command };
  });
}

/** writeOutputStyle(cwd, style) — the session's outputStyle, read by claude at start. */
function writeOutputStyle(cwd, style) {
  return mergeLocalSettings(cwd, (settings) => { settings.outputStyle = style; });
}

module.exports = {
  SETTINGS_REL, HOOK_SCRIPT, PERMISSION_HOOK_SCRIPT, STATUSLINE_SCRIPT,
  mergeLocalSettings, installHooks, installStatusLine, writeOutputStyle,
};
