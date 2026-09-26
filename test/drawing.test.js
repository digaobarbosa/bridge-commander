'use strict';
// A drawing as a first-class artifact: opened on a canvas, saved through the
// same guarded write as any text file, and merged shape by shape when the other
// hand writes it.
//
// Two levels:
//   1. the merge itself (ui/js/draw.js is DOM-free at import — the React mount
//      only happens inside mountDrawing, so the module imports straight in);
//   2. the server, end to end: a stale write on a drawing is still refused, and
//      the .svg beside it is created by the same door under the same rule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner } = require('./helper');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const drawMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'draw.js')).href);

const box = (id, version, extra) => Object.assign({ id, version, type: 'rectangle', x: 0, y: 0 }, extra || {});
const ids = (els) => els.map((e) => e.id).sort();
const byId = (els, id) => els.find((e) => e.id === id);

// ---------- 1. the merge ----------

test('a shape the other hand changed lands; a shape ours changed later stands', async () => {
  const { mergeElements } = await drawMod;
  const mine = [box('a', 3, { x: 10 }), box('b', 1)];
  const theirs = [box('a', 1, { x: 99 }), box('b', 7, { x: 42 })];
  const out = mergeElements(mine, theirs, new Set(['a', 'b']), new Set());
  assert.strictEqual(byId(out, 'a').x, 10, 'ours is the higher version — it stands');
  assert.strictEqual(byId(out, 'b').x, 42, 'theirs is the higher version — it lands');
});

test('a shape the captain has SELECTED is never moved or deleted by an incoming write', async () => {
  const { mergeElements } = await drawMod;
  const mine = [box('sel', 1, { x: 5 }), box('gone', 1)];
  // theirs moved the selected one and deleted the other — both were in the base
  const theirs = [box('sel', 9, { x: 500 })];
  const out = mergeElements(mine, theirs, new Set(['sel', 'gone']), new Set(['sel']));
  assert.strictEqual(byId(out, 'sel').x, 5, 'his selection is his, whatever the disk says');
  assert.strictEqual(byId(out, 'gone'), undefined, 'the one he was NOT holding follows the disk');
});

test('a shape drawn here since the last read survives; one they deleted goes', async () => {
  const { mergeElements } = await drawMod;
  const mine = [box('old', 1), box('fresh', 1)];
  const theirs = [box('old', 1), box('ofTheirs', 1)];
  const out = mergeElements(mine, theirs, new Set(['old']), new Set());
  assert.deepStrictEqual(ids(out), ['fresh', 'ofTheirs', 'old'], 'both new shapes, and the shared one');

  // now the same scene where THEY deleted `old`: it was in the base, we are not
  // holding it, so it goes — a delete is not a shape we get to keep
  const after = mergeElements(mine, [box('ofTheirs', 1)], new Set(['old']), new Set());
  assert.deepStrictEqual(ids(after), ['fresh', 'ofTheirs']);
});

test('an empty disk write does not wipe what was drawn here since', async () => {
  const { mergeElements } = await drawMod;
  const out = mergeElements([box('mine', 1)], [], new Set(), new Set());
  assert.deepStrictEqual(ids(out), ['mine']);
});

test('the file we write is the same bytes for the same scene — that is what stops two canvases writing at each other', async () => {
  const { sceneText, parseScene } = await drawMod;
  const els = [box('a', 2), box('b', 1)];
  const a = sceneText(els, { viewBackgroundColor: '#fff', scrollX: 100, zoom: { value: 2 } }, {});
  const b = sceneText(els, { viewBackgroundColor: '#fff', scrollX: -900, zoom: { value: 0.5 } }, {});
  assert.strictEqual(a, b, 'scroll and zoom are the viewer, not the drawing');
  assert.strictEqual(JSON.parse(a).type, 'excalidraw');
  assert.deepStrictEqual(ids(parseScene(a).elements), ['a', 'b'], 'and it reads back');
  // a deleted shape is a tombstone on the canvas and absent from the file
  assert.deepStrictEqual(ids(parseScene(sceneText([box('a', 2), box('x', 5, { isDeleted: true })], {}, {})).elements), ['a']);
});

test('the exported picture points at the fonts we actually serve', async () => {
  const { fixFontUrls } = await drawMod;
  const out = fixFontUrls('src: url("http://board/ui/vendor/excalidraw//dist/excalidraw-assets/Virgil.woff2");');
  assert.match(out, /\/ui\/vendor\/excalidraw\/excalidraw-assets\/Virgil\.woff2/);
  assert.ok(!/dist/.test(out), "0.17 exports the npm package's layout, not ours");
});

