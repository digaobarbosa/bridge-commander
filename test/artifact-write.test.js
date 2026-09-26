'use strict';
// Artifact WRITE (PUT /api/artifact) — the file editor's save, and the GET that
// hands out the version it is checked against.
//
// Two things are being defended here, and they are not the same thing:
//  - the captain's work: a write that lands on a file which moved underneath
//    him is refused (409) and nothing is written, so a lost edit is impossible
//    to do silently;
//  - the machine: the board has no auth of its own, so writing is allowed ONLY
//    into a file the board can name. That is four shapes and nothing else:
//      card artifact — a file already listed as some card's artifact;
//      playbook      — a `.md` DIRECTLY in <STATE_DIR>/playbooks;
//      charter       — the path charterPath() builds for a REGISTERED id;
//      hook          — an executable under <STATE_DIR>/hooks/, one level deep
//                      (named) or two (a lifecycle hook in its event's dir).
//    Everything else — an unlisted path, a traversal, a symlink, an upload, a
//    subdirectory, a directory — is 403 and untouched (the refusal matrix below).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');
const { charterPath } = require('../server/layout.js');
const { LIFECYCLE_EVENTS } = require('../server/hooks.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uriOf = (f) => 'file://' + f;
const get = (s, uri) => s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));
const put = (s, uri, content, version) => s.api('PUT', '/api/artifact', { uri, content, version });

// No id pinned: each call mints its own, so a test may stand up several.
async function cardWithArtifact(s, uri, label) {
  const cr = await s.api('POST', '/api/cards', { owner: LT, title: 'Deliverable' });
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri, label });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  return { id: cr.body.card.id, uri: add.body.artifact.uri };
}

// `bc-axi init` seeds the playbooks dir; a server boot does not, so tests do
// what init would have.
const playbooksDir = (ws) => path.join(ws, '.bridge-commander', 'playbooks');
function writePlaybook(s, name, body) {
  fs.mkdirSync(playbooksDir(s.dir), { recursive: true });
  const file = path.join(playbooksDir(s.dir), name);
  fs.writeFileSync(file, body);
  return file;
}

// startServerWithLieutenant registers "ada"; her memory folder is not written
// until something writes a charter.
function writeCharter(s, text, id = 'ada') {
  const file = charterPath(s.dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const hooksDir = (ws) => path.join(ws, '.bridge-commander', 'hooks');
function writeExec(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}
const isExec = (file) => (fs.statSync(file).mode & 0o111) === 0o111;
const listsHook = async (s, name) =>
  (await s.api('GET', '/api/hooks')).body.hooks.some((h) => h.name === name);

// The gate's answer to anything it does not own: GET 404 (so the editor never
// even opens it) and PUT 403. Card rows override `get`/`version`/`error`: a
// card refusal is tested with a genuine-looking version so the 403 is the
// gate's, not the version check's.
async function refused(s, uri, { get: getStatus = 404, version = '', error } = {}) {
  if (getStatus != null) {
    const g = await get(s, uri);
    assert.strictEqual(g.status, getStatus, 'GET ' + uri + ' → ' + JSON.stringify(g.body));
  }
  const p = await put(s, uri, 'pwned\n', version);
  assert.strictEqual(p.status, 403, 'PUT ' + uri + ' → ' + JSON.stringify(p.body));
  if (error) assert.match(p.body.error, error);
}

// ---------- round trip: every kind reads and writes the same way ----------

const KINDS = [
  { kind: 'card artifact', name: 'brief.md', before: '# brief\n\noriginal line\n', after: '# brief\n\nedited by the captain\n',
    async setup(s) {
      const file = path.join(s.dir, 'brief.md');
      fs.writeFileSync(file, this.before);
      return { file, uri: (await cardWithArtifact(s, file, 'worker brief')).uri };
    } },
  { kind: 'workspace playbook', name: 'default.md', before: 'first draft\n', after: 'second draft\n',
    async setup(s) {
      const file = writePlaybook(s, 'default.md', this.before);
      return { file, uri: uriOf(file) };
    } },
  { kind: 'registered lieutenant’s charter', name: 'README.md', before: '# Ada\n\nowns the compiler.\n', after: 'rewritten\n',
    async setup(s) {
      const file = writeCharter(s, this.before);
      return { file, uri: uriOf(file) };
    } },
  // An edit never costs a hook its executable bit — a hook the runner skips
  // silently is not a hook.
  { kind: 'named hook', name: 'gh-watch', before: '#!/bin/sh\necho v1\n', after: '#!/bin/sh\necho v2\n',
    async setup(s) {
      const file = writeExec(path.join(hooksDir(s.dir), 'gh-watch'), this.before);
      return { file, uri: uriOf(file) };
    },
    check: (file) => assert.ok(isExec(file), 'still executable') },
  { kind: 'lifecycle hook (two levels deep, in its event directory)', name: 'sweep.sh', before: '#!/bin/sh\nexit 0\n', after: '#!/bin/sh\nexit 1\n',
    async setup(s) {
      const file = writeExec(path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh'), this.before);
      return { file, uri: uriOf(file) };
    },
    check: (file) => assert.ok(isExec(file), 'still executable') },
];

for (const k of KINDS) {
  test('a ' + k.kind + ' reads and writes through the artifact routes, version check and all', async () => {
    const s = await startServerWithLieutenant();
    try {
      const { file, uri } = await k.setup(s);
      const got = await get(s, uri);
      assert.strictEqual(got.status, 200, JSON.stringify(got.body));
      assert.strictEqual(got.body.name, k.name);
      assert.strictEqual(got.body.content, k.before);
      assert.strictEqual(got.body.version, sha256(k.before), 'version is sha256 of the content');

      const w = await put(s, uri, k.after, got.body.version);
      assert.strictEqual(w.status, 200, JSON.stringify(w.body));
      assert.strictEqual(w.body.version, sha256(k.after));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), k.after, 'the file on disk IS the new text');
      if (k.check) k.check(file);
      // the version the write returned is the one a fresh read hands out
      assert.strictEqual((await get(s, uri)).body.version, w.body.version);

      // …and the old version is now stale: refused, carrying what is on disk
      const stale = await put(s, uri, 'mine\n', got.body.version);
      assert.strictEqual(stale.status, 409);
      assert.match(stale.body.error, /changed on disk/);
      assert.strictEqual(stale.body.content, k.after);
      assert.strictEqual(stale.body.version, sha256(k.after));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), k.after, 'nothing was written');
    } finally { await s.stop(); }
  });
}

