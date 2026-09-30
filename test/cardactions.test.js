'use strict';
// ui/js/cardactions.js — the card command table every card menu, tile button
// and detail header reads. These pin what a card offers and when: the moves
// with their order-comment rule, the built-ins with their `when` and their
// refusal, then plugin commands only where their `when` matches, in rank
// order, under a separator. And the tile's plugin markup: at most two icon
// buttons, badges from decorations and manifests, the running-activity chip.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const cols = [{ id: 'backlog', title: 'Backlog' }, { id: 'working', title: 'Working' }, { id: 'review', title: 'Review' }];
function doc() {
  return {
    columns: cols,
    lieutenants: [{ id: 'ada', name: 'Ada' }],
    workers: [{ card: 'W', branch: 'bc/w', ref: { harness: 'claude' } }],
    permissions: [],
    activities: [
      { id: 'r1', card: 'R', status: 'running', title: 'Deploy prod' },
      { id: 'r0', card: 'R', status: 'ok', title: 'Deploy staging' },
    ],
    cards: [
      { id: 'B', title: 'b', column: 'backlog', owner: 'ada', attributes: {} },
      { id: 'W', title: 'w', column: 'working', owner: 'ada', attributes: { repo: 'proj' }, status: { worker: { id: 'w1', state: 'working' } } },
      { id: 'R', title: 'r', column: 'review', owner: 'ada', attributes: { repo: 'proj', prs: [{ url: 'https://github.com/o/r/pull/7', state: 'open' }] },
        ext: { github: { badges: [{ text: 'CI ✓', tone: 'ok' }] }, flaky: { error: 'boom' } } },
    ],
  };
}
async function setup() {
  const state = await load('state.js');
  const slots = await load('slots.js');
  const A = await load('cardactions.js');
  slots.resetSlots();
  state.S.doc = doc();
  return { state, slots, A, card: (id) => state.S.doc.cards.find((c) => c.id === id) };
}
const deploy = (slot, extra) => Object.assign({ key: 'menu:' + slot + ':k.deploy', plugin: 'k', command: 'k.deploy', title: 'Deploy', icon: '🚀',
  when: { 'card.column': { $in: ['working', 'review'] } } }, extra);

test('moves: one per column, the card\'s own is current', async () => {
  const { A, card } = await setup();
  const m = A.cardMenuModel(card('B'));
  assert.deepStrictEqual(m.moves.map((x) => [x.column, !!x.current]), [['backlog', true], ['working', false], ['review', false]]);
});

test('a move that is an order asks for a comment; any other move does not', async () => {
  const { A } = await setup();
  const c = (column) => ({ column });
  assert.strictEqual(A.orderKind(c('backlog'), 'working'), 'start order');
  assert.strictEqual(A.orderKind(c('review'), 'backlog'), 'rework order');
  assert.strictEqual(A.orderKind(c('review'), 'done'), '');
  assert.strictEqual(A.orderKind(c('working'), 'working'), '', 'no move, no order');
  const asked = [];
  A.configureCardActions({ prompt: (msg) => { asked.push(msg); return '  go on  '; } });
  assert.strictEqual(A.orderComment('B', 'working'), 'go on');
  assert.strictEqual(A.orderComment('B', 'review'), '');
  assert.deepStrictEqual(asked, ['Comment for the start order (optional):']);
});