test('a file we cannot read is not an empty drawing — it throws instead of overwriting', async () => {
  const { parseScene } = await drawMod;
  assert.throws(() => parseScene('not json at all'));
  assert.throws(() => parseScene('{"type":"excalidraw"}'), /no elements/);
});

// ---------- what a refusal becomes ----------
// The defect this round exists to kill: the client answered a 409 by pinning the
// version it was refused with, and the autosave then wrote through clean 1.5 s
// later. Nobody chose that, and what was only on disk was gone.

test('a refused save comes back as a MERGE, keeping what was only on disk', async () => {
  const { resolveRefusal, parseScene, sceneText } = await drawMod;
  const mine = { elements: [box('seed1', 1), box('mine', 1)], appState: {}, files: {} };
  const disk = sceneText([box('seed1', 1), box('unheard', 1)], {}, {});
  const out = parseScene(resolveRefusal(mine, disk, new Set(['seed1']), new Set()));
  assert.deepStrictEqual(ids(out.elements), ['mine', 'seed1', 'unheard'],
    'what they wrote while we were not looking is still there, and so is ours');
});

test('a refusal we cannot read stays a refusal — there is nothing to write instead', async () => {
  const { resolveRefusal } = await drawMod;
  const mine = { elements: [box('mine', 1)], appState: {}, files: {} };
  assert.strictEqual(resolveRefusal(mine, 'not a drawing at all', new Set(), new Set()), null);
});

// The defect this round exists to kill: a lieutenant's write arrives while the
// captain is mid-gesture, so the merge is PARKED — but the screen was already
// told the file moved, and the debounce then wrote the not-yet-merged canvas at
// the version that had just been pinned to disk. A 200, and their shape gone.
// The refusal machinery cannot help: that write is not stale.
test('the debounce writes nothing while an incoming merge is parked behind a gesture', async () => {
  const { saveDue } = await drawMod;
  const canvas = 'seed1, captX';          // what the hand is drawing on
  const disk = 'seed1, captX, LT_NEW';    // what the other hand just wrote, not merged in yet
  assert.strictEqual(saveDue(canvas, disk, false, true), 'wait',
    'writing this would take LT_NEW off the disk, and the server would accept it');
  assert.strictEqual(saveDue(canvas, disk, false, false), 'write',
    'and the moment the merge has run, the save happens exactly as before');
  assert.strictEqual(saveDue('a', 'b', true, false), 'wait', 'one save at a time, as before');
  assert.strictEqual(saveDue('same', 'same', false, false), 'nothing', 'the disk already has this scene');
  assert.strictEqual(saveDue('same', 'same', false, true), 'nothing');
});

test('opening a drawing is a read: only a changed SHAPE counts as a change', async () => {
  const { sceneKey } = await drawMod;
  const loaded = [box('a', 3), box('b', 1)];
  // the canvas re-serialising the same shapes (mount, scroll, zoom, selection)
  // is not a change — only ids and versions are read
  assert.strictEqual(sceneKey(loaded), sceneKey([box('a', 3, { x: 9, seed: 77 }), box('b', 1)]));
  assert.notStrictEqual(sceneKey(loaded), sceneKey([box('a', 4), box('b', 1)]), 'a hand moved it — version bumped');
  assert.notStrictEqual(sceneKey(loaded), sceneKey(loaded.concat([box('c', 1)])), 'a hand drew one');
  assert.notStrictEqual(sceneKey(loaded), sceneKey([box('a', 4, { isDeleted: true }), box('b', 1)]), 'a hand deleted one');
});

// ---------- 2. the server ----------

async function cardWithArtifact(s, uri, label) {
  const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Diagram' }));
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri, label });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  return { id: cr.body.card.id, uri: add.body.artifact.uri };
}

test('a stale write to a drawing is still REFUSED — not merged, not forced', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'flow.excalidraw');
    const onDisk = '{"type":"excalidraw","elements":[{"id":"a","version":1}]}\n';
    fs.writeFileSync(file, onDisk);
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'flow');
    const stale = sha256('{"type":"excalidraw","elements":[]}\n');

    const put = await s.api('PUT', '/api/artifact', { uri, content: '{"elements":[]}', version: stale });
    assert.strictEqual(put.status, 409, 'the guarantee the whole artifact system rests on');
    assert.strictEqual(put.body.version, sha256(onDisk), 'and it says what is there now');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), onDisk, 'nothing was written');

    // with the version it actually read, the same write lands
    const ok = await s.api('PUT', '/api/artifact', { uri, content: '{"elements":[]}', version: sha256(onDisk) });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await s.stop();
  }
});

