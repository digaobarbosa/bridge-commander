'use strict';
// The card surfaces draw from ONE view model (ui/js/cardview.js), so they
// cannot drift. This renders the real kanban tile and the real table row for
// the same cards and asks both for the same facts — the table used to miss
// the stale ⚠ and the queued ⏳ the tile had. It also opens the real move menu,
// whose archive used to skip the live-worker refusal the bulk bar applies.
//
// board.js and table.js bind DOM at import, so getElementById hands out
// recording stubs (the artifact-viewer-live.test.js trick); popovers are built
// with fake-dom.js elements so their buttons can be read and clicked.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { FakeEl } = require('./fake-dom.js');

function fakeNode() {
  const store = {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {},
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
  };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (t[k] = /^(on|append|remove|add|focus|scroll|load|pause|play|insert|set|get|blur|click)/.test(k)
        ? () => fakeNode() : fakeNode());
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const nodes = new Map();
const byId = (id) => nodes.get(id) || (nodes.set(id, fakeNode()), nodes.get(id));
const body = new FakeEl('body');
globalThis.document = {
  getElementById: byId,
  createElement: (tag) => new FakeEl(tag),
  addEventListener() {},
  body,
  querySelector: () => fakeNode(),
  querySelectorAll: () => [],
};
globalThis.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, location: { pathname: '/', search: '' } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
globalThis.alert = () => {};

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const long = new Date(Date.now() - 10 * 60000).toISOString(); // well past the stale threshold
const base = { type: 'implementation', owner: 'ada', labels: [], attributes: {}, events: [], created: long, updated: long };
function seed(state) {
  state.S.doc = {
    columns: [{ id: 'backlog', title: 'Backlog' }, { id: 'working', title: 'Working' }, { id: 'review', title: 'Review' }],
    lieutenants: [{ id: 'ada', name: 'Ada', color: '#123456' }],
    permissions: [],
    workers: [{ card: 'MNC-3', branch: 'bc/live', ref: { harness: 'claude' } }],
    cards: [
      Object.assign({}, base, { id: 'MNC-1', title: 'stuck one', column: 'backlog',
        thread: [{ author: 'user', text: 'hello?', ts: long }], status: { owed: true, owedState: 'seen' } }),
      Object.assign({}, base, { id: 'MNC-2', title: 'unseen one', column: 'review', pendingOrder: { kind: 'rework-order' },
        thread: [{ author: 'user', text: 'redo', ts: new Date().toISOString() }], status: { owed: true, owedState: 'queued' } }),
      Object.assign({}, base, { id: 'MNC-3', title: 'busy one', column: 'working', thread: [],
        status: { worker: { id: 'w3', state: 'working' } } }),
    ],
  };
}
// the markup of one card's tile / row, cut out of the surface's html
function slice(html, id, open, close) {
  const i = html.indexOf(open + id + '"');
  assert.ok(i >= 0, id + ' is drawn');
  const j = html.indexOf(close, i);
  return html.slice(i, j);
}

test('the tile and the table row show the same corner: stale ⚠, queued ⏳', async () => {
  const state = await load('state.js');
  const { renderBoard } = await load('board.js');
  const { renderTable } = await load('table.js');
  seed(state);
  renderBoard();
  const board = byId('board').innerHTML;
  state.S.boardMode = 'table';
  renderTable();
  const table = byId('table').innerHTML;
  const tile = (id) => slice(board, id, 'data-id="', '</div></div>');
  const row = (id) => slice(table, id, '<tr data-id="', '</tr>');
  for (const surface of [tile, row]) {
    assert.match(surface('MNC-1'), /t-typing stale[^>]*>⚠/, 'stale on ' + surface.name);
    assert.match(surface('MNC-2'), /t-typing queued[^>]*>⏳/, 'queued on ' + surface.name);
    assert.ok(!/t-typing/.test(surface('MNC-3')), 'nothing owed on ' + surface.name);
  }
  assert.match(tile('MNC-2'), /⏳ ordered/);
  assert.match(row('MNC-2'), /rework-order pending/);
  assert.match(tile('MNC-3'), /t-peek/, 'Working carries the peek');
  assert.match(tile('MNC-1'), /Ada<\/span>/, 'the owner reads by name');
  assert.match(row('MNC-1'), /Ada<\/td>/);
});

test('the move menu refuses to archive a card with a live worker, like the bulk bar', async () => {
  const state = await load('state.js');
  const { openMoveMenu } = await load('board.js');
  const { archiveRefusal } = await load('bulk.js');
  seed(state);
  const archiveBtn = () => {
    const menu = body.children.find((n) => n.className === 'popover');
    return menu.buttons().find((b) => /archive/.test(b.textContent));
  };
  openMoveMenu('MNC-3', 10, 10);
  const refused = archiveBtn();
  assert.strictEqual(refused.disabled, true);
  assert.match(refused.textContent, /live worker on bc\/live/);
  assert.strictEqual(archiveRefusal(state.card('MNC-3')), 'live worker on bc/live', 'the same words as the bulk bar');

  openMoveMenu('MNC-1', 10, 10);
  const ok = archiveBtn();
  assert.strictEqual(ok.disabled, false);
  calls.length = 0;
  ok.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(calls.some((c) => /\/api\/cards\/MNC-1\/archive$/.test(c.url) && c.method === 'POST'), JSON.stringify(calls));
});
