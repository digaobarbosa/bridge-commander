'use strict';
// ui/js/when.js (JSON predicates) and ui/js/fields.js (form/config fields):
// pure modules the board and the server both load, so they answer alike.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const ctx = {
  card: { id: 'MON-1', column: 'working', labels: ['ui', 'bug'], attributes: { prs: [{ url: 'https://x/pr/1' }], branch: 'b1', empty: [] } },
  project: { name: 'roboflow' },
  worker: { state: 'working' },
  harness: 'claude',
};

test('getPath walks dots and indices, undefined past a gap', async () => {
  const { getPath } = await load('when.js');
  assert.strictEqual(getPath(ctx, 'card.attributes.prs[0].url'), 'https://x/pr/1');
  assert.strictEqual(getPath(ctx, 'card.attributes.prs[3].url'), undefined);
  assert.strictEqual(getPath(ctx, 'nope.deeper'), undefined);
});

test('field tests: equality, list membership, operators', async () => {
  const { matches } = await load('when.js');
  assert.ok(matches({ 'card.column': 'working' }, ctx));
  assert.ok(matches({ 'card.labels': 'bug' }, ctx), 'a list field contains the value');
  assert.ok(!matches({ 'card.column': 'review' }, ctx));
  assert.ok(matches({ 'card.attributes.branch': { $exists: true } }, ctx));
  assert.ok(matches({ 'card.attributes.empty': { $exists: false } }, ctx), 'an empty list carries nothing');
  assert.ok(matches({ 'card.column': { $in: ['working', 'review'] } }, ctx));
  assert.ok(matches({ 'card.column': { $nin: ['backlog'] } }, ctx));
  assert.ok(matches({ 'card.id': { $regex: '^MON-' } }, ctx));
  assert.ok(matches({ 'card.labels': { $contains: 'ui' } }, ctx));
  assert.ok(matches({ harness: { $ne: 'codex' } }, ctx));
});

test('combinators compose: $all, $any, $not; keys of one object are anded', async () => {
  const { matches } = await load('when.js');
  assert.ok(matches({ $any: [{ 'card.column': 'backlog' }, { 'worker.state': 'working' }] }, ctx));
  assert.ok(!matches({ $all: [{ 'card.column': 'working' }, { harness: 'codex' }] }, ctx));
  assert.ok(matches({ $not: { harness: 'codex' } }, ctx));
  assert.ok(!matches({ 'card.column': 'working', harness: 'codex' }, ctx));
  assert.ok(matches(undefined, ctx), 'no predicate = always');
});

test('a typo fails at compile time, not silently per render', async () => {
  const { compileWhen } = await load('when.js');
  assert.throws(() => compileWhen({ 'card.column': { $inn: ['x'] } }), /unknown operator "\$inn"/);
  assert.throws(() => compileWhen({ $or: [] }), /unknown combinator/);
  assert.throws(() => compileWhen({ 'a': { $in: 'x' } }), /needs a list/);
  assert.throws(() => compileWhen('card.column == x'), /must be an object/);
});

test('fields: defaults, coercion, enums, required, one-line strings', async () => {
  const { validateValues, defaultsFor } = await load('fields.js');
  const fields = {
    env: { enum: ['staging', 'prod'], default: 'staging' },
    count: { type: 'number' },
    dry: { type: 'boolean', default: false },
    slot: { type: 'string', required: true, title: 'Slot' },
    notes: { type: 'text' },
  };
  assert.deepStrictEqual(defaultsFor(fields, { slot: 'a', stray: 1 }), { env: 'staging', dry: false, slot: 'a' });
  assert.deepStrictEqual(validateValues(fields, { slot: 's1', count: '3', dry: 'on', stray: 'x' }).values,
    { env: 'staging', count: 3, dry: true, slot: 's1' });
  assert.deepStrictEqual(validateValues(fields, {}), { error: 'Slot is required', field: 'slot' });
  assert.match(validateValues(fields, { slot: 'a', env: 'dev' }).error, /must be one of staging, prod/);
  assert.match(validateValues(fields, { slot: 'a', count: 'x' }).error, /must be a number/);
  assert.match(validateValues(fields, { slot: 'a\nb' }).error, /one line/);
  assert.strictEqual(validateValues(fields, { slot: 'a', notes: 'l1\nl2' }).values.notes, 'l1\nl2');
});
