'use strict';
// ui/js/state.js — the board ingest (applyBoard), the filter seams, and the pure
// rules the flat board and the 3D room share. state.js touches no DOM at import,
// so it is imported directly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let St, S, setFilter, toggleFilter, filterMode, filterSelected, cardVisible, clearFilters,
  activeFilterCount, lieutenantByActor, lieutenantsByRecent;
test.before(async () => {
  St = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'state.js')).href);
  ({ S, setFilter, toggleFilter, filterMode, filterSelected, cardVisible, clearFilters,
    activeFilterCount, lieutenantByActor, lieutenantsByRecent } = St);
});
const RESET = () => ({ text: '', age: '', sel: [], types: [], columns: [] });

// ---------- filters: tri-state owner/label chips ----------
// setFilter (the popup's 3-position switch), toggleFilter (board/table/detail
// include toggles), selMatches/cardVisible (excludes drop the card outright;
// includes are OR within a dimension, AND across).

const CARDS = [
  { id: 'a', owner: 'monica', labels: ['infra'] },
  { id: 'b', owner: 'rex', labels: ['ux', 'infra'] },
  { id: 'c', owner: 'rex', labels: [] },
  { id: 'd', owner: 'ada', labels: ['ux'] },
];
function visible() { return CARDS.filter(cardVisible).map((c) => c.id).join(''); }
test.beforeEach(() => { S.doc = null; S.filters = RESET(); });

test('no owner/label selections: everything visible', () => {
  assert.strictEqual(visible(), 'abcd');
});

test('include-only: owner include keeps only that owner; two includes OR', () => {
  setFilter('owner', 'monica', 'in');
  assert.strictEqual(visible(), 'a');
  setFilter('owner', 'ada', 'in');
  assert.strictEqual(visible(), 'ad');
});

test('include-only: label includes OR within the dimension', () => {
  setFilter('label', 'infra', 'in');
  assert.strictEqual(visible(), 'ab');
  setFilter('label', 'ux', 'in');
  assert.strictEqual(visible(), 'abd');
});

test('exclude-only: excluded owner/label cards are dropped, rest untouched', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'ad');
  setFilter('label', 'ux', 'out');
  assert.strictEqual(visible(), 'a');
});

test('mixed: include and exclude compose across dimensions', () => {
  setFilter('label', 'infra', 'in');
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'a'); // infra cards minus rex's
});

test('mixed within one dimension: include one owner, exclude another', () => {
  setFilter('owner', 'monica', 'in');
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'a');
});

test('setFilter: direct set, overwrite, and back to dont-care', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(filterMode('owner', 'rex'), 'out');
  setFilter('owner', 'rex', 'in');
  assert.strictEqual(filterMode('owner', 'rex'), 'in');
  assert.strictEqual(S.filters.sel.length, 1); // overwrote, not stacked
  setFilter('owner', 'rex', '');
  assert.strictEqual(filterMode('owner', 'rex'), '');
  assert.strictEqual(S.filters.sel.length, 0);
});

test('toggleFilter stays a plain include on/off; an exclude flips to include', () => {
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), 'in');
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), '');
  setFilter('label', 'ux', 'out');
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), 'in');
});

test('toggleFilter with exclude=true (alt-click): exclude on/off; include flips to exclude', () => {
  toggleFilter('owner', 'rex', true);
  assert.strictEqual(filterMode('owner', 'rex'), 'out');
  toggleFilter('owner', 'rex', true);
  assert.strictEqual(filterMode('owner', 'rex'), '');
  toggleFilter('owner', 'rex'); // plain click: include
  toggleFilter('owner', 'rex', true);
  assert.strictEqual(filterMode('owner', 'rex'), 'out');
  assert.strictEqual(S.filters.sel.length, 1); // replaced, not stacked
});

test('filterSelected means include only; excludes count in the badge', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(filterSelected('owner', 'rex'), false);
  setFilter('owner', 'monica', 'in');
  assert.strictEqual(filterSelected('owner', 'monica'), true);
  assert.strictEqual(activeFilterCount(), 2);
});

test('mode-less entries (older paths) behave as includes', () => {
  S.filters.sel.push({ kind: 'owner', value: 'monica' });
  assert.strictEqual(filterMode('owner', 'monica'), 'in');
  assert.strictEqual(visible(), 'a');
});

