// The ⚡ screen's hooks column: the workspace's own executable scripts, what
// fires each one, and how the last run ended.
//
// A hook is a script somebody wrote. It has a kind, a last exit code, and — when
// it went red — output worth reading. So it is a card with those facts under
// captions rather than a line of 11px grey:
//
//   gh-watch                                                    ▶  ✎
//   FIRED BY            LAST RUN
//   ⚡ gh-watch          ran 4m ago · exit 0
//
// FIRED BY is the half of the story the two config tabs could not tell: a
// lifecycle hook names its event, a named hook names the SCHEDULES that fire it
// (clicking one jumps to that schedule beside this column), and one nothing
// fires says so. Red sorts to the top, because a failed run is why this screen
// gets opened.
//
// ▶ posts to the same door `bc-axi hook run` posts to — one code path, three
// callers. ✎ opens the file on the file screen, the same editor a playbook opens
// in, which is where "he asks a lieutenant to help build one" happens: a file on
// a screen he can point at.
//
// One rule governs every ▶ here: a refusal is visible. Enabled-and-works and
// disabled-with-a-reason are both fine; enabled-and-silently-refuses is the
// worst of the three, because it teaches him the screen is broken and he is
// right. So the ▶ on a lifecycle card is disabled WITH a title saying why, and
// the ▶ on a hook someone else is already running is not disabled at all — the
// server locks per name, so the screen does too, and a press it would refuse
// never looks live. Same principle, opposite answer.
//
// Deliberately absent: run detail (the output tail lives in hookruns.jsonl and
// is read with `bc-axi hook runs`, or through the schedule that fired it) and a
// create button (naming a file, making it executable and typing bash into a text
// box on a phone is the worst way to do all three).
import { api } from './api.js';
import { openArtifactFile } from './detail.js';
import { schedulesForHook } from './scmanager.js';
import { listSection, paintCards, rankSort, tally } from './listpanel.js';
import { hookView, hookBad, hookRank, hookCountText } from './panelviews.js';
import { runOutcome } from './util.js';

let listEl, countEl, noteEl, dirEl;
/** Hand the column its elements: {list, count, note, dir}. */
export function initHooks(els) {
  ({ list: listEl, count: countEl, note: noteEl, dir: dirEl } = els);
}

let items = null; // [{name, event, file, last, running}] — last answer from the server
let dir = '';
const running = new Set(); // hook names whose ▶ was pressed HERE — state, not a mutated button
let focus = ''; // a hook the schedules column sent us to — marked until the mode is re-entered

// A hook card names the schedules that fire it, and each name is a way there.
// The schedules column owns that focus, so this module is handed the action
// rather than reaching for it — the shape filepane's onModeSwitch uses.
let openScheduleFn = null;
export function onOpenSchedule(fn) { openScheduleFn = fn; }

/** What the masthead counts: {total, bad}. */
export function hookCounts() { return tally(items, hookBad); }

// Every render ASKS, not just the entering one — a hook run from the CLI, or a
// lifecycle hook firing, changes what a card says, and the board event that
// brought us here is this screen's only nudge. So there is no polling either.
const section = listSection({
  live: true,
  load: async () => {
    const r = await api.hooks();
    items = r.hooks || [];
    dir = r.dir || '';
  },
  paint,
  // said where a press says so when the list on screen is still true
  fail: (e, had) => { if (had) noteEl.textContent = '⚠ ' + e.message; else listEl.textContent = '⚠ ' + e.message; },
});

/** Read and repaint the column; `reload` is what ENTERING the mode passes. */
export function renderHooks(reload) {
  if (reload) { noteEl.textContent = ''; focus = ''; } // entering is a fresh look, not last visit's answer
  return section(reload);
}

// The other half of a schedule's hook link: mark the hook it named. The mark
// lasts until the mode is entered fresh — one gone on the next board event
// would be gone before he looked up.
export function focusHook(name) {
  focus = name;
  renderHooks();
}

function paint() {
  if (!items) return;
  const views = rankSort(items, hookRank).map((h) =>
    hookView(h, { firedBy: schedulesForHook(h.name), busy: running.has(h.name), focus }));
  const found = paintCards(listEl, views, press, 'no hooks — nothing executable in the hooks directory yet');
  countEl.textContent = items.length ? hookCountText(items) : '';
  // A hook a schedule names and this list does not have is the deleted-hook
  // case: the note says so rather than leaving a jump that silently did nothing.
  if (focus && !found) noteEl.textContent = 'no hook "' + focus + '" here — the schedule that fires it says so on its card';
  dirEl.textContent = dir + ' — a file here is a named hook; a directory is a lifecycle event';
}

function press(b, v) {
  const h = items.find((x) => x.name === v.name);
  if (!h) return;
  if (b.key === 'run') runNow(h);
  else if (b.key === 'edit') edit(h);
  else if (b.key === 'schedule' && openScheduleFn) openScheduleFn(b.arg);
}

// The run says what it did just under the list: the button is where he pressed,
// so it is where the answer belongs. The output tail is `bc-axi hook runs`.
//
// The press is held HERE and not on the button, because a board event repaints
// every row mid-run: a button that came back enabled under his thumb would be
// the second press the server then has to refuse. A Set per name, because the
// server's lock is per workspace + name — two hooks may run at once.
async function runNow(h) {
  if (running.has(h.name)) return;
  running.add(h.name);
  paint();
  let note;
  try {
    note = runOutcome((await api.runHook(h.name)).run);
  } catch (e) {
    note = e.message;
  }
  running.delete(h.name);
  await renderHooks();
  noteEl.textContent = h.name + ': ' + note;
}

// A hook is a file, so editing it is the file screen — the same 💾, the same
// version check, the same 409 as a playbook or a card artifact.
async function edit(h) {
  try {
    await openArtifactFile('file://' + h.file, h.name);
  } catch (e) {
    noteEl.textContent = '⚠ cannot open ' + h.name + ' — ' + e.message;
  }
}
