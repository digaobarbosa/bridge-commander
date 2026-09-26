'use strict';
// The file gate (server/filegate.js), as a table: which uris the artifact
// routes may read and write, against a real temp workspace. No server — the
// gate is a pure function of the disk and the board it is handed, and these
// rows are the security contract: traversal, symlinks, missing files, and the
// six allowed kinds.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileGate } = require('../server/filegate.js');
const { PACKAGED_PLAYBOOKS_DIR } = require('../server/playbooks.js');

function fixture() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-filegate-')));
  const put = (rel, text, mode) => {
    const f = path.join(ws, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, mode ? { mode } : undefined);
    return f;
  };
  const secret = put('secret.txt', 'SECRET');
  put('art/report.md', '# report');
  put('art/page.html', '<p>hi</p>');
  put('art/pic.png', 'PNG');
  fs.symlinkSync(secret, path.join(ws, 'art', 'link.md'));
  fs.mkdirSync(path.join(ws, 'elsewhere'));
  fs.symlinkSync(path.join(ws, 'elsewhere'), path.join(ws, 'linkdir'));
  put('.bridge-commander/playbooks/mine.md', 'playbook');
  fs.symlinkSync(secret, path.join(ws, '.bridge-commander/playbooks/evil.md'));
  put('lieutenants/scout/README.md', 'charter');
  fs.mkdirSync(path.join(ws, 'lieutenants', 'linky'));
  fs.symlinkSync(secret, path.join(ws, 'lieutenants', 'linky', 'README.md'));
  put('.bridge-commander/hooks/nightly', '#!/bin/sh\n', 0o755);
  put('.bridge-commander/hooks/report.html', '<script>x</script>', 0o755);
  put('.bridge-commander/hooks/worker-done/notify', '#!/bin/sh\n', 0o755);
  fs.symlinkSync(path.join(ws, 'elsewhere'), path.join(ws, '.bridge-commander/hooks/card-archived'));
  put('uploads/abcdef12__note.txt', 'uploaded');

  const f = (rel) => 'file://' + path.join(ws, rel);
  const listed = [
    'art/report.md', 'art/page.html', 'art/pic.png', 'art/link.md', 'art/new.svg', 'linkdir/new.txt',
  ].map((r) => ({ uri: f(r) }));
  listed.push({ uri: 'file://' + ws + '/art/../secret.txt' }); // listed, but not clean
  listed.push({ uri: 'attachment://abcdef12' });
  const board = {
    cards: [{ id: 'C-1', attributes: { artifacts: listed } }],
    lieutenants: [{ id: 'scout' }, { id: 'ghost' }, { id: 'linky' }],
  };
  const gate = createFileGate({
    workspace: ws,
    cards: () => board.cards,
    lieutenants: () => board.lieutenants,
    attachment: (id) => (id === 'abcdef12'
      ? { path: path.join(ws, 'uploads', 'abcdef12__note.txt'), name: 'note.txt', mime: 'text/plain' } : null),
    maxBytes: 1024,
  });
  return { ws, f, gate, secret };
}

test('classify: the allow-list, row by row', () => {
  const { ws, f, gate } = fixture();
  const packaged = 'file://' + path.join(PACKAGED_PLAYBOOKS_DIR, fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)
    .find((n) => n.endsWith('.md') && !/^readme/i.test(n)));
  const rows = [
    // uri                                          kind / error code          writable boardOwned
    [f('art/report.md'),                            'card', true, false],
    [f('art/new.svg'),                              'card', true, false],      // listed, not on disk yet
    ['attachment://abcdef12',                       'attachment', false, false],
    ['file://' + ws + '/art/../secret.txt',         'card', false, false],     // listed, but a `..` is never written
    [f('.bridge-commander/playbooks/mine.md'),      'playbook', true, false],
    [f('.bridge-commander/playbooks/other.md'),     'playbook', true, false],  // the copy-to-workspace create
    [packaged,                                      'packaged', false, false],
    [f('lieutenants/scout/README.md'),              'charter', true, true],
    [f('lieutenants/ghost/README.md'),              'charter', true, true],    // registered, never written
    [f('.bridge-commander/hooks/nightly'),          'hook', true, true],
    [f('.bridge-commander/hooks/fresh'),            'hook', true, true],       // a new named hook
    [f('.bridge-commander/hooks/worker-done/notify'), 'hook', true, true],
    // refused
    [f('secret.txt'),                               404],
    ['file://' + ws + '/art/../secret.txt/x',       404],                      // traversal, not listed
    [f('.bridge-commander/playbooks/../board.json'), 404],
    [f('.bridge-commander/playbooks/evil.md'),      404],                      // symlink in the playbooks dir
    [f('.bridge-commander/playbooks/notes.txt'),    404],                      // not a .md
    [f('lieutenants/nobody/README.md'),             404],                      // unregistered id
    [f('lieutenants/scout/other.md'),               404],
    [f('lieutenants/linky/README.md'),              404],                      // the charter is a symlink
    [f('.bridge-commander/hooks/card-archived/x'),  404],                      // symlinked event dir
    [f('.bridge-commander/hooks/a/b/c'),            404],                      // three deep
    [f('.bridge-commander/hooks/worker-done'),      404],                      // a directory, not a file
    [f('.bridge-commander/hooks/typo-event/x'),     400],                      // legal path, no such event
    ['attachment://ffff0000',                       404],                      // not listed
    ['/etc/passwd',                                 404],
    ['',                                            404],
    [null,                                          404],
  ];
  for (const [uri, want, writable, boardOwned] of rows) {
    const c = gate.classify(uri);
    if (typeof want === 'number') {
      assert.equal(c.code, want, 'refusal code for ' + uri + ': ' + JSON.stringify(c));
      assert.ok(c.error, 'refusal carries an error for ' + uri);
    } else {
      assert.deepEqual([c.kind, c.writable, c.boardOwned], [want, writable, boardOwned], 'row ' + uri);
    }
  }
});

