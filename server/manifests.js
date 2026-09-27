'use strict';
// manifests — what plugins exist, what each one contributes, and which of those
// contributions the workspace turned off. Pure data: no plugin code runs here.
//
//   <repo>/plugins/<id>/plugin.json                    shipped with bridge-commander
//   <ws>/.bridge-commander/plugins/<id>/plugin.json    the workspace's own; same id replaces the shipped one
//   <ws>/.bridge-commander/plugins.json                the overlay: enable/disable, config, per-contribution tweaks
//
// A broken manifest never bricks the board: it lands in the catalog with an
// `error`, contributes nothing, and says why (GET /api/plugins, the server log).
//
// Node built-ins only.
const fs = require('fs');
const path = require('path');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OVERLAY_FILE = 'plugins.json';
const SHIPPED_DIR = path.join(__dirname, '..', 'plugins');

// The keys a manifest may carry. Anything else is a typo, and a typo that is
// silently ignored is a contribution that silently never appears.
const TOP_KEYS = new Set(['id', 'name', 'description', 'version', 'enabled', 'activation',
  'server', 'ui', 'config', 'contributes']);
const CONTRIBUTION_KINDS = ['profiles', 'commands', 'menus', 'badges', 'views', 'sections', 'checks'];
// Menu slots are versioned: a slot that changes shape gets a new id, and a
// plugin written for the old one keeps working against the old one or fails
// loudly — never half-renders.
const MENU_SLOTS = ['card.menu/v1', 'card.actions/v1', 'detail.actions/v1', 'palette/v1'];
const SECTION_SLOTS = ['detail.sections/v1', 'settings.sections/v1'];
const VIEW_SLOTS = ['main/v1'];
const CHECK_PHASES = ['init', 'boot', 'card-start'];
const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'enum'];

function fail(msg) { throw new Error(msg); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() !== ''; }

/**
 * A form/config schema: `{ <name>: {type?, title?, description?, default?, enum?, required?} }`.
 * `enum` implies type 'enum'. Returns the normalized schema.
 */
function validateFields(fields, where) {
  if (fields === undefined) return {};
  if (!isObj(fields)) fail(where + ': must be an object of fields');
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) fail(where + ': bad field name "' + name + '"');
    if (!isObj(f)) fail(where + '.' + name + ': must be an object');
    const type = f.enum ? 'enum' : (f.type || 'string');
    if (!FIELD_TYPES.includes(type)) fail(where + '.' + name + ': type must be one of ' + FIELD_TYPES.join('|'));
    if (type === 'enum' && (!Array.isArray(f.enum) || !f.enum.length)) fail(where + '.' + name + ': enum needs a non-empty list');
    out[name] = Object.assign({}, f, { type });
  }
  return out;
}

function validateCommand(c, pluginId, i) {
  const where = 'contributes.commands[' + i + ']';
  if (!isObj(c)) fail(where + ': must be an object');
  if (!str(c.id)) fail(where + ': id required');
  // Namespaced by the plugin, so two plugins can never claim one command id.
  if (!c.id.startsWith(pluginId + '.')) fail(where + ': id "' + c.id + '" must start with "' + pluginId + '."');
  if (!LOCAL_ID_RE.test(c.id)) fail(where + ': bad id "' + c.id + '"');
  if (!str(c.title)) fail(where + ': title required');
  const run = c.run;
  const kinds = [run === 'server', isObj(run) && str(run.exec), isObj(run) && str(run.open)].filter(Boolean).length;
  if (kinds !== 1) fail(where + ': run must be "server", {exec} or {open}');
  if (c.prepare !== undefined && c.prepare !== 'server') fail(where + ': prepare must be "server" when set');
  return Object.assign({}, c, {
    form: validateFields(c.form, where + '.form'),
    tracked: !!c.tracked,
  });
}

