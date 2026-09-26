'use strict';
// The config screen's lists and the ⚡ screen's two columns: what each card
// says, which buttons it has, the order red comes in, and the read-and-paint
// cycle they all share. Views (panelviews.js) are plain data; the one painter
// (listpanel.js) runs against the small fake DOM in fake-dom.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom } = require('./fake-dom.js');

const { el } = installDom();
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);
const views = load('panelviews.js');
const panel = load('listpanel.js');
const util = load('util.js');

const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (deltaSec) => new Date(Date.now() + deltaSec * 1000).toISOString();
const facts = (v) => v.facts.map((f) => f.cap + ': ' + (f.bits ? f.bits.map((b) => b.label).join(' ') : f.text));
const labels = (xs) => xs.map((a) => a.label);

test('a run ends in one of six words, the ones bc-axi prints', async () => {
  const { runOutcome } = await util;
  assert.strictEqual(runOutcome({ code: 0 }), 'exit 0');
  assert.strictEqual(runOutcome({ code: 3 }), 'exit 3');
  assert.strictEqual(runOutcome({ timedOut: true }), 'timed out');
  assert.strictEqual(runOutcome({ error: 'ENOENT' }), 'failed to start');
  assert.strictEqual(runOutcome({ canceled: true, code: null }), 'restarted mid-run');
  assert.strictEqual(runOutcome({ code: null }), 'killed');
  assert.strictEqual(runOutcome({ skipped: true }), 'skipped');
});

// ---------- hooks ----------

test('a hook card says what fires it and how its last run ended', async () => {
  const { hookView } = await views;
  const named = hookView({ name: 'digest', file: '/h/digest', last: { started: iso(-240), code: 0, ok: true } },
    { firedBy: ['nightly', 'hourly'] });
  assert.deepStrictEqual(facts(named), ['fired by: ⚡ nightly ⚡ hourly', 'last run: ran 4m ago · exit 0']);
  assert.deepStrictEqual(named.facts[0].bits.map((b) => [b.key, b.arg]), [['schedule', 'nightly'], ['schedule', 'hourly']],
    'each schedule name is a way to that schedule');
  assert.deepStrictEqual(facts(hookView({ name: 'gh', file: 'f', last: null })),
    ['fired by: nothing — ▶ only', 'last run: never ran']);
  assert.deepStrictEqual(facts(hookView({ name: 'x', file: 'f', event: 'worker-done', last: { started: iso(-5), error: 'E' } })),
    ['fired by: worker-done', 'last run: ran just now · failed to start'], 'never "now ago"');
});

test('▶ is live on a named hook, disabled WITH a reason on a lifecycle one, and "…" while pressed', async () => {
  const { hookView } = await views;
  const named = hookView({ name: 'gh', file: '/h/gh' });
  assert.deepStrictEqual(labels(named.actions), ['▶', '✎']);
  assert.ok(!named.actions[0].disabled);
  const life = hookView({ name: 'sweep', file: 'f', event: 'worker-done' }).actions[0];
  assert.ok(life.disabled);
  assert.match(life.title, /worker-done fires this one/, 'a refusal is visible');
  const pressed = hookView({ name: 'gh', file: 'f', last: { ok: true, started: iso(-60) } }, { busy: true });
  assert.strictEqual(pressed.actions[0].label, '…');
  assert.ok(pressed.actions[0].disabled, 'a second press the server would refuse never looks live');
  assert.strictEqual(pressed.facts[1].text, 'running now');
  assert.strictEqual(hookView({ name: 'gh', file: 'f', running: { hook: 'gh' } }).facts[1].text, 'running now',
    'a run started from the CLI reads as running here too');
});

test('failed hooks come first; the rest keep the server\'s order', async () => {
  const { hookRank, hookCountText } = await views;
  const { rankSort } = await panel;
  const hooks = [{ name: 'a' }, { name: 'b', last: { ok: false } }, { name: 'c', last: { ok: true } }, { name: 'd', last: { ok: false } }];
  assert.deepStrictEqual(rankSort(hooks, hookRank).map((h) => h.name), ['b', 'd', 'a', 'c']);
  assert.strictEqual(hookCountText(hooks), '4 total · 2 failing');
});

// ---------- schedules ----------

