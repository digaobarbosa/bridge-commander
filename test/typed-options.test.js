'use strict';
// model and effort are TYPED options: the server hands them to the harness,
// which spells its own flags. One the harness does not honor is dropped with a
// note on the card timeline, and the start goes ahead — options are
// best-effort, verbs still throw. Observed on the fake, whose honored options
// BC_FAKE_OPTIONS narrows, through the marker file spawn writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { withOwner } = require('./helper');
const { workerKey, boot } = require('./workers-helper');

test('an option the harness does not honor lands a card warning and never reaches the spawn', async () => {
  const { s, fdir, teardown } = await boot({ BC_FAKE_OPTIONS: 'model' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Typed', id: 'typed', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/typed/start', { harness: 'fake', model: 'm-1', effort: 'high' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const marker = JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, 'typed') + '.json'), 'utf8'));
    assert.strictEqual(marker.model, 'm-1', 'the honored option reached the harness');
    assert.ok(!('effort' in marker), 'the dropped one did not');
    const card = (await s.api('GET', '/api/board')).body.cards.find((c) => c.id === 'typed');
    const warn = card.events.find((e) => e.kind === 'option-ignored');
    assert.ok(warn, JSON.stringify(card.events));
    assert.strictEqual(warn.text, 'fake does not support effort; started without it');
    assert.strictEqual(card.column, 'working', 'the start went ahead');
  } finally { await teardown(); }
});

test('with every option honored there is no warning, and both reach the spawn', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Both', id: 'both', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/both/start', { harness: 'fake', model: 'm-2', effort: 'low' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const marker = JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, 'both') + '.json'), 'utf8'));
    assert.strictEqual(marker.model, 'm-2');
    assert.strictEqual(marker.effort, 'low');
    const card = (await s.api('GET', '/api/board')).body.cards.find((c) => c.id === 'both');
    assert.ok(!card.events.some((e) => e.kind === 'option-ignored'));
  } finally { await teardown(); }
});