function validateMenus(menus, pluginId) {
  if (menus === undefined) return {};
  if (!isObj(menus)) fail('contributes.menus: must be an object keyed by slot');
  const out = {};
  for (const [slot, entries] of Object.entries(menus)) {
    if (!MENU_SLOTS.includes(slot)) fail('contributes.menus: unknown slot "' + slot + '" (known: ' + MENU_SLOTS.join(', ') + ')');
    if (!Array.isArray(entries)) fail('contributes.menus["' + slot + '"]: must be a list');
    out[slot] = entries.map((e, i) => {
      if (!isObj(e) || !str(e.command)) fail('contributes.menus["' + slot + '"][' + i + ']: command required');
      if (e.when !== undefined && !isObj(e.when)) fail('contributes.menus["' + slot + '"][' + i + ']: when must be an object predicate');
      return Object.assign({ rank: 1000 }, e);
    });
  }
  return out;
}

function validateList(list, kind, pluginId, each) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('contributes.' + kind + ': must be a list');
  const seen = new Set();
  return list.map((e, i) => {
    const where = 'contributes.' + kind + '[' + i + ']';
    if (!isObj(e)) fail(where + ': must be an object');
    const id = kind === 'profiles' ? e.name : e.id;
    if (!str(id) || !LOCAL_ID_RE.test(id)) fail(where + ': ' + (kind === 'profiles' ? 'name' : 'id') + ' required ([a-z0-9._-])');
    if (seen.has(id)) fail(where + ': duplicate "' + id + '"');
    seen.add(id);
    if (e.when !== undefined && !isObj(e.when)) fail(where + ': when must be an object predicate');
    return each ? each(e, where) : e;
  });
}

/**
 * Validate and normalize one manifest. `folder` is the directory name it was
 * found in; the id must match it. Throws Error(message) on the first problem.
 */
function validateManifest(m, folder) {
  if (!isObj(m)) fail('plugin.json must be a JSON object');
  for (const k of Object.keys(m)) if (!TOP_KEYS.has(k)) fail('unknown key "' + k + '"');
  if (!str(m.id) || !PLUGIN_ID_RE.test(m.id)) fail('id must match ' + PLUGIN_ID_RE);
  if (folder !== undefined && m.id !== folder) fail('id "' + m.id + '" must equal its folder name "' + folder + '"');
  if (m.activation !== undefined && !['lazy', 'boot'].includes(m.activation)) fail('activation must be lazy|boot');
  if (m.server !== undefined && !str(m.server)) fail('server must be a file name');
  if (m.ui !== undefined && !str(m.ui)) fail('ui must be a file name');
  for (const f of [m.server, m.ui]) {
    if (f !== undefined && (path.isAbsolute(f) || f.split(/[\\/]/).includes('..'))) fail('file "' + f + '" must stay inside the plugin folder');
  }
  const c = m.contributes === undefined ? {} : m.contributes;
  if (!isObj(c)) fail('contributes must be an object');
  for (const k of Object.keys(c)) if (!CONTRIBUTION_KINDS.includes(k)) fail('unknown contribution kind "' + k + '" (known: ' + CONTRIBUTION_KINDS.join(', ') + ')');
  const needsUi = (kind) => { if (c[kind] && c[kind].length && !m.ui) fail('contributes.' + kind + ' needs a "ui" module'); };
  const out = {
    id: m.id,
    name: str(m.name) ? m.name : m.id,
    description: typeof m.description === 'string' ? m.description : '',
    version: typeof m.version === 'string' ? m.version : '',
    enabled: m.enabled !== false,
    activation: m.activation || 'lazy',
    server: m.server,
    ui: m.ui,
    config: validateFields(m.config, 'config'),
    contributes: {
      profiles: validateList(c.profiles, 'profiles', m.id),
      commands: (c.commands === undefined ? [] : (Array.isArray(c.commands) ? c.commands : fail('contributes.commands: must be a list')))
        .map((x, i) => validateCommand(x, m.id, i)),
      menus: validateMenus(c.menus, m.id),
      badges: validateList(c.badges, 'badges', m.id, (e, where) => {
        if (!str(e.text)) fail(where + ': text required');
        return e;
      }),
      views: validateList(c.views, 'views', m.id, (e, where) => {
        if (!VIEW_SLOTS.includes(e.slot || 'main/v1')) fail(where + ': slot must be ' + VIEW_SLOTS.join('|'));
        if (!str(e.title)) fail(where + ': title required');
        return Object.assign({ slot: 'main/v1' }, e);
      }),
      sections: validateList(c.sections, 'sections', m.id, (e, where) => {
        if (!SECTION_SLOTS.includes(e.slot)) fail(where + ': slot must be one of ' + SECTION_SLOTS.join(', '));
        if (!str(e.title)) fail(where + ': title required');
        return e;
      }),
      checks: validateList(c.checks, 'checks', m.id, (e, where) => {
        const phase = e.phase || 'boot';
        if (!CHECK_PHASES.includes(phase)) fail(where + ': phase must be ' + CHECK_PHASES.join('|'));
        if (!str(e.bin) && !str(e.exec)) fail(where + ': bin or exec required');
        return Object.assign({}, e, { phase });
      }),
    },
  };
  needsUi('views');
  needsUi('sections');
  // A menu entry names a command: its own, or one a built-in or another plugin
  // registers (resolved by the consumer, which knows the whole set).
  if (m.server === undefined && out.contributes.commands.some((x) => x.run === 'server' || x.prepare === 'server')) {
    fail('a command with run/prepare "server" needs a "server" module');
  }
  return out;
}