test('clearFilters wipes includes and excludes', () => {
  setFilter('owner', 'rex', 'out');
  setFilter('label', 'infra', 'in');
  clearFilters();
  assert.strictEqual(S.filters.sel.length, 0);
  assert.strictEqual(visible(), 'abcd');
});

// ---------- lieutenantByActor ----------
// The seam behind notification/toast click routing for card-less chat items.

function withDoc(doc, fn) {
  const prev = S.doc;
  S.doc = doc;
  try { fn(); } finally { S.doc = prev; }
}

test('lieutenantByActor: matches by id', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    assert.strictEqual(lieutenantByActor('spock').id, 'spock');
  });
});

test('lieutenantByActor: matches by name (chat-say events carry the author name)', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    assert.strictEqual(lieutenantByActor('Mr. Spock').id, 'spock');
  });
});

test('lieutenantByActor: non-lieutenant actors resolve to nothing', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    for (const actor of ['server', 'user', 'worker', '', null, undefined]) {
      assert.strictEqual(lieutenantByActor(actor), undefined);
    }
  });
});

test('lieutenantByActor: safe with no board doc', () => {
  withDoc(null, () => {
    assert.strictEqual(lieutenantByActor('spock'), undefined);
  });
});

// ---------- lieutenantsByRecent ----------
// The order the lieutenant switcher freezes when it opens: most recent
// conversation first, the silent ones last by name. The FREEZE lives in
// ltswitcher.js, which touches the DOM at import.

function seed(lieutenants) { S.doc = { lieutenants }; }
function order() { return lieutenantsByRecent().map((l) => l.id).join(' '); }

test('no doc: empty, no throw', () => {
  S.doc = null;
  assert.strictEqual(order(), '');
});

test('most recent chat message first, regardless of registration order', () => {
  seed([
    { id: 'monica', name: 'Monica', chat: [{ ts: '2026-07-27T10:00:00Z' }] },
    { id: 'rex', name: 'Rex', chat: [{ ts: '2026-07-27T09:00:00Z' }] },
    { id: 'quill', name: 'Quill', chat: [{ ts: '2026-07-27T12:00:00Z' }] },
  ]);
  assert.strictEqual(order(), 'quill monica rex');
});

test('the last message wins even if the chat is not in timestamp order', () => {
  seed([
    { id: 'a', name: 'A', chat: [{ ts: '2026-07-27T12:00:00Z' }, { ts: '2026-07-27T08:00:00Z' }] },
    { id: 'b', name: 'B', chat: [{ ts: '2026-07-27T10:00:00Z' }] },
  ]);
  assert.strictEqual(order(), 'a b');
});

test('never spoke goes last, in name order — no oscillating between equals', () => {
  seed([
    { id: 'z', name: 'Zoe' },
    { id: 'a', name: 'Ada', chat: [] },
    { id: 'm', name: 'Moss', chat: [{ ts: '2026-07-27T09:00:00Z' }] },
    { id: 'b', name: 'Bo', chat: [] },
  ]);
  assert.strictEqual(order(), 'm a b z');
});

test('ties break by name, and the same doc always yields the same order', () => {
  seed([
    { id: 'r', name: 'Rex', chat: [{ ts: '2026-07-27T09:00:00Z' }] },
    { id: 'a', name: 'Ada', chat: [{ ts: '2026-07-27T09:00:00Z' }] },
  ]);
  assert.strictEqual(order(), 'a r');
  assert.strictEqual(order(), 'a r');
});

test('nameless lieutenants fall back to id for the tie-break', () => {
  seed([{ id: 'zed' }, { id: 'abe' }]);
  assert.strictEqual(order(), 'abe zed');
});

test('does not mutate the doc order', () => {
  seed([
    { id: 'old', name: 'Old', chat: [{ ts: '2026-07-27T08:00:00Z' }] },
    { id: 'new', name: 'New', chat: [{ ts: '2026-07-27T12:00:00Z' }] },
  ]);
  lieutenantsByRecent();
  assert.deepStrictEqual(S.doc.lieutenants.map((l) => l.id), ['old', 'new']);
});

// ---------- applyBoard: the one ingest ----------
// SSE, the reconnect refetch, the chat's echo refetch and the 3D room all take
// a board document in through applyBoard; a subscriber registered once sees
// every one of them.