// ---------- card artifact ----------

test('PUT with a stale version → 409, nothing written, and the answer carries what is on disk', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'first\n');
    const { uri } = await cardWithArtifact(s, file, 'brief');
    const stale = (await get(s, uri)).body.version;

    // someone else (another agent, another tab) writes it meanwhile
    fs.writeFileSync(file, 'written by someone else\n');

    const w = await put(s, uri, 'my edit\n', stale);
    assert.strictEqual(w.status, 409);
    assert.match(w.body.error, /changed on disk/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'written by someone else\n', 'the other write survives untouched');
    assert.strictEqual(w.body.content, 'written by someone else\n', '409 carries the current content');
    assert.strictEqual(w.body.version, sha256('written by someone else\n'), '…and its version');

    // saving again WITH that version is the deliberate overwrite, and it works
    const again = await put(s, uri, 'my edit\n', w.body.version);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'my edit\n');
  } finally { await s.stop(); }
});

test('a missing/blank version is never treated as "no opinion" — it is a 409', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'notes.txt');
    fs.writeFileSync(file, 'on disk\n');
    const { uri } = await cardWithArtifact(s, file, 'notes');
    for (const body of [{ uri, content: 'x\n' }, { uri, content: 'x\n', version: '' }]) {
      const w = await s.api('PUT', '/api/artifact', body);
      assert.strictEqual(w.status, 409, JSON.stringify(w.body));
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'on disk\n');
  } finally { await s.stop(); }
});

test('an uploaded attachment is not writable, and a write leaves no temp file behind', async () => {
  const s = await startServerWithLieutenant();
  try {
    const up = await s.api('POST', '/api/attachments', {
      name: 'notes.txt', mime: 'text/plain', dataBase64: Buffer.from('uploaded\n').toString('base64'),
    });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Has an upload' }));
    await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri: up.body.uri });
    const w = await put(s, up.body.uri, 'x\n', 'whatever');
    assert.strictEqual(w.status, 403, JSON.stringify(w.body));
    assert.match(w.body.error, /only file:\/\//);

    // and the happy path cleans up after itself
    const file = path.join(s.dir, 'clean.md');
    fs.writeFileSync(file, 'a\n');
    const { uri } = await cardWithArtifact(s, file, 'clean');
    const v = (await get(s, uri)).body.version;
    assert.strictEqual((await put(s, uri, 'b\n', v)).status, 200);
    const leftovers = fs.readdirSync(s.dir).filter((n) => n.includes('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'the atomic write renames its temp file away');
  } finally { await s.stop(); }
});

// ---------- playbooks ----------

test('GET /api/playbooks says where each playbook comes from and which file won', async () => {
  const s = await startServerWithLieutenant();
  try {
    writePlaybook(s, 'default.md', 'MY default\n');
    const dir = playbooksDir(s.dir);
    const r = await s.api('GET', '/api/playbooks');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dir, dir, 'the workspace dir is still in the answer');
    const by = Object.fromEntries(r.body.items.map((p) => [p.id, p]));

    // overridden in the workspace: the workspace file is the one that wins
    assert.deepStrictEqual(by.default, {
      id: 'default', source: 'workspace', file: path.join(dir, 'default.md'),
    });
    // not overridden: the packaged file, from the install's own playbooks/
    assert.strictEqual(by.investigation.source, 'packaged');
    assert.strictEqual(by.investigation.file,
      path.join(__dirname, '..', 'playbooks', 'investigation.md'));
    assert.ok(fs.existsSync(by.investigation.file), 'and it is a real file on disk');

    // the plain id list the picker and the CLI read is unchanged
    assert.deepStrictEqual(r.body.playbooks, r.body.items.map((p) => p.id));
    assert.ok(r.body.playbooks.includes('no-mistakes'));
  } finally { await s.stop(); }
});

// Writing a playbook takes two vocabularies — the placeholders and the five
// frontmatter keys — and the screen can only show them if the answer carries
// them. They come from server/playbooks.js, which is where the test that keeps
// them honest lives (playbooks.test.js).
test('GET /api/playbooks carries the reference the playbooks screen renders', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.mkdirSync(playbooksDir(s.dir), { recursive: true });
    const { placeholders, frontmatter } = (await s.api('GET', '/api/playbooks')).body.reference;
    assert.ok(placeholders.length && frontmatter.length, 'both lists are there');
    assert.ok(placeholders.some((p) => p.name === 'CARD_ID'));
    assert.ok(frontmatter.some((f) => f.key === 'harness'));
    for (const p of placeholders) assert.ok(p.name && p.desc.trim(), p.name + ' is described');
    for (const f of frontmatter) assert.ok(f.key && f.desc.trim(), f.key + ' is described');
  } finally { await s.stop(); }
});

