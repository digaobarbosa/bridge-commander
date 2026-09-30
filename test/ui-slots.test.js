'use strict';
// The wave-E1 UI slots: sidebar/v1 (sidebar.js, with the chat as its built-in
// filler), topbar/v1 (topbar.js), the command palette (palette.js), and the
// card-less run in commandui.js. The loader is fed a stubbed GET /api/plugins,
// exactly as the board is.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom } = require('./fake-dom.js');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const PAYLOAD = {
  plugins: [{ id: 'kit', name: 'Kit', enabled: true, source: 'workspace', config: {}, ui: '/plugins/kit/ui.js' }],
  contributions: {
    commands: [
      { id: 'kit.repo', title: 'Open the repo', icon: '🐙', open: 'https://github.com/o/r', plugin: 'kit' },
      { id: 'kit.sync', title: 'Sync everything', icon: '⟳', plugin: 'kit', run: 'exec' },
      { id: 'kit.review', title: 'Review helper', plugin: 'kit', run: 'exec' },
      { id: 'kit.deploy', title: 'Deploy', icon: '🚀', plugin: 'kit', run: 'exec' },
      { id: 'kit.a', title: 'A', plugin: 'kit', run: 'exec' },
      { id: 'kit.b', title: 'B', plugin: 'kit', run: 'exec' },
      { id: 'kit.c', title: 'C', plugin: 'kit', run: 'exec' },
    ],
    menus: {
      'topbar/v1': [
        { command: 'kit.repo', plugin: 'kit', key: 'menu:topbar/v1:kit.repo', rank: 10 },
        { command: 'kit.sync', plugin: 'kit', key: 'menu:topbar/v1:kit.sync', rank: 20 },
        // a card `when` never shows in the topbar: it has no card
        { command: 'kit.review', plugin: 'kit', key: 'menu:topbar/v1:kit.review', rank: 5, when: { 'card.column': 'review' } },
        { command: 'kit.a', plugin: 'kit', key: 'menu:topbar/v1:kit.a', rank: 30 },
        { command: 'kit.b', plugin: 'kit', key: 'menu:topbar/v1:kit.b', rank: 40 },
        { command: 'kit.c', plugin: 'kit', key: 'menu:topbar/v1:kit.c', rank: 50 },
      ],
      'palette/v1': [
        { command: 'kit.repo', plugin: 'kit', key: 'menu:palette/v1:kit.repo' },
        { command: 'kit.sync', plugin: 'kit', key: 'menu:palette/v1:kit.sync' },
        { command: 'kit.review', plugin: 'kit', key: 'menu:palette/v1:kit.review', when: { 'card.column': 'review' } },
      ],
      'card.menu/v1': [
        { command: 'kit.deploy', plugin: 'kit', key: 'menu:card.menu/v1:kit.deploy', when: { 'card.column': 'review' } },
        // also in the palette: listed once
        { command: 'kit.review', plugin: 'kit', key: 'menu:card.menu/v1:kit.review' },
      ],
    },
    badges: [],
    views: [
      { id: 'timeline', title: 'timeline', icon: '🛰', plugin: 'kit', key: 'view:timeline', rank: 1000, slot: 'main/v1' },
      { id: 'notes', title: 'Notes', icon: '📝', plugin: 'kit', key: 'view:notes', rank: 1000, slot: 'sidebar/v1' },
    ],
    sections: [],
    checks: [],
  },
  harnesses: [],
  disabled: [],
};
const DOC = {
  columns: [{ id: 'backlog', title: 'Backlog' }, { id: 'working', title: 'Working' }, { id: 'review', title: 'Review' }],
  lieutenants: [{ id: 'ada', name: 'Ada' }], workers: [], permissions: [], activities: [],
  cards: [
    { id: 'B', title: 'b', column: 'backlog', owner: 'ada', attributes: {} },
    { id: 'R', title: 'r', column: 'review', owner: 'ada', attributes: {} },
  ],
};

function stubFetch(answer) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    const a = typeof answer === 'function' ? answer(url, opts) : answer;
    return { ok: (a.status || 200) < 400, status: a.status || 200, json: async () => a.body };
  };
  f.calls = calls;
  return f;
}

