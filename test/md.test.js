'use strict';
// md.js — vendored marked + DOMPurify wiring, the image-source rewrite, and the
// copyText clipboard helper. md.js is an ES module (browser code); load it via
// dynamic import.
//
// Real DOMPurify only runs against a browser DOM, so the render claim splits in
// two: the fail-closed tests prove md() NEVER returns live HTML without a
// working sanitizer (with the real vendored purify — unsupported under Node —
// and with none at all), and the feature tests run the real vendored marked
// with a pass-through sanitizer stub that records what md() sends it and with
// which config (so the sanitize call itself, and its tag policy, are asserted
// on every render).
//
// Global order matters: md.js registers its DOMPurify hooks ONCE, on the first
// render with a supported sanitizer. That must be stubPurify, so the hook test
// can find them. copyText's navigator/document stubs go last; md() never reads
// them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, runCli } = require('./helper');

globalThis.marked = require(path.join(__dirname, '..', 'ui', 'vendor', 'marked.umd.js'));
const realPurify = require(path.join(__dirname, '..', 'ui', 'vendor', 'purify.min.js'));

const calls = []; // every {html, cfg} md() sent to the sanitizer
const hooks = {}; // every hook md() registered, by DOMPurify hook name
const passThrough = (html, cfg) => { calls.push({ html, cfg }); return html; };
const stubPurify = {
  isSupported: true,
  sanitize: passThrough,
  addHook: (name, fn) => { (hooks[name] = hooks[name] || []).push(fn); },
};

const mdMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'md.js')).href);
async function md(src, base) { return (await mdMod).md(src, base); }

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
  '9c6200010000050001' + '0d0a2db400000000' + '49454e44ae426082',
  'hex'
);

// ---------- fail closed (run before the stub is installed) ----------

test('no DOMPurify at all: output is escaped text, never live HTML', async () => {
  delete globalThis.DOMPurify;
  const out = await md('# hi\n<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<h1>')); // fail closed = no rendering at all
});

test('real vendored DOMPurify, unsupported environment: still fails closed', async () => {
  globalThis.DOMPurify = realPurify; // under Node: isSupported === false
  assert.strictEqual(realPurify.isSupported, false);
  const out = await md('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

// ---------- why the image rewrite lives inside the sanitize ----------
// An image in board markdown has no base of its own (it renders into the board
// page): `![](shot.png)` beside a document asked the board for /shot.png, and
// `attachment://id` never even survived the sanitizer. md.js rewrites both.

test('md() registers the rewrite as a sanitize hook and only touches img src', async () => {
  globalThis.DOMPurify = stubPurify;
  await md('![](attachment://a1b2c3d4e5f60718)', '/home/ai/cards/MNC-1');
  assert.strictEqual((hooks.uponSanitizeAttribute || []).length, 1);
  const hook = hooks.uponSanitizeAttribute[0];
  // The hook only sees a base while a render is in flight, so drive it the way
  // DOMPurify does: from inside the sanitize call.
  const seen = [];
  stubPurify.sanitize = () => {
    for (const c of [
      { node: { tagName: 'IMG' }, data: { attrName: 'src', attrValue: 'shot.png' } },
      { node: { tagName: 'IMG' }, data: { attrName: 'src', attrValue: 'attachment://a1b2c3d4e5f60718' } },
      { node: { tagName: 'IMG' }, data: { attrName: 'alt', attrValue: 'shot.png' } },
      { node: { tagName: 'A' }, data: { attrName: 'src', attrValue: 'shot.png' } },
    ]) { hook(c.node, c.data); seen.push(c.data.attrValue); }
    return '';
  };
  try {
    await md('anything', '/home/ai/cards/MNC-1');
  } finally {
    stubPurify.sanitize = passThrough;
  }
  assert.deepStrictEqual(seen, [
    '/artifacts/' + encodeURIComponent('/home/ai/cards/MNC-1') + '/shot.png',
    '/api/attachments/a1b2c3d4e5f60718',
    'shot.png', // alt is not a source
    'shot.png', // neither is a non-img element
  ]);
});

// ---------- rendering features (real marked, recording sanitizer stub) ----------

test('every render goes through the sanitizer, with the formatting-only policy', async () => {
  globalThis.DOMPurify = stubPurify;
  calls.length = 0;
  const out = await md('hello <script>x</script>');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].html, out); // md returns exactly what sanitize returned
  assert.ok(calls[0].html.includes('<script>'), 'marked passes raw HTML through — the sanitizer is load-bearing');
  const cfg = calls[0].cfg;
  assert.deepStrictEqual(cfg.USE_PROFILES, { html: true }); // no author SVG/MathML
  for (const t of ['style', 'form', 'button']) assert.ok(cfg.FORBID_TAGS.includes(t));
});

test('ordered and nested lists render natively', async () => {
  const out = await md('1. one\n2. two\n   - nested\n   - deep');
  assert.ok(out.includes('<ol>'));
  assert.ok(out.includes('<ul>'));
  assert.ok(out.includes('<li>one'));
  assert.ok(out.includes('<li>nested</li>'));
});

test('single newline inside a paragraph renders as a <br> soft break', async () => {
  const out = await md('line one\nline two');
  assert.ok(out.includes('line one<br>line two'));
});

test('blank line still separates paragraphs', async () => {
  const out = await md('para one\n\npara two');
  assert.ok(out.includes('<p>para one</p>'));
  assert.ok(out.includes('<p>para two</p>'));
});

test('GFM extras: italic, strikethrough, blockquote, hr, h4, task list', async () => {
  assert.ok((await md('*it*')).includes('<em>it</em>'));
  assert.ok((await md('~~gone~~')).includes('<del>gone</del>'));
  assert.ok((await md('> quoted')).includes('<blockquote>'));
  assert.ok((await md('---')).includes('<hr>'));
  assert.ok((await md('#### deep')).includes('<h4>deep</h4>'));
  assert.ok((await md('- [x] done')).includes('type="checkbox"'));
});

test('pipe table renders thead/tbody', async () => {
  const out = await md('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>a</th>'));
  assert.ok(out.includes('<td>1</td>'));
});

