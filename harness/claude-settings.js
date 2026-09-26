'use strict';
// claude-settings — the ONE writer of <cwd>/.claude/settings.local.json.
//
// Three things live in that file: the Stop hook every turn boundary on the
// board rides on, the statusLine command that feeds the context-window
// sidecar, and the session's outputStyle. The claude profile writes the first
// and the last, `bc-axi init/open` the first two. Two copies of this code
// drifted before (a different indent, a corrupt file one side recovered from
// and the other threw on), and the drift showed up as a lieutenant that
// stopped reporting turn ends — so every writer comes through here.
//
// Every write also hides the file from git (info/exclude), so it never dirties
// someone's worktree.

const fs = require('node:fs');
const path = require('node:path');
const { shellQuote, excludeFromGit } = require('./util.js');

const SETTINGS_REL = '.claude/settings.local.json';
const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
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

/**
 * installTurnEndHook(cwd, key, stateDir, callbackUrl) — merge the Stop hook
 * running turnend-hook.js. Idempotent; keeps every other hook, but only ONE bc
 * entry: a stale one (an earlier session in this cwd) is replaced.
 */
function installTurnEndHook(cwd, key, stateDir, callbackUrl) {
  const command = ['node', shellQuote(HOOK_SCRIPT), shellQuote(stateDir), shellQuote(key)]
    .concat(callbackUrl ? [shellQuote(callbackUrl)] : [])
    .join(' ');
  return mergeLocalSettings(cwd, (settings) => {
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    const ours = settings.hooks.Stop.some((m) =>
      Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command));
    if (ours) return;
    settings.hooks.Stop = settings.hooks.Stop.filter((m) =>
      !(Array.isArray(m.hooks) && m.hooks.some((h) =>
        typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT))));
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command }] });
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
  SETTINGS_REL, HOOK_SCRIPT, STATUSLINE_SCRIPT,
  mergeLocalSettings, installTurnEndHook, installStatusLine, writeOutputStyle,
};
