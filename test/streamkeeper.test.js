'use strict';
// ui/js/streamkeeper.js — what reopens the board stream and the 👁 pane after a
// server restart. BR2-2 measured the two ways a restart behind a proxy defeats
// EventSource's own retry: a 502 leaves it CLOSED for good, and a half-open proxy
// leaves it silent. The fake EventSource here is only a readyState; the clock is
// node's mock timers, so no test waits a real second.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let keepStream, backoffMs;
test.before(async () => {
  ({ keepStream, backoffMs } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'streamkeeper.js')).href));
});

const CONNECTING = 0, OPEN = 1, CLOSED = 2;

// A keeper over a counter of connects; the last "stream" is what error() sees.
function harness(t, staleMs = 12000) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const streams = [];
  const k = keepStream({ connect: () => streams.push({ readyState: CONNECTING }), staleMs });
  t.after(() => k.stop());
  return { k, streams, tick: (ms) => t.mock.timers.tick(ms) };
}

test('backoff doubles from 1 s and stops at 10 s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map(backoffMs), [1000, 2000, 4000, 8000, 10000, 10000]);
});

test('connects once at start', (t) => {
  const { streams } = harness(t);
  assert.strictEqual(streams.length, 1);
});

test('a CLOSED stream (a proxy 502) reopens after 1 s, then 2 s, then 4 s', (t) => {
  const { k, streams, tick } = harness(t);
  for (const [wait, total] of [[1000, 2], [2000, 3], [4000, 4]]) {
    streams.at(-1).readyState = CLOSED;
    k.error(streams.at(-1));
    tick(wait - 1);
    assert.strictEqual(streams.length, total - 1, 'not before ' + wait + ' ms');
    tick(1);
    assert.strictEqual(streams.length, total, 'reopened after ' + wait + ' ms');
  }
});

test('an open stream starts the backoff over', (t) => {
  const { k, streams, tick } = harness(t);
  streams.at(-1).readyState = CLOSED; k.error(streams.at(-1)); tick(1000);
  streams.at(-1).readyState = CLOSED; k.error(streams.at(-1)); tick(2000);
  k.opened();
  streams.at(-1).readyState = CLOSED; k.error(streams.at(-1));
  tick(1000);
  assert.strictEqual(streams.length, 4);
});

test('an error while CONNECTING is left to the browser retry', (t) => {
  const { k, streams, tick } = harness(t);
  k.error(streams.at(-1));
  tick(5000);
  assert.strictEqual(streams.length, 1);
});

test('two errors on one CLOSED stream reopen it once', (t) => {
  const { k, streams, tick } = harness(t);
  streams[0].readyState = CLOSED;
  k.error(streams[0]); k.error(streams[0]);
  tick(1000);
  assert.strictEqual(streams.length, 2);
});

test('a half-open stream reopens after the stale window, once per window', (t) => {
  const { k, streams, tick } = harness(t, 12000);
  for (let i = 0; i < 11; i++) { tick(1000); k.alive(); } // pings keep it alive
  assert.strictEqual(streams.length, 1);
  tick(12000);                                              // silence
  assert.strictEqual(streams.length, 1, 'not at exactly the window');
  tick(1000);
  assert.strictEqual(streams.length, 2, 'reopened within a second after it');
  tick(12000);
  assert.strictEqual(streams.length, 2);
  tick(1000);
  assert.strictEqual(streams.length, 3);
});

test('stop() ends the retry and the watchdog', (t) => {
  const { k, streams, tick } = harness(t);
  streams[0].readyState = CLOSED;
  k.error(streams[0]);
  k.stop();
  tick(60000);
  k.error(streams[0]);
  tick(60000);
  assert.strictEqual(streams.length, 1);
});