async function fresh(payload = PAYLOAD) {
  const state = await load('state.js');
  const slots = await load('slots.js');
  const views = await load('views.js');
  const sidebar = await load('sidebar.js');
  const P = await load('plugins.js');
  P.resetPlugins();
  slots.resetSlots();
  views.resetViews();
  sidebar.resetSidebars();
  state.S.doc = JSON.parse(JSON.stringify(DOC));
  views.registerView({ id: 'board', key: 'view:kanban', rank: 100, render() {} });
  P.configurePlugins({ fetch: stubFetch({ body: payload }), importModule: async () => ({ activate() {} }) });
  await P.loadPlugins();
  return { state, slots, views, sidebar, P };
}

// ---------- sidebar/v1 ----------

test('sidebar: the chat fills it; switching sidebar:chat off shows the plugin sidebar; back on restores the chat', async () => {
  const { sidebar, views, P } = await fresh();
  const chatEl = { style: { display: '' } };
  let chatPaints = 0;
  sidebar.registerSidebar({ id: 'chat', key: 'sidebar:chat', rank: 100, el: chatEl, render: () => { chatPaints++; } });
  // the plugin sidebar view went to the sidebar registry, not the board's switcher
  assert.deepStrictEqual(sidebar.sidebars().map((e) => e.id), ['chat', 'notes']);
  assert.ok(views.view('timeline') && !views.view('notes'), 'a sidebar view is not a main view');

  assert.strictEqual(sidebar.renderSidebar().id, 'chat');
  assert.strictEqual(chatEl.style.display, '', 'the chat is left to the stylesheet');
  assert.strictEqual(chatPaints, 1);

  P.configurePlugins({ fetch: stubFetch({ body: Object.assign({}, PAYLOAD, { disabled: ['sidebar:chat'] }) }) });
  await P.loadPlugins();
  assert.strictEqual(sidebar.activeSidebar().id, 'notes');
  // no host configured: the plugin sidebar has no element here, and the chat hides
  sidebar.renderSidebar();
  assert.strictEqual(chatEl.style.display, 'none');
  assert.strictEqual(chatPaints, 1, 'a hidden chat is not painted');

  P.configurePlugins({ fetch: stubFetch({ body: PAYLOAD }) });
  await P.loadPlugins();
  assert.strictEqual(sidebar.renderSidebar().id, 'chat');
  assert.strictEqual(chatEl.style.display, '');
  assert.strictEqual(chatPaints, 2);
});

test('sidebar: a made element sits before the board, mounts once, and goes when its entry does', async () => {
  const sidebar = await load('sidebar.js');
  sidebar.resetSidebars();
  const { body, el } = installDom();
  const host = el('main');
  body.appendChild(host);
  const chat = el('section');
  chat.style.display = '';
  host.appendChild(chat);
  sidebar.configureSidebar({ host, before: null });
  sidebar.registerSidebar({ id: 'chat', key: 'sidebar:chat', rank: 100, el: chat, render() {} });
  const seen = { mount: 0, render: 0 };
  const off = sidebar.registerSidebar({ id: 'notes', key: 'view:notes', plugin: 'kit',
    mount: () => { seen.mount++; }, render: (e) => { seen.render++; e.textContent = 'notes here'; } });
  sidebar.setDisabledSidebars(['sidebar:chat']);
  sidebar.renderSidebar();
  sidebar.renderSidebar();
  const made = sidebar.sidebarEl('notes');
  assert.strictEqual(made.parentNode, host);
  assert.strictEqual(made.className, 'bc-sidebar');
  assert.strictEqual(made.textContent, 'notes here');
  assert.deepStrictEqual(seen, { mount: 1, render: 2 });
  assert.strictEqual(chat.style.display, 'none');
  off();
  assert.strictEqual(made.parentNode, null, 'its element leaves with it');
  // every sidebar off: nothing on screen, nothing thrown
  assert.strictEqual(sidebar.renderSidebar(), null);
  sidebar.setDisabledSidebars([]);
  assert.strictEqual(sidebar.renderSidebar().id, 'chat');
  assert.strictEqual(chat.style.display, '');
  delete globalThis.document;
  delete globalThis.window;
  sidebar.resetSidebars();
});

// ---------- topbar/v1 ----------

