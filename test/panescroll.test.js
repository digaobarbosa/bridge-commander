'use strict';
// ui/js/panescroll.js — the 👁 drawer's scroll anchor. A frame is a sliding
// window over the pane's history, so new output pushes lines off its top; the
// anchor measures how far, so a scrolled-up reader stays on the same text.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let frameSlide;
test.before(async () => {
  ({ frameSlide } = await import(
    pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'panescroll.js')).href));
});

const nums = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);

test('history that only grew at the bottom (or a repainted screen) is no slide', () => {
  const old = [...nums(1, 50), '❯ ', '  esc to interrupt'];
  assert.strictEqual(frameSlide(old, [...nums(1, 50), '❯ ', '  ? for shortcuts']), 0);
  assert.strictEqual(frameSlide(old, [...nums(1, 60), '❯ ', '  esc to interrupt']), 0);
});

test('a window that slid up by N lines reports N, so the reader lands on the same text', () => {
  const old = nums(1, 100);
  const now = nums(8, 107); // 7 lines of output pushed 7 lines off the top
  const d = frameSlide(old, now);
  assert.strictEqual(d, 7);
  assert.strictEqual(now[30 - d], old[30]);
});

test('blank lines at the head do not anchor: the probe uses non-blank lines', () => {
  const old = ['a', '', '', '', 'b', 'c', 'd', 'e'];
  const now = ['', '', '', 'b', 'c', 'd', 'e', 'f']; // slid up by 1
  assert.strictEqual(frameSlide(old, now), 1);
});

// Seen on a real claude pane: finishing a 300-line reply slid the 500-line
// window 79 lines in one frame, past the line the reader was on. The slide is
// still measured from the head, so the reader's scrollTop goes below 0 and
// clamps to the oldest line still in the frame.
test('a slide past the reader is still measured', () => {
  const d = frameSlide(nums(1, 500), nums(80, 579));
  assert.strictEqual(d, 79);
  assert.ok(40 - d < 0, 'a reader on row 40 is parked at the top');
});

test('a frame with nothing in common (a /clear) or nothing at all: no anchor', () => {
  assert.strictEqual(frameSlide(nums(1, 20), nums(500, 519)), null);
  assert.strictEqual(frameSlide(['x'], ['', '']), null);
});
