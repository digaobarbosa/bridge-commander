'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { providerInfo } = require('../harness/session-links');

class Element {
  constructor() { this.hidden = true; this.children = []; this.dataset = {}; this.classList = { toggle() {}, remove() {} }; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  removeAttribute(name) { delete this[name]; }
  blur() {}
}
const elements = new Map();
globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
  createElement: () => new Element(), activeElement: null };
globalThis.localStorage = { getItem: () => null };
globalThis.window = { location: { href: '' } };
globalThis.EventSource = class { constructor() { throw new Error('navigation must not start a pane stream'); } };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', name)).href);
const ID = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const oldID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const session = (id = ID, extra = {}) => ({ resumeCli: providerInfo(extra.provider || 'codex').cli,
  resumeApp: providerInfo(extra.provider || 'codex').app || null,
  key: 'codex:' + id, provider: 'codex', id, cwd: '/tmp/project', host: 'local-mac', local: true,
  cwdAvailable: true, origin: 'external', surface: 'app', ...extra });
async function setup(sessions) {
  const { S } = await load('state.js');
  S.doc = { cards: [{ id: 'task', title: 'Continue task', column: 'review', sessions, currentSession: sessions[0].key }], workers: [] };
  window.location.href = '';
  return load('pane.js');
}

test('eye opens the saved Codex app thread after its card leaves Working without sending messages', async () => {
  const pane = await setup([session()]);
  globalThis.fetch = () => { throw new Error('app navigation must not send API writes'); };
  pane.openCardSession('task');
  assert.equal(window.location.href, 'codex://threads/' + ID);
  assert.equal(pane.paneOpen(), false);
});

test('multiple conversations require a selection and label the current session', async () => {
  const pane = await setup([session(), session(oldID)]);
  pane.openCardSession('task');
  assert.equal(window.location.href, '');
  assert.equal(pane.paneOpen(), true);
  const tabs = elements.get('pane-tabs').children;
  assert.match(tabs[0].textContent, /^● codex/);
  tabs[1].onclick();
  assert.match(elements.get('pane-msg').textContent, new RegExp(oldID));
  const actions = elements.get('pane-sessions').children;
  assert.deepEqual(actions.map((a) => a.textContent), ['Open in Codex', 'Copy resume command', 'Make current session']);
  actions[0].onclick();
  assert.equal(window.location.href, 'codex://threads/' + oldID);
});

test('missing and remote checkouts explain their limitation before any desktop launch', async () => {
  const pane = await setup([session(ID, { cwdAvailable: false })]);
  pane.openCardSession('task');
  assert.equal(window.location.href, '');
  assert.match(elements.get('pane-msg').textContent, /Restore this directory/);
  pane.closePane();
  await setup([session(ID, { local: false, host: 'remote-mac' })]);
  pane.openCardSession('task');
  assert.match(elements.get('pane-msg').textContent, /remote-mac/);
  assert.deepEqual(elements.get('pane-sessions').children.map((a) => a.textContent), ['Copy command for remote-mac']);
  assert.equal(window.location.href, '');
  pane.closePane();
});

test('choosing the current conversation patches only its session key', async () => {
  const pane = await setup([session(), session(oldID)]);
  const writes = [];
  globalThis.fetch = async (url, opts) => {
    writes.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  pane.openCardSession('task');
  elements.get('pane-tabs').children[1].onclick();
  const current = elements.get('pane-sessions').children.find((b) => b.textContent === 'Make current session');
  await current.onclick();
  assert.deepEqual(writes, [{ url: '/api/cards/task', method: 'PATCH', body: { currentSession: 'codex:' + oldID } }]);
  assert.match(elements.get('pane-tabs').children[0].textContent, /^● codex/);
  assert.equal(elements.get('pane-tabs').children[0].title, oldID + ' · local-mac');
  pane.closePane();
});

test('managed CLI eye probes process liveness once, including done workers', async () => {
  const pane = await setup([session(ID, { surface: 'cli', origin: 'managed' })]);
  const { S } = await load('state.js');
  const worker = { card: 'task', done: true, ref: { resumeId: ID, session: 'managed-live' } };
  S.doc.workers = [worker];
  const opener = elements.get('term-opener');
  opener.value = 'iterm2';
  opener.onchange();
  for (const live of [true, false, null]) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push([url, opts.method]);
      return { ok: true, json: async () => ({ sessions: S.doc.cards[0].sessions,
        currentSession: S.doc.cards[0].currentSession, worker: { ...worker, live } }) };
    };
    window.location.href = '';
    await pane.openCardSession('task');
    assert.deepEqual(calls, [['/api/cards/task/sessions', 'GET']]);
    if (live === true) assert.match(decodeURIComponent(window.location.href), /tmux new-session/);
    else if (live === false) assert.match(decodeURIComponent(window.location.href), /codex resume/);
    else {
      assert.equal(window.location.href, '');
      assert.match(elements.get('pane-msg').textContent, /Cannot verify/);
      assert.deepEqual(elements.get('pane-sessions').children, []);
    }
    pane.closePane();
  }
  opener.value = 'off';
  opener.onchange();
});

test('archived conversation opens from its frozen card without restoring it', async () => {
  const { S } = await load('state.js');
  S.doc = { cards: [], workers: [] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ archive: [{ ts: '2026-09-30', card: {
    id: 'archived', title: 'Archived task', sessions: [session()], currentSession: session().key,
  } }], total: 1 }) });
  const archive = await load('archive.js');
  archive.ensureArchive();
  await new Promise((resolve) => setImmediate(resolve));
  const pane = await load('pane.js');
  globalThis.fetch = () => { throw new Error('archived navigation must not restore or patch the card'); };
  window.location.href = '';
  pane.openCardSession('archived');
  assert.equal(window.location.href, 'codex://threads/' + ID);
});
