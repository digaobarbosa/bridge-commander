// slots — the registry the shell's slots read. Built-ins and plugins both
// contribute here, so a menu or a badge row never knows who filled it.
//
// An entry is typed data, never DOM: { key, plugin?, rank = 1000, when?, ...payload }.
// `when` is a JSON predicate (when.js) asked of the card context, so no plugin
// code runs to decide visibility. Pure and DOM-free: node tests import it.
import { matches } from './when.js';
import { esc } from './util.js';

export const DEFAULT_RANK = 1000;
export const LIMIT_PER_PLUGIN = 8;

const bySlot = new Map(); // slot -> Map(key -> entry)
let disabled = new Set();
const listeners = new Set();

function changed() {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { /* one bad listener must not stop the others */ }
  }
}

/**
 * Put an entry in a slot. A second entry with the same key replaces the first
 * (a plugin reload re-contributes); the first one's disposer then does nothing.
 * Returns dispose().
 */
export function contribute(slot, entry) {
  if (!entry || typeof entry.key !== 'string' || !entry.key) throw new Error('slots: an entry needs a key');
  const e = Object.freeze(Object.assign({ rank: DEFAULT_RANK }, entry));
  let m = bySlot.get(slot);
  if (!m) bySlot.set(slot, (m = new Map()));
  m.set(e.key, e);
  changed();
  return () => {
    if (m.get(e.key) !== e) return; // replaced since, or already gone
    m.delete(e.key);
    changed();
  };
}

/**
 * The entries a slot shows, in order: `when` is asked of `ctx` (no ctx = no
 * card to ask about, so `when` is not applied), disabled keys drop out, then
 * rank, then key. Each plugin keeps at most `limitPerPlugin` entries per slot —
 * its best-ranked ones — so one plugin cannot flood a menu. Entries without a
 * plugin are the shell's own and are not capped.
 */
export function entries(slot, ctx, { limitPerPlugin = LIMIT_PER_PLUGIN } = {}) {
  const m = bySlot.get(slot);
  if (!m) return [];
  const list = [...m.values()].filter((e) => !disabled.has(e.key) && (ctx === undefined || visible(e, ctx)));
  list.sort((a, b) => (a.rank - b.rank) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const per = new Map();
  return list.filter((e) => {
    if (!e.plugin) return true;
    const n = (per.get(e.plugin) || 0) + 1;
    per.set(e.plugin, n);
    return n <= limitPerPlugin;
  });
}
// A malformed predicate hides its own entry, never the slot.
function visible(e, ctx) {
  try { return matches(e.when, ctx); } catch (err) { return false; }
}

/** Replace the set of contribution keys the captain switched off. */
export function setDisabled(keys) {
  disabled = new Set(keys || []);
  changed();
}

/** Call fn after every change to the registry. Returns dispose(). */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The error boundary around one contribution: fn(entry)'s value, or
 * { error, plugin, key } when it throws (or its promise rejects). A failing
 * plugin fails in its own slot and nowhere else.
 */
export function boundary(entry, fn) {
  const fail = (e) => ({ error: String((e && e.message) || e), plugin: entry && entry.plugin, key: entry && entry.key });
  try {
    const v = fn(entry);
    return v && typeof v.then === 'function' ? v.then((x) => x, fail) : v;
  } catch (e) {
    return fail(e);
  }
}

// tones are whitelisted before they reach a class name
const TONES = new Set(['info', 'ok', 'warn', 'danger', 'muted']);

/** A data badge {text, tone?, tooltip?} as markup; everything escaped. */
export function badgeHtml(badge) {
  if (!badge || badge.text === undefined || badge.text === null || badge.text === '') return '';
  const tone = TONES.has(badge.tone) ? badge.tone : 'info';
  return '<span class="bc-badge bc-badge-' + tone + '"' + (badge.tooltip ? ' title="' + esc(badge.tooltip) + '"' : '') + '>' +
    esc(badge.text) + '</span>';
}

/** The placeholder a failed contribution leaves in its slot: "⚠ plugin X failed". */
export function failedHtml(entry, error) {
  const who = (entry && (entry.plugin || entry.key)) || 'unknown';
  const msg = error && typeof error === 'object' ? error.error || error.message : error;
  return '<span class="bc-failed" title="' + esc(msg ? String(msg) : 'failed') + '">⚠ plugin ' + esc(who) + ' failed</span>';
}

/** Drop every contribution and the disabled set. Tests start clean with it. */
export function resetSlots() {
  bySlot.clear();
  disabled = new Set();
  changed();
}
