'use strict';
// Card renderers in ui/js/util.js. util.js is browser ES-module code but touches
// no DOM at import time, so its renderers can be imported and asserted on
// directly (detail.js cannot — it binds DOM elements at import).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);

// cardStripHtml — the collapsed line atop an open card: PR state first, then the last event.

const CARD = {
  id: 'MNC-1',
  attributes: { prs: [{ url: 'https://github.com/o/r/pull/42', state: 'merged' }] },
  events: [
    { kind: 'start', text: 'worker started', ts: '2026-01-01T00:00:00Z' },
    { kind: 'done', text: 'the last thing that happened', ts: '2026-01-01T01:00:00Z' },
  ],
};
const emojiFor = (k) => (k === 'done' ? '🏁' : '');

test('the line leads with the PR state, then the last event', async () => {
  const { cardStripHtml } = await utilMod;
  const html = cardStripHtml(CARD, emojiFor);
  assert.ok(html.indexOf('prchip') < html.indexOf('dt-strip-ev'), 'PR comes first');
  assert.match(html, /pr-merged/);
  assert.match(html, /#42 · merged/);
  assert.ok(html.includes('🏁 the last thing that happened'), 'the LAST event, with its kind emoji');
  assert.ok(!html.includes('worker started'), 'only the last one');
});

test('no PR and no events still render a clickable row', async () => {
  const { cardStripHtml } = await utilMod;
  const html = cardStripHtml({ id: 'MNC-2' }, emojiFor);
  assert.match(html, /dt-strip-chev/);
  assert.match(html, /no events yet/);
  assert.ok(!html.includes('prchip'));
});

test('event text is escaped', async () => {
  const { cardStripHtml } = await utilMod;
  const html = cardStripHtml({ events: [{ kind: 'x', text: '<img src=x>' }] }, emojiFor);
  assert.ok(!html.includes('<img'), 'no raw html from an event');
});

// artifactsHtml — a table in a scroll wrapper, so labels align and long filenames stay whole.

const ARTS = [
  { uri: 'file:///w/validated-pr-pipeline-design.md', label: 'design' },
  { uri: '/w/pipeline-journal-sample.jsonl', label: 'journal' },
  { uri: 'https://github.com/tonylampada/bridge-commander/pull/32', label: 'pr' },
  { uri: '/w/a-really-quite-long-artifact-filename.png' },
  { uri: '/w/notes.md', label: 'notes' },
];

test('artifacts render as a table with one row per artifact', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  assert.match(html, /<table[ >]/, 'artifacts are a table');
  const rows = html.match(/<tr>/g) || [];
  assert.strictEqual(rows.length, ARTS.length, 'one row per artifact');
  // two aligned columns per row: label cell, then the filename cell
  assert.strictEqual((html.match(/<td class="a-label">/g) || []).length, ARTS.length);
  assert.strictEqual((html.match(/class="a-uri"/g) || []).length, ARTS.length);
  // no label falls back to the basename
  assert.ok(html.includes('<td class="a-label">a-really-quite-long-artifact-filename.png</td>'));
});

test('the table sits in a scroll container', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  const m = html.match(/<div class="([\w-]*arts-scroll[\w-]*)">\s*<table/);
  assert.ok(m, 'the table is wrapped in a scroll container: ' + html.slice(0, 200));
});

test('behaviour kept: http links open in a new tab, everything else opens the viewer', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  assert.match(html, /<a class="a-uri" href="https:\/\/github\.com[^"]*" target="_blank" rel="noopener"/);
  assert.match(html, /<code class="a-uri" data-view="\/w\/notes\.md"/);
  assert.strictEqual(artifactsHtml([]), '', 'no artifacts renders nothing');
  assert.match(html, /<div class="dt-arts-head">artifacts<\/div>/, 'the head is kept');
});

test('escaping is kept', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml([{ uri: '/w/<img src=x>.md', label: '"><script>' }]);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;img src=x&gt;\.md/);
});

// cardNumHtml — the tile shows the number ALONE; the owner's color already says whose card it is.

