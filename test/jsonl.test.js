'use strict';
// server/jsonl.js — the one reader for append-only jsonl files. A torn line
// (a crash mid-append) costs that line, never the rest of the file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonl, sealJsonl } = require('../server/jsonl.js');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jsonl-'));
  const f = path.join(dir, 'x.jsonl');
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
}

test('readJsonl: missing file is empty, torn lines are skipped and reported', () => {
  assert.deepStrictEqual(readJsonl(path.join(os.tmpdir(), 'bc-no-such-file.jsonl')), []);
  const f = tmpFile('{"a":1}\n{"a":2,"b\n\n{"a":3}\n{"a":4');
  const bad = [];
  assert.deepStrictEqual(readJsonl(f, (l) => bad.push(l)), [{ a: 1 }, { a: 3 }]);
  assert.deepStrictEqual(bad, ['{"a":2,"b', '{"a":4']);
});

test('sealJsonl: ends a torn last line so the next append is its own line', () => {
  const f = tmpFile('{"a":1}\n{"a":2');
  assert.strictEqual(sealJsonl(f), true);
  fs.appendFileSync(f, '{"a":3}\n');
  assert.deepStrictEqual(readJsonl(f), [{ a: 1 }, { a: 3 }]);
  assert.strictEqual(sealJsonl(f), false, 'a clean file is left alone');
  assert.strictEqual(sealJsonl(tmpFile('')), false);
  assert.strictEqual(sealJsonl(tmpFile() + '.missing'), false);
});