test('read: text, ENOENT, symlinks and raw headers', () => {
  const { ws, f, gate } = fixture();
  const r = gate.read(f('art/report.md'));
  assert.equal(r.content, '# report');
  assert.equal(r.name, 'report.md');
  assert.match(r.version, /^[0-9a-f]{64}$/);
  // A board-owned file that is not there is the empty document; a card's is a 404.
  assert.deepEqual(gate.read(f('lieutenants/ghost/README.md')), { name: 'README.md', content: '', version: '' });
  assert.deepEqual(gate.read(f('.bridge-commander/hooks/fresh')), { name: 'fresh', content: '', version: '' });
  assert.equal(gate.read(f('art/new.svg')).code, 404);
  assert.equal(gate.read(f('secret.txt')).code, 404);
  // Raw: a clean file:// path only.
  assert.equal(gate.read('file://' + ws + '/art/../secret.txt', { raw: true }).code, 400);
  const html = gate.read(f('art/page.html'), { raw: true });
  assert.equal(html.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.ok(!('Content-Security-Policy' in html.headers), 'a curated page renders');
  // A hook's basename is the writer's choice: never rendered on the board's origin.
  const hook = gate.read(f('.bridge-commander/hooks/report.html'), { raw: true });
  assert.equal(hook.headers['Content-Security-Policy'], 'sandbox');
  const att = gate.read('attachment://abcdef12', { raw: true });
  assert.equal(att.headers['Content-Type'], 'text/plain');
  assert.equal(att.headers['Content-Security-Policy'], 'sandbox');
  assert.equal(String(att.bytes), 'uploaded');
});

test('write: the version guard, symlinks, creates and refusals', () => {
  const { ws, f, gate, secret } = fixture();
  const cur = gate.read(f('art/report.md'));
  // A stale version is a conflict carrying what is on disk; nothing is written.
  const stale = gate.write(f('art/report.md'), 'mine', 'nope');
  assert.deepEqual(stale.conflict, { version: cur.version, content: '# report' });
  assert.equal(fs.readFileSync(path.join(ws, 'art/report.md'), 'utf8'), '# report');
  const ok = gate.write(f('art/report.md'), 'mine', cur.version);
  assert.equal(ok.bytes, 4);
  assert.equal(gate.read(f('art/report.md')).version, ok.version);
  // A listed symlink is refused, and what it points at is untouched.
  assert.equal(gate.write(f('art/link.md'), 'x', gate.read(f('art/link.md')).version).code, 403);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET');
  // Create: '' means "I expect no file"; anything else is a 404.
  assert.equal(gate.write(f('art/new.svg'), '<svg/>', 'v1').code, 404);
  assert.ok(gate.write(f('art/new.svg'), '<svg/>', '').version);
  assert.equal(gate.write(f('art/new.svg'), '<svg/>', '').conflict.content, '<svg/>');
  // Created under a symlinked directory: refused.
  assert.equal(gate.write(f('linkdir/new.txt'), 'x', '').code, 403);
  assert.ok(!fs.existsSync(path.join(ws, 'elsewhere', 'new.txt')));
  // Board-owned creates: the charter folder is made, a new hook is born executable.
  assert.ok(gate.write(f('lieutenants/ghost/README.md'), 'hello', '').version);
  assert.ok(gate.write(f('.bridge-commander/hooks/fresh'), '#!/bin/sh\n', '').version);
  assert.equal(fs.statSync(path.join(ws, '.bridge-commander/hooks/fresh')).mode & 0o777, 0o755);
  // Refusals, with the messages the routes relay.
  assert.deepEqual(gate.write(f('secret.txt'), 'x', ''),
    { code: 403, error: 'not an artifact of any card — refusing to write' });
  assert.deepEqual(gate.write('file://' + ws + '/art/../secret.txt', 'x', ''),
    { code: 403, error: 'unsafe artifact path' });
  assert.deepEqual(gate.write('attachment://abcdef12', 'x', ''),
    { code: 403, error: 'only file:// artifacts are writable' });
  assert.equal(gate.write(f('.bridge-commander/hooks/typo-event/x'), 'x', '').code, 400);
  const pb = gate.write('file://' + path.join(PACKAGED_PLAYBOOKS_DIR, 'investigation.md'), 'x', '');
  assert.deepEqual(pb, { code: 403, error: 'a packaged playbook is never written — copy it to the workspace first' });
  assert.equal(gate.write(f('art/report.md'), 'x'.repeat(2000), ok.version).code, 413);
});

test('readDir: only the folder of a listed artifact, and only inside it', () => {
  const { ws, gate } = fixture();
  const art = path.join(ws, 'art');
  assert.equal(gate.dirServable(art), true);
  assert.equal(gate.dirServable(ws), false);
  assert.equal(gate.dirServable(art + '/../art'), false);
  const r = gate.readDir(art, 'pic.png');
  assert.equal(String(r.bytes), 'PNG');
  assert.equal(r.headers['Content-Type'], 'image/png');
  assert.equal(gate.readDir(art, '../secret.txt').code, 403);
  assert.equal(gate.readDir(art, 'missing.png').code, 404);
  assert.equal(gate.readDir(ws, 'secret.txt').code, 404);
});
