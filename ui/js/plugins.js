// plugins — the board's side of the plugin host. It reads GET /api/plugins at
// boot and again whenever the board's `pluginsVersion` moves, and turns the
// answer into registry entries: menus, badges and sections into slots.js,
// views into views.js, the switched-off keys into both. No plugin code runs for
// any of that — it is all manifest data.
//
// A plugin's `ui` module is imported only when something needs it: its view is
// shown, or one of its detail sections is rendered. It gets the `ui` object of
// docs/rfc/plugins-contracts.md ("Plugin UI modules"), and every call into it
// runs inside the slot error boundary, so a broken plugin fails in its own
// slot and nowhere else.
//
// Importable without a DOM: the elements plugin views paint into are made only
// when a view registers, in the host main.js hands over (configurePlugins).
import { S, render } from './state.js';
import { contribute, setDisabled, boundary, failedHtml } from './slots.js';
import { registerView, setDisabledViews, current } from './views.js';
import { cardContext } from './cardview.js';
import { esc } from './util.js';

// What the board offered before harnesses were plugins: the fallback when the
// endpoint is missing (an older server) or answers without a list.
export const FALLBACK_HARNESSES = ['claude', 'codex'];

const EMPTY = { plugins: [], contributions: {}, harnesses: null, disabled: [] };

const P = {
  payload: EMPTY,
  loaded: false,       // a real answer (or a definite 404) has landed
  missing: false,      // the server has no /api/plugins
  error: '',
  version: null,       // the board's pluginsVersion we last loaded for
  inflight: null,
};
let commands = new Map();
let disposers = [];            // this load's slot and view registrations
const viewEls = new Map();     // view id -> the element it paints into
const modules = new Map();     // plugin id -> { promise, active, error, views, sections, disposers }
const changeFns = new Set();

const deps = {
  host: null,                  // #board-wrap: plugin views get a div in it
  before: null,                // …inserted before this node (the taskbar)
  openCard() {},
  openActivity() {},
  toast() {},
  fetch: (...a) => globalThis.fetch(...a),
  importModule: (url) => import(url),
};
/** Hand over what the loader cannot reach on its own (DOM host, panel openers). */
export function configurePlugins(d) { Object.assign(deps, d); }

export function onPluginsChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }
function changed() {
  for (const fn of [...changeFns]) {
    try { fn(); } catch (e) { /* a bad listener must not stop the load */ }
  }
}

// ---------- the pure part: an answer → registry entries ----------

/**
 * Map a GET /api/plugins answer onto what the registries take.
 * -> { slots: [{slot, entry}], views: [view], commands: Map(id -> command) }
 * A menu entry takes its title and icon from the command it names; one that
 * names a command nobody provides is dropped (it could not run anyway).
 */
