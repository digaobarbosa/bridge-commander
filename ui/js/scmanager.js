// The ⚡ screen's schedules column: the board's own clock, beside the hooks it
// fires.
//
// MNC-25 shipped the clock and gave it no screen; MNC-84 gave it a row of grey
// text on a config tab. A schedule is a LIVE thing — a countdown to the next
// fire, a last run that passed or failed, and an owner a failure wakes — so it
// is a card with those four facts under captions, at a size he can read from
// across the room:
//
//   ▸ gh-watch   → gh-watch                                    ‖  ✕
//     WHEN         NEXT FIRE      LAST FIRE            OWNER
//     every 5m     in 3m          fired 2m ago exit 0  tonylampada
//
// The `problem` is why this column is worth having at all. A schedule whose
// hook was deleted, or whose `when` stopped parsing, fires nothing forever and
// looks exactly like one that is working — that is the silent failure the clock
// exists to end, so a broken card is red, carries the server's whole sentence,
// and SORTS TO THE TOP. Red is the reason the screen gets opened; it must not
// be below the fold.
//
// Same rule for the add form's refusals: the server names the offending text
// ("bad schedule expression \"*/5 * * *\": a cron expression has 5 fields…"),
// and that message is shown VERBATIM. Replacing it with "invalid" would throw
// away the only part of it that helps.
//
// No endpoint was added for any of this. Every read and every write here is a
// door `bc-axi schedule …` already posts to, including the firings: they come
// off hookruns.jsonl, filtered to this schedule's trigger server-side, so the
// screen and the CLI read one truth.
import { api } from './api.js';
import { hhmm, runOutcome } from './util.js';
import { openAuxDetail, auxDetailKey, repaintAuxDetail, closeDetail } from './detail.js';
import { openLog } from './logview.js';
import { listSection, paintCards, rankSort, tally } from './listpanel.js';
import { scheduleView, scheduleBad, scheduleRank, scheduleCountText, outcomeClass, until } from './panelviews.js';

let listEl, countEl, noteEl, addEl, formEl, nameEl, hookEl, whenEl, ownerEl, overlapEl, catchupEl;
/** Hand the column its elements — the list, count, note and the add form's fields — and wire the form. */
export function initSchedules(els) {
  ({ list: listEl, count: countEl, note: noteEl, add: addEl, form: formEl, name: nameEl, hook: hookEl,
    when: whenEl, owner: ownerEl, overlap: overlapEl, catchup: catchupEl } = els);
  // Opening the form is the moment its pickers have to be right — a hook dropped
  // in a minute ago belongs on the list he is about to choose from.
  addEl.ontoggle = () => { if (addEl.open) loadPickers(); };
  formEl.onsubmit = submit;
}

// The one place the note is written, so a refusal always reads like one: every
// failure here leads with a ⚠, and that is what colours it. A refusal in the
// same faint grey as "added" is how a screen teaches him not to read it.
function say(text) {
  noteEl.textContent = text;
  noteEl.classList.toggle('sc-warn', text.startsWith('⚠'));
}

let items = null; // the last GET /api/schedules answer
// The schedule showing in the detail panel, and its firings as last read. One
// at a time, because the panel holds one subject at a time.
let openName = '';
const runs = new Map(); // name -> its firings, as last read
const busy = new Set(); // names with a press still in flight — state, not a mutated button

// The hook name jumps to that hook's card. automation.js hands the action down
// rather than this module reaching for it — the shape filepane's onModeSwitch uses.
let openHookFn = null;
export function onOpenHook(fn) { openHookFn = fn; }

// A card the hooks column sent us to — marked until the mode is entered fresh,
// because a mark that vanished on the next board event would be gone before he
// looked up.
let focus = '';
export function focusSchedule(name) {
  focus = name;
  renderSchedules();
}

/** What the masthead counts: {total, bad}. */
export function scheduleCounts() { return tally(items, scheduleBad); }

/** The names of the schedules that fire `hook`, off the answer this module already holds. */
export function schedulesForHook(hook) {
  return (items || []).filter((s) => s.hook === hook).map((s) => s.name);
}

