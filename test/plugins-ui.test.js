'use strict';
// ui/js/plugins.js (the loader), template.js (url and badge templates),
// commandui.commandKind and activities' pure parts. The loader reads
// GET /api/plugins — stubbed at fetch here — and fills slots.js and views.js
// from it; no plugin code runs for any of that.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const PAYLOAD = {
  plugins: [
    { id: 'kit', name: 'Kit', enabled: true, source: 'workspace', config: { region: 'eu' }, ui: '/plugins/kit/ui.js' },
    { id: 'off', name: 'Off', enabled: false, source: 'shipped' },
  ],
  contributions: {
    commands: [
      { id: 'kit.deploy', title: 'Deploy', icon: '🚀', form: { env: { enum: ['a', 'b'] } }, prepare: 'server', tracked: true, plugin: 'kit' },
      { id: 'kit.pr', title: 'Open PR', icon: '🔗', open: '${card.attributes.prs[0].url}', plugin: 'kit' },
    ],
    menus: {
      'card.menu/v1': [
        { command: 'kit.deploy', plugin: 'kit', key: 'menu:card.menu/v1:kit.deploy', rank: 50, when: { 'card.column': 'review' } },
        { command: 'nobody.has-this', plugin: 'kit', key: 'menu:card.menu/v1:nobody.has-this' },
      ],
      'card.actions/v1': [{ command: 'kit.pr', plugin: 'kit', key: 'menu:card.actions/v1:kit.pr', rank: 1000 }],
    },
    badges: [{ id: 'repo', text: '${card.repo}', tone: 'ok', plugin: 'kit', key: 'badge:repo', rank: 1000 }],
    views: [{ id: 'timeline', title: 'timeline', icon: '🛰', plugin: 'kit', key: 'view:timeline', rank: 1000 }],
    sections: [{ id: 'deploys', title: 'Deploys', slot: 'detail.sections/v1', plugin: 'kit', key: 'section:deploys', rank: 1000 }],
    checks: [],
  },
  harnesses: [{ name: 'claude', adapter: 'tmux' }, { name: 'deepseek', adapter: 'tmux', plugin: 'deepseek' }],
  disabled: ['view:kanban', 'menu:card.actions/v1:kit.pr'],
};
function stubFetch(answers) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push(String(url));
    const a = typeof answers === 'function' ? answers(url, opts) : answers;
    return { ok: a.status === undefined || a.status < 400, status: a.status || 200, json: async () => a.body };
  };
  f.calls = calls;
  return f;
}
async function fresh() {
  const slots = await load('slots.js');
  const views = await load('views.js');
  const P = await load('plugins.js');
  P.resetPlugins();
  slots.resetSlots();
  views.resetViews();
  views.registerView({ id: 'board', key: 'view:kanban', rank: 100, render() {} });
  views.registerView({ id: 'table', rank: 200, render() {} });
  return { slots, views, P };
}

test('mapContributions: menus take their command\'s title and icon; a menu naming no command is dropped', async () => {
  const { P } = await fresh();
  const m = P.mapContributions(PAYLOAD);
  const menu = m.slots.filter((s) => s.slot === 'card.menu/v1').map((s) => s.entry);
  assert.deepStrictEqual(menu.map((e) => [e.key, e.command, e.title, e.icon, e.rank]), [['menu:card.menu/v1:kit.deploy', 'kit.deploy', 'Deploy', '🚀', 50]]);
  assert.deepStrictEqual(menu[0].when, { 'card.column': 'review' });
  assert.deepStrictEqual(m.slots.find((s) => s.slot === 'card.badges/v1').entry.text, '${card.repo}');
  assert.strictEqual(m.slots.find((s) => s.slot === 'detail.sections/v1').entry.id, 'deploys');
  assert.deepStrictEqual(m.views.map((v) => [v.id, v.key, v.icon]), [['timeline', 'view:timeline', '🛰']]);
  assert.strictEqual(m.commands.get('kit.pr').open, '${card.attributes.prs[0].url}');
});