export function mapContributions(payload) {
  const c = (payload && payload.contributions) || {};
  const cmds = new Map((c.commands || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const slots = [];
  const rank = (e) => (Number.isFinite(e.rank) ? e.rank : 1000);
  for (const [slot, list] of Object.entries(c.menus || {})) {
    for (const e of list || []) {
      const cmd = e && cmds.get(e.command);
      if (!cmd) continue;
      slots.push({ slot, entry: {
        key: e.key || 'menu:' + slot + ':' + e.command, plugin: e.plugin || cmd.plugin, rank: rank(e), when: e.when,
        command: cmd.id, title: e.title || cmd.title || cmd.id, icon: e.icon || cmd.icon || '',
      } });
    }
  }
  for (const b of c.badges || []) {
    if (!b || !b.id) continue;
    slots.push({ slot: 'card.badges/v1', entry: {
      key: b.key || 'badge:' + b.id, plugin: b.plugin, rank: rank(b), when: b.when,
      text: b.text, tone: b.tone, tooltip: b.tooltip,
    } });
  }
  for (const s of c.sections || []) {
    if (!s || !s.id) continue;
    slots.push({ slot: s.slot || 'detail.sections/v1', entry: {
      key: s.key || 'section:' + s.id, plugin: s.plugin, rank: rank(s), when: s.when, id: s.id, title: s.title || s.id, icon: s.icon || '',
    } });
  }
  const views = (c.views || []).filter((v) => v && v.id).map((v) => ({
    id: v.id, key: v.key || 'view:' + v.id, plugin: v.plugin, rank: rank(v),
    title: v.title || v.id, icon: v.icon || '', tip: v.description || v.title || v.id,
  }));
  return { slots, views, commands: cmds };
}

// ---------- reads ----------

export function pluginsState() { return P; }
export function pluginList() { return (P.payload && P.payload.plugins) || []; }
export function plugin(id) { return pluginList().find((p) => p.id === id) || null; }
export function command(id) { return commands.get(id) || null; }
export function disabledKeys() { return (P.payload && P.payload.disabled) || []; }
/** Everything the enabled plugin `id` contributes, by kind, for the settings tab. */
export function contributionsOf(id) {
  const c = (P.payload && P.payload.contributions) || {};
  const mine = (list) => (list || []).filter((x) => x && x.plugin === id);
  const menus = [];
  for (const [slot, list] of Object.entries(c.menus || {})) for (const e of mine(list)) menus.push(Object.assign({ slot }, e));
  return { commands: mine(c.commands), menus, badges: mine(c.badges), views: mine(c.views), sections: mine(c.sections), checks: mine(c.checks) };
}
/** The module's load error, when its ui module failed to import or activate. */
export function moduleError(id) { const m = modules.get(id); return (m && m.error) || ''; }

/** Harness names for the lieutenant dropdowns: the server's list, or the fallback. */
export function harnesses() {
  const list = P.payload && P.payload.harnesses;
  const names = Array.isArray(list) ? list.map((h) => (typeof h === 'string' ? h : h && h.name)).filter(Boolean) : [];
  return names.length ? names : FALLBACK_HARNESSES.slice();
}
/** The harness a new lieutenant starts on: the server's word, else the first fallback it lists, else its first. */
export function defaultHarness() {
  const names = harnesses();
  const said = P.payload && P.payload.defaultHarness;
  if (said && names.includes(said)) return said;
  return names.includes(FALLBACK_HARNESSES[0]) ? FALLBACK_HARNESSES[0] : names[0];
}
/** Fill a <select> with the harnesses, keeping `selected` pickable even when unlisted. */
export function fillHarnessOptions(select, selected) {
  if (!select) return;
  const names = harnesses();
  if (selected && !names.includes(selected)) names.push(selected);
  const want = selected || select.value || defaultHarness();
  select.textContent = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    select.appendChild(o);
  }
  select.value = names.includes(want) ? want : defaultHarness();
}

// ---------- loading ----------

/** Fetch /api/plugins and apply it. Concurrent calls share one request. */
export function loadPlugins() {
  if (P.inflight) return P.inflight;
  P.inflight = (async () => {
    let payload = null;
    try {
      const r = await deps.fetch('/api/plugins');
      if (r.status === 404) { P.missing = true; payload = EMPTY; }
      else if (!r.ok) throw new Error('HTTP ' + r.status);
      else { P.missing = false; payload = await r.json(); }
      P.error = '';
    } catch (e) {
      // A failed read keeps what was loaded: the board must not lose its menus
      // over one dropped request.
      P.error = String((e && e.message) || e);
    }
    if (payload) apply(payload);
    else changed();
  })().finally(() => { P.inflight = null; });
  return P.inflight;
}

/** onBoard hook: a moved `pluginsVersion` means the catalog changed server-side. */
export function syncPlugins(doc) {
  const v = doc && doc.pluginsVersion;
  if (v === undefined || v === P.version) return;
  const first = P.version === null;
  P.version = v;
  // the boot fetch is already this version's answer (or on its way)
  if (first && (P.loaded || P.inflight)) return;
  loadPlugins();
}

function apply(payload) {
  P.payload = Object.assign({}, EMPTY, payload);
  P.loaded = true;
  const m = mapContributions(P.payload);
  commands = m.commands;
  const next = [];
  // Register the new set BEFORE disposing the old: an entry re-contributed
  // under the same key replaces the old one, whose disposer then does nothing,
  // so a view on screen is never torn down and rebuilt by a reload.
  for (const { slot, entry } of m.slots) next.push(contribute(slot, entry));
  const liveViews = new Set();
  for (const v of m.views) {
    liveViews.add(v.id);
    const el = viewEl(v.id);
    next.push(registerView({
      id: v.id, key: v.key, title: v.title, icon: v.icon, tip: v.tip, rank: v.rank, plugin: v.plugin,
      el, remember: true, screen: false,
      render: () => renderPluginView(v, el),
    }));
  }
  for (const d of disposers) d();
  disposers = next;
  for (const [id, el] of viewEls) {
    if (liveViews.has(id)) continue;
    if (el && el.remove) el.remove();
    viewEls.delete(id);
  }
  setDisabled(P.payload.disabled || []);
  setDisabledViews(P.payload.disabled || []);
  // a plugin switched off or gone takes its activated module with it
  for (const id of [...modules.keys()]) {
    const p = plugin(id);
    if (!p || p.enabled === false) disposeModule(id);
  }
  changed();
  render();
}

// Each plugin view paints into its own div in the board region, made once and
// kept across reloads (the plugin's DOM survives a catalog change).
function viewEl(id) {
  if (viewEls.has(id)) return viewEls.get(id);
  let el = null;
  if (deps.host && globalThis.document) {
    el = document.createElement('div');
    el.className = 'bc-view bc-plugin-view';
    el.id = 'pv-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    if (deps.before && deps.before.parentNode === deps.host) deps.host.insertBefore(el, deps.before);
    else deps.host.appendChild(el);
  }
  viewEls.set(id, el);
  return el;
}

// ---------- plugin ui modules ----------

function uiState() {
  return { doc: S.doc, context: (card) => cardContext(card, S.doc) };
}

async function uiApi(method, path, body) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('ui.api: a same-origin path starting with /');
  const r = await deps.fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  if (!r.ok) throw new Error((json && json.error) || 'HTTP ' + r.status);
  return json;
}

