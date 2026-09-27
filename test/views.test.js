'use strict';
// ui/js/views.js — the main/v1 registry. The switcher, the phone's mode menu
// and the render dispatch read it, so these are the rules the board region
// follows: which views are in the switcher, where a request lands, what a
// reload restores, and what switching the kanban off does.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

// a view element that records its class
function el() {
  const cls = new Set();
  return { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) } };
}
async function builtins() {
  const V = await load('views.js');
  V.resetViews();
  store.clear();
  const painted = [];
  const mk = (id, extra) => V.registerView(Object.assign({ id, el: el(), render: () => painted.push(id) }, extra));
  mk('board', { key: 'view:kanban', rank: 100, title: 'kanban', icon: '▦' });
  mk('table', { rank: 200 });
  mk('archive', { rank: 300 });
  mk('auto', { rank: 400 });
  mk('file', { screen: true, remember: false });
  mk('settings', { screen: true, remember: false });
  return { V, painted, mk };
}

test('the switcher lists the remembered views in rank order; screens are not in it', async () => {
  const { V, mk } = await builtins();
  mk('timeline', { plugin: 'deploy-kit', rank: 1000 });
  mk('early', { plugin: 'x', rank: 150 });
  assert.deepStrictEqual(V.views().map((v) => v.id), ['board', 'early', 'table', 'archive', 'auto', 'timeline']);
  assert.ok(V.isScreen('settings') && !V.isScreen('table'));
});

test('a request lands on a registered view or screen; anything else is the first switcher view', async () => {
  const { V } = await builtins();
  for (const m of ['table', 'archive', 'auto', 'file', 'settings']) assert.strictEqual(V.setMode(m), m);
  for (const m of ['nonsense', '', null, undefined]) assert.strictEqual(V.setMode(m), 'board', String(m));
  const { S } = await load('state.js');
  assert.strictEqual(S.boardMode, 'board', 'S.boardMode mirrors the registry for the modules that read it');
});

test('only an honored switcher request is remembered — never a screen, never a fallback', async () => {
  const { V } = await builtins();
  V.setMode('table');
  assert.strictEqual(store.get('bc-board-mode'), 'table');
  V.setMode('settings');
  assert.strictEqual(store.get('bc-board-mode'), 'table', 'a screen is not remembered');
  V.setMode('ghost');
  assert.strictEqual(store.get('bc-board-mode'), 'table', 'landing on the fallback is not a choice');
  assert.strictEqual(V.lastSwitcher(), 'table', 'the way out of a screen');
});

test('switching the view marks its element, paints it and enters it once', async () => {
  const { V, painted, mk } = await builtins();
  let entered = 0;
  const e = el();
  mk('probe', { el: e, enter: () => entered++, rank: 500 });
  const heard = [];
  V.onModeChange((to, from) => heard.push(from + '→' + to));
  V.setMode('board');
  V.setMode('probe');
  V.setMode('probe');
  assert.strictEqual(entered, 1, 'enter() runs on the way in, not on a re-request');
  assert.ok(e.classList.contains('view-on'));
  V.renderCurrent();
  assert.deepStrictEqual(painted.slice(-1), ['probe']);
  V.setMode('table');
  assert.ok(!e.classList.contains('view-on'));
  assert.deepStrictEqual(heard.slice(-3), ['board→probe', 'probe→probe', 'probe→table']);
});

test('switching view:kanban off drops ▦ and falls back to the first remaining switcher view', async () => {
  const { V } = await builtins();
  V.setMode('board');
  V.setDisabledViews(['view:kanban']);
  assert.ok(!V.views().some((v) => v.id === 'board'));
  assert.strictEqual(V.current(), 'table', 'the kanban was on screen: the table takes over');
  assert.strictEqual(V.setMode('board'), 'table', 'and a request for it lands on the table');
  V.setDisabledViews([]);
  assert.strictEqual(V.setMode('board'), 'board');
});

test('a reload that remembers a plugin view waits for it to register', async () => {
  const { V, mk } = await builtins();
  store.set('bc-board-mode', 'timeline');
  assert.strictEqual(V.restoreMode(), 'board', 'not registered yet: the fallback shows meanwhile');
  assert.strictEqual(store.get('bc-board-mode'), 'timeline', 'and the memory survives');
  mk('timeline', { plugin: 'deploy-kit' });
  assert.strictEqual(V.current(), 'timeline', 'it arrives: the board switches to it');
});

test('a choice made before the late view arrives wins over the reload', async () => {
  const { V, mk } = await builtins();
  store.set('bc-board-mode', 'timeline');
  V.restoreMode();
  V.setMode('archive');
  mk('timeline', { plugin: 'deploy-kit' });
  assert.strictEqual(V.current(), 'archive');
});

test('disposing the view on screen (its plugin went away) lands on the first switcher view', async () => {
  const { V, mk } = await builtins();
  V.setMode('table');
  const dispose = mk('timeline', { plugin: 'deploy-kit' });
  V.setMode('timeline');
  dispose();
  assert.strictEqual(V.current(), 'board', 'the remembered view is the one that left');
  assert.ok(!V.view('timeline'));
});