test('loadPlugins fills the slots and the view registry, and applies the disabled keys to both', async () => {
  const { P, slots, views } = await fresh();
  views.setMode('board');
  P.configurePlugins({ fetch: stubFetch({ body: PAYLOAD }) });
  await P.loadPlugins();
  const ctx = { card: { column: 'review', repo: 'proj', attributes: {} } };
  assert.deepStrictEqual(slots.entries('card.menu/v1', ctx).map((e) => e.command), ['kit.deploy']);
  assert.deepStrictEqual(slots.entries('card.menu/v1', { card: { column: 'backlog' } }), [], '`when` still filters');
  assert.deepStrictEqual(slots.entries('card.actions/v1', ctx), [], 'a disabled menu key drops out');
  assert.deepStrictEqual(views.views().map((v) => v.id), ['table', 'timeline'], 'view:kanban off, the plugin view in');
  assert.strictEqual(views.current(), 'table', 'the kanban was on screen: falls back');
  assert.strictEqual(P.command('kit.deploy').tracked, true);
  assert.deepStrictEqual(P.harnesses(), ['claude', 'deepseek']);
  assert.strictEqual(P.defaultHarness(), 'claude');
});

test('a reload replaces entries without tearing down the view on screen; a gone view leaves', async () => {
  const { P, views } = await fresh();
  let payload = PAYLOAD;
  P.configurePlugins({ fetch: stubFetch(() => ({ body: payload })) });
  await P.loadPlugins();
  views.setMode('timeline');
  const heard = [];
  views.onModeChange((to) => heard.push(to));
  await P.loadPlugins();
  assert.strictEqual(views.current(), 'timeline');
  assert.deepStrictEqual(heard, [], 'no flicker through the fallback');
  payload = Object.assign({}, PAYLOAD, { contributions: Object.assign({}, PAYLOAD.contributions, { views: [] }) });
  await P.loadPlugins();
  assert.ok(!views.view('timeline'));
  assert.notStrictEqual(views.current(), 'timeline');
});

test('an older server without /api/plugins: nothing contributed, the built-in harness pair', async () => {
  const { P, slots } = await fresh();
  P.configurePlugins({ fetch: stubFetch({ status: 404, body: { error: 'not found' } }) });
  await P.loadPlugins();
  assert.strictEqual(P.pluginsState().missing, true);
  assert.deepStrictEqual(P.harnesses(), ['claude', 'codex']);
  assert.deepStrictEqual(slots.entries('card.menu/v1'), []);
});

test('a failed read keeps what was loaded', async () => {
  const { P, slots } = await fresh();
  let fail = false;
  P.configurePlugins({ fetch: stubFetch(() => (fail ? { status: 500, body: {} } : { body: PAYLOAD })) });
  await P.loadPlugins();
  fail = true;
  await P.loadPlugins();
  assert.match(P.pluginsState().error, /500/);
  assert.strictEqual(slots.entries('card.menu/v1').length, 1);
});

test('syncPlugins refetches only when the board\'s pluginsVersion moves', async () => {
  const { P } = await fresh();
  const f = stubFetch({ body: PAYLOAD });
  P.configurePlugins({ fetch: f });
  await P.loadPlugins();
  P.syncPlugins({ pluginsVersion: 3 }); // the first version seen: the boot fetch already answered it
  P.syncPlugins({ pluginsVersion: 3 });
  P.syncPlugins({});
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(f.calls.length, 1);
  P.syncPlugins({ pluginsVersion: 4 });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(f.calls.length, 2);
});

