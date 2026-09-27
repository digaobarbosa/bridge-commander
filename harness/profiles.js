'use strict';
// profiles — a harness is an ADAPTER FAMILY (tmux, acp, fake) plus a PROFILE:
// the facts about one CLI. Plugins contribute profiles as JSON; this module
// turns that JSON into a registered harness.
//
//   resolveProfile(json, bases)  -> the merged profile (throws on a bad one)
//   loadProfiles({profiles, stateDir, log}) -> [{name, plugin, ok, error?}]
//   expandEnv(env, sources)      -> {env, missing[]}
//
// A derived JSON profile `extends` a JS base (claude, codex) and overlays only
// DATA: env, contextWindows, requirements, installHint. Behaviour stays in JS.

const fs = require('node:fs');
const path = require('node:path');
const port = require('./port.js');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A key named like a credential must come from the environment or
// secrets.env, never from a manifest that may be committed.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
const JSON_FIELDS = new Set(['name', 'extends', 'adapter', 'env', 'contextWindows', 'requirements',
  'installHint', 'command', 'args',
  // bookkeeping that manifests.js and contributions() add
  'plugin', 'key', 'rank', 'builtin', 'when', 'description']);
const SECRETS_FILE = 'secrets.env';

function fail(msg) { throw new Error(msg); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function validateEnv(env, where) {
  if (env === undefined) return {};
  if (!isObj(env)) fail(where + ': env must be an object');
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) fail(where + ': bad env name "' + k + '"');
    if (typeof v !== 'string') fail(where + ': env ' + k + ' must be a string');
    const ref = REF_RE.test(v);
    if (!ref && v.includes('${')) fail(where + ': env ' + k + ' must be exactly ${NAME} or a literal without ${');
    if (!ref && SECRET_KEY_RE.test(k)) {
      fail(where + ': env ' + k + ' looks like a secret, so it must be a ${NAME} reference, not a literal');
    }
    out[k] = v;
  }
  return out;
}

// { "deepseek": 128000 } or [["deepseek", 128000]] -> [[needle, n], ...]
function windowPairs(v, where) {
  if (v === undefined) return [];
  const pairs = Array.isArray(v) ? v : isObj(v) ? Object.entries(v) : fail(where + ': contextWindows must be an object or a list of pairs');
  return pairs.map((p) => {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || !p[0] || !(Number(p[1]) > 0)) {
      fail(where + ': contextWindows entry ' + JSON.stringify(p) + ' must be [needle, tokens]');
    }
    return [p[0].toLowerCase(), Number(p[1])];
  });
}

function validateRequirements(r, where) {
  if (r === undefined) return {};
  if (!isObj(r)) fail(where + ': requirements must be an object');
  const out = {};
  if (r.bins !== undefined) {
    if (!Array.isArray(r.bins) || !r.bins.every((b) => typeof b === 'string' && b)) fail(where + ': requirements.bins must be a list of names');
    out.bins = r.bins.slice();
  }
  for (const k of ['tmux', 'rootBypass']) if (r[k] !== undefined) out[k] = !!r[k];
  return out;
}

/**
 * resolveProfile(json, bases) -> profile. `bases` maps a name to a base profile
 * object (a Map, a plain object, or a lookup function). Throws with the reason.
 */
function resolveProfile(json, bases) {
  if (!isObj(json)) fail('a profile must be an object');
  const name = json.name;
  const where = 'profile "' + name + '"';
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail('profile name must match ' + NAME_RE);
  for (const k of Object.keys(json)) if (!JSON_FIELDS.has(k)) fail(where + ': unknown field "' + k + '"');
  const adapter = json.adapter === undefined ? 'tmux' : json.adapter;
  if (adapter !== 'tmux' && adapter !== 'acp') fail(where + ': adapter must be tmux or acp');
  const env = validateEnv(json.env, where);
  const windows = windowPairs(json.contextWindows, where);
  const requirements = validateRequirements(json.requirements, where);
  if (json.installHint !== undefined && typeof json.installHint !== 'string') fail(where + ': installHint must be a string');

  if (adapter === 'acp') {
    if (typeof json.command !== 'string' || !json.command) fail(where + ': an acp profile needs a command');
    if (json.args !== undefined && !(Array.isArray(json.args) && json.args.every((a) => typeof a === 'string'))) {
      fail(where + ': args must be a list of strings');
    }
    return {
      name, adapter, command: json.command, args: (json.args || []).slice(), env,
      contextWindows: windows, requirements, installHint: json.installHint || '',
    };
  }

  if (typeof json.extends !== 'string' || !json.extends) fail(where + ': a tmux profile needs "extends" (a base like claude)');
  const lookup = typeof bases === 'function' ? bases
    : bases instanceof Map ? (n) => bases.get(n)
      : (n) => (bases && Object.prototype.hasOwnProperty.call(bases, n) ? bases[n] : undefined);
  const base = lookup(json.extends);
  if (!base) fail(where + ': extends unknown profile "' + json.extends + '"');
  return Object.assign({}, base, {
    name,
    adapter,
    extends: json.extends,
    env: Object.assign({}, base.env || {}, env),
    // The derived entries come first, so they win the substring match.
    contextWindows: windows.concat(base.contextWindows || []),
    // Only what the JSON itself says may beat a live reading (the statusline).
    windowOverrides: windows.concat(base.windowOverrides || []),
    requirements: Object.assign({}, base.requirements || {}, requirements),
    installHint: json.installHint !== undefined ? json.installHint : base.installHint,
    settle: base.settle ? Object.assign({}, base.settle, { label: name }) : base.settle,
  });
}