test('applyBoard stores the doc, runs every subscriber in order, then renders once', () => {
  const seen = [];
  St.onBoard((doc) => seen.push(['a', doc.n, S.doc === doc]));
  St.onBoard((doc) => seen.push(['b', doc.n]));
  let renders = 0;
  const dispose = St.onRender(() => { renders++; seen.push(['render']); });
  St.applyBoard({ n: 1 });
  St.applyBoard({ n: 2 });
  assert.deepStrictEqual(seen, [['a', 1, true], ['b', 1], ['render'], ['a', 2, true], ['b', 2], ['render']]);
  assert.strictEqual(renders, 2);
  St.applyBoard(null); // a failed refetch hands nothing — nothing changes
  assert.strictEqual(S.doc.n, 2);
  assert.strictEqual(renders, 2);
  dispose();
  St.render();
  assert.strictEqual(renders, 2, 'a disposed listener hears no more renders');
});

test('applyLocalRead moves the marker forward only and clears the card dot', () => {
  const c = { id: 'k1', thread: [{ author: 'Monica', ts: '2026-01-02T00:00:00Z' }], status: { unread: true } };
  S.doc = { cards: [c], lieutenants: [] };
  assert.strictEqual(St.cardUnread(c), 1);
  St.applyLocalRead('card:k1', '2026-01-02T00:00:00Z');
  assert.strictEqual(St.cardUnread(c), 0);
  assert.strictEqual(c.status.unread, false);
  St.applyLocalRead('card:k1', '2026-01-01T00:00:00Z'); // an older read never rewinds
  assert.strictEqual(St.threadReadTs('card:k1'), '2026-01-02T00:00:00Z');
  S.doc = null;
  St.applyLocalRead('card:k1', '2026-01-03T00:00:00Z'); // no board yet: no throw
});

// ---------- cardMatches: one search and filter rule for 2D and 3D ----------

const DOC = {
  columns: [{ id: 'review', title: '👀 Your review' }, { id: 'backlog', title: '📋 Backlog' }],
  lieutenants: [{ id: 'monica', name: 'Monica' }],
  cards: [],
};
const CARD = {
  id: 'MNC-7', title: 'Fix the wall', body: 'the lane scrolls past the end', type: 'bug',
  owner: 'monica', column: 'review', labels: ['ux'], attributes: { pr: '149' },
};

test('cardMatches: text searches title, body, owner name, column title, labels, attributes', () => {
  for (const q of ['fix the', 'lane scrolls', 'MONICA', 'your review', 'ux', 'pr 149', 'mnc-7', 'bug']) {
    assert.ok(St.cardMatches(CARD, { text: q }, DOC), q);
  }
  assert.ok(!St.cardMatches(CARD, { text: 'backlog' }, DOC));
});

test('cardMatches: the 3D wall filter shape — owner chip, one column, a query — composes', () => {
  const wall = (owner, column, text) => ({
    text, sel: owner ? [{ kind: 'owner', value: owner, mode: 'in' }] : [], columns: column ? [column] : [],
  });
  assert.ok(St.cardMatches(CARD, wall('monica', 'review', 'wall'), DOC));
  assert.ok(!St.cardMatches(CARD, wall('rex', null, ''), DOC));
  assert.ok(!St.cardMatches(CARD, wall(null, 'backlog', ''), DOC));
  assert.ok(St.cardMatches(CARD, {}, DOC), 'an empty filter keeps everything');
  assert.ok(St.cardMatches(CARD, { text: 'monica' }, null), 'no doc: the owner id still matches');
});

test('cardMatches: the age filter reads real activity, not the mutable updated', () => {
  const now = new Date().toISOString();
  const old = '2020-01-01T00:00:00Z';
  assert.ok(St.cardMatches({ activity: now, updated: old }, { age: '3600' }, DOC));
  assert.ok(!St.cardMatches({ activity: old, updated: now }, { age: '3600' }, DOC));
  assert.ok(!St.cardMatches({}, { age: '3600' }, DOC), 'no timestamp at all is not recent');
});

test('cardVisible is cardMatches over S.filters and S.doc', () => {
  S.doc = DOC;
  S.filters.text = 'your review';
  assert.ok(cardVisible(CARD));
  S.filters.text = 'backlog';
  assert.ok(!cardVisible(CARD));
});

// ---------- lookups, recency, authors, unread, avatars ----------

