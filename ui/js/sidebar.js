// sidebar — the sidebar/v1 registry: what fills the pane at the board's left.
// It is a single slot: the first enabled entry, by rank, is on screen and the
// others are hidden. The chat registers here as `sidebar:chat` with its own
// #chat element, so it is never rebuilt — the registry only hides and shows
// it. A plugin view with `"slot": "sidebar/v1"` registers the same way
// (plugins.js) and gets an element made here, next to the chat. The overlay
// switching `sidebar:chat` off is what lets a plugin sidebar through.
//
// entry = { id, title, icon?, render(el), mount?(el), dispose?(el), plugin?,
//           key = 'sidebar:<id>', rank = 1000, el? }
//   el     — an element the entry brings (the chat's #chat); else one is made
//   mount  — called once, the first time the entry is on screen
// DOM-light: without a host it makes no element, so node tests hand it plain
// objects with a `style`.

const byId = new Map();
const madeEls = new Map(); // id -> the element made for an entry that brought none
const mounted = new Set(); // ids whose mount() ran
let disabled = new Set();
const changeFns = new Set();
const deps = { host: null, before: null };

/** Where made elements go: inside `host`, before `before` (the board region). */
export function configureSidebar(d) { Object.assign(deps, d); }

function emit() {
  for (const fn of [...changeFns]) {
    try { fn(); } catch (e) { /* one bad listener must not stop the others */ }
  }
}

/** Register a sidebar. A second one with the same id replaces the first. Returns dispose(). */
export function registerSidebar(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id) throw new Error('sidebar: an entry needs an id');
  if (typeof entry.render !== 'function') throw new Error('sidebar: "' + entry.id + '" needs render()');
  const e = Object.assign({ key: 'sidebar:' + entry.id, rank: 1000, title: entry.id, icon: '' }, entry);
  byId.set(e.id, e);
  emit();
  return () => {
    if (byId.get(e.id) !== e) return; // replaced since (a reload), or already gone
    byId.delete(e.id);
    mounted.delete(e.id);
    const el = madeEls.get(e.id);
    if (el) {
      if (e.dispose) try { e.dispose(el); } catch (err) {}
      if (el.remove) el.remove();
      madeEls.delete(e.id);
    }
    emit();
  };
}

function ranked(list) {
  return list.sort((a, b) => (a.rank - b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Every enabled sidebar, in rank order; the first one is on screen. */
export function sidebars() { return ranked([...byId.values()].filter((e) => !disabled.has(e.key))); }
/** The entry on screen, or null when every sidebar is switched off. */
export function activeSidebar() { return sidebars()[0] || null; }

/** The element entry `id` paints into: the one it brought, else one made on first need. */
export function sidebarEl(id) {
  const e = byId.get(id);
  if (e && e.el) return e.el;
  if (madeEls.has(id)) return madeEls.get(id);
  if (!e || !deps.host || !globalThis.document) return null;
  const el = document.createElement('section');
  el.className = 'bc-sidebar';
  el.id = 'sb-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  if (e.plugin) el.dataset.plugin = e.plugin;
  if (deps.before && deps.before.parentNode === deps.host) deps.host.insertBefore(el, deps.before);
  else deps.host.appendChild(el);
  madeEls.set(id, el);
  return el;
}

// An inline display wins over every stylesheet rule (mobile's per-tab ones
// included); '' hands the element back to the stylesheet untouched.
function show(el, on) {
  if (!el || !el.style) return;
  const want = on ? '' : 'none';
  if (el.style.display !== want) el.style.display = want;
}

/**
 * Show the active sidebar, hide the rest, mount it the first time, paint it.
 * Called on every render pass. Returns the active entry (or null).
 */
export function renderSidebar() {
  const a = activeSidebar();
  for (const e of byId.values()) {
    if (e === a) continue;
    show(e.el || madeEls.get(e.id), false);
  }
  if (!a) return null;
  const el = sidebarEl(a.id);
  show(el, true);
  if (!mounted.has(a.id)) {
    mounted.add(a.id);
    if (a.mount) try { a.mount(el); } catch (err) { /* render still runs: it paints the failure */ }
  }
  a.render(el);
  return a;
}

/**
 * The contribution keys the captain switched off (GET /api/plugins `disabled`),
 * `sidebar:chat` among them.
 */
export function setDisabledSidebars(keys) {
  const next = new Set((keys || []).filter((k) => typeof k === 'string'));
  const same = next.size === disabled.size && [...next].every((k) => disabled.has(k));
  disabled = next;
  if (!same) emit();
}

export function onSidebarChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }

/** Tests start clean with it. */
export function resetSidebars() {
  byId.clear();
  madeEls.clear();
  mounted.clear();
  disabled = new Set();
  changeFns.clear();
  Object.assign(deps, { host: null, before: null });
}
