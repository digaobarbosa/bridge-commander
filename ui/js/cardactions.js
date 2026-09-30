// cardactions — the card command table. Every surface that offers something to
// DO with a card (the tile's right-click / long-press menu, the table row's
// context menu, the detail header's ⋯ and its buttons, the tile's icon
// buttons) reads it here, so no two surfaces can disagree about what a card
// offers or when an action is refused.
//
// The built-ins are rows of the same shape a plugin command has:
//   { id, key, title, icon, group, when?, predicate?(card, facts), run(card) }
// `when` is a JSON predicate over the card context (when.js) — shown or not;
// `predicate` is a refusal — shown, greyed, with the reason, and asked again
// on click (a board push may have bound a worker meanwhile). Every built-in has
// a contribution key (`command:card.archive`), so the overlay can switch it
// off like any plugin's.
//
// Plugin commands come from slots.js: card.menu/v1 (under a separator in the
// menu), card.actions/v1 (≤ 2 icon buttons on the tile), detail.actions/v1
// (buttons in the detail header). The tile stays cheap: it renders data and
// markup only; no plugin code runs per card.
import { S, columns, cards, render } from './state.js';
import { cardFacts, cardContext } from './cardview.js';
import { entries, hasEntries, isDisabled, badgeHtml, failedHtml } from './slots.js';
import { matches } from './when.js';
import { expandTemplate } from './template.js';
import { api } from './api.js';
import { enterSelection } from './selection.js';
import { openPopover } from './popover.js';
import { runCommand, isBusy } from './commandui.js';
import { esc } from './util.js';
import { cardSessions } from './terminal.js';

export const TILE_ACTIONS_MAX = 2;

const deps = {
  openPane() {},
  openSession() {},
  talk() {},
  prompt: (msg) => (globalThis.prompt ? globalThis.prompt(msg, '') : ''),
  alert: (msg) => { if (globalThis.alert) globalThis.alert(msg); },
};
/** Hand over the actions that live in DOM-bound modules (the pane, the chat). */
export function configureCardActions(d) { Object.assign(deps, d); }

// ---------- moves ----------

/**
 * A captain move that becomes an ORDER (any → working = start order,
 * review → backlog = rework order) carries an optional comment for the owning
 * lieutenant; any other move carries none. -> 'start order' | 'rework order' | ''
 */
export function orderKind(c, to) {
  if (!c || c.column === to) return '';
  if (to === 'working') return 'start order';
  if (c.column === 'review' && to === 'backlog') return 'rework order';
  return '';
}
/** Ask for the order's comment (empty or cancelled = none; the order still goes). */
export function orderComment(cardId, to) {
  const order = orderKind(cards().find((k) => k.id === cardId), to);
  if (!order) return '';
  return (deps.prompt('Comment for the ' + order + ' (optional):') || '').trim();
}
/** Move a card the way every surface does: with the order comment rule. */
export async function moveCard(cardId, to) {
  try { await api.moveCard(cardId, to, orderComment(cardId, to)); } catch (e) { deps.alert(e.message); }
}

// ---------- the built-in table ----------

async function archive(c) {
  // asked again: a worker may have bound since the menu was drawn
  const now = cards().find((k) => k.id === c.id);
  const v = now ? cardFacts(now, S.doc, Date.now()).canArchive : { ok: false, reason: 'card is gone' };
  if (!v.ok) { deps.alert('Not archived: ' + v.reason); return; }
  try { await api.archiveCard(c.id); } catch (e) { deps.alert(e.message); }
}

export const BUILTIN_ACTIONS = [
  { id: 'card.peek', title: 'open or resume session', icon: '👁', group: 'card', rank: 100,
    visible: (c) => c.column === 'working' || cardSessions(c).length > 0, run: (c) => deps.openSession(c.id) },
  { id: 'card.watch', title: 'watch the live terminal', icon: '▣', group: 'card', rank: 110,
    when: { 'card.column': 'working' }, visible: (c) => c.execution !== 'external', run: (c) => deps.openPane(c.id) },
  { id: 'card.talk', title: 'talk in its thread', icon: '💬', group: 'card', rank: 200, run: (c) => deps.talk(c.id) },
  // The way INTO selection mode, on the board and the table alike — nothing has
  // to sit on screen the rest of the time for it to be reachable.
  { id: 'card.select', title: 'select cards', icon: '☑', group: 'card', rank: 300, run: (c) => { enterSelection(c.id); render(); } },
  // Archiving kills a live worker's session: the same refusal the bulk bar applies.
  { id: 'card.archive', title: 'archive', icon: '✕', group: 'card', rank: 900, danger: true,
    predicate: (c, f) => f.canArchive, run: archive },
].map((a) => Object.freeze(Object.assign({ key: 'command:' + a.id }, a)));
const MOVE_KEY = 'command:card.move';

/**
 * What a card's menu offers, as data: `moves` (one per column; the card's own
 * is `current`), the built-in `actions` (a refused one carries `refused` with
 * the reason), then `plugins` (card.menu/v1 entries whose `when` matches).
 * Every item has `run()`.
 */