test('the tile carries the number and not the prefix', async () => {
  const { cardNumHtml } = await utilMod;
  const html = cardNumHtml('MNC-62');
  assert.match(html, /62/, 'the number is on the tile');
  assert.ok(!html.includes('MNC-'), 'the prefix is not');
  assert.strictEqual(cardNumHtml('MNC-62'), '<span class="t-num">62</span>');
});

test('an id with no trailing number gets no element at all', async () => {
  const { cardNumHtml } = await utilMod;
  // archived cards really are shaped like this — a guess would be worse than nothing
  for (const id of ['pipeline-test-b6', 'bc-unblock-server', 'MNC', '', undefined]) {
    assert.strictEqual(cardNumHtml(id), '', String(id) + ': no number element, not an empty one');
  }
});

// playbookAttrHtml — only Backlog offers the picker: a started card's brief is already rendered.

const cardIn = (column, playbook) =>
  ({ id: 'MNC-1', type: 'implementation', column, playbook });

test('a Backlog card shows the playbook and offers the picker', async () => {
  const { playbookAttrHtml } = await utilMod;
  const html = playbookAttrHtml(cardIn('backlog', 'default'), true);
  // never "brief": that is the rendered text the worker receives, not its template
  assert.match(html, /<span class="k">playbook<\/span>/, 'the chip is labelled playbook');
  assert.match(html, /<span class="v">default<\/span>/, 'it shows the card\'s playbook');
  assert.match(html, /<button type="button" class="owner-edit"/, 'the ✎ opens the picker');
});

test('a card outside Backlog shows the playbook and no editor', async () => {
  const { playbookAttrHtml } = await utilMod;
  for (const column of ['working', 'review', 'peer']) {
    const html = playbookAttrHtml(cardIn(column, 'default'), false);
    assert.match(html, /<span class="v">default<\/span>/, column + ': the playbook is still shown');
    assert.doesNotMatch(html, /<button/, column + ': no editor is offered');
  }
});

test('no playbook reads as a card that cannot start, editable or not', async () => {
  const { playbookAttrHtml } = await utilMod;
  for (const editable of [true, false]) {
    const html = playbookAttrHtml(cardIn(editable ? 'backlog' : 'working', ''), editable);
    assert.match(html, /class="attr attr-playbook none"/, 'the chip carries the none state');
    assert.match(html, /none — cannot start/);
  }
  // a plan card never starts, so it has no playbook to show at all
  assert.strictEqual(playbookAttrHtml({ id: 'MNC-2', type: 'plan', column: 'backlog', playbook: '' }, true), '');
});

// runsOn — the header/switcher model line. The pin wins (it is what the next
// launch runs); a live status from an older or failing turn is named, not shown
// as the truth (the captain read "gpt-6-astra" while codex ran on another model).
test('runsOn: the pin wins over the live status, and a mismatch is named as the last turn', async () => {
  const { runsOn, lastTurnHtml } = await utilMod;
  const live = { model: 'gpt-6-astra', effort: 'high' };
  assert.deepStrictEqual(runsOn({ agentStatus: live }), { model: 'gpt-6-astra', effort: 'high', last: '' });
  assert.deepStrictEqual(runsOn({ model: 'gpt-6-astra', effort: 'high', agentStatus: live }),
    { model: 'gpt-6-astra', effort: 'high', last: '' }, 'agreement is no hint');
  assert.deepStrictEqual(runsOn({ model: 'gpt-6-terra', agentStatus: live }),
    { model: 'gpt-6-terra', effort: 'high', last: 'gpt-6-astra (high)' });
  assert.deepStrictEqual(runsOn({ effort: 'low', agentStatus: live }),
    { model: 'gpt-6-astra', effort: 'low', last: 'gpt-6-astra (high)' });
  assert.deepStrictEqual(runsOn({ model: 'm', effort: 'low' }), { model: 'm', effort: 'low', last: '' },
    'no live status yet: the pin alone');
  assert.strictEqual(lastTurnHtml('x', ''), '');
  assert.match(lastTurnHtml('x', 'a <b>'), /class="x".*>last turn: a &lt;b&gt;</);
  assert.match(lastTurnHtml('x', 'gpt-6-astra', true), /title="last turn: gpt-6-astra[^"]*">⚠</);
});