test('the .svg beside the drawing is created by the same door, under the same rule', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'flow.excalidraw');
    fs.writeFileSync(file, '{"type":"excalidraw","elements":[]}\n');
    const { id, uri } = await cardWithArtifact(s, 'file://' + file, 'flow');
    const svgUri = uri + '.svg';
    const svgFile = file + '.svg';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

    // not listed on any card yet → refused, exactly like any other path
    const bare = await s.api('PUT', '/api/artifact', { uri: svgUri, content: svg, version: '' });
    assert.strictEqual(bare.status, 403);
    assert.ok(!fs.existsSync(svgFile));

    assert.strictEqual((await s.api('POST', '/api/cards/' + id + '/artifacts', { uri: svgUri, label: 'flow.excalidraw.svg' })).status, 200);
    const made = await s.api('PUT', '/api/artifact', { uri: svgUri, content: svg, version: '' });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(fs.readFileSync(svgFile, 'utf8'), svg, 'the picture is on disk next to the drawing');
    assert.strictEqual(made.body.version, sha256(svg));

    // it exists now, so "I expect nothing there" is a stale claim — refused
    const again = await s.api('PUT', '/api/artifact', { uri: svgUri, content: '<svg/>', version: '' });
    assert.strictEqual(again.status, 409, 'creation never becomes a way around the version check');
    assert.strictEqual(fs.readFileSync(svgFile, 'utf8'), svg);

    // and it serves as an image, which is what makes it renderable everywhere else
    const raw = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(svgUri) + '&raw=1');
    assert.strictEqual(raw.headers.get('content-type'), 'image/svg+xml');
    assert.match(await raw.text(), /^<svg /);
  } finally {
    await s.stop();
  }
});

// The reviewer's repro, end to end against a real server and the real client
// policy: a disk that moved without the PUT route (an agent writing its own
// worktree file, or a board SSE that missed the event), a pinned stale version,
// and then an AUTOMATIC save — the one with no human behind it.
test('after a refusal, the automatic save that follows merges — it never overwrites clean', async () => {
  const { resolveRefusal, sceneText, parseScene } = await drawMod;
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'flow.excalidraw');
    fs.writeFileSync(file, sceneText([box('seed1', 1)], {}, {}));
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'flow');

    // the canvas opens: base and version as read
    const opened = (await s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri))).body;
    const baseIds = new Set(parseScene(opened.content).elements.map((e) => e.id));
    let pinned = opened.version;
    // the captain draws one shape
    let scene = [box('seed1', 1), box('mine', 1)];

    // and somebody writes the file without going through the PUT route at all,
    // so nothing is announced and nothing here hears about it
    fs.writeFileSync(file, sceneText([box('seed1', 1), box('unheard', 1)], {}, {}));

    // autosave #1 — refused, as it must be
    const refused = await s.api('PUT', '/api/artifact', { uri, content: sceneText(scene, {}, {}), version: pinned });
    assert.strictEqual(refused.status, 409);
    assert.deepStrictEqual(ids(parseScene(fs.readFileSync(file, 'utf8')).elements), ['seed1', 'unheard'], 'nothing was written');

    // what the client does with that refusal, and it is the whole fix: merge,
    // then write the merged scene against the version the refusal carried
    const merged = resolveRefusal({ elements: scene, appState: {}, files: {} }, refused.body.content, baseIds, new Set());
    assert.ok(merged, 'a drawing can always answer a refusal');
    const again = await s.api('PUT', '/api/artifact', { uri, content: merged, version: refused.body.version });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));

    assert.deepStrictEqual(ids(parseScene(fs.readFileSync(file, 'utf8')).elements), ['mine', 'seed1', 'unheard'],
      "the other hand's shape survived the save that followed its own refusal");
  } finally {
    await s.stop();
  }
});

test('a missing file with a version claim is still 404 — creation is not a fallback', async () => {
  const s = await startServerWithLieutenant();
  try {
    const missing = path.join(s.dir, 'nope.excalidraw');
    const { uri } = await cardWithArtifact(s, 'file://' + missing, 'nope');
    const r = await s.api('PUT', '/api/artifact', { uri, content: 'x', version: sha256('something') });
    assert.strictEqual(r.status, 404);
    assert.ok(!fs.existsSync(missing));
  } finally {
    await s.stop();
  }
});
