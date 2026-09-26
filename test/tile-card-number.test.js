'use strict';
// The card number is back on the kanban tile — the number ALONE, never the
// prefix, because the owner's color already says whose card it is. util.js is
// browser ES-module code that touches no DOM at import, so the renderer runs
// directly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const utilMod = import(pathToFileURL(ui('js', 'util.js')).href);

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
