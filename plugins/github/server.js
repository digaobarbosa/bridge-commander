'use strict';
// github — owns the PR watch. The board builds the watch (server/prwatch.js,
// which needs the store, the workers and the archive verb) and hands it over as
// ctx.internal; this plugin decides whether it runs. So disabling "github" in
// the overlay stops the polling of gh, which is the point of built-ins being
// plugins.
//
// No decorator: the core PR chip (ui/js/util.js prChipHtml) already shows every
// PR's number, state and link on the tile and the detail strip. A badge here
// would repeat it.

function activate(ctx) {
  const internal = ctx.internal;
  // A workspace copy of this plugin gets no internal tier: it cannot reach the
  // store, so it has no watch to run. Say so rather than fail the activation.
  if (!internal || !internal.prWatch || typeof internal.prWatch.tick !== 'function') {
    ctx.log('no internal PR watch available (only the shipped github plugin gets one); the PR watch is not running');
    return;
  }
  ctx.watchers.register({ id: 'prwatch', intervalMs: internal.prWatchIntervalMs, tick: internal.prWatch.tick });
}

module.exports = { activate };
