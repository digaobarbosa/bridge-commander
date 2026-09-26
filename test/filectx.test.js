'use strict';
// The promise of the co-edit screen: "I select a piece and talk to you about
// it". That only holds if the file and the lines reach the LIEUTENANT, not just
// the composer. Two levels:
//
//  1. the format itself (ui/js/filectx.js — DOM-free, imported straight in);
//  2. end to end: a message sent that way arrives on the owning lieutenant's
//     queue — what the agent drains — carrying file, lines and snippet.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');

const mod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'filectx.js')).href);

test('a selection becomes file + lines + a fenced snippet', async () => {
  const { fileContextBlock } = await mod;
  const block = fileContextBlock({
    name: 'drain.py',
    lines: '33–35',
    text: 'async def _attempt(self, item):\n    return await self.deliver(item)',
  });
  assert.match(block, /`drain\.py`/, 'names the file');
  assert.match(block, /L33–35/, 'names the lines');
  assert.match(block, /```py\n/, 'fences the snippet with the language');
  assert.ok(block.includes('async def _attempt(self, item):'), 'carries the text itself');
  assert.ok(block.endsWith('\n\n'), 'leaves the captain\'s own words on their own line');
});

test('no selection still says which file is open', async () => {
  const { fileContextBlock } = await mod;
  const block = fileContextBlock({ name: 'brief.md' });
  assert.match(block, /`brief\.md`/);
  assert.ok(!block.includes('```'), 'nothing to quote, so no fence');
  assert.strictEqual(fileContextBlock(null), '', 'no file screen open → no context at all');
});

test('a snippet that is itself markdown cannot break out of its fence', async () => {
  const { fileContextBlock } = await mod;
  const block = fileContextBlock({ name: 'readme.md', lines: '1–3', text: 'text\n```\nfake close\n```\nmore' });
  const fence = /\n(`{4,})md\n/.exec(block);
  assert.ok(fence, 'the opening fence outruns the backticks inside');
  assert.ok(block.trimEnd().endsWith(fence[1]), 'and the closing fence matches it');
});

test('a message sent from the file screen reaches the lieutenant queue with the context', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Askable' }));
    const { fileContextBlock } = await mod;
    // exactly what the composer builds and posts
    const text = fileContextBlock({ name: 'drain.py', lines: '38–40', text: 'except TimeoutError:\n    await sleep(1)' }) +
      'does this need jitter?';
    const r = await s.api('POST', '/api/feedback', { target: 'card:askable', text });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // the queue is what the agent drains — the context has to be in there
    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.strictEqual(feed.body.items.length, 1);
    const item = feed.body.items[0];
    assert.strictEqual(item.kind, 'message');
    assert.strictEqual(item.target, 'card:askable', 'still the card thread — no new scope');
    assert.match(item.text, /`drain\.py`/, 'which file');
    assert.match(item.text, /L38–40/, 'which lines');
    assert.match(item.text, /except TimeoutError:/, 'the selected text');
    assert.match(item.text, /does this need jitter\?/, 'and the question it was asked about');

    // and the same message is the one in the card's thread (one conversation)
    const card = (await s.api('GET', '/api/cards/askable')).body;
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].text, text);
  } finally {
    await s.stop();
  }
});
