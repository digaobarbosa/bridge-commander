// What each card on the config screen and the ⚡ screen SAYS — its name, its
// captioned facts, which buttons it has — as plain data. No DOM here, so the
// words are tested in node; listpanel.js paints them.
import { ago, runOutcome } from './util.js';

/** '1 card', '14 cards' — a project's and a lieutenant's live-card count. */
export const cardCount = (n) => (n === 1 ? '1 card' : n + ' cards');

// ---------- hooks ----------

/** A hook whose last run did not come back clean — the reason ⚡ gets opened. */
export const hookBad = (h) => !!(h.last && !h.last.ok);
/** Failed first, otherwise the server's order. */
export const hookRank = (h) => (hookBad(h) ? 0 : 1);

/** A hook's last run: 'ran 4m ago · exit 0', 'ran just now · timed out', 'never ran'. */
export function hookLastRun(r) {
  if (!r) return 'never ran';
  const when = ago(r.started); // 'now' | '4m' | '2h' | '3d'
  return 'ran ' + (when === 'now' ? 'just now' : when + ' ago') + ' · ' + runOutcome(r);
}

/**
 * A hook card. ctx: {firedBy: names of the schedules that fire it, busy: a ▶
 * pressed here still in flight, focus: the hook the schedules column sent us to}.
 * A refusal is visible: a lifecycle hook's ▶ is disabled WITH the reason.
 */
export function hookView(h, ctx = {}) {
  const live = !!ctx.busy || !!h.running; // h.running: a run started from the CLI
  const run = { key: 'run', label: ctx.busy ? '…' : '▶', disabled: !!ctx.busy,
    title: 'run it now — the same door bc-axi hook run posts to' };
  if (h.event) {
    // by hand it would get an empty BC_CARD, and a card-shaped script would do the wrong thing quietly
    run.disabled = true;
    run.title = h.event + ' fires this one — running it by hand would hand it no card';
  }
  return {
    kind: 'hk', name: h.name, title: h.file,
    cls: hookBad(h) ? 'au-bad' : '', focus: !!ctx.focus && h.name === ctx.focus,
    actions: [run, { key: 'edit', label: '✎', title: 'edit — ' + h.file }],
    facts: [
      firedBy(h, ctx.firedBy || []),
      { cap: 'last run', text: live ? 'running now' : hookLastRun(h.last),
        cls: live ? 'hk-running' : !h.last ? 'hk-never' : h.last.ok ? 'hk-ok' : 'hk-bad' },
    ],
  };
}

// A lifecycle hook is fired by its event; a named one by the schedules that
// point at it, and each of those is a way to that schedule.
function firedBy(h, names) {
  if (h.event) {
    return { cap: 'fired by', bits: [{ label: h.event, cls: 'hk-event', title: 'the card lifecycle event that fires this one' }] };
  }
  if (!names.length) return { cap: 'fired by', text: 'nothing — ▶ only', cls: 'au-off' };
  return { cap: 'fired by', bits: names.map((n) => ({ key: 'schedule', arg: n, label: '⚡ ' + n, cls: 'hk-sched',
    title: 'the schedule that fires this — show it beside this column' })) };
}

/** The hooks column's count: '3 total · 1 failing'. */
export function hookCountText(items) {
  const bad = items.filter(hookBad).length;
  return items.length + ' total' + (bad ? ' · ' + bad + ' failing' : '');
}

// ---------- schedules ----------
// The words are `bc-axi schedule list`'s own: one clock, one vocabulary.

/** Red: fires nothing (a `problem`), or its last firing failed. A skip is the overlap policy working. */
export const scheduleBad = (s) => !!s.problem || !!(s.last && !s.last.skipped && !s.last.ok);
/** Broken first, paused next, working last. */
export const scheduleRank = (s) => (scheduleBad(s) ? 0 : s.paused ? 1 : 2);

/** 'in 3m' — how far off the next fire is; 'due now'; 'never' without one. */
export function until(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return 'never';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return 'in ' + s + 's';
  if (s < 3600) return 'in ' + Math.round(s / 60) + 'm';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + 'h';
  return 'in ' + Math.round(s / 86400) + 'd';
}