test('fenced code carries its language class; content stays escaped', async () => {
  const out = await md('```js\nconst x = 1 < 2;\n```');
  assert.ok(out.includes('language-js'));
  assert.ok(out.includes('1 &lt; 2'));
});

test('mermaid fence stays an escaped code block, tagged for the enhancer', async () => {
  const out = await md('```mermaid\ngraph TD\nA-->B\n```');
  assert.ok(out.includes('language-mermaid'));
  assert.ok(out.includes('A--&gt;B')); // escaped source, no diagram markup server-side
  assert.ok(!out.includes('<svg'));
});

test('links render with href; images survive', async () => {
  const out = await md('[x](https://example.com) ![alt](https://example.com/i.png)');
  assert.ok(out.includes('<a href="https://example.com"'));
  assert.ok(out.includes('<img src="https://example.com/i.png"'));
});

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

// ---------- copyText: the one clipboard helper behind every copy affordance ----------
// Over plain HTTP (tailnet phone) there is no navigator.clipboard, and the
// execCommand fallback must then run SYNCHRONOUSLY inside the click call —
// execCommand outside a user gesture is a silent no-op on mobile Safari.

// navigator exists as a global getter in modern Node — replace via defineProperty
function setNavigator(v) {
  Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
}
// minimal DOM for the textarea fallback; records the execCommand call
function stubDocument(execResult) {
  const calls = { exec: 0, value: null, appended: 0, removed: 0, selected: 0 };
  const ta = {
    style: {},
    value: null,
    select() { calls.selected++; },
    remove() { calls.removed++; },
  };
  globalThis.document = {
    createElement: () => ta,
    body: { appendChild(n) { calls.appended++; calls.value = n.value; } },
    execCommand(cmd) { assert.strictEqual(cmd, 'copy'); calls.exec++; return execResult; },
  };
  return calls;
}

test('no navigator.clipboard (insecure context): execCommand runs synchronously in the call', async () => {
  setNavigator({}); // plain-HTTP browser: clipboard is undefined
  const calls = stubDocument(true);
  const { copyText } = await mdMod;
  const p = copyText('hello board');
  // asserted BEFORE awaiting: the fallback fired inside the click's own call
  assert.strictEqual(calls.exec, 1);
  assert.strictEqual(calls.value, 'hello board');
  assert.strictEqual(calls.selected, 1);
  assert.strictEqual(calls.removed, 1); // textarea cleaned up
  assert.strictEqual(await p, true);
});

test('fallback reports failure honestly when execCommand returns false', async () => {
  setNavigator({});
  stubDocument(false);
  const { copyText } = await mdMod;
  assert.strictEqual(await copyText('x'), false);
});

test('secure context: navigator.clipboard.writeText is used, no textarea', async () => {
  let written = null;
  setNavigator({ clipboard: { writeText: (t) => { written = t; return Promise.resolve(); } } });
  const calls = stubDocument(true);
  const { copyText } = await mdMod;
  assert.strictEqual(await copyText('via clipboard api'), true);
  assert.strictEqual(written, 'via clipboard api');
  assert.strictEqual(calls.exec, 0);
});

test('writeText rejection (focus/permission) falls back to execCommand', async () => {
  setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
  const calls = stubDocument(true);
  const { copyText } = await mdMod;
  assert.strictEqual(await copyText('fallback text'), true);
  assert.strictEqual(calls.exec, 1);
  assert.strictEqual(calls.value, 'fallback text');
});