test('copy to workspace: a packaged playbook reads, refuses to be written, and copies in', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.mkdirSync(playbooksDir(s.dir), { recursive: true });
    const packaged = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.id === 'investigation');
    assert.strictEqual(packaged.source, 'packaged');
    // it OPENS — that is what read-only means, and what the copy copies
    const got = await get(s, uriOf(packaged.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const content = got.body.content;
    assert.ok(content.length, 'the packaged playbook has content');

    // …and it is never written in place: the install is a git checkout of this repo
    const nope = await put(s, uriOf(packaged.file), 'pwned\n', got.body.version);
    assert.strictEqual(nope.status, 403);
    assert.match(nope.body.error, /packaged playbook/);
    assert.strictEqual(fs.readFileSync(packaged.file, 'utf8'), content, 'the installed file is untouched');

    // The copy is a create in the workspace: version '' = "expect no file".
    const target = path.join(playbooksDir(s.dir), 'investigation.md');
    const w = await put(s, uriOf(target), content, '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), content);

    // and now the same id resolves to the workspace copy
    const after = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.id === 'investigation');
    assert.deepStrictEqual(after, { id: 'investigation', source: 'workspace', file: target });
  } finally { await s.stop(); }
});

// ---------- charters ----------

// A lieutenant registered without --charter-file has no memory file and no
// folder to put one in. The row still offers ✎, so the GET has to answer — with
// the empty document at version '', which is what the PUT reads as "I expect no
// file" (the same create a derived card artifact is written with).
test('a lieutenant with no charter yet opens on the empty document, and the first save creates it', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = charterPath(s.dir, 'ada');
    assert.ok(!fs.existsSync(path.dirname(file)), 'no memory folder to start with');
    const uri = uriOf(file);
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual({ name: got.body.name, content: got.body.content, version: got.body.version },
      { name: 'README.md', content: '', version: '' });

    const w = await put(s, uri, 'first words\n', '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first words\n');
    assert.strictEqual(w.body.version, sha256('first words\n'));

    // and now it is an ordinary file: the create version no longer applies
    const again = await put(s, uri, 'clobber\n', '');
    assert.strictEqual(again.status, 409);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first words\n');
  } finally { await s.stop(); }
});

test('a retired lieutenant’s charter stops being editable — the id is what the gate matches', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = writeCharter(s, 'mine\n');
    assert.strictEqual((await get(s, uriOf(file))).status, 200);
    const r = await s.api('DELETE', '/api/lieutenants/ada', { actor: 'user' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await refused(s, uriOf(file));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'mine\n', 'the file is kept, just not writable from here');
  } finally { await s.stop(); }
});

// ---------- hooks ----------

test('a hook written where none was is born EXECUTABLE — there is no chmod on a phone', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.mkdirSync(hooksDir(s.dir), { recursive: true });
    const file = path.join(hooksDir(s.dir), 'brand-new');
    const uri = uriOf(file);
    // A board-owned file that is not written yet reads as the empty document at
    // version '' — whatever kind it is. The board built this path, so "not
    // there" is a state, not a 404, and '' is exactly what the PUT reads as "I
    // expect no file".
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual(
      { content: got.body.content, version: got.body.version }, { content: '', version: '' });

    const w = await put(s, uri, '#!/bin/sh\necho hi\n', '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.ok(isExec(file));
    // and it is a hook the moment it lands
    assert.ok(await listsHook(s, 'brand-new'));
  } finally { await s.stop(); }
});

// A workspace that has never had a hook has no hooks/ either, and that must not
// be the one place a lieutenant cannot write the first one. hooks/ is a fixed
// name the board owns, so the board makes it, exactly as it makes a
// lieutenant's memory folder.
test('the FIRST hook in a workspace creates hooks/ — the board owns that name', async () => {
  const s = await startServerWithLieutenant();
  try {
    assert.ok(!fs.existsSync(hooksDir(s.dir)), 'no hooks directory to start with');
    const file = path.join(hooksDir(s.dir), 'gh-watch');
    const w = await put(s, uriOf(file), '#!/bin/sh\necho hi\n', '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho hi\n');
    assert.ok(isExec(file), 'and born executable');
    assert.ok(await listsHook(s, 'gh-watch'));
  } finally { await s.stop(); }
});

