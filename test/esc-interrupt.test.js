'use strict';
// ui/js/interrupt.js — when the composer's ⏹ shows, and when Esc means "stop
// the agent" instead of its old meaning. ESM (it ships to the browser), hence
// the dynamic import.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let interruptTarget, escInterrupts;
test.before(async () => {
  ({ interruptTarget, escInterrupts } = await import(
    pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'interrupt.js')).href));
});

function doc({ ltBusy = true, ltCan = true, wBusy = true, wCan = true, column = 'working' } = {}) {
  return {
    lieutenants: [{ id: 'ada', busy: ltBusy, canInterrupt: ltCan }],
    cards: [{ id: 'C-1', owner: 'ada', column }],
    workers: [{ card: 'C-1', busy: wBusy, canInterrupt: wCan }],
  };
}

test('a lieutenant chat stops the lieutenant, only while it is busy and its harness can', () => {
  assert.deepStrictEqual(interruptTarget('lieutenant:ada', doc()), { kind: 'lieutenants', id: 'ada' });
  assert.strictEqual(interruptTarget('lieutenant:ada', doc({ ltBusy: false })), null);
  assert.strictEqual(interruptTarget('lieutenant:ada', doc({ ltCan: false })), null);
  assert.strictEqual(interruptTarget('lieutenant:nobody', doc()), null);
});

test('a card thread stops the card\'s WORKER, not the busy lieutenant the thread talks to', () => {
  assert.deepStrictEqual(interruptTarget('card:C-1', doc()), { kind: 'cards', id: 'C-1' });
  assert.strictEqual(interruptTarget('card:C-1', doc({ wBusy: false })), null, 'a busy lieutenant does not count');
  assert.strictEqual(interruptTarget('card:C-1', doc({ wCan: false })), null);
  assert.strictEqual(interruptTarget('card:C-1', doc({ column: 'review' })), null, 'only a Working card has a live worker');
  assert.strictEqual(interruptTarget('card:none', doc()), null);
  assert.strictEqual(interruptTarget(null, doc()), null);
});

test('Esc stops the agent from an EMPTY composer with no menu open', () => {
  const base = { value: '', attachments: 0, menuOpen: false, target: 'lieutenant:ada', doc: doc() };
  assert.deepStrictEqual(escInterrupts(base), { kind: 'lieutenants', id: 'ada' });
  assert.deepStrictEqual(escInterrupts({ ...base, value: '  \n' }), { kind: 'lieutenants', id: 'ada' }, 'whitespace is empty');
});

test('Esc keeps its old meaning with text, a staged file, a menu open, or an idle agent', () => {
  const base = { value: '', attachments: 0, menuOpen: false, target: 'lieutenant:ada', doc: doc() };
  assert.strictEqual(escInterrupts({ ...base, value: 'half a thought' }), null);
  assert.strictEqual(escInterrupts({ ...base, value: '/sta' }), null, 'the slash menu owns Esc');
  assert.strictEqual(escInterrupts({ ...base, attachments: 1 }), null);
  assert.strictEqual(escInterrupts({ ...base, menuOpen: true }), null);
  assert.strictEqual(escInterrupts({ ...base, doc: doc({ ltBusy: false }) }), null);
});
