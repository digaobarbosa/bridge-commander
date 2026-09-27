'use strict';
// server/plugins.js — the plugin host: boot and lazy activation, the ctx,
// disposers that unwind everything, observe-only events, cached decorations,
// and a failing plugin that fails alone. Fixture plugins live in
// test/fixtures/plugins/{shipped,workspace}/ and report into a global.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCatalog, writeOverlay } = require('../server/manifests.js');
const { createPluginHost } = require('../server/plugins.js');

const FIX = path.join(__dirname, 'fixtures', 'plugins');

function setup(opts) {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bc-host-'));
  if (opts && opts.overlay) writeOverlay(stateDir, opts.overlay);
  const rec = globalThis.__bcPluginFixture = { activated: [], deactivated: [], events: [], decorated: [], errors: [], ctx: {} };
  const logs = [];
  const watchers = { regs: [], disposed: [], register(spec) { this.regs.push(spec); return () => this.disposed.push(spec.id); } };
  const api = { board: () => ({ cards: [] }) };
  const internal = { secret: 'core-only' };
  const host = createPluginHost({
    catalog: () => resolveCatalog({ shippedDir: path.join(FIX, 'shipped'), workspaceDir: path.join(FIX, 'workspace'), stateDir }),
    log: (m) => logs.push(m), api, internal, watchers,
  });
  return { host, rec, logs, watchers, stateDir, api, internal };
}
const byId = (host) => Object.fromEntries(host.status().map((s) => [s.id, s]));
const card = (id, updated) => ({ id, updated: updated || '2026-01-01T00:00:00.000Z', column: 'working' });

test('bootActivate starts the enabled boot plugins only; a bad `when` disables its plugin, loudly', async () => {
  const { host, rec, logs } = setup();
  await host.bootActivate();
  assert.deepStrictEqual(rec.activated.slice().sort(), ['alpha', 'boom', 'wsone']);
  const s = byId(host);
  assert.strictEqual(s.alpha.active, true);
  assert.strictEqual(s.lazy.active, false, 'lazy waits to be asked');
  assert.strictEqual(s.off.active, false);
  assert.strictEqual(s.badwhen.active, false);
  assert.match(s.badwhen.error, /when of menus\["card.menu\/v1"\] badwhen.x: .*unknown operator "\$bogus"/);
  assert.ok(logs.some((l) => /plugin badwhen: disabled/.test(l)));
  const bw = host.catalog().plugins.find((p) => p.id === 'badwhen');
  assert.strictEqual(bw.enabled, false, 'the catalog the server reads contributions from says disabled');
  assert.strictEqual(await host.handler('badwhen.x'), null);
});

test('the ctx: config, api for all, internal only for shipped, namespaced commands, known events', async () => {
  const { host, rec, api, internal } = setup();
  await host.bootActivate();
  const a = rec.ctx.alpha;
  assert.deepStrictEqual([a.plugin.id, a.plugin.config.greeting], ['alpha', 'hi']);
  assert.strictEqual(a.api, api);
  assert.strictEqual(a.internal, internal, 'shipped plugins get the internal tier');
  assert.strictEqual(rec.ctx.wsone.api, api);
  assert.strictEqual(rec.ctx.wsone.internal, undefined, 'a workspace plugin does not');
  assert.match(rec.errors[0], /"alpha.go" must start with "wsone."/);
  assert.match(rec.errors[1], /unknown event "card-moverd"/);
  const h = await host.handler('alpha.go');
  assert.deepStrictEqual(h.prepare({}), { greeting: 'hi' });
  assert.deepStrictEqual(h.run({ card: { id: 'C1' } }), { ok: true, message: 'went C1' });
  const r = await host.route('alpha', 'get', 'ping');
  assert.strictEqual(r(), 'pong');
  assert.strictEqual(await host.route('alpha', 'POST', 'ping'), null);
});

test('deactivate unwinds every registration, then calls the module deactivate', async () => {
  const { host, rec, watchers } = setup();
  await host.bootActivate();
  assert.deepStrictEqual(watchers.regs.map((w) => w.id), ['alpha/poll'], 'watchers delegate, ids tagged by plugin');
  assert.ok(host.decorations(card('C1'), {}).alpha);
  await host.deactivate('alpha');
  assert.deepStrictEqual(rec.deactivated, ['alpha']);
  assert.deepStrictEqual(watchers.disposed, ['alpha/poll']);
  assert.strictEqual(byId(host).alpha.active, false);
  await host.emit('card-moved', { card: card('C1') });
  assert.deepStrictEqual(rec.events, [], 'the listener is gone');
  assert.strictEqual(host.decorations(card('C1', 'later'), {}).alpha, undefined, 'the decorator is gone');
  // A ctx kept past deactivation cannot register again.
  assert.throws(() => rec.ctx.alpha.decorate(() => ({})), /not active/);
  // The command handler and route went too: asking again starts the plugin
  // afresh, and its handle() finds no stale registration to collide with.
  assert.ok((await host.handler('alpha.go')).run);
  assert.strictEqual(rec.activated.filter((x) => x === 'alpha').length, 2);
  assert.strictEqual(byId(host).alpha.error, undefined);
});

