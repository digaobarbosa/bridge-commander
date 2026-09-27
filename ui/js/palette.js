// palette — the command palette (⌘K / Ctrl+K, or the ⌘ in the header): one
// filterable list of what the captain can run from here.
//
// Its context is the card open in the detail panel, else nothing:
//   - palette/v1 entries whose `when` matches that context (with no card, the
//     empty one — so an entry that asks about a card hides), run against that
//     card or card-less;
//   - with a card open, that card's own commands too: its moves, the built-in
//     actions (a refused one shows why and does not run) and the plugin
//     commands its menus, tile and detail header offer.
// The server re-checks every `when` before a run; hiding here is for the
// captain, not for safety.
//
// It is a modal (modal.js), so Escape — main.js's chain — and a backdrop
// click close it. The filtering and the item list are pure; the DOM is made
// only when the palette opens.
import { S, card as cardById } from './state.js';
import { cardContext, EMPTY_CONTEXT } from './cardview.js';
import { entries, hasEntries } from './slots.js';
import { cardMenuModel } from './cardactions.js';
import { runCommand, isBusy } from './commandui.js';
import { openModal } from './modal.js';
import { esc } from './util.js';

export const PALETTE_SLOT = 'palette/v1';
const CARD_SLOTS = ['card.menu/v1', 'card.actions/v1', 'detail.actions/v1'];

const deps = {
  openCardId: () => null, // the card the detail panel shows, when it shows one
};
export function configurePalette(d) { Object.assign(deps, d); }

// ---------- the pure part ----------

/**
 * Fuzzy match: every character of `query`, in order, somewhere in `text`
 * (case-insensitive). -> { score, hits: [index] } or null. Consecutive runs
 * and word starts score higher; a later first hit and gaps score lower.
 */
export function fuzzyMatch(query, text) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hits = [];
  let score = 0;
  let at = 0;
  let prev = -2;
  for (const ch of q) {
    const i = lower.indexOf(ch, at);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\s\-_./:·]/.test(t[i - 1]);
    score += 1 + (i === prev + 1 ? 6 : 0) + (wordStart ? 4 : 0) - Math.min(3, (i - at) * 0.2);
    hits.push(i);
    prev = i;
    at = i + 1;
  }
  return { score: score - hits[0] * 0.1, hits };
}

/**
 * Keep the items `query` matches (title first, then title + hint), best
 * first; an empty query keeps them all in their order. -> [{item, hits}]
 */
export function filterItems(items, query) {
  const out = [];
  items.forEach((item, i) => {
    let m = fuzzyMatch(query, item.title);
    if (!m) {
      const alt = fuzzyMatch(query, item.title + ' ' + (item.hint || ''));
      m = alt && { score: alt.score - 5, hits: alt.hits.filter((h) => h < item.title.length) };
    }
    if (m) out.push({ item, hits: m.hits, score: m.score, i });
  });
  if (String(query || '').trim()) out.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return out.map(({ item, hits }) => ({ item, hits }));
}

/**
 * What the palette offers with card `c` open (null = none). Every item is
 * { id, title, icon, hint, refused?, busy?, run() }.
 */
export function paletteItems(c, doc = S.doc) {
  const ctx = c ? cardContext(c, doc) : EMPTY_CONTEXT;
  const items = [];
  const seen = new Set();
  const plugin = (e, hint) => {
    if (seen.has(e.command)) return;
    seen.add(e.command);
    const busy = isBusy(e.command, c ? c.id : '');
    items.push({ id: e.command, title: e.title, icon: e.icon || '', hint: hint || e.plugin || '', busy,
      run: () => runCommand(e.command, c ? c.id : null) });
  };
  if (hasEntries(PALETTE_SLOT)) for (const e of entries(PALETTE_SLOT, ctx)) plugin(e);
  if (!c) return items;
  const model = cardMenuModel(c, doc);
  for (const m of model.moves) {
    if (m.current) continue;
    items.push({ id: m.id, title: 'move to ' + m.title, icon: '→', hint: c.id, run: m.run });
  }
  for (const a of model.actions) {
    items.push({ id: a.id, title: a.title, icon: a.icon || '', hint: c.id, refused: a.refused || '', run: a.run });
  }
  for (const slot of CARD_SLOTS) {
    if (!hasEntries(slot)) continue;
    for (const e of entries(slot, ctx)) plugin(e, (e.plugin ? e.plugin + ' · ' : '') + c.id);
  }
  return items;
}