export function cardMenuModel(c, doc = S.doc, nowMs = Date.now()) {
  const ctx = cardContext(c, doc);
  const f = cardFacts(c, doc, nowMs);
  const moves = isDisabled(MOVE_KEY) ? [] : ((doc && doc.columns) || []).map((col) => ({
    id: 'card.move:' + col.id, key: MOVE_KEY, title: col.title || col.id, column: col.id,
    current: col.id === c.column, run: () => moveCard(c.id, col.id),
  }));
  const actions = BUILTIN_ACTIONS
    .filter((a) => !isDisabled(a.key) && matches(a.when, ctx) && (!a.visible || a.visible(c)))
    .map((a) => {
      const v = a.predicate ? a.predicate(c, f) : { ok: true };
      return { id: a.id, key: a.key, title: a.title, icon: a.icon, danger: !!a.danger,
        refused: v.ok ? '' : v.reason || 'not available', run: () => a.run(c) };
    });
  const plugins = entries('card.menu/v1', ctx).map((e) => ({
    id: e.command, key: e.key, title: e.title, icon: e.icon, plugin: e.plugin,
    busy: isBusy(e.command, c.id), run: () => runCommand(e.command, c.id),
  }));
  return { moves, actions, plugins };
}

/** The model as popover items: move to…, the built-ins, then the plugins under a rule. */
export function menuItems(model) {
  const items = [];
  if (model.moves.length) {
    items.push({ head: 'move to' });
    for (const m of model.moves) {
      items.push(m.current ? { label: '● ' + m.title, current: true } : { label: m.title, onClick: m.run });
    }
  }
  if (model.actions.length) {
    if (items.length) items.push({ sep: true });
    for (const a of model.actions) {
      const label = (a.icon ? a.icon + ' ' : '') + a.title;
      // refused: inert and grey, saying why — never a red button that does nothing
      items.push(a.refused
        ? { label: label + ' — ' + a.refused, title: 'not available: ' + a.refused }
        : { label, danger: a.danger, onClick: a.run });
    }
  }
  if (model.plugins.length) {
    items.push({ sep: true });
    for (const p of model.plugins) {
      const label = (p.icon ? p.icon + ' ' : '') + p.title + (p.busy ? ' …' : '');
      items.push(p.busy ? { label, title: 'running' } : { label, title: p.plugin ? 'from plugin ' + p.plugin : '', onClick: p.run });
    }
  }
  return items;
}

/** Open the card's menu at a point or under an element (tile, table row, detail ⋯). */
export function openCardMenu(cardId, at) {
  const c = cards().find((k) => k.id === cardId);
  if (!c) return null;
  return openPopover(at, menuItems(cardMenuModel(c, S.doc, Date.now())), { id: 'move-menu' });
}

// ---------- tile + detail markup (data only) ----------

/** The tile's plugin icon buttons (card.actions/v1), at most two. */
export function tileActionsHtml(c, doc = S.doc) {
  if (!hasEntries('card.actions/v1')) return '';
  return entries('card.actions/v1', cardContext(c, doc)).slice(0, TILE_ACTIONS_MAX)
    .map((e) => cmdButtonHtml(e, c, 't-cmd', false)).join('');
}
/** The detail header's plugin buttons (detail.actions/v1). */
export function detailActionsHtml(c, doc = S.doc) {
  if (!hasEntries('detail.actions/v1')) return '';
  return entries('detail.actions/v1', cardContext(c, doc)).map((e) => cmdButtonHtml(e, c, 'dt-cmd', true)).join('');
}
function cmdButtonHtml(e, c, cls, withTitle) {
  const b = isBusy(e.command, c.id);
  return '<button type="button" class="' + cls + (b ? ' busy' : '') + '" data-cmd="' + esc(e.command) + '"' +
    ' title="' + esc(e.title + (e.plugin ? ' · ' + e.plugin : '')) + '"' + (b ? ' disabled' : '') + '>' +
    esc(e.icon || '▸') + (withTitle ? '<span>' + esc(e.title) + '</span>' : '') + '</button>';
}

/**
 * The plugin badges a card wears: its server decorations (card.ext.<plugin>
 * .badges; a decorator that failed shows "⚠ plugin X failed") and the
 * manifest badges whose `when` matches, their `${…}` filled from the card
 * context. A manifest badge whose template names nothing is not drawn.
 */
export function pluginBadgesHtml(c, doc = S.doc) {
  let html = '';
  const ext = c && c.ext;
  if (ext && typeof ext === 'object') {
    for (const [pluginId, d] of Object.entries(ext)) {
      if (!d || typeof d !== 'object') continue;
      if (d.error) { html += failedHtml({ plugin: pluginId }, d.error); continue; }
      for (const b of Array.isArray(d.badges) ? d.badges : []) html += badgeHtml(b);
    }
  }
  if (hasEntries('card.badges/v1')) {
    const ctx = cardContext(c, doc);
    for (const e of entries('card.badges/v1', ctx)) {
      const t = expandTemplate(e.text, ctx);
      if (t.missing.length || !t.text.trim()) continue;
      html += badgeHtml({ text: t.text, tone: e.tone, tooltip: e.tooltip ? expandTemplate(e.tooltip, ctx).text : (e.plugin || '') });
    }
  }
  return html;
}

/** The chip a tile wears while one of its tracked runs is going. */
export function activityChipHtml(c, doc = S.doc) {
  const running = ((doc && doc.activities) || []).filter((a) => a && a.card === c.id && a.status === 'running');
  if (!running.length) return '';
  const a = running[0];
  const name = a.title || a.command || 'activity';
  return '<span class="t-activity" data-activity="' + esc(a.id) + '" title="' + esc(name + ' running' + (running.length > 1 ? ' (+' + (running.length - 1) + ' more)' : '') + ' — click for its log') + '">' +
    '<span class="spin"></span>' + esc(name) + (running.length > 1 ? ' ×' + running.length : '') + '</span>';
}