// KEY=value lines; `export`, quotes and comments tolerated. Never throws.
function readEnvFile(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || /^\s*#/.test(raw)) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * expandEnv(env, sources) -> {env, missing[]}. A ${NAME} reference takes the
 * first source that has NAME; a literal passes through.
 */
function expandEnv(env, sources) {
  const out = {};
  const missing = [];
  for (const [k, v] of Object.entries(env || {})) {
    const m = REF_RE.exec(v);
    if (!m) { out[k] = v; continue; }
    const src = (sources || []).find((s) => s && Object.prototype.hasOwnProperty.call(s, m[1]) && s[m[1]] !== '');
    if (src) out[k] = String(src[m[1]]);
    else missing.push(m[1]);
  }
  return { env: out, missing };
}

// The sources a launch expands against, read at LAUNCH time so a key exported
// or added to secrets.env after boot takes effect on the next spawn.
function envSources(secretsFile) {
  return [process.env, secretsFile ? readEnvFile(secretsFile) : {}];
}

function buildAdapter(profile) {
  if (profile.adapter === 'acp') {
    let mod;
    try { mod = require('./acp-adapter.js'); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && /acp-adapter/.test(String(e.message))) fail('acp adapter not available');
      throw e;
    }
    return mod.acpAdapter(profile);
  }
  return require('./tmux-adapter.js').tmuxAdapter(profile);
}

// The JS profiles a derived one may extend. Lazy: a board that loads no
// derived profile never requires the tmux machinery from here.
function builtinBases() {
  return new Map([
    ['claude', require('./claude-tmux.js').profile],
    ['codex', require('./codex-tmux.js').profile],
  ]);
}

/**
 * loadProfiles({profiles, stateDir, log}) -> [{name, plugin, ok, error?}]
 * `profiles` is contributions(catalog).profiles. `stateDir` is where
 * secrets.env lives (the workspace's .bridge-commander). One bad profile is
 * recorded and logged, never fatal.
 */
function loadProfiles({ profiles, stateDir, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const bases = builtinBases();
  const secretsFile = stateDir ? path.join(stateDir, SECRETS_FILE) : '';
  const seen = new Set();
  const out = [];
  for (const json of profiles || []) {
    const name = json && json.name;
    const plugin = (json && json.plugin) || null;
    try {
      if (seen.has(name)) fail('duplicate profile "' + name + '"');
      if (json.builtin) {
        // A shipped plugin DECLARES a JS profile so it is listed and can be
        // disabled; the port already knows how to load it.
        if (!port.isBuiltin(name)) fail('"' + name + '" is not a built-in profile');
        seen.add(name);
        port.tagHarness(name, plugin);
        out.push({ name, plugin, ok: true, builtin: true });
        continue;
      }
      if (port.isBuiltin(name)) fail('duplicate profile "' + name + '" (a built-in has that name)');
      const profile = resolveProfile(json, (n) => bases.get(n));
      profile.plugin = plugin;
      profile.secretsFile = secretsFile;
      const impl = buildAdapter(profile);
      if (!impl.profile) impl.profile = profile;
      port.registerHarness(name, impl, { plugin });
      seen.add(name);
      if (profile.adapter === 'tmux') bases.set(name, profile);
      out.push({ name, plugin, ok: true });
    } catch (e) {
      const error = String((e && e.message) || e);
      say('profile ' + (name || '?') + (plugin ? ' (plugin ' + plugin + ')' : '') + ' not loaded: ' + error);
      out.push({ name: name || null, plugin, ok: false, error });
    }
  }
  return out;
}

module.exports = { resolveProfile, loadProfiles, expandEnv, envSources, readEnvFile, SECRET_KEY_RE, SECRETS_FILE };