// Every render ASKS, not just the entering one — a schedule fires, is paused
// from the CLI, or has its hook deleted, and the board event is this column's
// only nudge. So there is no polling either.
const section = listSection({
  live: true,
  load: async () => {
    items = (await api.schedules()).schedules || [];
    // Only the schedule in the panel is re-read — its firings must not go on
    // saying a firing ago is the newest one, and a panel nobody opened costs
    // nothing.
    if (openName) {
      try { runs.set(openName, (await api.schedule(openName)).runs || []); }
      catch (e) { runs.delete(openName); shutPanel(); }
    }
  },
  paint: () => {
    // A schedule removed from under an open panel takes the panel with it — the
    // ✕ on this screen and one typed at a terminal are the same removal.
    if (openName && !items.some((s) => s.name === openName)) shutPanel();
    paint();
    repaintAuxDetail(); // the firings just re-read are what the panel is showing
  },
  fail: (e, had) => { if (had) say('⚠ ' + e.message); else listEl.textContent = '⚠ ' + e.message; },
});

/** Read and repaint the column; `reload` is what ENTERING the mode passes. */
export function renderSchedules(reload) {
  if (reload) { say(''); focus = ''; loadPickers(); } // entering is a fresh look, not last visit's answer
  return section(reload);
}

function paint() {
  if (!items) return;
  const views = rankSort(items, scheduleRank).map((s) =>
    scheduleView(s, { busy: busy.has(s.name), focus, open: s.name === openName }));
  paintCards(listEl, views, press, 'no schedules — the board keeps no clock yet');
  countEl.textContent = items.length ? scheduleCountText(items) : '';
}

function press(b, v) {
  const s = items.find((x) => x.name === v.name);
  if (!s) return;
  if (b.key === 'toggle') toggle(s);
  else if (b.key === 'hook' && openHookFn) openHookFn(s.hook);
  else if (b.key === 'pause') setPaused(s, !s.paused);
  else if (b.key === 'remove') remove(s);
}

// ---------- the firings, in the board's own detail panel ----------
// The panel holds the list and NOTHING else: one line per firing — when, how it
// ended, how long it took. The output of a firing is a terminal's output, and
// pouring it in here is what buried every other firing under one blob; it opens
// in a modal instead, one firing at a time.
const runKey = (name) => 'schedule:' + name;

function panelSubject(name) {
  return {
    key: runKey(name),
    emoji: '⚡',
    title: name,
    sub: 'schedule · firings',
    paint: (el) => paintFirings(el, name),
    onClose: () => { if (openName === name) { openName = ''; runs.delete(name); paint(); } },
  };
}

// The firings, newest first — the trace's own records, not a second copy kept
// on the schedule.
function paintFirings(el, name) {
  const list = runs.get(name);
  // Signature, not a blind rebuild: the panel repaints on every board event and
  // a rebuild under a finger would drop the press that is landing on it.
  const sig = name + '\n' + (list ? list.map((r) => r.started + '|' + r.ms + '|' + runOutcome(r)).join('\n') : '…');
  if (el.__bcSig === sig) return;
  el.__bcSig = sig;
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'dt-events-head';
  head.textContent = 'firings';
  el.append(head);
  const box = document.createElement('div');
  box.className = 'dt-runs';
  el.append(box);
  if (!list) { box.append(runNote('reading the firings…')); return; }
  if (!list.length) { box.append(runNote('no firings recorded')); return; }
  for (const r of list) box.append(firingLine(name, r));
}

function runNote(text) {
  const el = document.createElement('div');
  el.className = 'dt-run-note';
  el.textContent = text;
  return el;
}

// One line, and it is a button: the log is behind it.
function firingLine(name, r) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dt-run';
  b.title = 'the output of this firing';
  const when = document.createElement('span');
  when.className = 'dt-run-when';
  when.textContent = hhmm(r.started);
  const how = document.createElement('span');
  how.className = 'dt-run-how ' + outcomeClass(r);
  how.textContent = runOutcome(r);
  const ms = document.createElement('span');
  ms.className = 'dt-run-ms';
  ms.textContent = r.ms + 'ms';
  b.append(when, how, ms);
  b.onclick = () => openLog(name + ' · ' + hhmm(r.started), r.output);
  return b;
}

// ---------- the presses ----------