/** A title with the matched characters bolded; escaped. */
export function markHits(title, hits) {
  if (!hits || !hits.length) return esc(title);
  const set = new Set(hits);
  let out = '';
  for (let i = 0; i < title.length; i++) out += set.has(i) ? '<b>' + esc(title[i]) + '</b>' : esc(title[i]);
  return out;
}

// ---------- the modal ----------

let open = null; // { handle, items, shown, sel }

export function paletteOpen() { return !!(open && open.handle.isOpen()); }

/** ⌘K: open the palette, or close it when it is the one open. */
export function togglePalette() {
  if (paletteOpen()) { open.handle.close(); return; }
  openPalette();
}

export function openPalette() {
  const id = deps.openCardId();
  const c = id ? cardById(id) : null;
  const items = paletteItems(c);
  const handle = openModal({
    title: c ? '⌘ ' + (c.title || c.id) : '⌘ commands',
    cls: 'bc-palette',
    body: '<input class="bc-pal-input" type="text" autocomplete="off" spellcheck="false" placeholder="' +
      (c ? 'run a command on ' + esc(c.id) + '…' : 'run a command…') + '" aria-label="command">' +
      '<div class="bc-pal-list" role="listbox"></div>',
    onClose: () => { if (open && open.handle === handle) open = null; },
  });
  const input = handle.body.querySelector('.bc-pal-input');
  const list = handle.body.querySelector('.bc-pal-list');
  const st = { handle, items, shown: [], sel: 0 };
  open = st;

  const paint = () => {
    st.shown = filterItems(st.items, input.value);
    if (st.sel >= st.shown.length) st.sel = Math.max(0, st.shown.length - 1);
    if (!st.items.length) {
      list.innerHTML = '<div class="bc-pal-empty">' + (c ? 'no commands for this card' : 'no commands here — open a card for its commands') + '</div>';
      return;
    }
    if (!st.shown.length) { list.innerHTML = '<div class="bc-pal-empty">no command matches</div>'; return; }
    list.innerHTML = st.shown.map(({ item, hits }, i) => {
      const off = item.refused || item.busy;
      const why = item.refused ? ' — ' + item.refused : item.busy ? ' …' : '';
      return '<button type="button" role="option" class="bc-pal-item' + (i === st.sel ? ' on' : '') + (off ? ' off' : '') + '" data-i="' + i + '"' +
        (item.refused ? ' title="not available: ' + esc(item.refused) + '"' : '') + ' aria-selected="' + (i === st.sel) + '">' +
        '<span class="bc-pal-icon">' + esc(item.icon || '▸') + '</span>' +
        '<span class="bc-pal-title">' + markHits(item.title, hits) + '<span class="bc-pal-why">' + esc(why) + '</span></span>' +
        '<span class="bc-pal-hint">' + esc(item.hint || '') + '</span></button>';
    }).join('');
    const on = list.querySelector('.bc-pal-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const row = st.shown[i];
    if (!row || row.item.refused || row.item.busy) return;
    // closed first: a command with a form opens its own modal on top of nothing
    handle.close();
    row.item.run();
  };
  const move = (d) => {
    if (!st.shown.length) return;
    st.sel = (st.sel + d + st.shown.length) % st.shown.length;
    paint();
  };

  input.addEventListener('input', () => { st.sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(st.sel); }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.bc-pal-item');
    if (b) pick(Number(b.dataset.i));
  });
  paint();
  input.focus();
  return handle;
}
