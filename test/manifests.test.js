'use strict';
// server/manifests.js — plugin discovery, validation, the overlay, and the
// contributions the enabled plugins add. Pure data; no plugin code runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../server/manifests.js');

function tmp() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bc-man-')); }
function plugin(root, id, manifest, files = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

const deploy = {
  id: 'deploy',
  commands: undefined,
  contributes: {
    commands: [{ id: 'deploy.run', title: 'Deploy', form: { env: { enum: ['staging', 'prod'], default: 'staging' } },
      run: { exec: 'echo ${input.env}' }, tracked: true }],
    menus: { 'card.menu/v1': [{ command: 'deploy.run', rank: 200, when: { 'card.column': 'working' } }] },
  },
};
delete deploy.commands;

test('a valid manifest normalizes: defaults filled, enum typed, menus ranked', () => {
  const out = m.validateManifest(deploy, 'deploy');
  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.activation, 'lazy');
  assert.strictEqual(out.contributes.commands[0].form.env.type, 'enum');
  assert.strictEqual(out.contributes.commands[0].tracked, true);
  assert.strictEqual(out.contributes.menus['card.menu/v1'][0].rank, 200);
});

test('typos and bad shapes are refused loudly, naming the problem', () => {
  const bad = [
    [{ id: 'x', contibutes: {} }, /unknown key "contibutes"/],
    [{ id: 'y' }, /must equal its folder name/],
    [{ id: 'x', contributes: { command: [] } }, /unknown contribution kind "command"/],
    [{ id: 'x', contributes: { commands: [{ id: 'other.run', title: 'T', run: { exec: 'true' } }] } }, /must start with "x\."/],
    [{ id: 'x', contributes: { commands: [{ id: 'x.run', title: 'T', run: {} }] } }, /run must be/],
    [{ id: 'x', contributes: { menus: { 'card.menu': [] } } }, /unknown slot "card.menu"/],
    [{ id: 'x', contributes: { views: [{ id: 'v', title: 'V' }] } }, /needs a "ui" module/],
    [{ id: 'x', contributes: { commands: [{ id: 'x.run', title: 'T', run: 'server' }] } }, /needs a "server" module/],
    [{ id: 'x', server: '../escape.js' }, /inside the plugin folder/],
    [{ id: 'x', contributes: { checks: [{ id: 'c' }] } }, /bin or exec required/],
    [{ id: 'x', contributes: { menus: { 'topbar/v2': [] } } }, /unknown slot "topbar\/v2"/],
    [{ id: 'x', ui: 'ui.js', contributes: { views: [{ id: 'v', title: 'V', slot: 'sidebar/v2' }] } }, /slot must be main\/v1\|sidebar\/v1/],
  ];
  for (const [man, re] of bad) assert.throws(() => m.validateManifest(man, 'x'), re, JSON.stringify(man));
});

test('the card-less slots: topbar/v1 and palette/v1 menus, a sidebar/v1 view, a settings section', () => {
  const man = m.validateManifest({ id: 'x', ui: 'ui.js', contributes: {
    commands: [{ id: 'x.repo', title: 'Repo', icon: '↗', run: { open: 'https://github.com/o/r' } }],
    menus: { 'topbar/v1': [{ command: 'x.repo' }], 'palette/v1': [{ command: 'x.repo', rank: 5 }] },
    views: [{ id: 'side', title: 'Side', slot: 'sidebar/v1' }, { id: 'main', title: 'Main' }],
    sections: [{ id: 'prefs', title: 'Prefs', slot: 'settings.sections/v1' }],
  } }, 'x');
  assert.deepStrictEqual(man.contributes.menus['topbar/v1'], [{ command: 'x.repo', rank: 1000 }]);
  assert.deepStrictEqual(man.contributes.views.map((v) => v.slot), ['sidebar/v1', 'main/v1']);
  assert.deepStrictEqual(m.CARDLESS_SLOTS, ['topbar/v1', 'palette/v1']);
  assert.ok(m.CARDLESS_SLOTS.every((slot) => m.MENU_SLOTS.includes(slot)));
});

test('discover: a workspace plugin replaces the shipped one with the same id, a broken one is recorded not fatal', () => {
  const shipped = tmp(), ws = tmp();
  plugin(shipped, 'deploy', deploy);
  plugin(shipped, 'broken', '{ not json');
  plugin(ws, 'deploy', Object.assign({}, deploy, { name: 'Mine' }));
  const found = m.discover({ shippedDir: shipped, workspaceDir: ws });
  assert.deepStrictEqual(found.map((p) => [p.id, p.source]), [['broken', 'shipped'], ['deploy', 'workspace']]);
  assert.match(found[0].error, /not valid JSON/);
  assert.strictEqual(found[1].manifest.name, 'Mine');
});

test('the overlay enables, disables, configures, and tweaks contributions', () => {
  const shipped = tmp(), state = tmp();
  plugin(shipped, 'deploy', Object.assign({}, deploy, { config: { slot: { type: 'string', default: 'a' } } }));
  plugin(shipped, 'off', { id: 'off', enabled: false });
  m.writeOverlay(state, {
    plugins: { off: { enabled: true }, deploy: { config: { slot: 'b', stray: 1 } } },
    contributions: { 'menu:card.menu/v1:deploy.run': { rank: 5 } },
  });
  let cat = m.resolveCatalog({ shippedDir: shipped, stateDir: state });
  const byId = Object.fromEntries(cat.plugins.map((p) => [p.id, p]));
  assert.strictEqual(byId.off.enabled, true);
  assert.deepStrictEqual(byId.deploy.config, { slot: 'b' });
  let c = m.contributions(cat);
  assert.strictEqual(c.menus['card.menu/v1'][0].rank, 5);
  assert.strictEqual(c.commands[0].plugin, 'deploy');

  m.writeOverlay(state, { plugins: {}, contributions: { 'command:deploy.run': { enabled: false } } });
  c = m.contributions(m.resolveCatalog({ shippedDir: shipped, stateDir: state }));
  assert.strictEqual(c.commands.length, 0);

  m.writeOverlay(state, { plugins: { deploy: { enabled: false } }, contributions: {} });
  c = m.contributions(m.resolveCatalog({ shippedDir: shipped, stateDir: state }));
  assert.deepStrictEqual(c.menus, {});
});

test('a malformed overlay reads as empty', () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'plugins.json'), 'nope');
  const logs = [];
  assert.deepStrictEqual(m.readOverlay(state, (l) => logs.push(l)), { plugins: {}, contributions: {} });
  assert.match(logs[0], /unreadable/);
});