// The gate that writes hooks lets the writer pick the basename, and NAME_RE says
// a dot is fine — so `report.html` is a legal hook. The viewer's one exemption
// (a curated .html artifact renders instead of downloading) exists for a file the
// captain promoted onto a card by hand; a hook is never that. So a hook keeps the
// sandbox and the attachment disposition every other non-card artifact gets, and
// writing one is not a way to get script onto the board's own origin.
test('a hook named report.html is served sandboxed and as an attachment, never rendered', async () => {
  const s = await startServerWithLieutenant();
  try {
    const uri = uriOf(path.join(hooksDir(s.dir), 'report.html'));
    const body = '<!doctype html><script>fetch("/api/board")</script>';
    const w = await put(s, uri, body, '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));

    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-security-policy'), 'sandbox');
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(await res.text(), body);
  } finally { await s.stop(); }
});

// An event directory is not a fixed name: creating one invents a lifecycle
// event, and a typo'd event is a hook that silently never fires, forever. So it
// stays a refusal — but an HONEST one: the name is fine, the id is fine, the
// directory is what is missing, and "unknown artifact" would be a lie.
test('a hook in an event directory that is not there is refused by NAME, not as an unknown artifact', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.mkdirSync(hooksDir(s.dir), { recursive: true });
    const missing = path.join(hooksDir(s.dir), 'worker-dnoe', 'sweep.sh'); // the typo is the point
    for (const r of [await get(s, uriOf(missing)), await put(s, uriOf(missing), '#!/bin/sh\n', '')]) {
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /no hook event directory "worker-dnoe"/);
      for (const e of LIFECYCLE_EVENTS) assert.ok(r.body.error.includes(e), 'it names ' + e);
      assert.ok(!/unknown artifact/.test(r.body.error), 'and never pretends the path is unknown');
    }
    assert.ok(!fs.existsSync(path.dirname(missing)), 'nothing was created for a typo');
  } finally { await s.stop(); }
});

test('an event directory that IS there takes the write, and the board never invents one', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.mkdirSync(path.join(hooksDir(s.dir), 'worker-done'), { recursive: true });
    const file = path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh');
    const w = await put(s, uriOf(file), '#!/bin/sh\n', '');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.ok(isExec(file));
  } finally { await s.stop(); }
});

