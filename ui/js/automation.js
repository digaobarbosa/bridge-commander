// The ⚡ screen: the board's clock and the scripts it fires, in one place.
//
// Hooks and schedules were two tabs four deep in config, a screen he visits
// twice a month. They are not configuration — they are a running thing with a
// countdown and an exit code, and this is the mode he watches them in.
//
// The two lists stay in their own modules (hkmanager.js, scmanager.js): the
// wiring moved here, the behaviour did not. This file is the shell — it reads
// the schedules FIRST so the hooks list can say what fires each hook, it hands
// each list the action that jumps to the other, and it writes the masthead.
//
// The masthead answers one question without scrolling: is anything red. That is
// the reason this screen gets opened at all, so the count is the loudest thing
// on it and both lists sort their red to the top.
import { renderSchedules, scheduleCounts, focusSchedule, onOpenHook, initSchedules } from './scmanager.js';
import { renderHooks, hookCounts, focusHook, onOpenSchedule, initHooks } from './hkmanager.js';
import { mastheadText } from './panelviews.js';

// A schedule names its hook and a hook names what fires it, so each list is
// handed the other's focus rather than reaching for it — the shape filepane's
// onModeSwitch uses.
onOpenHook(focusHook);
onOpenSchedule(focusSchedule);

let alarmEl, countsEl;
/** Find the screen's elements and hand each column its own. Called once, at boot. */
export function initAutomation() {
  const $ = (id) => document.getElementById(id);
  alarmEl = $('au-alarm');
  countsEl = $('au-counts');
  initSchedules({ list: $('sc-list'), count: $('sc-count'), note: $('sc-note'), add: $('sc-add'),
    form: $('sc-form'), name: $('sc-name'), hook: $('sc-hook'), when: $('sc-when'),
    owner: $('sc-owner'), overlap: $('sc-overlap'), catchup: $('sc-catchup') });
  initHooks({ list: $('hk-list'), count: $('hk-count'), note: $('hk-note'), dir: $('hk-dir') });
}

// `reload` is what ENTERING the mode passes — a fresh look, not last visit's
// answer. Every render asks the server either way (a schedule fires, a hook is
// run from the CLI, and the board event that arrives is this screen's only
// nudge), which is also why nothing here polls.
//
// Schedules first and awaited: a hook card says which schedules fire it, and it
// reads that off the answer this line puts in place.
export async function renderAutomation(reload) {
  await renderSchedules(reload);
  await renderHooks(reload);
  paintMasthead();
}

function paintMasthead() {
  const m = mastheadText(scheduleCounts(), hookCounts());
  countsEl.textContent = m.counts;
  alarmEl.hidden = !m.alarm;
  alarmEl.textContent = m.alarm;
}