test('built-ins: session navigation survives stages, watch stays Working-only, archive refuses live workers', async () => {
  const { A, card } = await setup();
  const ids = (id) => A.cardMenuModel(card(id)).actions.map((a) => a.id);
  assert.deepStrictEqual(ids('B'), ['card.talk', 'card.select', 'card.archive']);
  assert.deepStrictEqual(ids('W'), ['card.peek', 'card.watch', 'card.talk', 'card.select', 'card.archive']);
  card('R').sessions = [{ key: 'codex:one', provider: 'codex', id: '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }];
  assert.deepStrictEqual(ids('R'), ['card.peek', 'card.talk', 'card.select', 'card.archive']);
  const arch = (id) => A.cardMenuModel(card(id)).actions.find((a) => a.id === 'card.archive');
  assert.strictEqual(arch('W').refused, 'live worker on bc/w');
  assert.strictEqual(arch('B').refused, '');
  card('W').execution = 'external';
  assert.ok(!ids('W').includes('card.watch'), 'externally managed sessions do not offer an unavailable board terminal');
});

test('a refused built-in is an inert menu item that says why — never a red button', async () => {
  const { A, card } = await setup();
  const items = A.menuItems(A.cardMenuModel(card('W')));
  const arch = items.find((i) => /archive/.test(i.label || ''));
  assert.strictEqual(arch.onClick, undefined);
  assert.ok(!arch.danger);
  assert.match(arch.label, /archive — live worker on bc\/w/);
  const ok = A.menuItems(A.cardMenuModel(card('B'))).find((i) => /archive/.test(i.label || ''));
  assert.ok(ok.danger && typeof ok.onClick === 'function');
});

test('the overlay can switch a built-in off by its key', async () => {
  const { A, slots, card } = await setup();
  slots.setDisabled(['command:card.select', 'command:card.move']);
  const m = A.cardMenuModel(card('B'));
  assert.ok(!m.actions.some((a) => a.id === 'card.select'));
  assert.deepStrictEqual(m.moves, []);
});

test('plugin commands show only where `when` matches, by rank, under a separator', async () => {
  const { A, slots, card } = await setup();
  slots.contribute('card.menu/v1', deploy('card.menu/v1', { rank: 200 }));
  slots.contribute('card.menu/v1', { key: 'menu:card.menu/v1:k.ping', plugin: 'k', command: 'k.ping', title: 'Ping', rank: 100 });
  slots.contribute('card.menu/v1', { key: 'menu:card.menu/v1:k.pr', plugin: 'k', command: 'k.pr', title: 'Open PR',
    when: { 'card.attributes.prs': { $exists: true } }, rank: 300 });
  const ids = (id) => A.cardMenuModel(card(id)).plugins.map((p) => p.id);
  assert.deepStrictEqual(ids('B'), ['k.ping'], 'backlog, no PR: only the when-less one');
  assert.deepStrictEqual(ids('W'), ['k.ping', 'k.deploy']);
  assert.deepStrictEqual(ids('R'), ['k.ping', 'k.deploy', 'k.pr']);
  const items = A.menuItems(A.cardMenuModel(card('R')));
  const i = items.findIndex((x) => x.label === 'Ping');
  assert.ok(items[i - 1].sep, 'the first plugin entry follows a rule');
  assert.ok(items.findIndex((x) => /archive/.test(x.label || '')) < i, 'after every built-in');
});

test('the tile carries at most two plugin buttons, data only', async () => {
  const { A, slots, card } = await setup();
  for (const n of ['a', 'b', 'c']) {
    slots.contribute('card.actions/v1', { key: 'menu:card.actions/v1:k.' + n, plugin: 'k', command: 'k.' + n, title: n.toUpperCase(), icon: n, rank: n.charCodeAt(0) });
  }
  const html = A.tileActionsHtml(card('B'));
  assert.deepStrictEqual([...html.matchAll(/data-cmd="([^"]+)"/g)].map((m) => m[1]), ['k.a', 'k.b']);
  assert.strictEqual(A.tileActionsHtml(card('B')).includes('<script'), false);
  slots.resetSlots();
  assert.strictEqual(A.tileActionsHtml(card('B')), '', 'an empty slot costs nothing');
});

test('badges: decorations, a failed decorator, and manifest badges filled from the context', async () => {
  const { A, slots, card } = await setup();
  slots.contribute('card.badges/v1', { key: 'badge:repo', plugin: 'k', text: '⎇ ${card.attributes.repo}', tone: 'ok',
    when: { 'card.column': { $in: ['working', 'review'] } } });
  slots.contribute('card.badges/v1', { key: 'badge:branch', plugin: 'k', text: '${card.branch}' });
  const r = A.pluginBadgesHtml(card('R'));
  assert.match(r, /bc-badge-ok[^>]*>CI ✓</);
  assert.match(r, /⚠ plugin flaky failed/);
  assert.match(r, />⎇ proj</);
  assert.ok(!/bc-badge[^>]*><\/span>/.test(r), 'a template naming nothing is not drawn');
  assert.strictEqual(A.pluginBadgesHtml(card('B')), '', 'backlog: the `when` hides it, no decorations');
});

test('a running activity puts a chip on its card', async () => {
  const { A, card } = await setup();
  assert.match(A.activityChipHtml(card('R')), /data-activity="r1"[^>]*>.*Deploy prod/);
  assert.strictEqual(A.activityChipHtml(card('B')), '');
});