// A workspace reached through a symlinked parent is ordinary, not exotic: /tmp
// is one on macOS, and ~/work → /mnt/data/work is one anywhere. The gate
// realpaths the directory a hook sits in, so the path it compares against has to
// be resolved the same way — or the board refuses its OWN hooks, every ✎ on the
// tab answers "unknown artifact", and nothing in that message points at why.
test('a workspace reached through a SYMLINK edits its hooks like any other', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-linkws-')));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  const s = await startServerWithLieutenant({ dir: link });
  try {
    writeExec(path.join(hooksDir(real), 'gh-watch'), '#!/bin/sh\necho v1\n');
    // the uri under test is the one the tab is handed, not one the test spells
    const listed = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.name === 'gh-watch');
    assert.ok(listed, 'the board lists it');

    const got = await get(s, uriOf(listed.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.content, '#!/bin/sh\necho v1\n');
    const w = await put(s, uriOf(listed.file), '#!/bin/sh\necho v2\n', got.body.version);
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(fs.readFileSync(path.join(hooksDir(real), 'gh-watch'), 'utf8'), '#!/bin/sh\necho v2\n');

    // …and a lifecycle hook, two levels down, through the same link
    const sweep = writeExec(path.join(hooksDir(real), 'worker-done', 'sweep.sh'), '#!/bin/sh\nexit 0\n');
    const two = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.event === 'worker-done');
    assert.ok(two, 'the board lists that one too');
    const g2 = await get(s, uriOf(two.file));
    assert.strictEqual(g2.status, 200, JSON.stringify(g2.body));
    const p2 = await put(s, uriOf(two.file), '#!/bin/sh\nexit 1\n', g2.body.version);
    assert.strictEqual(p2.status, 200, JSON.stringify(p2.body));
    assert.strictEqual(fs.readFileSync(sweep, 'utf8'), '#!/bin/sh\nexit 1\n');
  } finally {
    await s.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The board's own directory is one the board MAKES — `--workspace ~/boards/new`
// through a symlinked ~/boards is the first boot of a new board, not an error.
// Giving up on the link because the leaf is not there yet costs that whole
// process every hook it has, and a restart quietly fixing it is what makes the
// symptom impossible to place.
test('a workspace directory that does not exist YET still resolves through the link', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-newws-')));
  const real = path.join(tmp, 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, path.join(tmp, 'link'));
  const fresh = path.join(tmp, 'link', 'newboard'); // nothing there — the server makes it
  const s = await startServerWithLieutenant({ dir: fresh });
  try {
    assert.ok(fs.existsSync(path.join(real, 'newboard')), 'the board was born through the link');
    writeExec(path.join(hooksDir(path.join(real, 'newboard')), 'gh-watch'), '#!/bin/sh\necho v1\n');
    const listed = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.name === 'gh-watch');
    assert.ok(listed, 'the board lists it');
    const got = await get(s, uriOf(listed.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const w = await put(s, uriOf(listed.file), '#!/bin/sh\necho v2\n', got.body.version);
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(
      fs.readFileSync(path.join(hooksDir(path.join(real, 'newboard')), 'gh-watch'), 'utf8'),
      '#!/bin/sh\necho v2\n');
  } finally {
    await s.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The same link, one level down: a CARD artifact added through a symlinked
// directory (`bc-axi card artifact add --uri /tmp/x.md` on macOS) read fine and
// could never be saved — the gate refuses a path whose realpath differs. The
// board stores the real directory at add time; a symlinked LEAF is still refused.
test('a card artifact added through a symlinked directory saves; a symlinked leaf still does not', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-linkart-')));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const s = await startServerWithLieutenant();
  try {
    fs.writeFileSync(path.join(real, 'notes.md'), 'v1\n');
    for (const given of [path.join(link, 'notes.md'), uriOf(path.join(link, 'notes.md'))]) {
      const { id, uri } = await cardWithArtifact(s, given, 'notes');
      assert.strictEqual(uri, uriOf(path.join(real, 'notes.md')), 'stored through the real directory: ' + given);
      const got = await get(s, uri);
      assert.strictEqual(got.status, 200, JSON.stringify(got.body));
      const w = await put(s, uri, got.body.content + 'more\n', got.body.version);
      assert.strictEqual(w.status, 200, JSON.stringify(w.body));
      // the path the caller knows still names the entry
      const rm = await s.api('DELETE', '/api/cards/' + id + '/artifacts', { uri: given });
      assert.strictEqual(rm.body.removed, true, JSON.stringify(rm.body));
    }
    assert.strictEqual(fs.readFileSync(path.join(real, 'notes.md'), 'utf8'), 'v1\nmore\nmore\n');

    fs.writeFileSync(path.join(real, 'target.md'), 'the real file\n');
    fs.symlinkSync(path.join(real, 'target.md'), path.join(real, 'leaf.md'));
    const { uri } = await cardWithArtifact(s, path.join(link, 'leaf.md'), 'leaf');
    assert.strictEqual(uri, uriOf(path.join(real, 'leaf.md')), 'the directory is followed, the leaf is not');
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const w = await put(s, uri, 'overwritten\n', got.body.version);
    assert.strictEqual(w.status, 403, JSON.stringify(w.body));
    assert.match(w.body.error, /symlink/);
    assert.strictEqual(fs.readFileSync(path.join(real, 'target.md'), 'utf8'), 'the real file\n');
  } finally {
    await s.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- what the gate refuses ----------
// One test per row, named by the row: each is a reason this is a gate and not
// a workspace file API, and a failing row must name itself rather than let a
// collapsed test hide which edge rotted. `after` asserts nothing was written.

const REFUSALS = [
  { name: 'card: a path that is not any card artifact',
    get: null, error: /not an artifact|only file:\/\//,
    async setup(s) {
      const listed = path.join(s.dir, 'listed.md');
      const secret = path.join(s.dir, 'secret.txt');
      fs.writeFileSync(listed, 'listed\n');
      fs.writeFileSync(secret, 'do not touch\n');
      await cardWithArtifact(s, listed, 'the one artifact');
      return {
        uris: ['file://' + secret, secret, 'file:///etc/hosts', '/etc/hosts'],
        version: sha256('do not touch\n'),
        after: () => assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'do not touch\n'),
      };
    } },
  // A file:// uri is stored verbatim, so a `..` inside one sails through the
  // allowlist's string compare. The path guard is what stops it before disk:
  // path.resolve is a no-op on an already-clean absolute path, so anything it
  // changes was not clean.
  { name: 'card: a listed uri with a traversal segment (normalize, then compare)',
    get: null, error: /unsafe artifact path/,
    async setup(s) {
      const secret = path.join(s.dir, 'secret.txt');
      fs.writeFileSync(secret, 'do not touch\n');
      fs.mkdirSync(path.join(s.dir, 'sub'));
      const uri = 'file://' + path.join(s.dir, 'sub') + '/../secret.txt';
      const stored = await cardWithArtifact(s, uri);
      assert.strictEqual(stored.uri, uri, 'stored verbatim — the allowlist alone would pass it');
      return {
        uris: [uri], version: sha256('do not touch\n'),
        after: () => assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'do not touch\n'),
      };
    } },
  // It still READS (the viewer has always followed the file), so the version
  // the editor holds is a genuine one — the refusal is specific to writing.
  { name: 'card: a listed artifact that is a symlink; the link target is never written',
    get: 200, error: /symlink/,
    async setup(s) {
      const target = path.join(s.dir, 'outside.txt');
      const link = path.join(s.dir, 'innocent.md');
      fs.writeFileSync(target, 'the real file\n');
      fs.symlinkSync(target, link);
      const { uri } = await cardWithArtifact(s, link, 'looks like an artifact');
      return {
        uris: [uri], version: (await get(s, uri)).body.version,
        after: () => assert.strictEqual(fs.readFileSync(target, 'utf8'), 'the real file\n'),
      };
    } },

  { name: 'playbook: a file outside the playbooks dir',
    async setup(s) {
      writePlaybook(s, 'default.md', 'ok\n');
      const outside = path.join(s.dir, 'notes.md');
      fs.writeFileSync(outside, 'private\n');
      return { uris: [uriOf(outside)], after: () => assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'private\n') };
    } },
  { name: 'playbook: a traversal out of the playbooks dir — the client never supplies a prefix',
    async setup(s) {
      const dir = path.dirname(writePlaybook(s, 'default.md', 'ok\n'));
      const board = path.join(s.dir, '.bridge-commander', 'board.json');
      const before = fs.readFileSync(board, 'utf8');
      return {
        // the un-normalized spelling too — the string is what arrives, not a path object
        uris: [uriOf(path.join(dir, '..', '..', 'board.json')), 'file://' + dir + '/../../board.json'],
        after: () => assert.strictEqual(fs.readFileSync(board, 'utf8'), before, 'the board is untouched'),
      };
    } },
  { name: 'playbook: a non-.md file in the playbooks dir',
    async setup(s) {
      writePlaybook(s, 'default.md', 'ok\n');
      const f = writePlaybook(s, 'notes.txt', 'not a playbook\n');
      return { uris: [uriOf(f)], after: () => assert.strictEqual(fs.readFileSync(f, 'utf8'), 'not a playbook\n') };
    } },
  { name: 'playbook: a symlink in the playbooks dir pointing outside it is not followed',
    async setup(s) {
      const dir = path.dirname(writePlaybook(s, 'default.md', 'ok\n'));
      const secret = path.join(s.dir, 'secret.md');
      fs.writeFileSync(secret, 'the good stuff\n');
      fs.symlinkSync(secret, path.join(dir, 'sneaky.md'));
      return { uris: [uriOf(path.join(dir, 'sneaky.md'))], after: () => assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n') };
    } },
  { name: 'playbook: a .md in a SUBDIRECTORY — directly inside means directly',
    async setup(s) {
      const dir = path.dirname(writePlaybook(s, 'default.md', 'ok\n'));
      fs.mkdirSync(path.join(dir, 'sub'));
      const f = path.join(dir, 'sub', 'nested.md');
      fs.writeFileSync(f, 'nested\n');
      return { uris: [uriOf(f)], after: () => assert.strictEqual(fs.readFileSync(f, 'utf8'), 'nested\n') };
    } },

  { name: 'charter: the README of an id no lieutenant holds',
    async setup(s) {
      writeCharter(s, 'mine\n');
      const ghost = writeCharter(s, 'not a lieutenant\n', 'mallory');
      return { uris: [uriOf(ghost)], after: () => assert.strictEqual(fs.readFileSync(ghost, 'utf8'), 'not a lieutenant\n') };
    } },
  { name: 'charter: another file in the lieutenant’s own folder — the charter is README.md and only that',
    async setup(s) {
      const other = path.join(path.dirname(writeCharter(s, 'mine\n')), 'notes.md');
      fs.writeFileSync(other, 'private\n');
      return { uris: [uriOf(other)], after: () => assert.strictEqual(fs.readFileSync(other, 'utf8'), 'private\n') };
    } },
  { name: 'charter: a README in a SUBDIRECTORY of the lieutenant’s folder — not a tree to edit',
    async setup(s) {
      const sub = path.join(path.dirname(writeCharter(s, 'mine\n')), 'examples');
      fs.mkdirSync(sub, { recursive: true });
      const nested = path.join(sub, 'README.md');
      fs.writeFileSync(nested, 'nested\n');
      return { uris: [uriOf(nested)], after: () => assert.strictEqual(fs.readFileSync(nested, 'utf8'), 'nested\n') };
    } },
  { name: 'charter: a charter that is a symlink is not followed',
    async setup(s) {
      const file = charterPath(s.dir, 'ada');
      const secret = path.join(s.dir, 'secret.md');
      fs.writeFileSync(secret, 'the good stuff\n');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(secret, file);
      return { uris: [uriOf(file)], after: () => assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n') };
    } },
  { name: 'charter: a traversal out of the lieutenants folder — the client never supplies a prefix',
    async setup(s) {
      const file = writeCharter(s, 'mine\n');
      const dir = path.dirname(file);
      const board = path.join(s.dir, '.bridge-commander', 'board.json');
      const before = fs.readFileSync(board, 'utf8');
      return {
        uris: [
          uriOf(path.join(dir, '..', '..', '.bridge-commander', 'board.json')),
          'file://' + dir + '/../../.bridge-commander/board.json',
          // one that spells its way BACK to a real charter is still not one
          'file://' + dir + '/../ada/README.md',
        ],
        after: () => {
          assert.strictEqual(fs.readFileSync(board, 'utf8'), before, 'the board is untouched');
          assert.strictEqual(fs.readFileSync(file, 'utf8'), 'mine\n', 'and so is the charter');
        },
      };
    } },

  { name: 'hook: a path OUTSIDE hooks/, however ordinary it looks',
    async setup(s) {
      fs.mkdirSync(hooksDir(s.dir), { recursive: true });
      const outside = path.join(s.dir, '.bridge-commander', 'gh-watch');
      fs.writeFileSync(outside, 'not a hook\n');
      // the state dir's own files are the point of the refusal
      const board = path.join(s.dir, '.bridge-commander', 'board.json');
      const before = fs.readFileSync(board, 'utf8');
      return {
        uris: [uriOf(outside), uriOf(board)],
        after: () => {
          assert.strictEqual(fs.readFileSync(board, 'utf8'), before);
          assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'not a hook\n');
        },
      };
    } },
  { name: 'hook: a hook that is a SYMLINK is not followed',
    async setup(s) {
      fs.mkdirSync(hooksDir(s.dir), { recursive: true });
      const secret = path.join(s.dir, 'secret.sh');
      fs.writeFileSync(secret, 'the good stuff\n');
      const link = path.join(hooksDir(s.dir), 'innocent');
      fs.symlinkSync(secret, link);
      return { uris: [uriOf(link)], after: () => assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n') };
    } },
  { name: 'hook: a hook inside a symlinked EVENT directory is not followed',
    async setup(s) {
      fs.mkdirSync(hooksDir(s.dir), { recursive: true });
      const elsewhere = path.join(s.dir, 'elsewhere');
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'sweep.sh'), 'theirs\n');
      fs.symlinkSync(elsewhere, path.join(hooksDir(s.dir), 'worker-done'));
      return {
        uris: [uriOf(path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh'))],
        after: () => assert.strictEqual(fs.readFileSync(path.join(elsewhere, 'sweep.sh'), 'utf8'), 'theirs\n'),
      };
    } },
  { name: 'hook: a TRAVERSAL out of hooks/ — the client never supplies a prefix',
    async setup(s) {
      const dir = hooksDir(s.dir);
      const real = writeExec(path.join(dir, 'real'), '#!/bin/sh\nexit 0\n');
      const board = path.join(s.dir, '.bridge-commander', 'board.json');
      const before = fs.readFileSync(board, 'utf8');
      return {
        uris: [
          uriOf(path.join(dir, '..', 'board.json')),
          'file://' + dir + '/../board.json',
          'file://' + dir + '/worker-done/../../board.json',
          // one that spells its way BACK into hooks/ is still not a hook path
          'file://' + dir + '/../hooks/real',
        ],
        after: () => {
          assert.strictEqual(fs.readFileSync(board, 'utf8'), before, 'the board is untouched');
          assert.strictEqual(fs.readFileSync(real, 'utf8'), '#!/bin/sh\nexit 0\n');
        },
      };
    } },
  { name: 'hook: a DIRECTORY — an event dir is not a file to edit',
    async setup(s) {
      const eventDir = path.join(hooksDir(s.dir), 'worker-done');
      fs.mkdirSync(eventDir, { recursive: true });
      return {
        uris: [uriOf(eventDir), uriOf(hooksDir(s.dir))],
        after: () => assert.ok(fs.statSync(eventDir).isDirectory(), 'still a directory'),
      };
    } },
  { name: 'hook: a THIRD level — hooks/ is one level of events, not a tree',
    async setup(s) {
      const deep = writeExec(path.join(hooksDir(s.dir), 'worker-done', 'lib', 'helper.sh'), '#!/bin/sh\n');
      return { uris: [uriOf(deep)], after: () => assert.strictEqual(fs.readFileSync(deep, 'utf8'), '#!/bin/sh\n') };
    } },
];

for (const row of REFUSALS) {
  test('refused — ' + row.name, async () => {
    const s = await startServerWithLieutenant();
    try {
      const { uris, version, after } = await row.setup(s);
      for (const uri of uris) {
        await refused(s, uri, { get: row.get === undefined ? 404 : row.get, version, error: row.error });
      }
      after();
    } finally { await s.stop(); }
  });
}

// ---------- the live side: SSE announce and the CLI door ----------
// The captain saves through PUT /api/artifact and gets a 409 when the file
// moved; an agent must get the SAME check, through the server, and a refused
// write must be REPORTED (exit 1), never swallowed. A write that lands
// announces itself on the board SSE (event `artifact`), carrying the writer's
// client tag so the tab that saved ignores its own echo.

// Keep an SSE stream open and pull frames one at a time; next(ms) resolves the
// next non-ping frame as {event, data}, or null when the window closes quiet.
async function sseReader(base) {
  const res = await fetch(base + '/api/events');
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending = null;
  async function next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end !== -1) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = (/^event: (.*)$/m.exec(frame) || [])[1];
        if (event === 'ping') continue;
        const raw = (/^data: (.*)$/m.exec(frame) || [])[1];
        return { event, data: raw ? JSON.parse(raw) : null };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      if (!pending) pending = reader.read();
      const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok('timeout'), left))]);
      if (r === 'timeout') return null;
      pending = null;
      if (r.done) return null;
      buf += dec.decode(r.value, { stream: true });
    }
  }
  return { next, close: () => reader.cancel().catch(() => {}) };
}