/** '2m ago'. Seconds, not 'now': "fired now" is not a thing a past event is. */
export function since(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/** The last fire: 'fired 2m ago · exit 0'. A skip is a firing too, so it reads as one. */
export function fireOutcome(r) {
  if (!r) return 'never fired';
  if (r.skipped) return 'skipped ' + since(r.started) + ' (previous firing still going)';
  return 'fired ' + since(r.started) + ' · ' + runOutcome(r);
}

/** The colour a firing wears. */
export function outcomeClass(r) {
  if (!r) return 'sc-never';
  return r.skipped ? 'sc-skip' : r.ok ? 'sc-ok' : 'sc-bad';
}

/** The next fire — unless none is coming: paused, or a problem the tick refuses to fire past. */
export function nextText(s) {
  return s.paused ? 'paused' : s.problem ? 'fires nothing' : until(s.next);
}

/**
 * A schedule card: four captioned facts (when, next fire, last fire, owner),
 * the hook it fires as a way there, PAUSED as a chip rather than a shade, and a
 * `problem` in full. ctx: {busy: a press in flight, focus, open: its firings are in the panel}.
 */
export function scheduleView(s, ctx = {}) {
  const busy = !!ctx.busy;
  const open = !!ctx.open;
  return {
    kind: 'sc', name: s.name, lead: open ? '▾' : '▸',
    cls: [scheduleBad(s) && 'au-bad', s.paused && 'sc-off', open && 'au-open'].filter(Boolean).join(' '),
    focus: !!ctx.focus && s.name === ctx.focus,
    headKey: 'toggle', headTitle: open ? 'close the firings panel' : 'the recent firings, in the panel',
    chips: [
      { key: 'hook', arg: s.hook, label: '→ ' + s.hook, cls: 'sc-hook', aria: 'the hook this fires: ' + s.hook,
        tip: 'the hook this fires — show it on the hooks list' },
      ...(s.paused ? [{ label: 'PAUSED', cls: 'sc-chip', title: 'this schedule fires nothing until it is resumed' }] : []),
    ],
    // '‖' rather than U+23F8: the board's fonts have no glyph for it
    actions: [
      { key: 'pause', label: busy ? '…' : s.paused ? '▶' : '‖', disabled: busy,
        title: s.paused ? 'resume — the cursor re-arms at now, so it wakes up owing no windows'
          : 'pause — it fires nothing until resumed' },
      { key: 'remove', label: '✕', disabled: busy, title: 'remove this schedule — the hook itself survives' },
    ],
    facts: [
      { cap: 'when', text: s.describe },
      { cap: 'next fire', text: nextText(s), cls: s.paused || s.problem ? 'au-off' : 'sc-next' },
      { cap: 'last fire', text: fireOutcome(s.last), cls: outcomeClass(s.last) },
      { cap: 'owner', text: s.owner, cls: 'au-who' },
    ],
    problem: s.problem || '',
  };
}

/** The schedules column's count: '4 total · 1 failing · 1 paused'. */
export function scheduleCountText(list) {
  const bad = list.filter(scheduleBad).length;
  const off = list.filter((s) => !scheduleBad(s) && s.paused).length;
  const parts = [list.length + ' total'];
  if (bad) parts.push(bad + ' failing');
  if (off) parts.push(off + ' paused');
  return parts.join(' · ');
}

// ---------- the ⚡ masthead ----------

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/**
 * The line that answers "is anything red" without scrolling, from the two
 * columns' {total, bad}: counts '3 schedules · 1 hook', and the alarm naming
 * each half ('1 schedule failing · 2 hooks failing'), '' when nothing is red.
 */
export function mastheadText(s, h) {
  const parts = [];
  if (s.bad) parts.push(plural(s.bad, 'schedule') + ' failing');
  if (h.bad) parts.push(plural(h.bad, 'hook') + ' failing');
  return { counts: plural(s.total, 'schedule') + ' · ' + plural(h.total, 'hook'), alarm: parts.join(' · ') };
}

// ---------- config screen ----------

/** A project: the live cards that name it, its path, and the git facts a start depends on. */
export function projectView(p) {
  return {
    kind: 'pj', name: p.name,
    chips: [{ label: cardCount(p.cards), cls: 'pj-n', title: 'live cards with repo: ' + p.name }],
    note: p.path,
    // a clone that is gone keeps its card and says so — no git fact would be true
    facts: p.missing
      ? [{ cap: 'path', text: '⚠ not on disk', cls: 'pj-warn' }]
      : [{ cap: 'remote', text: p.remote || 'none' }, { cap: 'branch', text: p.branch || 'unknown' }],
  };
}

// The three session states, each said as the thing the captain would do about it.
const SESSION = {
  live: { text: 'live', cls: 'lt-live', title: 'the harness says its session is up' },
  dead: { text: 'dead', cls: 'lt-dead', title: 'it had a session and it is gone — the board respawns it, or reset it yourself' },
  none: { text: 'no session', cls: 'lt-none', title: 'never spawned: this lieutenant is registered but nothing is running for it' },
};

/**
 * A lieutenant row: one line — name, id, `WAL-4 · 14 cards · live` — and two
 * icons. Retire is not here: the switcher's ⋯ is the one door onto it.
 */
export function lieutenantView(l) {
  return {
    name: l.name || l.id, id: l.id,
    facts: l.next + ' · ' + cardCount(l.cards) + ' · ',
    session: SESSION[l.session] || SESSION.none,
    actions: [
      { key: 'settings', label: '⚙', cls: 'lt-act', title: 'settings — name, colour, avatar, voice, card prefix' },
      { key: 'charter', label: '✎', cls: 'lt-act', title: 'charter — ' + l.memory },
    ],
  };
}
