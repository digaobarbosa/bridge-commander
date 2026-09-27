'use strict';
// ui/js/slots.js — the registry the shell's slots read: contribute, filter by
// `when` and by the disabled keys, order by rank then key, cap per plugin, and
// the error boundary that keeps a failing plugin inside its own slot.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'slots.js')).href);
const keys = (list) => list.map((e) => e.key);

test('entries come back by rank, then key; rank defaults to 1000', async () => {
  const s = await load;
  s.resetSlots();
  s.contribute('card.menu/v1', { key: 'b' });
  s.contribute('card.menu/v1', { key: 'a' });
  s.contribute('card.menu/v1', { key: 'z', rank: 10 });
  assert.deepStrictEqual(keys(s.entries('card.menu/v1')), ['z', 'a', 'b']);
  assert.strictEqual(s.entries('card.menu/v1')[1].rank, 1000);
  assert.deepStrictEqual(s.entries('nothing/v1'), []);
});

test('the payload rides along, and the entry is frozen', async () => {
  const s = await load;
  s.resetSlots();
  s.contribute('card.menu/v1', { key: 'k', plugin: 'p', command: 'deploy.run', title: 'Deploy' });
  const [e] = s.entries('card.menu/v1');
  assert.strictEqual(e.command, 'deploy.run');
  assert.ok(Object.isFrozen(e));
});

test('dispose removes the entry; a replaced entry\'s disposer does nothing', async () => {
  const s = await load;
  s.resetSlots();
  const d1 = s.contribute('x/v1', { key: 'k', title: 'one' });
  s.contribute('x/v1', { key: 'k', title: 'two' });
  d1();
  assert.deepStrictEqual(s.entries('x/v1').map((e) => e.title), ['two'], 'the reload\'s entry survives the old disposer');
  const d3 = s.contribute('x/v1', { key: 'j' });
  d3();
  d3();
  assert.deepStrictEqual(keys(s.entries('x/v1')), ['k']);
});

test('an entry needs a key', async () => {
  const s = await load;
  assert.throws(() => s.contribute('x/v1', { title: 'no key' }), /key/);
});

test('when is asked of the context; no context means no card to ask about', async () => {
  const s = await load;
  s.resetSlots();
  s.contribute('card.menu/v1', { key: 'wk', when: { 'card.column': 'working' } });
  s.contribute('card.menu/v1', { key: 'all' });
  s.contribute('card.menu/v1', { key: 'bad', when: { 'card.column': { $nope: 1 } } });
  const ctx = { card: { column: 'backlog' } };
  assert.deepStrictEqual(keys(s.entries('card.menu/v1', ctx)), ['all'], 'a malformed predicate hides only its own entry');
  assert.deepStrictEqual(keys(s.entries('card.menu/v1', { card: { column: 'working' } })), ['all', 'wk']);
  assert.deepStrictEqual(keys(s.entries('card.menu/v1')), ['all', 'bad', 'wk']);
});

test('disabled keys drop out until they are enabled again', async () => {
  const s = await load;
  s.resetSlots();
  s.contribute('v/v1', { key: 'a' });
  s.contribute('v/v1', { key: 'b' });
  s.setDisabled(['a']);
  assert.deepStrictEqual(keys(s.entries('v/v1')), ['b']);
  s.setDisabled([]);
  assert.deepStrictEqual(keys(s.entries('v/v1')), ['a', 'b']);
});

test('a plugin keeps at most 8 entries per slot — its best-ranked ones; the shell is not capped', async () => {
  const s = await load;
  s.resetSlots();
  for (let i = 0; i < 12; i++) s.contribute('m/v1', { key: 'p' + String(i).padStart(2, '0'), plugin: 'noisy', rank: 100 - i });
  for (let i = 0; i < 10; i++) s.contribute('m/v1', { key: 'core' + i });
  const list = s.entries('m/v1');
  const noisy = list.filter((e) => e.plugin === 'noisy');
  assert.strictEqual(noisy.length, 8);
  assert.deepStrictEqual(noisy.map((e) => e.rank), [89, 90, 91, 92, 93, 94, 95, 96], 'the lowest ranks win');
  assert.strictEqual(list.filter((e) => !e.plugin).length, 10);
  assert.strictEqual(s.entries('m/v1', undefined, { limitPerPlugin: 2 }).filter((e) => e.plugin).length, 2);
});

test('onChange fires on contribute, dispose and setDisabled, until disposed', async () => {
  const s = await load;
  s.resetSlots();
  let n = 0;
  const off = s.onChange(() => n++);
  const d = s.contribute('c/v1', { key: 'a' });
  s.setDisabled(['a']);
  d();
  assert.strictEqual(n, 3);
  off();
  s.contribute('c/v1', { key: 'b' });
  assert.strictEqual(n, 3);
});

test('boundary: the value, or the error tagged with its plugin', async () => {
  const s = await load;
  const e = { key: 'badge:x', plugin: 'gh' };
  assert.strictEqual(s.boundary(e, () => 42), 42);
  assert.deepStrictEqual(s.boundary(e, () => { throw new Error('boom'); }), { error: 'boom', plugin: 'gh', key: 'badge:x' });
  assert.deepStrictEqual(await s.boundary(e, async () => { throw new Error('late'); }), { error: 'late', plugin: 'gh', key: 'badge:x' });
  assert.strictEqual(await s.boundary(e, async () => 'ok'), 'ok');
});

test('badgeHtml escapes, whitelists the tone, and draws nothing for no text', async () => {
  const s = await load;
  assert.strictEqual(s.badgeHtml({ text: 'CI ✓', tone: 'ok', tooltip: 'all green' }),
    '<span class="bc-badge bc-badge-ok" title="all green">CI ✓</span>');
  const evil = s.badgeHtml({ text: '<img>', tone: '"><x', tooltip: '"onmouseover=' });
  assert.ok(!evil.includes('<img>') && !evil.includes('"><x') && !evil.includes('"onmouseover'));
  assert.match(evil, /bc-badge-info/, 'an unknown tone falls back to info');
  assert.strictEqual(s.badgeHtml({ text: '' }), '');
  assert.strictEqual(s.badgeHtml(null), '');
});

test('failedHtml names the plugin and carries the error as a tooltip', async () => {
  const s = await load;
  assert.strictEqual(s.failedHtml({ key: 'k', plugin: 'gh' }, { error: 'boom' }),
    '<span class="bc-failed" title="boom">⚠ plugin gh failed</span>');
  assert.match(s.failedHtml({ key: 'view:<x>' }, new Error('e')), /⚠ plugin view:&lt;x&gt; failed/);
});
