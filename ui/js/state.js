// central UI state + derived selectors. The board doc from SSE is the truth;
// everything here is view state or cheap derivation over it. Pure: no DOM at
// import, so the 3D room and node tests share these rules.
import { validAvatar } from './avatars.js';

export const USER = 'user';

export const S = {
  doc: null,               // full board doc from the server
  connected: false,
  // The chat panel always talks to a lieutenant: either its main chat or one of
  // its card threads (the interlocutor of a card thread is the owning
  // lieutenant). null until the first doc lands / a lieutenant exists.
  chatMode: null,          // {mode:'lieutenant', id} | {mode:'card', id} | null
  openCardId: null,        // detail panel
  view: 'chat',            // mobile tab: 'chat' | 'board'
  boardMode: 'board',      // the board region's view: 'board' (kanban) | 'table' | 'archive'
  // The ONE filter state, shared by every board-region mode. `text` lives in
  // the topbar input; the rest is configured in the filter popup (filterpop.js).
  // Every dimension is MULTI: sel holds {kind:'label'|'owner', value} chips,
  // types/columns hold toggled values. Semantics: OR within a dimension, AND
  // across dimensions.
  filters: { text: '', age: '', sel: [], types: [], columns: [] },
  notifOpen: false,
  notifShowAll: false,
  notifExpanded: new Set(), // seq of level-1 item whose preceding gap is expanded
};

let renderFn = () => {};
export function onRender(fn) { renderFn = fn; }
export function render() { renderFn(); }

// ---------- board ingest ----------
// Every board document — SSE push, reconnect refetch, the chat's echo refetch,
// the 3D room — enters through applyBoard, so no path can skip a tracker.
const boardSubs = [];
/** Register fn(doc), run on every board document taken in, before the render. */
export function onBoard(fn) { boardSubs.push(fn); }
/** The one entry point for a board document: store it, notify subscribers, render. */
export function applyBoard(doc) {
  if (!doc) return;
  S.doc = doc;
  for (const fn of boardSubs) fn(doc);
  render();
}

// ---------- pure rules (no S.doc) ----------
/** Map id → item for a list of board records (cards, lieutenants, columns). */
export function byId(list) { return new Map((list || []).map((x) => [x.id, x])); }
/**
 * Whether `actor` names this lieutenant. The server stamps chat-say events and
 * messages with the author NAME, not the id, so both match.
 */
export function isActor(lt, actor) { return !!(lt && actor) && (lt.id === actor || lt.name === actor); }
/** Messages in `msgs` the captain has not read: not his own, newer than `readTs`. */
export function unreadCount(msgs, readTs) {
  return (msgs || []).filter((m) => m.author !== USER && (!readTs || m.ts > readTs)).length;
}
/** The captain's read marker for a thread target, from a board doc's `reads` map. */
export function readMarker(readsMap, target) {
  const u = readsMap && readsMap[USER];
  return (u && u.threads && u.threads[target]) || '';
}

