'use strict';
// After the profiles slice, nothing in the core names an agent CLI: what a CLI
// is, how it launches and what its screens mean live in its harness profile
// (harness/*-tmux.js). The one literal left outside the profiles is the
// default in port.defaultHarness(). The board UI reads its harness list from
// GET /api/plugins; its one literal is the fallback for a server without it
// (plugins.js FALLBACK_HARNESSES).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js')).map((f) => path.join('server', f)),
  path.join('cli', 'bc-axi'),
  ...fs.readdirSync(path.join(ROOT, 'cli')).filter((f) => f.endsWith('.js')).map((f) => path.join('cli', f)),
];
// A quoted literal is code deciding on a CLI name; prose may mention one.
const LITERAL = /(['"`])(claude|codex)\1/;

test('no quoted CLI name in server/ or cli/', () => {
  const hits = [];
  for (const rel of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return; // a comment explains, it does not decide
      if (LITERAL.test(line)) hits.push(rel + ':' + (i + 1) + ': ' + line.trim());
    });
  }
  assert.deepStrictEqual(hits, [], 'harness names belong in the profile:\n' + hits.join('\n'));
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('no quoted CLI name in ui/ outside the fallback harness list', () => {
  const files = [...walk(path.join(ROOT, 'ui', 'js')).filter((f) => f.endsWith('.js')), path.join(ROOT, 'ui', 'index.html')];
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line) || /FALLBACK_HARNESSES = /.test(line)) return;
      if (LITERAL.test(line)) hits.push(path.relative(ROOT, file) + ':' + (i + 1) + ': ' + line.trim());
    });
  }
  assert.deepStrictEqual(hits, [], 'the dropdowns read GET /api/plugins harnesses:\n' + hits.join('\n'));
});
