'use strict';
// An image in board markdown. Markdown renders into the board page, so it has no
// base of its own: `![](shot.png)` beside a document asked the board for
// /shot.png, and `attachment://id` never even survived the sanitizer. Both are
// rewritten by md.js — this suite pins the rewrite, the reason it lives inside
// the sanitize instead of after it, and that the URLs it produces are the ones
// the server actually serves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, runCli } = require('./helper');

globalThis.marked = require(path.join(__dirname, '..', 'ui', 'vendor', 'marked.umd.js'));
const mdMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'md.js')).href);

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
  '9c6200010000050001' + '0d0a2db400000000' + '49454e44ae426082',
  'hex'
);

// ---------- the rewrite itself ----------

test('an attachment id becomes the attachment serve, base or no base', async () => {
  const { mdImgSrc } = await mdMod;
  assert.strictEqual(mdImgSrc('attachment://a1b2c3d4e5f60718', ''), '/api/attachments/a1b2c3d4e5f60718');
  assert.strictEqual(mdImgSrc('attachment://a1b2c3d4e5f60718', '/cards/X'), '/api/attachments/a1b2c3d4e5f60718');
});

test('a relative image resolves against the document directory, via the directory serve', async () => {
  const { mdImgSrc } = await mdMod;
  const dir = '/home/ai/cards/MNC-1';
  const base = '/artifacts/' + encodeURIComponent(dir) + '/';
  assert.strictEqual(mdImgSrc('shot.png', dir), base + 'shot.png');
  assert.strictEqual(mdImgSrc('./shot.png', dir), base + 'shot.png');
  assert.strictEqual(mdImgSrc('img/shot.png', dir), base + 'img/shot.png');
  assert.strictEqual(mdImgSrc('a b.png', dir), base + 'a%20b.png');
});

test('everything already resolvable is left exactly as written', async () => {
  const { mdImgSrc } = await mdMod;
  const dir = '/home/ai/cards/MNC-1';
  for (const src of ['https://x/y.png', 'http://x/y.png', 'data:image/png;base64,AA',
    '/api/artifact?uri=x&raw=1', '/artifacts/d/x.png', '//cdn/x.png', '#anchor', '']) {
    assert.strictEqual(mdImgSrc(src, dir), '', src + ' is not rewritten');
  }
  // No document = nothing for a relative path to resolve against (a card body).
  assert.strictEqual(mdImgSrc('shot.png', ''), '');
});

// ---------- why it lives inside the sanitize ----------

test('md() registers the rewrite as a sanitize hook and only touches img src', async () => {
  const hooks = {};
  globalThis.DOMPurify = {
    isSupported: true,
    sanitize: (html) => html,
    addHook: (name, fn) => { (hooks[name] = hooks[name] || []).push(fn); },
  };
  const { md } = await mdMod;
  md('![](attachment://a1b2c3d4e5f60718)', '/home/ai/cards/MNC-1');
  assert.strictEqual((hooks.uponSanitizeAttribute || []).length, 1);
  const hook = hooks.uponSanitizeAttribute[0];
  // The hook only sees a base while a render is in flight, so drive it the way
  // DOMPurify does: from inside the sanitize call.
  const seen = [];
  globalThis.DOMPurify.sanitize = () => {
    for (const c of [
      { node: { tagName: 'IMG' }, data: { attrName: 'src', attrValue: 'shot.png' } },
      { node: { tagName: 'IMG' }, data: { attrName: 'src', attrValue: 'attachment://a1b2c3d4e5f60718' } },
      { node: { tagName: 'IMG' }, data: { attrName: 'alt', attrValue: 'shot.png' } },
      { node: { tagName: 'A' }, data: { attrName: 'src', attrValue: 'shot.png' } },
    ]) { hook(c.node, c.data); seen.push(c.data.attrValue); }
    return '';
  };
  md('anything', '/home/ai/cards/MNC-1');
  assert.deepStrictEqual(seen, [
    '/artifacts/' + encodeURIComponent('/home/ai/cards/MNC-1') + '/shot.png',
    '/api/attachments/a1b2c3d4e5f60718',
    'shot.png', // alt is not a source
    'shot.png', // neither is a non-img element
  ]);
  delete globalThis.DOMPurify;
});

// ---------- the URLs the rewrite produces, against the real server ----------

test('the image beside a markdown artifact is served at the url the rewrite builds', async () => {
  const s = await startServerWithLieutenant();
  try {
    const dir = path.join(s.dir, 'report');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.md'), '# it works\n\n![](shot.png)\n');
    fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
    const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Report' }));
    const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts',
      { uri: path.join(dir, 'report.md'), label: 'report' });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    const { mdImgSrc } = await mdMod;
    const res = await fetch(s.base + mdImgSrc('shot.png', dir));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
  } finally {
    await s.stop();
  }
});

test('bc-axi attach prints an id and a markdown line that resolves to the bytes', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'shot.png');
    fs.writeFileSync(file, PNG);
    const r = await runCli(['attach', file, '--workspace', s.dir]);
    assert.strictEqual(r.code, 0, r.stderr);
    const [id, line] = r.stdout.trim().split('\n');
    assert.match(id, /^[a-f0-9]{16}$/);
    assert.strictEqual(line, '![shot.png](attachment://' + id + ')');

    // The line the CLI printed, rendered the way the board renders it.
    const { mdImgSrc } = await mdMod;
    const url = mdImgSrc(/\((.+)\)/.exec(line)[1], '');
    const res = await fetch(s.base + url);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).length, PNG.length);

    const j = await runCli(['attach', file, '--json', '--workspace', s.dir]);
    const meta = JSON.parse(j.stdout);
    assert.strictEqual(meta.mime, 'image/png');
    assert.strictEqual(meta.uri, 'attachment://' + meta.id);
    assert.strictEqual(meta.markdown, '![shot.png](attachment://' + meta.id + ')');
  } finally {
    await s.stop();
  }
});
