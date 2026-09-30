'use strict';
// ui/js/modes.js — which board-region modes exist and which this browser
// remembers. The four switcher modes stick across a reload; the file and config
// screens never do, and leaving one lands on the remembered switcher mode.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modes = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'modes.js')).href);

test('the switcher is kanban, table, archived and ⚡ — in that order', async () => {
  const { MODE_BTN } = await modes;
  assert.deepStrictEqual(Object.keys(MODE_BTN), ['board', 'table', 'archive', 'auto']);
});

test('a screen is a real mode; anything unknown is the kanban', async () => {
  const { boardModeFor } = await modes;
  for (const m of ['board', 'table', 'archive', 'auto', 'file', 'settings']) assert.strictEqual(boardModeFor(m), m);
  for (const m of ['nonsense', '', null, undefined]) assert.strictEqual(boardModeFor(m), 'board', String(m));
});

test('leaving a screen (or reloading) goes back to a switcher mode, never to a screen', async () => {
  const { switcherModeFor } = await modes;
  for (const m of ['board', 'table', 'archive', 'auto']) assert.strictEqual(switcherModeFor(m), m, m + ' is remembered');
  for (const m of ['settings', 'file', 'nonsense', null]) assert.strictEqual(switcherModeFor(m), 'board', String(m));
});