// The object a plugin's activate(ui) receives; see the contract.
function makeUi(p, mod) {
  const reg = (map) => (spec) => {
    if (!spec || typeof spec.id !== 'string' || typeof spec.render !== 'function') throw new Error('register({id, render}) needed');
    map.set(spec.id, spec);
    const dispose = () => { if (map.get(spec.id) === spec) map.delete(spec.id); };
    mod.disposers.push(dispose);
    render(); // what was waiting on this renderer paints now
    return dispose;
  };
  return Object.freeze({
    plugin: Object.freeze({ id: p.id, config: Object.freeze(Object.assign({}, p.config || {})) }),
    views: Object.freeze({ register: reg(mod.views) }),
    sections: Object.freeze({ register: reg(mod.sections) }),
    state: uiState,
    openCard: (id) => deps.openCard(id),
    openActivity: (id) => deps.openActivity(id),
    toast: (text) => deps.toast(String(text)),
    api: uiApi,
    html: Object.freeze({ esc }),
  });
}

/** Import and activate plugin `id`'s ui module once. Resolves to its record. */
export function ensureModule(id) {
  const existing = modules.get(id);
  if (existing) return existing.promise;
  const p = plugin(id);
  const mod = { promise: null, active: false, error: '', views: new Map(), sections: new Map(), disposers: [], plugin: id };
  modules.set(id, mod);
  mod.promise = (async () => {
    try {
      if (!p || !p.ui) throw new Error('plugin ' + id + ' has no ui module');
      const m = await deps.importModule(p.ui);
      const target = typeof m.activate === 'function' ? m : m.default;
      if (!target || typeof target.activate !== 'function') throw new Error('its ui module exports no activate(ui)');
      await target.activate(makeUi(p, mod));
    } catch (e) {
      mod.error = String((e && e.message) || e);
    }
    mod.active = true;
    changed();
    render();
    return mod;
  })();
  return mod.promise;
}