/** Read and validate <dir>/plugin.json. Throws with a message that names the file. */
function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(file + ': ' + (e.code === 'ENOENT' ? 'missing' : 'not valid JSON (' + e.message + ')')); }
  try { return validateManifest(raw, path.basename(dir)); }
  catch (e) { throw new Error(file + ': ' + e.message); }
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch (e) { return []; }
}

/**
 * Every plugin folder, shipped then workspace; a workspace folder with the same
 * id REPLACES the shipped one whole (files are never mixed).
 * -> [{id, dir, source: 'shipped'|'workspace', manifest|null, error|null}]
 */
function discover({ shippedDir = SHIPPED_DIR, workspaceDir } = {}) {
  const byId = new Map();
  for (const [root, source] of [[shippedDir, 'shipped'], [workspaceDir, 'workspace']]) {
    if (!root) continue;
    for (const name of listDirs(root)) {
      const dir = path.join(root, name);
      let manifest = null, error = null;
      try { manifest = readManifest(dir); } catch (e) { error = e.message; }
      byId.set(name, { id: name, dir, source, manifest, error });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The overlay, or an empty one. A malformed file reads as empty and says so. */
function readOverlay(stateDir, log) {
  const empty = { plugins: {}, contributions: {} };
  if (!stateDir) return empty;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(stateDir, OVERLAY_FILE), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT' && log) log('plugins.json unreadable, ignoring it: ' + e.message);
    return empty;
  }
  return {
    plugins: isObj(raw.plugins) ? raw.plugins : {},
    contributions: isObj(raw.contributions) ? raw.contributions : {},
  };
}

/** Write the overlay atomically (temp file + rename). */
function writeOverlay(stateDir, overlay) {
  const file = path.join(stateDir, OVERLAY_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ plugins: overlay.plugins || {}, contributions: overlay.contributions || {} }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Config = the manifest's defaults, then the overlay's values for the fields it declares. */
function effectiveConfig(manifest, overlayConfig) {
  const out = {};
  for (const [k, f] of Object.entries(manifest.config)) if (f.default !== undefined) out[k] = f.default;
  if (isObj(overlayConfig)) for (const [k, v] of Object.entries(overlayConfig)) if (k in manifest.config) out[k] = v;
  return out;
}

/** The overlay key of one contribution: `<kind>:<id>`, menus `menu:<slot>:<command>`. */
function contributionKey(kind, id, slot) {
  return kind === 'menu' ? 'menu:' + slot + ':' + id : kind + ':' + id;
}

/**
 * The resolved catalog.
 * -> {plugins: [{id, dir, source, name, description, version, enabled, activation,
 *                server, ui, config, manifest, error}], overlay}
 * `enabled` = no error, and the overlay's word if it has one, else the manifest's default.
 */
function resolveCatalog({ shippedDir = SHIPPED_DIR, workspaceDir, stateDir, log } = {}) {
  const overlay = readOverlay(stateDir, log);
  const plugins = discover({ shippedDir, workspaceDir }).map((p) => {
    const o = isObj(overlay.plugins[p.id]) ? overlay.plugins[p.id] : {};
    if (p.error) {
      if (log) log('plugin ' + p.id + ' disabled: ' + p.error);
      return { id: p.id, dir: p.dir, source: p.source, name: p.id, description: '', version: '',
        enabled: false, activation: 'lazy', server: undefined, ui: undefined, config: {}, manifest: null, error: p.error };
    }
    const m = p.manifest;
    return {
      id: p.id, dir: p.dir, source: p.source, name: m.name, description: m.description, version: m.version,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : m.enabled,
      activation: m.activation, server: m.server, ui: m.ui,
      config: effectiveConfig(m, o.config), manifest: m, error: null,
    };
  });
  return { plugins, overlay };
}

/**
 * What the enabled plugins contribute, each entry tagged with its `plugin` id,
 * overlay applied (a contribution the overlay disables is gone; `rank` overrides).
 * -> {profiles, commands, menus: {<slot>: [...]}, badges, views, sections, checks}
 */
function contributions(catalog) {
  const out = { profiles: [], commands: [], menus: {}, badges: [], views: [], sections: [], checks: [] };
  const tweaks = catalog.overlay.contributions;
  const keep = (key) => !(isObj(tweaks[key]) && tweaks[key].enabled === false);
  const rankOf = (key, r) => (isObj(tweaks[key]) && Number.isFinite(tweaks[key].rank) ? tweaks[key].rank : r);
  for (const p of catalog.plugins) {
    if (!p.enabled || !p.manifest) continue;
    const c = p.manifest.contributes;
    for (const kind of ['profiles', 'commands', 'badges', 'views', 'sections', 'checks']) {
      const single = { profiles: 'profile', commands: 'command', badges: 'badge', views: 'view', sections: 'section', checks: 'check' }[kind];
      for (const e of c[kind]) {
        const key = contributionKey(single, kind === 'profiles' ? e.name : e.id);
        if (!keep(key)) continue;
        out[kind].push(Object.assign({}, e, { plugin: p.id, key, rank: rankOf(key, e.rank === undefined ? 1000 : e.rank) }));
      }
    }
    for (const [slot, entries] of Object.entries(c.menus)) {
      for (const e of entries) {
        const key = contributionKey('menu', e.command, slot);
        if (!keep(key)) continue;
        (out.menus[slot] = out.menus[slot] || []).push(Object.assign({}, e, { plugin: p.id, key, rank: rankOf(key, e.rank) }));
      }
    }
  }
  const byRank = (a, b) => (a.rank - b.rank) || a.key.localeCompare(b.key);
  for (const kind of ['badges', 'views', 'sections', 'checks']) out[kind].sort(byRank);
  for (const slot of Object.keys(out.menus)) out.menus[slot].sort(byRank);
  return out;
}

module.exports = {
  PLUGIN_ID_RE, OVERLAY_FILE, SHIPPED_DIR, MENU_SLOTS, SECTION_SLOTS, VIEW_SLOTS, CHECK_PHASES, FIELD_TYPES,
  validateManifest, validateFields, readManifest, discover, readOverlay, writeOverlay,
  effectiveConfig, contributionKey, resolveCatalog, contributions,
};
