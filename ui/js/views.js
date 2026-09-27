// views — the main/v1 registry: what can fill the board region, and which one
// does now. The built-ins (kanban, table, archive, ⚡, the file and config
// screens) register here exactly as a plugin view does, so the switcher, the
// phone's mode menu, the render dispatch and the "what does a reload restore"
// rule all read one list.
//
// view = { id, title, icon, el, render(), enter?(), remember, screen, plugin?,
//          key = 'view:<id>', rank = 1000, tip? }
//   remember — a switcher view: shown in ▦☰🧊⚡ and restored after a reload
//   screen   — entered from somewhere else (a file, the gear); never remembered
// DOM-light: it only toggles the class of each view's `el`, so node tests can
// hand it plain objects.
import { S } from './state.js';
import { boardModeFor, switcherModeFor } from './modes.js';

const STORE_KEY = 'bc-board-mode';
const byId = new Map();
let disabled = new Set();
let cur = null;
let pending = null; // the stored view restoreMode() could not land on yet
const changeFns = new Set(); // registry changed (a view came, went, or was switched off)
const modeFns = new Set();   // the current view changed: fn(to, from)

function emit(set, ...args) {
  for (const fn of [...set]) {
    try { fn(...args); } catch (e) { /* one bad listener must not stop the others */ }
  }
}

/** Register a view. A second one with the same id replaces the first. Returns dispose(). */
export function registerView(v) {
  if (!v || typeof v.id !== 'string' || !v.id) throw new Error('views: a view needs an id');
  if (typeof v.render !== 'function') throw new Error('views: view "' + v.id + '" needs render()');
  const e = Object.assign({ key: 'view:' + v.id, rank: 1000, title: v.id, icon: '', remember: !v.screen, screen: false }, v);
  byId.set(e.id, e);
  emit(changeFns);
  if (cur === e.id) toggleEls();
  // the view a reload wanted, arriving late (a plugin view loads after boot)
  else if (pending === e.id && enabled(e)) setMode(e.id);
  return () => {
    if (byId.get(e.id) !== e) return;
    byId.delete(e.id);
    emit(changeFns);
    if (cur === e.id) setMode(lastSwitcher());
  };
}

function enabled(v) { return v && !disabled.has(v.key); }
function ranked(list) {
  return list.sort((a, b) => (a.rank - b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The switcher views, in rank order: registered, remembered, not switched off. */
export function views() {
  return ranked([...byId.values()].filter((v) => v.remember && !v.screen && enabled(v)));
}
/** Every registered view (screens and switched-off ones included), in rank order. */
export function allViews() { return ranked([...byId.values()]); }
export function view(id) { return byId.get(id) || null; }
/** The id of the view on screen. */
export function current() { return cur; }
export function isScreen(id) { const v = byId.get(id); return !!(v && v.screen); }

// Where a request for `id` lands: the view itself when it is registered and
// on, otherwise the first switcher view — the kanban unless it is off.
function resolve(id) {
  const sw = views().map((v) => v.id);
  const screens = [...byId.values()].filter((v) => v.screen && enabled(v)).map((v) => v.id);
  return boardModeFor(id, sw, screens, sw[0] || screens[0] || null);
}
function stored() {
  try { return globalThis.localStorage ? globalThis.localStorage.getItem(STORE_KEY) : null; } catch (e) { return null; }
}
/** The switcher view a reload restores, and the way out of a screen. */
export function lastSwitcher() {
  const sw = views().map((v) => v.id);
  return switcherModeFor(stored(), sw, sw[0] || null);
}

function toggleEls() {
  for (const v of byId.values()) {
    const on = v.id === cur;
    if (v.el && v.el.classList) v.el.classList.toggle('view-on', on);
  }
}

/**
 * Switch the board region to `id` (resolved as above). A remembered view is
 * stored for the next reload; entering a view runs its enter(). Listeners hear
 * (to, from) after the switch. Returns the id landed on.
 */
export function setMode(id) {
  pending = null; // a choice made since boot beats what the reload wanted
  const to = resolve(id);
  const from = cur;
  cur = to;
  S.boardMode = to;
  const v = byId.get(to);
  // Stored only when the request was honored: a fallback is not a choice, and
  // must not overwrite a remembered plugin view that simply has not loaded yet.
  if (v && v.remember && !v.screen && to === id) {
    try { if (globalThis.localStorage) globalThis.localStorage.setItem(STORE_KEY, to); } catch (e) {}
  }
  toggleEls();
  if (v && to !== from && v.enter) {
    try { v.enter(); } catch (e) { /* a view that fails to enter still shows */ }
  }
  emit(modeFns, to, from);
  return to;
}

/**
 * Boot: land on the view this browser remembers. When that view is not
 * registered yet (a plugin view), land on the fallback and switch to it the
 * moment it registers — unless the captain picked something meanwhile.
 */
export function restoreMode() {
  const want = stored();
  const to = setMode(want || lastSwitcher());
  if (want && to !== want) pending = want;
  return to;
}

/** Paint the current view. Returns what its render() returned. */
export function renderCurrent() {
  const v = byId.get(cur);
  return v ? v.render() : undefined;
}

/**
 * The contribution keys the captain switched off (GET /api/plugins `disabled`).
 * Switching off the view on screen falls back to the first remaining one.
 */
export function setDisabledViews(keys) {
  disabled = new Set(keys || []);
  emit(changeFns);
  if (cur && !enabled(byId.get(cur))) setMode(lastSwitcher());
}

export function onViewsChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }
export function onModeChange(fn) { modeFns.add(fn); return () => modeFns.delete(fn); }

/** Tests start clean with it. */
export function resetViews() {
  byId.clear();
  disabled = new Set();
  cur = null;
  pending = null;
  changeFns.clear();
  modeFns.clear();
}
