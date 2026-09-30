'use strict';
// The plugin system over HTTP (server/pluginapi.js + the wiring in server.js):
// the catalog the UI renders from, the overlay, commands run on a card,
// activities and their logs, checks, a plugin's own routes and browser module,
// lifecycle events and card decorations. A fixture plugin (recorder) is copied
// into the temp workspace's .bridge-commander/plugins before the server boots.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, startServerWithProject, withOwner, until, LT } = require('./helper');

const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'server', 'recorder');

function seedPlugin(dir) {
  const dest = path.join(dir, '.bridge-commander', 'plugins', 'recorder');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(FIXTURE, dest, { recursive: true });
}

function eventsOf(s) {
  const file = path.join(s.dir, '.bridge-commander', 'plugins', 'recorder', 'events.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let s;
test.before(async () => {
  s = await startServerWithLieutenant({
    seed: seedPlugin,
    env: { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
  });
  // The boot plugins start after the server answers; wait for ours.
  await until('recorder active', async () => {
    const r = await s.api('GET', '/api/plugins');
    return r.body.plugins.find((p) => p.id === 'recorder' && p.active);
  });
});
test.after(async () => { if (s) await s.stop(); });

async function card(id, extra) {
  const r = await s.api('POST', '/api/cards', withOwner(Object.assign({ title: 'Card ' + id, id }, extra || {})));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.card;
}
async function activityEnded(id) {
  return until('activity ' + id + ' ended', async () => {
    const a = (await s.api('GET', '/api/activities')).body.activities.find((x) => x.id === id);
    return a && a.status !== 'running' ? a : null;
  });
}

test('GET /api/plugins: the catalog, commands without their shell line, harnesses', async () => {
  const r = await s.api('GET', '/api/plugins');
  assert.strictEqual(r.status, 200);
  const rec = r.body.plugins.find((p) => p.id === 'recorder');
  assert.strictEqual(rec.source, 'workspace');
  assert.strictEqual(rec.enabled, true);
  assert.strictEqual(rec.active, true);
  assert.strictEqual(rec.error, null);
  assert.strictEqual(rec.ui, '/plugins/recorder/ui.js');
  assert.deepStrictEqual(rec.config, { greeting: 'hello' });
  assert.strictEqual(rec.configSchema.greeting.type, 'string');
  assert.strictEqual(rec.dir, undefined, 'the plugin folder is the server\'s business');
  const cmds = r.body.contributions.commands.filter((c) => c.plugin === 'recorder');
  const echo = cmds.find((c) => c.id === 'recorder.echo');
  assert.strictEqual(echo.tracked, true);
  assert.deepStrictEqual(echo.form.word, { type: 'string', default: 'x' });
  for (const c of cmds) {
    assert.ok(!JSON.stringify(c).includes('BC_INPUT_WORD'), 'no exec line reaches the browser: ' + JSON.stringify(c));
    assert.strictEqual(c.env, undefined);
  }
  assert.strictEqual(cmds.find((c) => c.id === 'recorder.link').open, 'https://example.com/c/${card.id}?t=${card.title}');
  assert.strictEqual(cmds.find((c) => c.id === 'recorder.greet').prepare, 'server');
  assert.ok(r.body.contributions.menus['card.menu/v1'].some((m) => m.command === 'recorder.greet'));
  assert.ok(r.body.contributions.checks.some((c) => c.plugin === 'recorder' && c.id === 'fine' && c.exec === undefined));
  assert.ok(Array.isArray(r.body.harnesses) && r.body.harnesses.every((h) => typeof h.name === 'string'));
  assert.ok(Array.isArray(r.body.disabled));
  // The shipped acp-agents plugin adds two harnesses beside the tmux ones.
  const h = (n) => r.body.harnesses.find((x) => x.name === n);
  assert.strictEqual(h('claude-acp').adapter, 'acp');
  assert.strictEqual(h('claude-acp').plugin, 'acp-agents');
  assert.strictEqual(h('codex-acp').adapter, 'acp');
  assert.strictEqual(h('claude').adapter, 'tmux');
  assert.strictEqual(h('codex').adapter, 'tmux');
  assert.ok(r.body.plugins.find((p) => p.id === 'acp-agents').enabled);
});

test('the board carries activities, pluginsVersion, and card.ext from a decorator (omitted when empty)', async () => {
  await card('deco-1', { labels: ['deco'] });
  await card('plain-1');
  const b = (await s.api('GET', '/api/board')).body;
  assert.ok(Array.isArray(b.activities));
  assert.strictEqual(typeof b.pluginsVersion, 'number');
  const deco = b.cards.find((c) => c.id === 'deco-1');
  assert.deepStrictEqual(deco.ext, { recorder: { badges: [{ text: 'R', tone: 'info', tooltip: 'recorded' }], attrs: { seen: 'deco-1' } } });
  assert.strictEqual(b.cards.find((c) => c.id === 'plain-1').ext, undefined);
});

test('a server command: prepare merges the plugin\'s defaults, run answers its message', async () => {
  await card('greet-1');
  const p = await s.api('POST', '/api/commands/recorder.greet/prepare', { card: 'greet-1' });
  assert.deepStrictEqual(p.body, { values: { name: 'Card greet-1' } });
  const r = await s.api('POST', '/api/commands/recorder.greet/run', { card: 'greet-1', input: { name: 'Ada' } });
  assert.deepStrictEqual(r.body, { ok: true, message: 'hello Ada on greet-1' });
});

test('run refuses: 403 when no menu `when` matches, 400 on bad input, 404 unknown command or card, 403 card-less', async () => {
  await card('greet-2');
  // a lieutenant move lands only in review: out of backlog, the greet menu entry no longer matches
  assert.strictEqual((await s.api('POST', '/api/cards/greet-2/move', { column: 'review' })).status, 200);
  const r = await s.api('POST', '/api/commands/recorder.greet/run', { card: 'greet-2', input: { name: 'x' } });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /does not apply/);
  await card('greet-3');
  const bad = await s.api('POST', '/api/commands/recorder.greet/run', { card: 'greet-3', input: { name: '' } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.field, 'name');
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.nope/run', { card: 'greet-3' })).status, 404);
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.greet/run', { card: 'no-such' })).status, 404);
  // no card = a card-less call, and greet sits on cards only
  const cardless = await s.api('POST', '/api/commands/recorder.greet/run', { input: { name: 'x' } });
  assert.strictEqual(cardless.status, 403);
  assert.match(cardless.body.error, /needs a card/);
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.greet/run', { card: '  ' })).status, 400);
});

test('card-less commands: a topbar link, a server handler with card null, an exec in the workspace', async () => {
  const home = await s.api('POST', '/api/commands/recorder.home/run', {});
  assert.deepStrictEqual(home.body, { ok: true, url: 'https://example.com/home' });
  // prepare and run both see card: null
  const p = await s.api('POST', '/api/commands/recorder.hello/prepare', {});
  assert.deepStrictEqual(p.body, { values: { who: 'the bridge' } });
  const r = await s.api('POST', '/api/commands/recorder.hello/run', { input: { who: 'Ada' } });
  assert.deepStrictEqual(r.body, { ok: true, message: 'hello Ada with no card' });
  // the same palette command still runs on a card when one is given
  await card('hello-1');
  const onCard = await s.api('POST', '/api/commands/recorder.hello/run', { card: 'hello-1', input: { who: 'Bo' } });
  assert.deepStrictEqual(onCard.body, { ok: true, message: 'hello Bo on hello-1' });
  // an exec with no card runs in the workspace, and its run names no card
  const w = await s.api('POST', '/api/commands/recorder.where/run', {});
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  assert.strictEqual(w.body.run.card, '');
  const log = await until('where log', async () => {
    const l = (await s.api('GET', '/api/activities/' + w.body.run.id + '/log')).body;
    return l && l.done ? l : null;
  });
  assert.strictEqual(log.text.trim(), 'ws ' + path.basename(s.dir));
});

test('card-less refusals: a card template is 422 missing; a card-only or card-`when` command is 403', async () => {
  const miss = await s.api('POST', '/api/commands/recorder.needs-card/run', {});
  assert.strictEqual(miss.status, 422);
  assert.deepStrictEqual(miss.body.missing, ['card.id']);
  // placed in the palette, but its `when` asks about a card: the empty context fails it
  const rev = await s.api('POST', '/api/commands/recorder.review-only/run', {});
  assert.strictEqual(rev.status, 403);
  // …and on a card in review it runs
  await card('rev-only-1');
  assert.strictEqual((await s.api('POST', '/api/cards/rev-only-1/move', { column: 'review' })).status, 200);
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.review-only/run', { card: 'rev-only-1' })).status, 200);
  // placed on cards only (card.menu/v1): no card-less run, no card-less prepare
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.link/run', {})).status, 403);
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.greet/prepare', {})).status, 403);
  // the topbar entries reach the browser under their slot
  const menus = (await s.api('GET', '/api/plugins')).body.contributions.menus;
  assert.deepStrictEqual(menus['topbar/v1'].map((m) => m.command), ['recorder.home', 'recorder.where']);
});

test('an open command: the URL, expanded without quoting', async () => {
  await card('link-1', { title: 'My Title' });
  const r = await s.api('POST', '/api/commands/recorder.link/run', { card: 'link-1' });
  assert.deepStrictEqual(r.body, { ok: true, url: 'https://example.com/c/link-1?t=My Title' });
});

test('a tracked exec: an activity on the board, its log readable, its stream ending', async () => {
  await card('echo-1');
  const r = await s.api('POST', '/api/commands/recorder.echo/run', { card: 'echo-1', input: { word: 'yes' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const id = r.body.activity.id;
  assert.strictEqual(r.body.activity.card, 'echo-1');
  const end = await activityEnded(id);
  assert.strictEqual(end.status, 'ok');
  const b = (await s.api('GET', '/api/board')).body;
  assert.ok(b.activities.some((a) => a.id === id), 'board.activities lists it');
  assert.ok((await s.api('GET', '/api/activities?card=echo-1')).body.activities.every((a) => a.card === 'echo-1'));
  const log = (await s.api('GET', '/api/activities/' + id + '/log')).body;
  assert.match(log.text, /card echo-1/);
  assert.match(log.text, /word yes/);
  assert.strictEqual(log.done, true);
  const from = (await s.api('GET', '/api/activities/' + id + '/log?from=' + log.size)).body;
  assert.strictEqual(from.text, '');
  const sse = await (await fetch(s.base + '/api/activities/' + id + '/stream')).text();
  assert.match(sse, /event: chunk\ndata: \{"text":"card echo-1/);
  assert.match(sse, /event: end\ndata: \{[^\n]*"status":"ok"/);
  assert.strictEqual((await s.api('GET', '/api/activities/r-nope-0000/log')).status, 404);
});

test('stream a running activity, then cancel it: chunks, then end with canceled', async () => {
  await card('slow-1');
  const id = (await s.api('POST', '/api/commands/recorder.slow/run', { card: 'slow-1' })).body.activity.id;
  const res = await fetch(s.base + '/api/activities/' + id + '/stream');
  const reader = res.body.getReader();
  let text = '';
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += Buffer.from(value).toString('utf8');
    }
  })();
  await until('first chunk', async () => /started/.test(text));
  assert.deepStrictEqual((await s.api('POST', '/api/activities/' + id + '/cancel')).body, { ok: true });
  await read;
  assert.match(text, /event: end\ndata: \{[^\n]*"status":"canceled"/);
  assert.strictEqual((await s.api('POST', '/api/activities/r-nope-0000/cancel')).status, 404);
});

test('an untracked exec answers at once and never reaches the board', async () => {
  await card('quick-1');
  const r = await s.api('POST', '/api/commands/recorder.quick/run', { card: 'quick-1' });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.activity, null);
  assert.match(r.body.run.id, /^r-/);
  const b = (await s.api('GET', '/api/board')).body;
  assert.ok(!b.activities.some((a) => a.id === r.body.run.id));
});

test('a failed tracked run: level-1 activity-failed on the card, and the owner is queued', async () => {
  await card('fail-1', { labels: ['failable'] });
  const r = await s.api('POST', '/api/commands/recorder.fail/run', { card: 'fail-1' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const end = await activityEnded(r.body.activity.id);
  assert.strictEqual(end.status, 'failed');
  const ev = await until('activity-failed event', async () =>
    (await s.api('GET', '/api/cards/fail-1')).body.events.find((e) => e.kind === 'activity-failed'));
  assert.strictEqual(ev.level, 1);
  assert.match(ev.text, /about to fail/);
  const feed = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
  const item = feed.find((it) => it.kind === 'activity-failed' && it.card === 'fail-1');
  assert.ok(item, 'the owner is queued');
  assert.strictEqual(item.activity, r.body.activity.id);
  assert.match(item.hint, new RegExp('bc-axi activity log ' + item.activity));
  // the detail.actions entry wants the label: without it, 403
  await card('fail-2');
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.fail/run', { card: 'fail-2' })).status, 403);
});

test('GET /api/checks: by phase, with the fix on a failure; a bad phase is 400', async () => {
  const boot = (await s.api('GET', '/api/checks?phase=boot')).body.checks;
  const fine = boot.find((c) => c.plugin === 'recorder' && c.id === 'fine');
  assert.deepStrictEqual([fine.ok, fine.message], [true, 'all fine']);
  const init = (await s.api('GET', '/api/checks?phase=init')).body.checks;
  const nope = init.find((c) => c.plugin === 'recorder' && c.id === 'nope');
  assert.deepStrictEqual([nope.ok, nope.severity, nope.fix], [false, 'warn', 'install nothing']);
  assert.ok(!init.some((c) => c.id === 'fine'), 'phase filters');
  assert.strictEqual((await s.api('GET', '/api/checks?phase=never')).status, 400);
});

test('/plugins/<id>/<file>: the ui module and its folder, never server.js or a way out', async () => {
  const ui = await fetch(s.base + '/plugins/recorder/ui.js');
  assert.strictEqual(ui.status, 200);
  assert.match(ui.headers.get('content-type'), /text\/javascript/);
  assert.strictEqual(ui.headers.get('cache-control'), 'no-store');
  assert.match(await ui.text(), /export function activate/);
  assert.strictEqual((await fetch(s.base + '/plugins/recorder/ui/extra.js')).status, 200);
  for (const bad of ['server.js', 'plugin.json', 'ui/%2e%2e/server.js', '%2e%2e%2f%2e%2e%2fboard.json', 'ui%2f..%2fserver.js', 'ui/nope.js']) {
    const r = await fetch(s.base + '/plugins/recorder/' + bad);
    assert.strictEqual(r.status, 404, bad);
    assert.doesNotMatch(await r.text(), /activate\(ctx\)/, bad);
  }
  assert.strictEqual((await fetch(s.base + '/plugins/nobody/ui.js')).status, 404);
});

test('/api/x/<plugin>/<subpath>: the plugin\'s own routes; 404 when none', async () => {
  const hello = await s.api('GET', '/api/x/recorder/hello');
  assert.strictEqual(hello.status, 200);
  assert.strictEqual(hello.body.hi, true);
  assert.strictEqual(typeof hello.body.cards, 'number');
  assert.deepStrictEqual((await s.api('POST', '/api/x/recorder/echo', { a: 1 })).body, { got: { a: 1 } });
  assert.strictEqual((await s.api('GET', '/api/x/recorder/echo')).status, 404);
  assert.strictEqual((await s.api('GET', '/api/x/nobody/hello')).status, 404);
});

test('events reach a boot plugin: created, moved (from/to), archived, activity-ended', async () => {
  await card('ev-1');
  await s.api('POST', '/api/cards/ev-1/move', { column: 'review' });
  await s.api('POST', '/api/cards/ev-1/archive', { reason: 'killed' });
  const ev = await until('the archive heard', async () => {
    const all = eventsOf(s).filter((e) => e.card === 'ev-1');
    return all.some((e) => e.event === 'card-archived') ? all : null;
  });
  assert.deepStrictEqual(ev.map((e) => e.event), ['card-created', 'card-moved', 'card-archived']);
  assert.deepStrictEqual([ev[1].from, ev[1].to], ['backlog', 'review']);
  assert.ok(eventsOf(s).some((e) => e.event === 'activity-ended' && e.status), 'activity-ended carries the run');
});

test('PUT /api/plugins/overlay: disable and re-enable, pluginsVersion bumps, bad shapes are 400', async () => {
  const v0 = (await s.api('GET', '/api/board')).body.pluginsVersion;
  const off = await s.api('PUT', '/api/plugins/overlay', { plugins: { recorder: { enabled: false } } });
  assert.strictEqual(off.status, 200, JSON.stringify(off.body));
  assert.strictEqual(off.body.restartNeeded, false);
  let cat = (await s.api('GET', '/api/plugins')).body;
  let rec = cat.plugins.find((p) => p.id === 'recorder');
  assert.deepStrictEqual([rec.enabled, rec.active, rec.ui], [false, false, undefined]);
  assert.ok(!cat.contributions.commands.some((c) => c.plugin === 'recorder'));
  assert.ok((await s.api('GET', '/api/board')).body.pluginsVersion > v0);
  assert.strictEqual((await s.api('POST', '/api/commands/recorder.link/run', { card: 'link-1' })).status, 404);
  assert.strictEqual((await fetch(s.base + '/plugins/recorder/ui.js')).status, 404);
  const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'plugins.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.plugins.recorder, { enabled: false });

  // a contribution toggle, and config, merge into the same entry
  await s.api('PUT', '/api/plugins/overlay', { contributions: { 'command:recorder.quick': { enabled: false } } });
  const on = await s.api('PUT', '/api/plugins/overlay', { plugins: { recorder: { enabled: true, config: { greeting: 'yo' } } } });
  assert.strictEqual(on.status, 200);
  cat = (await s.api('GET', '/api/plugins')).body;
  rec = cat.plugins.find((p) => p.id === 'recorder');
  assert.deepStrictEqual([rec.enabled, rec.config.greeting], [true, 'yo']);
  assert.deepStrictEqual(cat.disabled, ['command:recorder.quick']);
  assert.ok(!cat.contributions.commands.some((c) => c.id === 'recorder.quick'));
  await card('greet-9');
  const g = await s.api('POST', '/api/commands/recorder.greet/run', { card: 'greet-9', input: { name: 'Bo' } });
  assert.deepStrictEqual(g.body, { ok: true, message: 'yo Bo on greet-9' });
  // null removes
  await s.api('PUT', '/api/plugins/overlay', { contributions: { 'command:recorder.quick': null } });
  assert.deepStrictEqual((await s.api('GET', '/api/plugins')).body.disabled, []);

  for (const body of [[], { plugins: [] }, { plugins: { recorder: { enabled: 'yes' } } }, { nope: {} },
    { plugins: { 'Bad Id': {} } }, { contributions: { 'x:y': { rank: 'high' } } },
    { plugins: { recorder: { config: { unknown: 1 } } } }]) {
    assert.strictEqual((await s.api('PUT', '/api/plugins/overlay', body)).status, 400, JSON.stringify(body));
  }
});

test('worker events: a start is worker-started plus the move into Working; done is worker-done', async () => {
  const p = await startServerWithProject({ seed: seedPlugin });
  try {
    await until('recorder active', async () =>
      (await p.s.api('GET', '/api/plugins')).body.plugins.find((x) => x.id === 'recorder' && x.active));
    await p.s.api('POST', '/api/cards', withOwner({ title: 'Work', id: 'work-1', attributes: { repo: 'proj' } }));
    const st = await p.s.api('POST', '/api/cards/work-1/start', { harness: 'fake' });
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    await p.s.api('POST', '/api/cards/work-1/worker/done', { outcome: 'did it' });
    const ev = await until('worker-done heard', async () => {
      const all = eventsOf(p.s).filter((e) => e.card === 'work-1');
      return all.some((e) => e.event === 'worker-done') ? all : null;
    });
    assert.deepStrictEqual(ev.map((e) => e.event), ['card-created', 'card-moved', 'worker-started', 'worker-done']);
    assert.deepStrictEqual([ev[1].from, ev[1].to], ['backlog', 'working']);
    // a command's shell runs in the card's worktree by default
    const r = await p.s.api('POST', '/api/commands/recorder.echo/run', { card: 'work-1' });
    const end = await until('echo ended', async () => {
      const a = (await p.s.api('GET', '/api/activities?card=work-1')).body.activities.find((x) => x.id === r.body.activity.id);
      return a && a.status !== 'running' ? a : null;
    });
    assert.strictEqual(end.status, 'ok');
  } finally { await p.teardown(); }
});

// The PR watch is the github plugin's. With no such plugin the server keeps
// running it (prwatch.test.js); an overlay that disables github turns it off.
test('the PR watch: off when the overlay disables the github plugin, back when re-enabled', async () => {
  const os = require('node:os');
  const { startServer, seedBoard, sleep } = require('./helper');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-prw-off-'));
  const gh = path.join(root, 'gh-stub');
  fs.writeFileSync(gh, '#!/bin/sh\necho \'{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}\'\n');
  fs.chmodSync(gh, 0o755);
  const url = 'https://github.com/acme/p/pull/1';
  const p = await startServer({
    seed: (dir) => {
      seedBoard(dir, {
        lieutenants: [{ id: LT, name: 'Ada', color: '#58b6ff', prefix: 'ADA', cardSeq: 0, created: '2026-01-01T00:00:00Z' }],
        cards: [{ id: 'pr-1', title: 'PR', type: 'implementation', owner: LT, column: 'review', labels: [],
          attributes: { prs: [{ url, state: 'open' }] }, events: [], thread: [], body: '', playbook: 'default',
          created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }],
      });
      fs.writeFileSync(path.join(dir, '.bridge-commander', 'plugins.json'), JSON.stringify({ plugins: { github: { enabled: false } } }));
    },
    env: { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '100', BC_GH_CMD: gh },
  });
  try {
    await sleep(800);
    assert.strictEqual((await p.api('GET', '/api/cards/pr-1')).status, 200, 'no watch while github is disabled');
    await p.api('PUT', '/api/plugins/overlay', { plugins: { github: null } });
    await until('archived once the watch is back', async () => (await p.api('GET', '/api/cards/pr-1')).status === 404);
  } finally {
    await p.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an enabled profile toggled by the overlay says a restart is needed', async () => {
  const r = await s.api('PUT', '/api/plugins/overlay', { plugins: { deepseek: { enabled: true } } });
  assert.strictEqual(r.body.restartNeeded, true);
  const back = await s.api('PUT', '/api/plugins/overlay', { plugins: { deepseek: null } });
  assert.strictEqual(back.body.restartNeeded, false);
});
