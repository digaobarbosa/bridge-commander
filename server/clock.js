'use strict';
// clock — the board's clock at run time: the tick, the firing, the claims and
// the announcements. server/schedules.js is the PURE half (when a window is
// due, what a `when` means); this is the half with state and a hook in flight.
// The board itself stays in server.js: everything this module touches on it
// comes in through createClock().
//
// A schedule fires A HOOK, through `hook run` and nothing else — the clock gets
// no private door. Everything a firing needs to decide (which card, whether to
// wake anybody, what to say) is the hook's business, because a hook is bash
// with `bc-axi` on its PATH.
//
// The cursor is `lastWindow`: the DUE TIME of the last window this schedule
// handled. Windows are a function of that cursor and the clock, so a restart
// neither loses a due window nor fires one twice — the tick after the boot sees
// exactly the windows that came due while nobody was looking, and the catch-up
// policy says what to do with them.
const crypto = require('crypto');
const { parseWhen, nextAfter, dueWindows, pickWindows, describeWhen } = require('./schedules.js');
const { namedHookFile, hooksDir, runningHook, cancelNamedHook, traceSkip, lastRunsFor } = require('./hooks.js');

/**
 * createClock(deps) -> { tick, publicSchedules, findSchedule, scheduleTrigger, describeWhenSafe }
 *   workspace          the board's workspace (hooks and the run trace live there)
 *   schedules()        the board's live schedule list (board.schedules)
 *   findLieutenant(id) the registered lieutenant, or null
 *   notify(s, {text, kind, level, wake})  a timeline event for schedule `s`,
 *                      plus a queue item for its owner when `wake` is set
 *   keys               {seen, claim, forget}(scope, key) — the event-key store
 *   save()             persist the board and broadcast it
 *   runNamedHook       hooks.js runNamedHook (a seam for tests)
 *   now()              ISO timestamp
 *   hookTimeoutMs      per-run timeout, 0 = the hooks.js default
 */
