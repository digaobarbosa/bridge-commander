'use strict';
// server/watchers.js — the one skeleton for periodic work: overlap guard,
// catch + log with the id, unref'd timers, <=0 disables.
const test = require('node:test');
const assert = require('node:assert');
const { createWatchers } = require('../server/watchers.js');

// A timer seam the test drives by hand: fire(id) runs one due tick.
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval: (fn, ms) => {
      const t = { fn, ms, unrefed: false, cleared: false, unref() { this.unrefed = true; return this; } };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => { t.cleared = true; },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('register schedules an unref\'d timer at intervalMs; <=0 or NaN disables', () => {
  const ft = fakeTimers();
  const w = createWatchers(ft);
  w.register({ id: 'a', intervalMs: 50, tick: () => {} });
  w.register({ id: 'off', intervalMs: 0, tick: () => {} });
  w.register({ id: 'neg', intervalMs: -5, tick: () => {} });
  w.register({ id: 'nan', intervalMs: NaN, tick: () => {} });
  assert.strictEqual(ft.timers.length, 1);
  assert.strictEqual(ft.timers[0].ms, 50);
  assert.strictEqual(ft.timers[0].unrefed, true);
  assert.deepStrictEqual(w.list().map((x) => [x.id, x.enabled]), [['a', true], ['off', false], ['neg', false], ['nan', false]]);
});

test('a tick still running is never overlapped', async () => {
  const ft = fakeTimers();
  const w = createWatchers(ft);
  let calls = 0;
  let release;
  w.register({ id: 'slow', intervalMs: 10, tick: () => { calls++; return new Promise((r) => { release = r; }); } });
  const fire = ft.timers[0].fn;
  fire();
  fire();
  fire();
  assert.strictEqual(calls, 1);
  assert.strictEqual(w.list()[0].running, true);
  release();
  await flush();
  assert.strictEqual(w.list()[0].running, false);
  fire();
  assert.strictEqual(calls, 2);
  release();
  await flush();
});

test('a throwing tick (sync or async) is caught and logged with its id; the next tick still runs', async () => {
  const ft = fakeTimers();
  const logs = [];
  const w = createWatchers(Object.assign({ log: (m) => logs.push(m) }, ft));
  let n = 0;
  w.register({ id: 'boom', intervalMs: 10, tick: async () => { n++; throw new Error('saveBoard failed'); } });
  w.register({ id: 'sync', intervalMs: 10, tick: () => { throw new Error('sync fail'); } });
  const unhandled = [];
  const onRej = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRej);
  try {
    await ft.timers[0].fn();
    await ft.timers[1].fn();
    await ft.timers[0].fn();
    await flush();
  } finally {
    process.off('unhandledRejection', onRej);
  }
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(unhandled, []);
  assert.ok(logs.some((m) => /watcher boom/.test(m) && /saveBoard failed/.test(m)), logs.join('\n'));
  assert.ok(logs.some((m) => /watcher sync/.test(m) && /sync fail/.test(m)), logs.join('\n'));
  const boom = w.list().find((x) => x.id === 'boom');
  assert.strictEqual(boom.lastError, 'saveBoard failed');
  assert.strictEqual(boom.runs, 2);
});

test('dispose clears one watcher, stop clears all; a duplicate id is refused', () => {
  const ft = fakeTimers();
  const w = createWatchers(ft);
  const dispose = w.register({ id: 'a', intervalMs: 10, tick: () => {} });
  w.register({ id: 'b', intervalMs: 10, tick: () => {} });
  assert.throws(() => w.register({ id: 'b', intervalMs: 10, tick: () => {} }), /already registered/);
  dispose();
  assert.strictEqual(ft.timers[0].cleared, true);
  assert.deepStrictEqual(w.list().map((x) => x.id), ['b']);
  dispose(); // idempotent
  w.stop();
  assert.strictEqual(ft.timers[1].cleared, true);
  assert.deepStrictEqual(w.list(), []);
});

test('real timers: a tiny interval ticks and never keeps the process alive', async () => {
  const w = createWatchers();
  let n = 0;
  w.register({ id: 'real', intervalMs: 5, tick: () => { n++; } });
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.ok(n >= 2, 'ticked ' + n + ' times');
});