test('a plugin ui module is imported once, on need, and handed the contract\'s ui object', async () => {
  const { P } = await fresh();
  let seen = null, imports = 0;
  P.configurePlugins({
    fetch: stubFetch({ body: PAYLOAD }),
    importModule: async (url) => {
      imports++;
      assert.strictEqual(url, '/plugins/kit/ui.js');
      return { activate(ui) {
        seen = ui;
        ui.views.register({ id: 'timeline', render(el, st) { el.painted = st.doc; } });
        ui.sections.register({ id: 'deploys', render() { throw new Error('section broke'); } });
      } };
    },
  });
  await P.loadPlugins();
  await Promise.all([P.ensureModule('kit'), P.ensureModule('kit')]);
  assert.strictEqual(imports, 1);
  assert.deepStrictEqual(Object.keys(seen).sort(), ['api', 'html', 'openActivity', 'openCard', 'plugin', 'sections', 'state', 'toast', 'views']);
  assert.deepStrictEqual(seen.plugin, { id: 'kit', config: { region: 'eu' } });
  assert.strictEqual(seen.html.esc('<b>'), '&lt;b&gt;');
  await assert.rejects(seen.api('GET', 'https://evil.example/x'), /same-origin/);
  const el = { innerHTML: '' };
  P.renderPluginView({ id: 'timeline', plugin: 'kit', key: 'view:timeline', title: 'timeline' }, el);
  assert.ok('painted' in el, 'the registered renderer painted');
  const sec = { innerHTML: '' };
  P.renderPluginSection({ id: 'deploys', plugin: 'kit', key: 'section:deploys' }, sec, { id: 'R' });
  assert.match(sec.innerHTML, /⚠ plugin kit failed/, 'a throwing section fails inside its own box');
});

test('a module that fails to import fails in its slot, and says why', async () => {
  const { P } = await fresh();
  P.configurePlugins({ fetch: stubFetch({ body: PAYLOAD }), importModule: async () => { throw new Error('SyntaxError: nope'); } });
  await P.loadPlugins();
  await P.ensureModule('kit');
  const el = { innerHTML: '' };
  P.renderPluginView({ id: 'timeline', plugin: 'kit', key: 'view:timeline', title: 'timeline' }, el);
  assert.match(el.innerHTML, /⚠ plugin kit failed/);
  assert.match(P.moduleError('kit'), /nope/);
});

test('templates: a link command\'s url is filled from the context, http(s) only', async () => {
  const { expandUrl, expandTemplate } = await load('template.js');
  const ctx = { card: { id: 'R', branch: 'feat/x', attributes: { prs: [{ url: 'https://github.com/o/r/pull/7' }], evil: 'javascript:alert(1)' }, repo: 'o/r' } };
  assert.strictEqual(expandUrl('${card.attributes.prs[0].url}', ctx), 'https://github.com/o/r/pull/7');
  assert.strictEqual(expandUrl('https://github.com/${card.repo}/tree/${card.branch}', ctx), 'https://github.com/o/r/tree/feat/x');
  assert.strictEqual(expandUrl('${card.attributes.evil}', ctx), null, 'javascript: is refused');
  assert.strictEqual(expandUrl('file:///etc/passwd', ctx), null);
  assert.strictEqual(expandUrl('https://x.test/${card.nope}', ctx), null, 'a half-filled url is never opened');
  assert.deepStrictEqual(expandTemplate('⎇ ${card.repo} ${card.attributes}', ctx), { text: '⎇ o/r ', missing: ['card.attributes'] });
});

test('commandKind: a link opens, a form or a prepare opens the modal, else it runs', async () => {
  const { commandKind } = await load('commandui.js');
  assert.strictEqual(commandKind({ open: 'https://x' }), 'open');
  assert.strictEqual(commandKind({ form: { a: {} } }), 'form');
  assert.strictEqual(commandKind({ form: {}, prepare: 'server' }), 'form');
  assert.strictEqual(commandKind({ form: {} }), 'run');
  assert.strictEqual(commandKind(null), null);
});

test('the taskbar shows every running activity, then the last three that ended', async () => {
  const { taskbarItems, chunkText } = await load('activities.js');
  const at = (m) => '2026-09-01T00:0' + m + ':00Z';
  const list = [
    { id: 'a', status: 'ok', endedAt: at(1) }, { id: 'b', status: 'running', startedAt: at(9) },
    { id: 'c', status: 'failed', endedAt: at(5) }, { id: 'd', status: 'ok', endedAt: at(3) },
    { id: 'e', status: 'canceled', endedAt: at(4) }, { id: 'f', status: 'running', startedAt: at(8) },
  ];
  assert.deepStrictEqual(taskbarItems(list).map((a) => a.id), ['b', 'f', 'c', 'e', 'd']);
  assert.strictEqual(chunkText('"line\\n"'), 'line\n');
  assert.strictEqual(chunkText('{"text":"x"}'), 'x');
  assert.strictEqual(chunkText('raw text'), 'raw text');
});
