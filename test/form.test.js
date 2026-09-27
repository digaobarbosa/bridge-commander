'use strict';
// ui/js/form.js — a plugin's form or config fields as one labelled control per
// field, and the raw values back out for fields.validateValues.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

const FIELDS = {
  env: { type: 'enum', enum: ['staging', 'prod'], title: 'Environment', required: true },
  note: { type: 'string', placeholder: 'why?' },
  body: { type: 'text', description: 'the long one' },
  count: { type: 'number', default: 3 },
  force: { type: 'boolean', title: 'Force' },
};

test('one labelled control per field type', async () => {
  const { formHtml } = await load('form.js');
  const html = formHtml(FIELDS, {}, { idPrefix: 'f1' });
  assert.match(html, /^<div class="bc-form">/);
  assert.match(html, /<label for="f1-env">Environment <span class="bc-req"/);
  assert.match(html, /<select id="f1-env" name="env" data-bc-field="env" required>/);
  assert.match(html, /<input type="text" id="f1-note"[^>]*placeholder="why\?"/);
  assert.match(html, /<textarea id="f1-body"[^>]*><\/textarea><small class="bc-desc">the long one<\/small>/);
  assert.match(html, /<input type="number" step="any" id="f1-count"[^>]* value="3">/, 'the default fills an absent value');
  assert.match(html, /<input type="checkbox" id="f1-force"[^>]*>/);
  assert.match(html, /<label for="f1-force">Force<\/label>/);
  assert.strictEqual((html.match(/<label /g) || []).length, 5);
});

test('values fill the controls; enum selects the matching option', async () => {
  const { formHtml } = await load('form.js');
  const html = formHtml(FIELDS, { env: 'prod', note: 'n', body: 'b', count: 7, force: true }, { idPrefix: 'x' });
  assert.match(html, /<option value="prod" selected>prod<\/option>/);
  assert.ok(!/value="staging" selected/.test(html));
  assert.match(html, /id="x-note"[^>]* value="n"/);
  assert.match(html, />b<\/textarea>/);
  assert.match(html, /value="7"/);
  assert.match(html, /id="x-force"[^>]* checked>/);
});

test('an optional enum offers an empty choice; a required one does not', async () => {
  const { formHtml } = await load('form.js');
  assert.match(formHtml({ e: { enum: ['a'] } }, {}), /<option value="" selected>—<\/option>/);
  assert.ok(!/<option value="">/.test(formHtml({ e: { enum: ['a'], required: true } }, {})));
});

test('everything is escaped: names, titles, values, options, descriptions', async () => {
  const { formHtml } = await load('form.js');
  const X = '"><script>alert(1)</script>';
  const html = formHtml({ ['n' + X]: { title: X, description: X, placeholder: X, enum: [X] } }, { ['n' + X]: X }, { idPrefix: 'p' });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!/="[^"]*"><script/.test(html));
  assert.match(html, /id="p-n__/, 'the id keeps only id-safe characters');
});

test('readForm reads each declared control; a checkbox is a boolean', async () => {
  const { readForm } = await load('form.js');
  const ctl = (field, props) => Object.assign({ getAttribute: (k) => (k === 'data-bc-field' ? field : null) }, props);
  const root = {
    querySelectorAll: (sel) => {
      assert.strictEqual(sel, '[data-bc-field]');
      return [
        ctl('env', { value: 'prod' }), ctl('note', { value: '' }), ctl('count', { value: '4' }),
        ctl('force', { checked: true, value: 'on' }), ctl('stray', { value: 'x' }),
      ];
    },
  };
  assert.deepStrictEqual(readForm(root, FIELDS), { env: 'prod', note: '', count: '4', force: true });
});

test('what readForm returns is what fields.validateValues takes', async () => {
  const { validateValues } = await load('fields.js');
  const r = validateValues(FIELDS, { env: 'prod', note: '', count: '4', force: true });
  assert.deepStrictEqual(r, { values: { env: 'prod', count: 4, force: true } });
});