// Pressing a card opens its firings beside it; pressing the open one closes the
// panel. The card itself never grows, so the column never reflows.
async function toggle(s) {
  if (openName === s.name && auxDetailKey() === runKey(s.name)) return closeDetail();
  openName = s.name;
  paint(); // the caret turns now; the panel says it is reading until the fetch lands
  openAuxDetail(panelSubject(s.name));
  try {
    runs.set(s.name, (await api.schedule(s.name)).runs || []);
  } catch (e) {
    say('⚠ ' + s.name + ': ' + e.message);
    shutPanel();
    return paint();
  }
  repaintAuxDetail();
}

// The panel is gone (closed from the ✕, or its schedule was removed): forget the
// subject and let the cards say so.
function shutPanel() {
  const name = openName;
  openName = '';
  if (name) runs.delete(name);
  if (auxDetailKey() === runKey(name)) closeDetail();
}

// The press is held HERE and not on the button, because a board event repaints
// every row mid-request: a button that came back enabled under his thumb would
// be a second write the server then has to sort out.
async function setPaused(s, paused) {
  if (busy.has(s.name)) return;
  busy.add(s.name);
  paint();
  let note;
  try {
    const r = await api.pauseSchedule(s.name, paused);
    note = s.name + (paused ? ' paused — it fires nothing until resumed'
      : ' resumed — next fire ' + until(r.schedule && r.schedule.next));
  } catch (e) { note = '⚠ ' + s.name + ': ' + e.message; }
  busy.delete(s.name);
  await renderSchedules();
  say(note);
}

// The confirm says what removal does NOT do, because that is the part he cannot
// see from here: it forgets a clock entry, it does not delete a script. It says
// "untouched" rather than "still there" — the schedule most likely to be removed
// from this screen is one whose hook is already gone, and that is exactly the row
// a promise about the file still existing would be a lie on.
async function remove(s) {
  if (busy.has(s.name)) return;
  if (!confirm('Remove the schedule "' + s.name + '"?\n\n'
    + 'The hook ' + s.hook + ' is untouched — only the clock entry goes, so nothing fires it any more.')) return;
  busy.add(s.name);
  paint();
  let note;
  try {
    await api.removeSchedule(s.name);
    note = s.name + ' removed — the hook ' + s.hook + ' is untouched';
  } catch (e) { note = '⚠ ' + s.name + ': ' + e.message; }
  busy.delete(s.name);
  if (openName === s.name) shutPanel();
  await renderSchedules();
  say(note);
}

// ---------- add ----------
// The two pickers are the point of having a form at all: a hook that exists and
// an owner who is registered are the two refusals `add` spends most of its time
// on, and a free-text box would earn both of them again every time.
async function loadPickers() {
  try {
    const [h, l] = await Promise.all([api.hooks(), api.lieutenants()]);
    // A schedule fires a NAMED hook — a lifecycle hook is fired by the event
    // that owns it, so it is not on this list.
    fill(hookEl, (h.hooks || []).filter((x) => !x.event).map((x) => x.name), 'no named hooks');
    fill(ownerEl, (l.lieutenants || []).map((x) => x.id), 'no lieutenants');
  } catch (e) { say('⚠ ' + e.message); }
}

// Rebuilt only when the set actually changed: a repaint that reset a picker
// under his finger would be the same bug as one that ate what he typed.
function fill(sel, values, empty) {
  const want = values.join('\n');
  if (sel.dataset.filled === want) return;
  sel.dataset.filled = want;
  const had = sel.value;
  sel.textContent = '';
  for (const v of (values.length ? values : [''])) {
    const o = document.createElement('option');
    o.value = values.length ? v : '';
    o.textContent = values.length ? v : empty;
    sel.append(o);
  }
  if (values.includes(had)) sel.value = had;
}

async function submit(e) {
  e.preventDefault();
  say('');
  try {
    const r = await api.addSchedule({
      name: nameEl.value.trim(), hook: hookEl.value, when: whenEl.value.trim(),
      owner: ownerEl.value, overlap: overlapEl.value, catchup: catchupEl.value,
    });
    nameEl.value = '';
    whenEl.value = '';
    addEl.open = false;
    await renderSchedules();
    say(r.schedule.name + ' added — ' + r.schedule.hook + ' ' + r.schedule.describe
      + ', owner ' + r.schedule.owner + '; next fire ' + until(r.schedule.next));
  } catch (err) {
    // VERBATIM. The refusal names the offending text — which `when` did not
    // parse, which hook is not there — and "invalid" would throw all of it away.
    say('⚠ ' + err.message);
  }
}