function createClock({
  workspace: WORKSPACE, schedules, findLieutenant, notify, keys, save, runNamedHook, now, hookTimeoutMs,
}) {
  // The line between "missed while the server was down" and "came due while we
  // were watching" — the whole meaning of catch-up `none`.
  const SCHEDULER_BOOT = Date.now();

  function findSchedule(name) { return schedules().find((s) => s.name === name); }
  // The trace's `trigger` for a firing. It names the SCHEDULE, not just "a
  // schedule": two schedules on one hook each read their own last fire out of
  // hookruns.jsonl, and nobody keeps a second copy of what already happened.
  function scheduleTrigger(s) { return 'schedule:' + s.name; }

  // scheduleProblem(s) -> '' or why this schedule cannot fire right now. Checked
  // on EVERY tick, not just at `add`: a hook deleted out from under a live
  // schedule has to make that schedule say so, rather than failing silently every
  // window forever.
  function scheduleProblem(s) {
    try { parseWhen(s.when); } catch (e) { return e.message; }
    // A cursor that is not a date is a DEAD window: every due-window question is
    // asked from it, and all of them answer nothing, forever. board.json is
    // git-tracked, so a bad merge or a hand edit is how this arrives — and a
    // clock that quietly stops is the exact failure this card replaces. Said out
    // loud here for the same reason an unparseable `when` is, and healed the same
    // way any cursor is: pause and resume re-arms it at now.
    if (s.lastWindow && Number.isNaN(Date.parse(s.lastWindow))) {
      return 'cursor "' + s.lastWindow + '" is not a date — this schedule cannot work out what is due'
        + ' (bc-axi schedule pause ' + s.name + ' && bc-axi schedule resume ' + s.name + ' re-arms it at now)';
    }
    if (!namedHookFile(WORKSPACE, s.hook)) {
      return 'hook "' + s.hook + '" is gone from ' + hooksDir(WORKSPACE) + ' — this schedule fires nothing';
    }
    if (!findLieutenant(s.owner)) {
      return 'owner "' + s.owner + '" is not a registered lieutenant — a failure here would land nowhere';
    }
    return '';
  }

  // A problem is announced ONCE, when it appears, and once when it clears. The
  // board's bell is level 1 because a schedule that stopped firing is exactly the
  // silent failure this card exists to end; a level-2 line marks the recovery.
  // An unregistered owner cannot be woken, so the board stream is all there is.
  // The kind travels onto the QUEUE ITEM as well as the timeline entry, and the
  // two must be the same one: the drain dispatches on the item's kind alone, so a
  // recovery labelled `schedule-failed` reaches its owner headlined "a firing
  // failed" and advised to fix the hook and pause the schedule — advice that is
  // exactly backwards for the schedule that just told them it is working again.
  function announceScheduleProblem(s, problem) {
    const text = problem
      ? 'schedule ' + s.name + ' cannot fire: ' + problem
      : 'schedule ' + s.name + ' is healthy again';
    const kind = problem ? 'schedule-failed' : 'schedule';
    notify(s, { text, kind, level: problem ? 1 : 2, wake: true });
  }

  // A schedule is not a card, so it gets its own scope in the key store rather
  // than a parallel store of its own. The `@` is what keeps the two apart for
  // good: a card id has to start with a word character, so no card can ever be
  // spelled like this.
  function scheduleKeyScope(s) { return '@schedule:' + s.name; }

  // The SIGNATURE of a failure: how it went wrong, plus the tail of what it said.
  // Two windows that failed the same way are the same failure and are worth one
  // wake between them; a hook that starts exiting 4 instead of 3, or says
  // something new, is a different failure and is worth hearing about.
  function failureKey(run) {
    const how = run.timedOut ? 'timeout' : run.error ? 'spawn' : 'exit:' + run.code;
    const tail = String(run.output || '').slice(-500);
    return how + ':' + crypto.createHash('sha1').update(tail).digest('hex').slice(0, 12);
  }

  // A firing that fails lands on its OWNER, carrying the hook's output — never
  // only in a log. The trace already holds the run detail; this is the wake.
  //
  // Announced ONCE, the way announceScheduleProblem announces a problem once, and
  // through the key store MNC-24 already built for this shape. A 5m schedule
  // whose hook is permanently broken fails 288 times a day, and a drain holding
  // 288 identical items is quieter than one holding a single item, because its
  // owner stops reading it. A repeat still lands on the timeline at level 2 — the
  // record stays whole; the bell and the queue item are the only things the key
  // spends.
  function landScheduleFailure(s, run) {
    const how = run.timedOut ? 'timed out' : run.error ? String(run.error)
      : run.code === null ? 'killed' : 'exit ' + run.code;
    const text = ('schedule ' + s.name + ' — hook ' + s.hook + ' FAILED (' + how + ')'
      + (run.output ? ':\n' + run.output : '')).slice(0, 2000);
    // ask -> deliver -> claim, the order the pair documents: claiming first would
    // make a delivery that throws a wake forever answered "duplicate".
    const scope = scheduleKeyScope(s);
    const key = failureKey(run);
    const fresh = !keys.seen(scope, key);
    notify(s, { text, kind: 'schedule-failed', level: fresh ? 1 : 2, wake: fresh });
    save();
    if (fresh) keys.claim(scope, key);
  }

  // The other half of announcing once: silence has to mean one thing. The first
  // green firing after a failing one says so on the timeline and forgets the key,
  // so the next failure is heard as new rather than swallowed as a repeat of one
  // that is already fixed.
  function landScheduleRecovery(s) {
    if (!keys.forget(scheduleKeyScope(s))) return;
    notify(s, { text: 'schedule ' + s.name + ' — hook ' + s.hook + ' is green again',
      kind: 'schedule', level: 2, wake: false });
    save();
  }

  // recordSkip(s, why) — a firing that did NOT run is still a firing. `skip` that
  // swallows its windows makes a schedule which never runs look exactly like one
  // that is working, so every skipped window gets a line in the same trace the
  // runs land in.
  function recordSkip(s, why) {
    traceSkip(WORKSPACE, { hook: s.hook, trigger: scheduleTrigger(s), reason: 'skipped: ' + why });
  }

  // The run this schedule's hook is holding, named the way the EBUSY refusal
  // names it — an operator reading a skip afterwards has to be able to find the
  // firing that displaced the window, and `started` + `trigger` is what identifies
  // it on the trace. A pass between windows holds no run: say so rather than
  // invent one.
  function inFlightFiring(s) {
    const run = runningHook(WORKSPACE, s.hook);
    if (!run) return 'the firing in flight is still running';
    return 'the firing in flight (trigger ' + run.trigger + ', started ' + run.started
      + (run.card ? ', card ' + run.card : '') + ') is still running';
  }

  // fireSchedule(s) -> 'ran' | 'skipped' | 'queued' — one window, awaited to the
  // end. The EBUSY here is the OTHER overlap: not this schedule's own previous
  // firing (the tick handles that, below) but somebody else's run of the same
  // hook — the board's ▶, a lieutenant at the CLI, a second schedule. Same
  // policy, because from the window's point of view it is the same situation.
  async function fireSchedule(s) {
    const trigger = scheduleTrigger(s);
    for (let attempt = 0; ; attempt++) {
      try {
        const run = await runNamedHook(WORKSPACE, s.hook, {}, {
          trigger, timeoutMs: hookTimeoutMs || 0,
        });
        // A run cancelled to make room for another already answered its own
        // caller; only a genuine failure wakes the owner, and only a genuine
        // success closes a failure that is still open.
        if (!run.ok && !run.canceled) landScheduleFailure(s, run);
        else if (run.ok) landScheduleRecovery(s);
        return 'ran';
      } catch (e) {
        if (e && e.code === 'ENOHOOK') return 'skipped'; // scheduleProblem says it on the next tick
        if (!e || e.code !== 'EBUSY') throw e;
        if (s.overlap === 'queue') return 'queued';
        if (s.overlap === 'restart' && attempt === 0) {
          await cancelNamedHook(WORKSPACE, s.hook);
          continue; // and if someone took the name in that instant, skip below
        }
        recordSkip(s, e.message);
        return 'skipped';
      }
    }
  }

  // runSchedule(s, windows) — one schedule's due windows, oldest first, ONE AT A
  // TIME. A catch-up backlog is not an overlap: `all` over a weekend means fire
  // each of those windows, in order, and the next one starts when the last one is
  // done. Runs outside the tick, which decides and never waits.
  //
  // Two cursors, deliberately, and the difference between them is the whole
  // durability story:
  //
  //   the CLAIM   in memory, keyed by the schedule OBJECT, alive for exactly as
  //               long as a pass is. The windows a pass took stop being due the
  //               moment it takes them, so the ticks that go by while a
  //               six-minute hook runs see the overlap policy and not the same
  //               backlog again. Keyed by the object and not by the name because
  //               a name can be removed and given to a new schedule while a pass
  //               is still running, and that new schedule is not the one firing.
  //   lastWindow  on disk, and it lags the claim on purpose. board.json still
  //               names the pre-pass window for the whole run, so a machine
  //               powered off mid-hook comes back and offers that window again.
  //               At-least-once is the promise a clock can keep; at-most-once
  //               would lose the firing outright, with nothing anywhere to say a
  //               window had ever come due.
  //
  // A pass writes the claim it REACHED — which the overlap policy's skips have
  // been moving all along — never the cursor it started with, or `skip` would
  // turn into back-to-back firing and the trace would hold skips for windows that
  // then ran. `queue` is the one outcome that lands somewhere earlier: the window
  // it could not take is re-offered on the next tick.
  const claimed = new Map();
  async function runSchedule(s, windows) {
    let requeue = null;
    try {
      for (const w of windows) {
        const outcome = await fireSchedule(s);
        if (outcome === 'queued') { requeue = w - 1; break; } // re-offered next tick
      }
    } catch (e) {
      console.error(now() + ' schedule ' + s.name + ' failed to fire: ' + String((e && e.message) || e));
    } finally {
      // Nothing above this line is awaited by anybody, so a board write that fails
      // here is an unhandled rejection — which is to say the whole server, killed
      // by a full disk while a hook was running. It is contained like every other
      // background loop's failure.
      try {
        const reached = requeue !== null ? requeue : claimed.get(s);
        // FORWARD only, and only onto the schedule this pass actually owns. Both
        // halves are load-bearing. A `resume` that landed while the hook ran has
        // already re-armed the cursor at now — a pause is not a queue — and
        // stamping an older claim over it would make the whole paused interval
        // due. And a schedule removed and re-added under the same name is a
        // different schedule: it must not start life owing a dead pass's backlog.
        // The `queue` pull-back is not a rewind, so it survives this: `w - 1` is
        // never earlier than the cursor the pass started from.
        const owned = findSchedule(s.name) === s;
        if (owned && reached !== undefined && reached > (Date.parse(s.lastWindow) || 0)) {
          s.lastWindow = new Date(reached).toISOString();
          save();
        }
      } catch (e) {
        console.error(now() + ' schedule ' + s.name + ': the board would not save after a firing: '
          + String((e && e.message) || e));
      }
    }
  }

  // The overlap POLICY: a window came due while this schedule's PREVIOUS firing
  // is still running. It is a policy over `hook run`'s refusal, not a second
  // opinion about what is running — the five-minute poll that takes six minutes
  // is the case, and all three answers are defensible depending on the hook.
  //
  //   skip     don't run — and record every window it dropped
  //   queue    leave the cursor where it is; the window is re-offered when the
  //            firing in flight finishes. It survives a restart because the
  //            cursor is board state, not a list in memory
  //   restart  kill what is running (the whole process group, traced as canceled)
  //            and let the next tick start the window that displaced it
  function overlapPolicy(s, due) {
    if (s.overlap === 'queue') return;
    if (s.overlap === 'restart') {
      cancelNamedHook(WORKSPACE, s.hook).catch(() => {});
      return;
    }
    // Two different firings in one line, and keeping them apart is the whole
    // point of writing it: the window being DROPPED, and the firing it lost to.
    // The run in flight is read off `hook run`'s own registry (started, trigger)
    // rather than guessed from the windows here, which are the dropped ones.
    const lost = inFlightFiring(s);
    for (const w of due) recordSkip(s, 'window ' + new Date(w).toISOString() + ' — ' + lost);
    // Against the CLAIM, because a skip belongs to the pass in flight: it reaches
    // board.json when that pass finishes, and a crash before then leaves the
    // window due again — which is the honest answer, since nothing ran.
    claimed.set(s, due[due.length - 1]);
  }

  let scheduleTicking = false;
  async function scheduleTick() {
    if (scheduleTicking) return;
    scheduleTicking = true;
    try {
      let changed = false;
      const nowMs = Date.now();
      for (const s of [...schedules()]) {
        const problem = scheduleProblem(s);
        if (problem !== s.problem) {
          // A paused schedule still reports a problem it has — you pause a clock,
          // you do not stop wanting to know its hook was deleted — but announcing
          // it would be a wake nobody asked for.
          if (!s.paused) announceScheduleProblem(s, problem);
          s.problem = problem;
          changed = true;
        }
        if (problem || s.paused) continue;
        const when = parseWhen(s.when);
        const anchor = Date.parse(s.created) || 0;
        // A schedule that has never fired starts its cursor HERE: `add` is not a
        // firing, and a fresh 5m schedule that fired the instant it was created
        // would make every `add` a surprise.
        if (!s.lastWindow) { s.lastWindow = new Date(nowMs).toISOString(); changed = true; continue; }
        // The claim, when a pass holds one, is ahead of the stored cursor — see
        // runSchedule. Reading past both is what stops a pass being offered the
        // windows it already took.
        const from = Math.max(Date.parse(s.lastWindow), claimed.get(s) || 0);
        const due = dueWindows(when, from, nowMs, anchor);
        if (!due.windows.length) continue;
        // Its own previous firing is still running: that is what `overlap` is for.
        if (claimed.has(s)) { overlapPolicy(s, due.windows); continue; }
        const { fire, dropped } = pickWindows(due, s.catchup, SCHEDULER_BOOT);
        if (dropped) {
          // No silent caps: a policy that drops windows says how many, so `all`
          // hitting its ceiling is never mistaken for full coverage.
          console.error(now() + ' schedule ' + s.name + ': ' + dropped + ' due window(s) not fired (catch-up '
            + s.catchup + ')');
        }
        // The claim is taken HERE, before anything is awaited, so no second pass
        // can ever be handed these windows. It reaches board.json when the pass
        // ends, and it reaches it even for a firing that threw — at-least-once
        // belongs to delivery, and a schedule that retries a broken hook every
        // tick forever is a wake storm, not a recovery. The trace and the owner's
        // drain hold what happened.
        claimed.set(s, due.windows[due.windows.length - 1]);
        // Deliberately not awaited: the tick's job is to decide, not to wait out
        // a hook. Every window still fires in order, one at a time, per schedule.
        // The claim is dropped out here rather than inside, so a pass that somehow
        // dies on the way out cannot wedge the schedule shut forever.
        runSchedule(s, fire)
          .finally(() => claimed.delete(s))
          .catch((e) => console.error(now() + ' schedule ' + s.name + ': '
            + String((e && e.message) || e)));
      }
      if (changed) save();
    } catch (e) {
      console.error(now() + ' schedule tick failed: ' + String((e && e.message) || e));
    } finally {
      scheduleTicking = false;
    }
  }
  // What `schedule list` and `schedule show` read: the stored schedule plus the
  // two things that make it trustworthy — when it fires next, and how it last
  // went. The last fire comes off hookruns.jsonl (one backward walk for the whole
  // list); there is no second copy of a run anywhere on this board.
  function publicSchedules() {
    const last = lastRunsFor(WORKSPACE, schedules().map((s) => ({
      key: s.name, hook: s.hook, trigger: scheduleTrigger(s),
    })));
    return schedules().map((s) => {
      let next = null;
      try {
        const when = parseWhen(s.when);
        // A schedule that has never fired will arm at now, so now is the honest
        // answer for an empty cursor. An unparseable one is a different thing
        // entirely: there is no next fire to compute, and printing a plausible
        // "in 4m" for a clock that will never fire again is the lie `problem` is
        // there to replace.
        const from = s.lastWindow ? Date.parse(s.lastWindow) : Date.now();
        if (!Number.isNaN(from)) {
          const t = nextAfter(when, from, Date.parse(s.created) || 0);
          next = t ? new Date(t).toISOString() : null;
        }
      } catch (e) { /* an unparseable `when` has no next fire — `problem` says why */ }
      return Object.assign({}, s, { next, last: last.get(s.name) || null, describe: describeWhenSafe(s.when) });
    });
  }
  function describeWhenSafe(text) {
    try { return describeWhen(parseWhen(text)); } catch (e) { return String(text || ''); }
  }

  return { tick: scheduleTick, publicSchedules, findSchedule, scheduleTrigger, describeWhenSafe };
}

module.exports = { createClock };