test('reload: a plugin the overlay disables is deactivated and answers nothing', async () => {
  const s = setup();
  await s.host.bootActivate();
  writeOverlay(s.stateDir, { plugins: { alpha: { enabled: false } } });
  await s.host.reload();
  assert.deepStrictEqual(s.rec.deactivated, ['alpha']);
  assert.strictEqual(await s.host.handler('alpha.go'), null, 'no lazy re-activation of a disabled plugin');
  assert.strictEqual(await s.host.route('alpha', 'GET', 'ping'), null);
  writeOverlay(s.stateDir, { plugins: {} });
  await s.host.reload();
  assert.strictEqual(byId(s.host).alpha.active, true, 'booted: a boot plugin enabled again starts again');
});

test('lazy activation: on the first handler/route ask, once even when asked concurrently', async () => {
  const { host, rec } = setup();
  await host.bootActivate();
  assert.ok(!rec.activated.includes('lazy'));
  const [h1, h2] = await Promise.all([host.handler('lazy.hi'), host.handler('lazy.hi')]);
  assert.deepStrictEqual(h1.run(), { ok: true });
  assert.ok(h2.run);
  assert.strictEqual(rec.activated.filter((x) => x === 'lazy').length, 1);
  const echo = await host.route('lazy', 'POST', '/echo');
  assert.strictEqual(echo(null, null, 'b'), 'b');
  assert.strictEqual(await host.handler('lazy.nope'), null, 'a command nobody declares');
  assert.strictEqual(byId(host).lazy.active, true);
});

test('a lazy plugin also starts from route() alone', async () => {
  const { host, rec } = setup();
  await host.reload();
  const echo = await host.route('lazy', 'POST', 'echo');
  assert.strictEqual(typeof echo, 'function');
  assert.deepStrictEqual(rec.activated, ['lazy']);
});

test('a disabled plugin contributes and activates nothing', async () => {
  const { host, rec } = setup();
  await host.bootActivate();
  await host.activate('off');
  assert.strictEqual(await host.handler('off.x'), null);
  assert.strictEqual(await host.route('off', 'GET', 'x'), null);
  assert.ok(!rec.activated.includes('off'));
  assert.strictEqual(host.catalog().plugins.find((p) => p.id === 'off').enabled, false);
});

test('an activation that throws unwinds what it registered and stays failed until reload', async () => {
  const { host, rec, watchers, logs } = setup();
  await host.reload();
  assert.strictEqual(await host.handler('failing.x'), null);
  assert.deepStrictEqual(watchers.disposed, ['failing/w'], 'its watcher was unwound');
  assert.match(byId(host).failing.error, /cannot start/);
  assert.ok(logs.some((l) => /plugin failing: activation failed: cannot start/.test(l)));
  await host.handler('failing.x');
  assert.strictEqual(rec.activated.filter((x) => x === 'failing').length, 1, 'no retry storm');
  await host.reload();
  await host.handler('failing.x');
  assert.strictEqual(rec.activated.filter((x) => x === 'failing').length, 2, 'reload lets it try again');
});

test('a throwing plugin never breaks emit or decorations for the others', async () => {
  const { host, rec, logs } = setup();
  await host.bootActivate();
  const payload = { card: card('C9') };
  await host.emit('card-moved', payload);
  assert.deepStrictEqual(rec.events, [['alpha', 'C9']]);
  assert.strictEqual(payload.card.id, 'C9', 'observe-only: a handler mutates its own copy');
  assert.ok(logs.some((l) => /plugin boom: event card-moved handler failed: boom sync/.test(l)));
  assert.ok(logs.some((l) => /plugin boom: event card-moved handler failed: boom async/.test(l)));
  const d = host.decorations(card('C9'), {});
  assert.deepStrictEqual(d.alpha, { badges: [{ text: 'α', tone: 'info' }], attrs: { seen: 'C9' } });
  assert.deepStrictEqual(d.boom, { error: 'boom decorate' });
  await host.emit('worker-done', {}); // nobody listens: fine
});

test('decorations are cached per card.id + card.updated', async () => {
  const { host, rec } = setup();
  await host.bootActivate();
  host.decorations(card('C1', 't1'), {});
  host.decorations(card('C1', 't1'), {});
  assert.deepStrictEqual(rec.decorated, ['C1']);
  host.decorations(card('C1', 't2'), {});
  host.decorations(card('C2', 't1'), {});
  assert.deepStrictEqual(rec.decorated, ['C1', 'C1', 'C2']);
});