const cliArgs = (s) => ['--workspace', s.dir, '--port', String(s.port)];
const versionOf = (stderr) => (/version: ([0-9a-f]{64})/.exec(stderr) || [])[1];

test('a landed write announces itself on the board SSE — uri, new version, and who wrote it', async () => {
  const s = await startServerWithLieutenant();
  const sse = await sseReader(s.base);
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'one\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    assert.strictEqual((await sse.next(2000)).event, 'board'); // the on-connect hello
    assert.strictEqual((await sse.next(2000)).event, 'board'); // card created
    assert.strictEqual((await sse.next(2000)).event, 'board'); // artifact promoted

    const v = (await get(s, uri)).body.version;
    const w = await s.api('PUT', '/api/artifact', { uri, content: 'two\n', version: v, client: 'tab-7' });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));

    const ev = await sse.next(2000);
    assert.strictEqual(ev.event, 'artifact', 'the write is announced on the stream that already exists');
    assert.strictEqual(ev.data.uri, uri);
    assert.strictEqual(ev.data.version, sha256('two\n'), 'the new version, so an open editor can tell it from its own');
    assert.strictEqual(ev.data.by, 'tab-7', 'the writer is named — that is how a tab ignores its own echo');
    assert.strictEqual(await sse.next(400), null, 'and nothing else — no board re-push for a file write');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('a REFUSED write announces nothing — no phantom update on anybody\'s screen', async () => {
  const s = await startServerWithLieutenant();
  const sse = await sseReader(s.base);
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'on disk\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    while (await sse.next(300)) {} // drain the board pushes from the setup

    const w = await put(s, uri, 'nope\n', sha256('stale'));
    assert.strictEqual(w.status, 409);
    assert.strictEqual(await sse.next(500), null, 'nothing was written, so nothing is announced');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'on disk\n');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('cli: artifact read hands out content + version; write with it lands', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, '# brief\n\noriginal\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = cliArgs(s);

    const read = await runCli(['artifact', 'read', uri, ...args]);
    assert.strictEqual(read.code, 0, read.stderr);
    assert.strictEqual(read.stdout, '# brief\n\noriginal\n', 'content on stdout, byte for byte');
    const version = versionOf(read.stderr);
    assert.strictEqual(version, sha256('# brief\n\noriginal\n'), 'the version is on stderr, ready to hand back');

    // --json is the same thing in one piece, for a caller that would rather parse
    const asJson = await runCli(['artifact', 'read', uri, '--json', ...args]);
    assert.deepStrictEqual(JSON.parse(asJson.stdout), { name: 'brief.md', version, content: '# brief\n\noriginal\n' });

    const edited = path.join(s.dir, 'edited.md');
    fs.writeFileSync(edited, '# brief\n\nrewritten by the agent\n');
    const wrote = await runCli(['artifact', 'write', uri, '--file', edited, '--version', version, ...args]);
    assert.strictEqual(wrote.code, 0, wrote.stderr);
    assert.match(wrote.stdout, /wrote .*brief\.md/);
    assert.match(wrote.stdout, new RegExp(sha256('# brief\n\nrewritten by the agent\n')));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# brief\n\nrewritten by the agent\n');
  } finally { await s.stop(); }
});