test('byRecency: newest real activity first, activity over updated, blanks last', () => {
  const list = [
    { id: 'old', activity: '2026-01-01T00:00:00Z' },
    { id: 'blank' },
    { id: 'new', activity: '2026-01-03T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
    { id: 'mid', updated: '2026-01-02T00:00:00Z' },
  ];
  assert.deepStrictEqual(list.sort(St.byRecency).map((c) => c.id), ['new', 'mid', 'old', 'blank']);
});

test('byId and columnTitle', () => {
  const m = St.byId(DOC.lieutenants);
  assert.strictEqual(m.get('monica').name, 'Monica');
  assert.strictEqual(St.byId(undefined).size, 0);
  S.doc = DOC;
  assert.strictEqual(St.columnTitle('review'), '👀 Your review');
  assert.strictEqual(St.columnTitle('gone'), 'gone', 'an unknown column shows its id');
});

test('isActor: id or name, and an empty actor is nobody', () => {
  const lt = { id: 'spock', name: 'Mr. Spock' };
  assert.ok(St.isActor(lt, 'spock'));
  assert.ok(St.isActor(lt, 'Mr. Spock'));
  assert.ok(!St.isActor(lt, 'kirk'));
  assert.ok(!St.isActor({ id: 'x' }, undefined), 'a nameless lieutenant must not match a missing actor');
  assert.ok(!St.isActor(null, 'spock'));
});

test('unread: the captain\'s own messages never count; the read marker is the cursor', () => {
  const chat = [
    { author: 'Monica', ts: '2026-01-01T00:00:00Z' },
    { author: 'user', ts: '2026-01-02T00:00:00Z' },
    { author: 'Monica', ts: '2026-01-03T00:00:00Z' },
  ];
  assert.strictEqual(St.unreadCount(chat, ''), 2, 'no marker: every lieutenant message is unread');
  assert.strictEqual(St.unreadCount(chat, '2026-01-01T00:00:00Z'), 1);
  assert.strictEqual(St.unreadCount(chat, '2026-01-03T00:00:00Z'), 0);
  const reads = { user: { threads: { 'lieutenant:monica': '2026-01-01T00:00:00Z' } } };
  assert.strictEqual(St.readMarker(reads, 'lieutenant:monica'), '2026-01-01T00:00:00Z');
  assert.strictEqual(St.readMarker(undefined, 'lieutenant:monica'), '');
  S.doc = { lieutenants: [{ id: 'monica', chat }], reads };
  assert.strictEqual(St.lieutenantUnread(S.doc.lieutenants[0]), 1);
});

test('the 3D berth and the flat board agree on unread, except when the captain spoke last', async () => {
  const { unansweredReply } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'bridge3d', 'liveness.js')).href);
  const reads = (ts) => ({ user: { threads: { 'lieutenant:monica': ts } } });
  const lt = (...chat) => ({ id: 'monica', chat });
  const said = { author: 'Monica', ts: '2026-01-02T00:00:00Z' };
  for (const marker of ['', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z']) {
    S.doc = { lieutenants: [lt(said)], reads: reads(marker) };
    assert.strictEqual(unansweredReply(S.doc.lieutenants[0], S.doc.reads), St.lieutenantUnread(S.doc.lieutenants[0]) > 0, marker);
  }
  // The deliberate difference: the room never marks a chat read, so a reply
  // from the room is his "I have read it".
  const answered = lt(said, { author: 'user', ts: '2026-01-04T00:00:00Z' });
  S.doc = { lieutenants: [answered], reads: reads('') };
  assert.strictEqual(St.lieutenantUnread(answered), 1);
  assert.strictEqual(unansweredReply(answered, S.doc.reads), false);
});

test('validAvatar / lieutenantAvatar: an index in the 8x8 sheet, else null', async () => {
  const { validAvatar } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'avatars.js')).href);
  assert.strictEqual(validAvatar(0), 0);
  assert.strictEqual(validAvatar(63), 63);
  for (const bad of [64, -1, 1.5, '3', null, undefined]) assert.strictEqual(validAvatar(bad), null, String(bad));
  S.doc = { lieutenants: [{ id: 'a', avatar: 7 }, { id: 'b', avatar: 99 }] };
  assert.strictEqual(St.lieutenantAvatar('a'), 7);
  assert.strictEqual(St.lieutenantAvatar('b'), null);
});

test('util.hhmm: local HH:MM, and blank for a timestamp that is not one', async () => {
  const { hhmm } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);
  assert.match(hhmm('2026-01-02T03:04:00Z'), /^\d\d:\d\d$/);
  assert.strictEqual(hhmm(undefined), '');
  assert.strictEqual(hhmm('garbage'), '');
});
