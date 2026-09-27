'use strict';
// watchers — periodic work with one skeleton: an overlap guard, a catch that
// names the watcher, and an unref'd timer. Supervision and the PR watch used to
// copy-paste this (without the catch, so a throwing save became an unhandled
// rejection); a plugin's watcher gets the same guarantees through
// ctx.watchers.register.
//
// Node built-ins only.

/**
 * createWatchers(deps) -> { register, list, stop }
 *   log(msg)            where a failed tick is reported (default: stderr)
 *   setInterval         timer seam for tests (default: the global)
 *   clearInterval       its pair (default: the global)
 *
 * register({id, intervalMs, tick}) -> dispose()
 *   intervalMs that is not a positive integer disables the watcher: it is
 *   listed but never scheduled (BC_*_INTERVAL_MS=0 is how tests silence one).
 *   A tick still running when the next one is due is skipped, never overlapped.
 */
function createWatchers({
  log = (msg) => console.error(msg),
  setInterval: setIv = setInterval,
  clearInterval: clearIv = clearInterval,
} = {}) {
  const all = new Map(); // id -> entry

  function register({ id, intervalMs, tick }) {
    if (typeof id !== 'string' || !id) throw new Error('watcher id required');
    if (typeof tick !== 'function') throw new Error('watcher ' + id + ': tick must be a function');
    if (all.has(id)) throw new Error('watcher ' + id + ' is already registered');
    const enabled = Number.isInteger(intervalMs) && intervalMs > 0;
    const w = { id, intervalMs, enabled, running: false, runs: 0, lastError: null, timer: null };

    async function fire() {
      if (w.running) return; // never overlap ticks
      w.running = true;
      try {
        await tick();
        w.lastError = null;
      } catch (e) {
        w.lastError = String((e && e.message) || e);
        try { log('watcher ' + id + ' tick failed: ' + w.lastError); } catch (_) { /* a broken logger must not wedge the guard */ }
      } finally {
        w.runs++;
        w.running = false;
      }
    }
    w.fire = fire;

    if (enabled) {
      w.timer = setIv(fire, intervalMs);
      // A watcher must never keep the process alive on its own.
      if (w.timer && typeof w.timer.unref === 'function') w.timer.unref();
    }
    all.set(id, w);

    return function dispose() {
      if (all.get(id) !== w) return;
      if (w.timer) clearIv(w.timer);
      w.timer = null;
      all.delete(id);
    };
  }

  function list() {
    return [...all.values()].map((w) => ({
      id: w.id, intervalMs: w.intervalMs, enabled: w.enabled,
      running: w.running, runs: w.runs, lastError: w.lastError,
    }));
  }

  function stop() {
    for (const w of all.values()) if (w.timer) clearIv(w.timer);
    all.clear();
  }

  return { register, list, stop };
}

module.exports = { createWatchers };