// THE defect the CLI door exists to prevent: a write that did not happen and
// does not say so. The exit code and the words both have to carry it.
test('cli: writing with a stale version writes NOTHING and says so loudly (exit 1)', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'as the agent read it\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = cliArgs(s);
    const stale = versionOf((await runCli(['artifact', 'read', uri, ...args])).stderr);

    // the captain saves while the agent is thinking
    const captain = 'the captain rewrote this paragraph\n';
    fs.writeFileSync(file, captain);

    const mine = path.join(s.dir, 'mine.md');
    fs.writeFileSync(mine, 'the agent version\n');
    const r = await runCli(['artifact', 'write', uri, '--file', mine, '--version', stale, ...args]);
    assert.strictEqual(r.code, 1, 'a refused write is a FAILED command, not a quiet no-op');
    assert.match(r.stderr, /NOT WRITTEN/, 'and it says so in words');
    assert.match(r.stderr, new RegExp(sha256(captain)), 'naming the version that is there now');
    assert.match(r.stderr, /artifact read/, 'and what to do about it');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), captain, "the captain's text survives untouched");

    // re-read, redo on top, write with the new version: that lands
    const fresh = versionOf((await runCli(['artifact', 'read', uri, ...args])).stderr);
    fs.writeFileSync(mine, captain + 'plus the agent line\n');
    const again = await runCli(['artifact', 'write', uri, '--file', mine, '--version', fresh, ...args]);
    assert.strictEqual(again.code, 0, again.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), captain + 'plus the agent line\n');
  } finally { await s.stop(); }
});