function disposeModule(id) {
  const mod = modules.get(id);
  if (!mod) return;
  modules.delete(id);
  for (const [vid, spec] of mod.views) {
    if (spec.dispose) try { spec.dispose(viewEls.get(vid)); } catch (e) {}
  }
  for (const d of mod.disposers) try { d(); } catch (e) {}
}

function paintFailure(el, entry, error) {
  const html = '<div class="bc-slot-failed">' + failedHtml(entry, error) + '</div>';
  if (el.__bcHtml !== html) { el.__bcHtml = html; el.innerHTML = html; }
}

/**
 * Paint plugin view `v` into `el`: import the module on first need, then its
 * render(el, state) inside the error boundary. Called on every board push
 * while the view is on screen.
 */
export function renderPluginView(v, el) {
  if (!el) return;
  const entry = { plugin: v.plugin, key: v.key };
  const mod = modules.get(v.plugin);
  if (!mod || !mod.active) {
    if (!mod) ensureModule(v.plugin).then(() => { if (current() === v.id) render(); });
    const html = '<div class="bc-slot-loading">loading ' + esc(v.title) + '…</div>';
    if (el.__bcHtml !== html) { el.__bcHtml = html; el.innerHTML = html; }
    return;
  }
  if (mod.error) return paintFailure(el, entry, mod.error);
  const r = mod.views.get(v.id);
  if (!r) return paintFailure(el, entry, 'its ui module registered no view "' + v.id + '"');
  el.__bcHtml = null; // the plugin owns this DOM now
  const res = boundary(entry, () => r.render(el, uiState()));
  if (res && res.error) paintFailure(el, entry, res.error);
}

/**
 * Paint detail section `entry` for `card` into `el` (same rules as a view).
 * Returns the renderer's dispose(el), when it has one, for the caller to run
 * when the section leaves the panel.
 */
export function renderPluginSection(entry, el, card) {
  const mod = modules.get(entry.plugin);
  if (!mod || !mod.active) {
    if (!mod) ensureModule(entry.plugin);
    const html = '<div class="bc-slot-loading">loading…</div>';
    if (el.__bcHtml !== html) { el.__bcHtml = html; el.innerHTML = html; }
    return null;
  }
  if (mod.error) { paintFailure(el, entry, mod.error); return null; }
  const r = mod.sections.get(entry.id);
  if (!r) { paintFailure(el, entry, 'its ui module registered no section "' + entry.id + '"'); return null; }
  if (el.__bcHtml) { el.__bcHtml = null; el.innerHTML = ''; }
  const res = boundary(entry, () => r.render(el, card, uiState()));
  if (res && res.error) paintFailure(el, entry, res.error);
  return r.dispose ? () => { try { r.dispose(el); } catch (e) {} } : null;
}

// ---------- writes ----------

/**
 * PUT /api/plugins/overlay with a partial overlay, then reload. -> the
 * server's answer ({restartNeeded?}); throws with the server's message.
 */
export async function saveOverlay(patch) {
  const res = await uiApi('PUT', '/api/plugins/overlay', patch);
  await loadPlugins();
  return res || {};
}

/** Tests start clean with it. */
export function resetPlugins() {
  for (const d of disposers) d();
  disposers = [];
  for (const id of [...modules.keys()]) disposeModule(id);
  viewEls.clear();
  commands = new Map();
  Object.assign(P, { payload: EMPTY, loaded: false, missing: false, error: '', version: null, inflight: null });
}