test('a schedule card: four captioned facts in the CLI\'s words', async () => {
  const { scheduleView } = await views;
  const v = scheduleView({ name: 'gh-watch', hook: 'gh-watch', describe: 'every 5m', next: iso(180), owner: 'tony',
    last: { started: iso(-120), code: 0, ok: true } });
  assert.deepStrictEqual(facts(v), ['when: every 5m', 'next fire: in 3m', 'last fire: fired 2m ago · exit 0', 'owner: tony']);
  assert.deepStrictEqual(labels(v.chips), ['→ gh-watch'], 'the hook it fires, as a way there');
  assert.deepStrictEqual(labels(v.actions), ['‖', '✕']);
});

test('paused and broken schedules say no fire is coming, rather than a plausible one', async () => {
  const { scheduleView, nextText } = await views;
  const paused = scheduleView({ name: 'p', hook: 'h', next: iso(180), paused: true });
  assert.ok(labels(paused.chips).includes('PAUSED'), 'paused is a chip, not a shade');
  assert.strictEqual(paused.actions[0].label, '▶', 'and its button resumes');
  assert.strictEqual(nextText({ next: iso(180), paused: true }), 'paused');
  const broken = scheduleView({ name: 'b', hook: 'doomed', next: iso(180), problem: 'hook "doomed" is gone — nothing fires' });
  assert.strictEqual(broken.facts[1].text, 'fires nothing');
  assert.strictEqual(broken.problem, 'hook "doomed" is gone — nothing fires', 'the whole sentence, never cut');
});

test('relative times: a next fire is "in", a past one is "ago" and never "now"', async () => {
  const { until, since, fireOutcome } = await views;
  assert.strictEqual(until(new Date(NOW + 180e3).toISOString(), NOW), 'in 3m');
  assert.strictEqual(until(new Date(NOW + 7200e3).toISOString(), NOW), 'in 2h');
  assert.strictEqual(until(new Date(NOW - 5e3).toISOString(), NOW), 'due now');
  assert.strictEqual(until(null, NOW), 'never');
  assert.strictEqual(since(new Date(NOW - 5e3).toISOString(), NOW), '5s ago');
  assert.strictEqual(fireOutcome(null), 'never fired');
  assert.strictEqual(fireOutcome({ started: iso(-120), skipped: true }), 'skipped 2m ago (previous firing still going)',
    'a skip is a firing too');
});

test('red schedules first, paused next, working last — and the masthead names both halves', async () => {
  const { scheduleRank, scheduleCountText, scheduleBad, hookBad, mastheadText } = await views;
  const { rankSort, tally } = await panel;
  const list = [
    { name: 'ok1', last: { ok: true } },
    { name: 'off', paused: true },
    { name: 'skip', last: { skipped: true } },
    { name: 'gone', problem: 'hook missing' },
    { name: 'red', last: { ok: false } },
  ];
  assert.deepStrictEqual(rankSort(list, scheduleRank).map((s) => s.name), ['gone', 'red', 'off', 'ok1', 'skip'],
    'a skip is the overlap policy working, not red');
  assert.strictEqual(scheduleCountText(list), '5 total · 2 failing · 1 paused');
  const m = mastheadText(tally(list, scheduleBad), tally([{ last: { ok: false } }], hookBad));
  assert.deepStrictEqual(m, { counts: '5 schedules · 1 hook', alarm: '2 schedules failing · 1 hook failing' });
  assert.strictEqual(mastheadText({ total: 1, bad: 0 }, { total: 0, bad: 0 }).alarm, '', 'silent when nothing is red');
});

// ---------- config screen ----------

test('a project says its cards, its path and its git facts — or that the clone is gone', async () => {
  const { projectView } = await views;
  const p = projectView({ name: 'web', path: '/src/web', cards: 1, remote: 'git@x:web', branch: 'main' });
  assert.deepStrictEqual(labels(p.chips), ['1 card']);
  assert.strictEqual(p.note, '/src/web');
  assert.deepStrictEqual(facts(p), ['remote: git@x:web', 'branch: main']);
  assert.deepStrictEqual(facts(projectView({ name: 'old', path: '/gone', cards: 0, missing: true })), ['path: ⚠ not on disk']);
  assert.deepStrictEqual(facts(projectView({ name: 'bare', path: '/b', cards: 3 })), ['remote: none', 'branch: unknown']);
});