test('cli: artifact write refuses to guess — no --version means no write', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'untouched\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = cliArgs(s);
    const mine = path.join(s.dir, 'mine.md');
    fs.writeFileSync(mine, 'mine\n');

    const r = await runCli(['artifact', 'write', uri, '--file', mine, ...args]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /usage: bc-axi artifact write/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'untouched\n');

    // and the server's own guards still answer through the CLI: an unlisted path
    const secret = path.join(s.dir, 'secret.txt');
    fs.writeFileSync(secret, 'do not touch\n');
    const bad = await runCli(['artifact', 'write', 'file://' + secret, '--file', mine, '--version', sha256('do not touch\n'), ...args]);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.stderr, /not an artifact of any card/);
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'do not touch\n');
  } finally { await s.stop(); }
});

// `bc-axi artifact write` once guarded on a FALSY --version, so the one version
// `artifact read` hands out for a file nobody wrote yet was the one version it
// would not take. Asserted end to end, through the CLI.
test('cli: artifact read then write CREATES the first hook — the empty version is a real one', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(hooksDir(s.dir), 'gh-watch');
    const uri = uriOf(file);
    const args = cliArgs(s);

    const read = await runCli(['artifact', 'read', uri, ...args]);
    assert.strictEqual(read.code, 0, read.stderr);
    assert.strictEqual(read.stdout, '', 'a board-owned file nobody wrote yet reads as the empty document');
    assert.match(read.stderr, /^version: *$/m, 'at version ""');

    const body = path.join(s.dir, 'draft.sh');
    fs.writeFileSync(body, '#!/bin/sh\nbc-axi event "$BC_CARD" --kind note\n');
    const wrote = await runCli(['artifact', 'write', uri, '--file', body, '--version', '', ...args]);
    assert.strictEqual(wrote.code, 0, wrote.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\nbc-axi event "$BC_CARD" --kind note\n');
    assert.ok(isExec(file), 'and born executable, like any other hook');
    assert.ok(await listsHook(s, 'gh-watch'), 'a lieutenant wrote a hook with nothing but the CLI');

    // …and the door still closes behind it: the version that just landed is the
    // only one the next write may carry.
    const stale = await runCli(['artifact', 'write', uri, '--file', body, '--version', '', ...args]);
    assert.strictEqual(stale.code, 1, 'an empty version means "no file yet" — and there is one now');
    assert.match(stale.stderr, /NOT WRITTEN/);
  } finally { await s.stop(); }
});

// What the editor marks after taking an outside write. 0-based line numbers,
// because that is what CodeMirror counts in.
test('changedLines names the lines the other hand touched', async () => {
  const { changedLines } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);

  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nb\nc\n'), [], 'identical text marks nothing');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nB\nc\n'), [1], 'one line rewritten');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nx\ny\nb\nc\n'), [1, 2], 'two lines inserted — only they are marked');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nb\nc\nd\n'), [3], 'appended at the end');
  assert.deepStrictEqual(changedLines('', 'hello\n'), [0], 'a file that was empty');
  // a pure deletion leaves no new line to mark, so the seam carries it — the
  // captain still gets a mark to look at instead of a silent shrink
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nc\n'), [1]);
  assert.deepStrictEqual(changedLines('a\nb\n', ''), [0]);
});