// ---------- selectors ----------
export function cards() { return (S.doc && S.doc.cards) || []; }
export function card(id) { return cards().find((c) => c.id === id); }
export function columns() { return (S.doc && S.doc.columns) || []; }
/** A column's display title, or the id itself when the column is unknown. */
export function columnTitle(id) {
  const col = columns().find((k) => k.id === id);
  return col ? col.title || col.id : id;
}
export function lieutenants() { return (S.doc && S.doc.lieutenants) || []; }
export function lieutenant(id) { return lieutenants().find((l) => l.id === id); }
// Lieutenants by most recent conversation — the chat's last message first, and
// whoever never spoke at the end, ordered by name so equals never swap places.
// The switcher freezes this at open (ltswitcher.js): rows must not slide under
// a finger mid-tap.
export function lieutenantsByRecent() {
  return lieutenants().slice().sort((a, b) => {
    const ta = lieutenantChatTs(a), tb = lieutenantChatTs(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}
function lieutenantChatTs(l) {
  const chat = (l && l.chat) || [];
  let ts = '';
  for (const m of chat) if (m.ts > ts) ts = m.ts;
  return ts;
}
// The lieutenant behind an event's `actor`, if any. The server stamps chat-say
// events with the author NAME (not the id — server.js's msg.author), so match
// both; 'user'/'server'/'worker' actors resolve to nothing.
export function lieutenantByActor(actor) {
  return lieutenants().find((l) => isActor(l, actor));
}
export function lieutenantColor(id) {
  const l = lieutenant(id);
  return l && /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#66788a';
}
export function lieutenantName(id) {
  const l = lieutenant(id);
  return l ? l.name || l.id : id;
}
export function lieutenantAvatar(id) {
  const l = lieutenant(id);
  return validAvatar(l && l.avatar);
}
// the worker registry record bound to a card (board.workers rides the payload);
// its agentStatus feeds the Working-tile context bar
export function workerFor(cardId) {
  return ((S.doc && S.doc.workers) || []).find((w) => w.card === cardId);
}

export function reads() {
  const r = (S.doc && S.doc.reads && S.doc.reads[USER]) || {};
  return {
    notifSeq: r.notifSeq || 0,
    notifSeqs: r.notifSeqs || [],
    threads: r.threads || {},
  };
}
/**
 * Apply a read marker to the local doc until the next broadcast carries it.
 * The server persists reads without broadcasting (only this user's view moves).
 */
export function applyLocalRead(target, ts) {
  if (!S.doc) return;
  const all = S.doc.reads || (S.doc.reads = {});
  const u = all[USER] || (all[USER] = { notifSeq: 0, notifSeqs: [], threads: {} });
  const threads = u.threads || (u.threads = {});
  if (!threads[target] || threads[target] < ts) threads[target] = ts;
  // the board dot reads the server-derived card status, not the marker
  const m = /^card:(.+)$/.exec(target);
  const c = m && card(m[1]);
  if (c && c.status) c.status.unread = false;
}
export function threadReadTs(target) { return readMarker(S.doc && S.doc.reads, target); }
export function threadUnread(target, msgs) { return unreadCount(msgs, threadReadTs(target)); }
export function cardUnread(c) { return threadUnread('card:' + c.id, c.thread); }
export function lieutenantUnread(l) { return threadUnread('lieutenant:' + l.id, l.chat); }
// newest unread-relevant ts on a card: lieutenant thread messages + level-1
// events — the same inputs the server derives card unread from. Used as the
// read-marker dedupe key so each new unread-relevant item allows exactly one POST.
export function cardActivityTs(c) {
  let ts = '';
  for (const m of (c && c.thread) || []) if (m.author !== USER && m.ts > ts) ts = m.ts;
  for (const e of (c && c.events) || []) if (e.level === 1 && e.ts > ts) ts = e.ts;
  return ts;
}

// A card's last-real-activity timestamp, for display and column sort. The server
// derives `activity` (max of the card's real event/thread timestamps) so incidental
// writes — a status-lease refresh/decay, an attribute sync — never read as "now".
// Fall back to the mutable `updated` for any older cached doc without it.
export function cardRecency(c) { return (c && (c.activity || c.updated)) || ''; }
/** Sort comparator: most recent real activity first (cardRecency). */
export function byRecency(a, b) {
  return (new Date(cardRecency(b) || 0).getTime() || 0) - (new Date(cardRecency(a) || 0).getTime() || 0);
}

// ---------- status (card.status is the single source; no other status feed) ----------
export function cardStatus(c) {
  return (c && c.status) || { worker: { id: null, state: 'absent' }, owed: false, unread: false };
}
// owed on a target, as a tri-state: null (nothing owed), 'queued' (the message
// is durably in the lieutenant's inbox but NOT yet drained — unseen), or 'seen'
// (drained; the lieutenant is actively on the hook for a reply). Both are
// server-derived from the delivery queue — owed means the latest captain
// message is unACKED, regardless of who spoke last in the thread, so a message
// buried under an interleaved reply keeps showing until actually consumed.
// Cards carry status.owed/owedState; a lieutenant's main chat carries the
// equivalent chatOwed/chatQueued bits.
export function targetOwedState(target) {
  const lt = /^lieutenant:(.+)$/.exec(target || '');
  if (lt) {
    const l = lieutenant(lt[1]);
    if (!l) return null;
    let owed = l.chatOwed;
    if (owed === undefined) { // older server payload: fall back to the last-message rule
      const ch = l.chat || [];
      const last = ch[ch.length - 1];
      owed = !!(last && last.author === USER);
    }
    if (!owed) return null;
    return l.chatQueued ? 'queued' : 'seen';
  }
  const c = card((target || '').slice(5));
  const st = c && cardStatus(c);
  if (!st || !st.owed) return null;
  return st.owedState || 'seen'; // older server payload: owed only — assume seen
}
export function targetOwed(target) { return !!targetOwedState(target); }
// "may be stuck": owed with no lieutenant reply for longer than the stale
// threshold. Purely client-derived from thread timestamps; the periodic
// re-render refreshes it.
const OWED_STALE_MS = 180000;
function owedSinceTs(msgs) {
  let since = null;
  for (const m of msgs || []) {
    if (m.author === USER) { if (since == null) since = m.ts; }
    else since = null;
  }
  return since;
}
export function targetMsgs(target) {
  const lt = /^lieutenant:(.+)$/.exec(target || '');
  if (lt) return (lieutenant(lt[1]) || {}).chat || [];
  return (card((target || '').slice(5)) || {}).thread || [];
}
export function targetOwedStale(target) {
  if (!targetOwed(target)) return false;
  const since = owedSinceTs(targetMsgs(target));
  return !!since && Date.now() - new Date(since).getTime() >= OWED_STALE_MS;
}
export function owedTargets() {
  const out = [];
  for (const l of lieutenants()) if (targetOwed('lieutenant:' + l.id)) out.push('lieutenant:' + l.id);
  for (const c of cards()) if (cardStatus(c).owed) out.push('card:' + c.id);
  return out;
}

// ---------- kinds ----------
// The board doc carries the EFFECTIVE kinds map (server-merged: built-ins under
// registered entries): {<kind>: {emoji, level}}. Any event whose kind is in the
// map renders that emoji; absent/unknown kinds render with no emoji.
export function kinds() { return (S.doc && S.doc.kinds) || {}; }
export function kindEmoji(kind) {
  const k = kind && kinds()[kind];
  return k && k.emoji ? String(k.emoji) : '';
}

// the unified event stream: board-level events + every card's events, by seq
export function allEvents() {
  const out = [];
  for (const e of (S.doc && S.doc.events) || []) out.push(e);
  for (const c of cards()) for (const e of c.events || []) out.push(Object.assign({ card: c.id, cardTitle: c.title }, e));
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
// the bell: level-1 events UNION lieutenant card-thread replies, newest first,
// with read flags. Mirrors the server's /api/notifications derivation: reply
// items carry ts/text/actor/card/cardTitle/read + kind "reply" (no seq — their
// read state is the thread read marker, so opening the card clears them).
// Lieutenant main-chat messages ride their own level-1 event, so those chats
// are excluded (no double count); level-2 never notifies.
export function notifItems() {
  const r = reads();
  const items = allEvents().filter((e) => e.level === 1)
    .map((e) => Object.assign({}, e, { read: e.seq <= r.notifSeq || r.notifSeqs.includes(e.seq) }));
  for (const c of cards()) {
    const readTs = threadReadTs('card:' + c.id);
    for (const m of c.thread || []) {
      if (m.author === USER) continue;
      items.push({ ts: m.ts, level: 1, kind: 'reply', text: m.text, actor: m.author,
        card: c.id, cardTitle: c.title, read: !!readTs && m.ts <= readTs });
    }
  }
  return items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : (b.seq || 0) - (a.seq || 0)));
}
export function notifUnreadCount() { return notifItems().filter((e) => !e.read).length; }

// ---------- filters ----------
// Owner/label selections are tri-state: mode 'in' (include) or 'out' (exclude);
// absent = don't care. Entries without a mode (older paths) count as 'in'.
export function filterMode(kind, value) {
  const f = S.filters.sel.find((x) => x.kind === kind && x.value === value);
  return f ? f.mode || 'in' : '';
}
export function filterSelected(kind, value) { return filterMode(kind, value) === 'in'; }
// board/table/detail owner+label clicks: plain click = include on/off,
// alt-click (exclude=true) = exclude on/off
export function toggleFilter(kind, value, exclude) {
  if (!value) return;
  if (exclude) { setFilter(kind, value, filterMode(kind, value) === 'out' ? '' : 'out'); return; }
  const i = S.filters.sel.findIndex((f) => f.kind === kind && f.value === value);
  const wasIn = i >= 0 && (S.filters.sel[i].mode || 'in') === 'in';
  if (i >= 0) S.filters.sel.splice(i, 1);
  if (!wasIn) S.filters.sel.push({ kind, value, mode: 'in' });
  render();
}
// the popup's per-item 3-position switch: set the state directly
// (mode '' = don't care, 'in' = include, 'out' = exclude)
export function setFilter(kind, value, mode) {
  if (!value) return;
  const i = S.filters.sel.findIndex((f) => f.kind === kind && f.value === value);
  if (i >= 0) S.filters.sel.splice(i, 1);
  if (mode === 'in' || mode === 'out') S.filters.sel.push({ kind, value, mode });
  render();
}
export function clearFilters() {
  S.filters = { text: '', age: '', sel: [], types: [], columns: [] };
  render();
}
export function filtersActive() {
  return !!(S.filters.text || S.filters.age || S.filters.sel.length
    || S.filters.types.length || S.filters.columns.length);
}
// what the filter button's badge counts: every active filter VALUE except text
// (the text is already visible in the input itself) — three labels = 3
export function activeFilterCount() {
  const f = S.filters;
  return f.sel.length + (f.age ? 1 : 0) + f.types.length + f.columns.length;
}
// toggle a value in a multi dimension array (types / columns)
export function toggleDim(dim, value) {
  const arr = S.filters[dim];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  render();
}
function ageCutoff(v) {
  if (!v) return 0;
  if (v === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return Date.now() - parseInt(v, 10) * 1000;
}
/**
 * The lower-cased text a card is searched by: title, id, body, type, owner id
 * and name, labels, attributes and column title. `doc` supplies the names.
 */
export function cardSearchText(c, doc) {
  const col = ((doc && doc.columns) || []).find((k) => k.id === c.column);
  const lt = ((doc && doc.lieutenants) || []).find((l) => l.id === c.owner);
  const at = c.attributes || {};
  return [c.title, c.id, c.body, c.type, c.owner, lt ? lt.name || lt.id : '', (c.labels || []).join(' '),
    Object.entries(at).map(([k, v]) => k + ' ' + v).join(' '),
    col ? col.title : c.column,
  ].filter(Boolean).join(' ').toLowerCase();
}
/**
 * Whether a card passes a filter shaped like S.filters — {text, age, sel,
 * types, columns}, every field optional. Pure over `doc`, so the 3D wall uses
 * the same rule with its own filter object.
 */
export function cardMatches(c, f, doc) {
  const q = (f.text || '').trim().toLowerCase();
  if (q && !cardSearchText(c, doc).includes(q)) return false;
  const cutoff = ageCutoff(f.age);
  if (cutoff) { const t = cardRecency(c); if (!t || new Date(t).getTime() < cutoff) return false; }
  if (f.types && f.types.length && !f.types.includes(c.type)) return false;
  if (f.columns && f.columns.length && !f.columns.includes(c.column)) return false;
  return selMatches(c, f.sel);
}
export function cardVisible(c) {
  return !filtersActive() || cardMatches(c, S.filters, S.doc);
}
// the owner/label chips: excludes drop the card outright; includes are OR
// within each dimension, AND across them — two owners included means "either
// owner", never the impossible "both"
export function selMatches(c, sel = S.filters.sel) {
  const inc = { owner: [], label: [] }, exc = { owner: [], label: [] };
  for (const f of sel || []) ((f.mode === 'out' ? exc : inc)[f.kind] || []).push(f.value);
  if (exc.owner.includes(c.owner || '')) return false;
  if (exc.label.some((n) => (c.labels || []).includes(n))) return false;
  if (inc.owner.length && !inc.owner.includes(c.owner || '')) return false;
  if (inc.label.length && !inc.label.some((n) => (c.labels || []).includes(n))) return false;
  return true;
}
