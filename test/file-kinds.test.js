'use strict';
// util.js classifyFile / attachmentKind — which viewer a file name (or an
// attachment's mime) opens in. The case that went wrong once: audio names used
// to fall into the binary list and got a download instead of a player.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const util = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);

test('audio names open the player, never the download', async () => {
  const { classifyFile } = await util;
  for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'MP3']) {
    assert.strictEqual(classifyFile('reply.' + ext), 'audio', ext);
  }
});

test('every other kind lands in its own viewer', async () => {
  const { classifyFile } = await util;
  const cases = {
    'board.excalidraw': 'drawing', 'shot.PNG': 'image', 'd.svg': 'image', 'demo.mp4': 'video', 'clip.mov': 'video',
    'teach.html': 'html', 'brief.md': 'markdown', 'notes.txt': 'text', 'run.log': 'text', 'cfg.yaml': 'text',
    'bundle.zip': 'binary', 'spec.pdf': 'binary', 'font.woff2': 'binary',
    'worker.prompt': '', 'Makefile': '', '': '',
  };
  for (const [name, kind] of Object.entries(cases)) assert.strictEqual(classifyFile(name), kind, name || '(empty)');
});

test('an attachment goes by its mime first, then its name, and asks the server when neither says', async () => {
  const { attachmentKind } = await util;
  assert.strictEqual(attachmentKind('audio/mpeg', 'x.bin'), 'audio', 'the mime wins over the name');
  assert.strictEqual(attachmentKind('image/svg+xml', ''), 'image');
  assert.strictEqual(attachmentKind('application/json', ''), 'text');
  assert.strictEqual(attachmentKind('application/octet-stream', 'a.txt'), 'binary', 'a known mime with no viewer downloads');
  assert.strictEqual(attachmentKind('', 'voice.ogg'), 'audio', 'no mime: the name decides');
  assert.strictEqual(attachmentKind('', 'brief.md'), 'text');
  assert.strictEqual(attachmentKind('', 'teach.html'), 'text', 'an attached page shows as its source');
  assert.strictEqual(attachmentKind('', 'bundle.zip'), '', 'a name with no inline viewer leaves it to the served type');
  assert.strictEqual(attachmentKind('', 'screenshot from the call'), '');
});