test('a lieutenant row: next id, card count and session in one run, settings and charter — no retire', async () => {
  const { lieutenantView } = await views;
  const v = lieutenantView({ id: 'wal', name: 'Wall-E', next: 'WAL-4', cards: 14, session: 'dead', memory: '/lt/wal/README.md' });
  assert.strictEqual(v.facts + v.session.text, 'WAL-4 · 14 cards · dead');
  assert.deepStrictEqual(labels(v.actions), ['⚙', '✎'], 'retiring stays in the switcher ⋯ menu');
  assert.match(v.actions[1].title, /README\.md/);
  assert.strictEqual(lieutenantView({ id: 'x', next: 'X-1', cards: 1 }).facts + lieutenantView({ id: 'x' }).session.text,
    'X-1 · 1 card · no session');
});

// ---------- the painter ----------

test('a painted schedule card reads as its view, and the hook pill does not toggle the card', async () => {
  const { scheduleView } = await views;
  const { paintCards } = await panel;
  const list = el();
  const pressed = [];
  const v = scheduleView({ name: 'nightly', hook: 'digest', describe: 'at 03:00', owner: 'tony', next: iso(3600),
    problem: 'bad schedule expression' }, { focus: 'nightly' });
  assert.strictEqual(paintCards(list, [v], (b, view) => pressed.push(b.key + ':' + view.name), 'none'), true,
    'the card the hooks column sent us to is found…');
  const card = list.children[0];
  assert.ok(card.scrolled, '…and scrolled into view');
  assert.strictEqual(card.textContent,
    '▸nightly→ digest‖✕whenat 03:00next firefires nothinglast firenever firedownertony⚠ bad schedule expression');
  card.buttons().find((b) => b.textContent === '→ digest').click();
  assert.deepStrictEqual(pressed, ['hook:nightly'], 'the pill jumps to the hook; the card stays shut');
  card.children[0].click();
  assert.deepStrictEqual(pressed, ['hook:nightly', 'toggle:nightly'], 'the head row opens the firings');
  paintCards(list, [], () => {}, 'no schedules — the board keeps no clock yet');
  assert.strictEqual(list.textContent, 'no schedules — the board keeps no clock yet');
});

// ---------- the read-and-paint cycle ----------

function fakeServer() {
  const s = { reads: 0, paints: 0, failures: [], release: [], fail: false };
  s.load = () => new Promise((resolve, reject) => {
    s.reads++;
    s.release.push(() => (s.fail ? reject(new Error('down')) : resolve()));
  });
  s.paint = () => { s.paints++; };
  s.onFail = (e, had) => s.failures.push(e.message + (had ? ' (list kept)' : ' (no list yet)'));
  s.answer = async () => { while (s.release.length) { s.release.shift()(); await new Promise((r) => setTimeout(r, 0)); } };
  return s;
}

test('a config tab reads on the way in and repaints what it has on every board event', async () => {
  const { listSection } = await panel;
  const srv = fakeServer();
  const render = listSection({ load: srv.load, paint: srv.paint, fail: srv.onFail });
  const entering = render(true);
  render(); // a board event while the read is in flight: that read answers it
  await srv.answer();
  await entering;
  assert.deepStrictEqual([srv.reads, srv.paints], [1, 1]);
  await render();
  await render();
  assert.deepStrictEqual([srv.reads, srv.paints], [1, 3], 'board events cost no read');
  const again = render(true);
  await srv.answer();
  await again;
  assert.strictEqual(srv.reads, 2, 'entering the tab again reads afresh');
});

test('the ⚡ columns read on every render, and one that lands mid-read makes it go round once more', async () => {
  const { listSection } = await panel;
  const srv = fakeServer();
  const render = listSection({ live: true, load: srv.load, paint: srv.paint, fail: srv.onFail });
  const first = render(true);
  render();
  render(); // two asks during one read: one more read covers both
  await srv.answer();
  await first;
  assert.deepStrictEqual([srv.reads, srv.paints], [2, 1], 'the answer painted is the fresher one');
  const next = render();
  await srv.answer();
  await next;
  assert.strictEqual(srv.reads, 3, 'a board event is a read here — it is the only nudge');
  srv.fail = true;
  const failed = render();
  await srv.answer();
  await failed;
  assert.deepStrictEqual(srv.failures, ['down (list kept)'], 'a failed re-read does not blank a list still true on screen');
});