test('topbar: card-less entries only, rank order, at most 4 per plugin, escaped markup', async () => {
  await fresh();
  const T = await load('topbar.js');
  const list = T.topbarEntries();
  assert.deepStrictEqual(list.map((e) => e.command), ['kit.repo', 'kit.sync', 'kit.a', 'kit.b']);
  const html = T.topbarHtml([{ command: 'x.y', title: 'Say "hi" <b>', icon: '<i>', plugin: 'x' }], () => false);
  assert.match(html, /data-cmd="x\.y"/);
  assert.match(html, /<span class="tb-label">Say &quot;hi&quot; &lt;b&gt;<\/span>/);
  assert.ok(!html.includes('<i>') && !html.includes('<b>'), 'nothing raw');
  assert.match(T.topbarHtml([{ command: 'x.y', title: 'T' }], () => true), /class="tb-cmd busy"[^>]* disabled/);
});

// ---------- the palette ----------

test('fuzzyMatch / filterItems: subsequences, word starts and runs rank first', async () => {
  const { fuzzyMatch, filterItems, markHits } = await load('palette.js');
  assert.strictEqual(fuzzyMatch('xyz', 'Open the repo'), null);
  assert.deepStrictEqual(fuzzyMatch('otr', 'Open the repo').hits, [0, 5, 9]);
  assert.deepStrictEqual(fuzzyMatch('', 'anything'), { score: 0, hits: [] });
  const items = [{ title: 'archive' }, { title: 'Open the repo on GitHub' }, { title: 'move to Review' }, { title: 'Deploy', hint: 'rfslot' }];
  assert.deepStrictEqual(filterItems(items, '').map((r) => r.item.title), items.map((i) => i.title), 'no query keeps the order');
  assert.deepStrictEqual(filterItems(items, 'repo').map((r) => r.item.title), ['Open the repo on GitHub']);
  assert.strictEqual(filterItems(items, 're')[0].item.title, 'move to Review', 'a word start beats a mid-word hit');
  // the hint matches too, and its hits are not drawn on the title
  assert.deepStrictEqual(filterItems(items, 'rfslot').map((r) => [r.item.title, r.hits]), [['Deploy', []]]);
  assert.strictEqual(markHits('a<b', [1]), 'a<b>&lt;</b>b');
});

test('paletteItems: no card = only the palette entries the empty context meets; a card adds its own commands', async () => {
  const { state } = await fresh();
  const { paletteItems } = await load('palette.js');
  assert.deepStrictEqual(paletteItems(null).map((i) => i.id), ['kit.repo', 'kit.sync']);

  const R = state.S.doc.cards.find((c) => c.id === 'R');
  const ids = paletteItems(R).map((i) => i.id);
  // palette entries against the card (review-only now shows; same rank = key order), then the card's own
  assert.deepStrictEqual(ids.slice(0, 3), ['kit.repo', 'kit.review', 'kit.sync']);
  assert.ok(ids.includes('card.move:backlog') && !ids.includes('card.move:review'), 'moves, not to where it is');
  assert.ok(ids.includes('card.talk') && ids.includes('card.archive'), 'the built-in actions');
  assert.ok(ids.includes('kit.deploy'), 'a card.menu/v1 command whose `when` matches');
  assert.strictEqual(ids.filter((i) => i === 'kit.review').length, 1, 'a command in two slots is listed once');

  const B = state.S.doc.cards.find((c) => c.id === 'B');
  const onB = paletteItems(B).map((i) => i.id);
  assert.ok(!onB.includes('kit.deploy') && onB.indexOf('kit.review') > 2, 'on a backlog card: no deploy; review only from the card menu');
});

// ---------- card-less runs ----------

test('runCommand with no card: a link opens from the empty context; a run posts no card', async () => {
  await fresh();
  const C = await load('commandui.js');
  const opened = [];
  const toasts = [];
  const fetch = stubFetch({ body: { ok: true, message: 'synced' } });
  C.configureCommands({ openUrl: (u) => opened.push(u), toast: (t, sub) => toasts.push([t, sub]), fetch });
  await C.runCommand('kit.repo', null);
  assert.deepStrictEqual(opened, ['https://github.com/o/r']);
  await C.runCommand('kit.sync', null);
  assert.deepStrictEqual(fetch.calls, [{ url: '/api/commands/kit.sync/run', body: { input: {} } }]);
  assert.deepStrictEqual(toasts, [['⟳ synced', '']]);
  // with a card it still names the card
  await C.runCommand('kit.sync', 'R');
  assert.deepStrictEqual(fetch.calls[1].body, { card: 'R', input: {} });
});
