// pane.js — the 👁 peek drawer: watch a worker's / lieutenant's terminal LIVE.
// Opens an EventSource on the target's /pane/stream (a dedicated per-target
// SSE — never the board-wide /api/events). Every `frame` event carries the
// pane's full rendered screen, so the <pre> is REPLACED, not appended to.
// Closing the drawer closes the EventSource; the server releases the harness
// pane by refcount. unsupported/no-pane/busy arrive as tidy inline messages.
//
// The <pre> is also TYPEABLE: focus it and every keystroke is POSTed to the
// target's /pane/input (the write half of the same pair). No terminal emulator
// is involved — keys go out, the polled frames come back, and the server bursts
// the poll for a moment after input so the echo does not sit behind the 1s
// baseline.
import { card, lieutenant, workerFor } from './state.js';
import { api } from './api.js';
import { ansiToHtml } from './ansi.js';
import { keyForEvent } from './panekeys.js';
import { terminalLink, safeAttach, refResume, cardTarget, lieutenantTarget } from './terminal.js';
import { openPopover, closePopover } from './popover.js';
import { handResumeOf } from './plugins.js';
import { getTerminalMode, onTerminalMode } from './terminalsettings.js';
import { push as toast } from './toast.js';
import { keepStream } from './streamkeeper.js';

const overlay = document.getElementById('pane-overlay');
const titleEl = document.getElementById('pane-title');
const liveEl = document.getElementById('pane-live');
const preEl = document.getElementById('pane-body');
const msgEl = document.getElementById('pane-msg');
const hintEl = document.getElementById('pane-hint');
const termEl = document.getElementById('pane-term');
const copyEl = document.getElementById('pane-copy');
let es = null;
let keeper = null;               // reopens es while the drawer is open
// The server pings pane streams every 5s; longer silence means a dead stream.
const STALE_MS = 12000;
let inputUrl = null;
let termTarget = null;          // { session, window } of what the drawer shows
let resume = null;              // { cmd, cli } when the harness can be resumed by hand

// ---------- ⌨ open in a real terminal ----------
// Off (the default) or no known session: the button is not there at all.
function drawTerm() {
  const link = overlay.hidden ? null : terminalLink(getTerminalMode(), termTarget);
  termEl.hidden = !link;
  termEl.dataset.copy = (link && link.copy) || '';
  if (link && link.href) termEl.href = link.href; else termEl.removeAttribute('href');
}
termEl.onclick = (e) => {
  const cmd = termEl.dataset.copy;
  if (!cmd) return;              // an href: the browser hands it to the terminal app
  e.preventDefault();
  navigator.clipboard.writeText(cmd).then(
    () => toast({ emoji: '⌨', text: 'tmux command copied — paste it in a terminal' }),
    () => toast({ emoji: '⌨', text: 'could not copy: ' + cmd }));
};
onTerminalMode(drawTerm);

// ---------- 📋 copy a command ----------
// Independent of the ⌨ setting: copying needs no terminal choice, and it is the
// way in when the board's own session is gone.
function copyItems() {
  const attach = safeAttach(termTarget);
  const items = [];
  if (attach) items.push({ label: 'attach tmux', cmd: attach,
    title: 'join the live session as a grouped session — the agent\'s own view never moves' });
  if (resume) items.push({ label: 'resume ' + resume.cli, cmd: resume.cmd,
    title: 'use only when the board\'s session is gone — two ' + resume.cli + ' processes on one conversation conflict' });
  return items;
}
function resumeOf(ref) {
  const prefix = handResumeOf(ref && ref.harness);
  const cmd = refResume(ref, prefix);
  return cmd ? { cmd, cli: prefix.split(' ')[0] } : null;
}
function drawCopy() {
  copyEl.hidden = overlay.hidden || !copyItems().length;
  if (copyEl.hidden) closePopover('pane-copy-pop');
}
function copy(cmd) {
  navigator.clipboard.writeText(cmd).then(
    () => toast({ emoji: '📋', text: 'copied — paste it in a terminal' }),
    () => toast({ emoji: '📋', text: 'could not copy: ' + cmd }));
}
copyEl.onclick = () => {
  if (closePopover('pane-copy-pop')) return; // a second click is a toggle
  const items = copyItems().map((it) => ({ label: it.label, title: it.title + '\n\n' + it.cmd, onClick: () => copy(it.cmd) }));
  openPopover(copyEl, items, { id: 'pane-copy-pop', align: 'right' });
};

function stop() {
  if (keeper) { keeper.stop(); keeper = null; }
  if (es) { es.close(); es = null; }
}
function setLive(on) {
  liveEl.classList.toggle('on', on);
  liveEl.title = on ? 'live' : 'not streaming';
}
function showMsg(text) {
  stop(); // a guard event ends the stream server-side too — don't let EventSource retry-loop
  inputUrl = null; // no screen, nothing to type into — and the hint says so
  setHint();
  setLive(false);
  preEl.hidden = true;
  msgEl.hidden = false;
  msgEl.textContent = text;
}

// ---------- typing into the pane ----------
// One POST per keystroke, chained: fetches to the same origin can complete out
// of order, and out-of-order keystrokes would scramble typed text ("abc" → "acb").
// The chain costs one promise per key and makes ordering a non-question.
//
// Two things keep the chain from becoming a trap. Each hop is bounded by a
// timeout, so one stalled request cannot wedge every key behind it forever; and
// INTERRUPTS SKIP THE QUEUE entirely — Ctrl-C is the one key whose whole purpose
// is to arrive when the pane is not keeping up, and ordering an interrupt
// against the text it interrupts is meaningless anyway.
const SEND_TIMEOUT_MS = 5000;
const JUMPS_QUEUE = new Set(['C-c', 'C-d', 'C-z', 'C-\\']);

let sending = Promise.resolve();
// api.js turns a 4xx/5xx into a rejection: without the flash a rejected
// keystroke is preventDefaulted away from the browser and vanishes unseen.
function post(url, payload) {
  return api.paneInput(url, payload, SEND_TIMEOUT_MS)
    .then(() => null, (e) => { flash(String((e && e.message) || e)); });
}
function sendInput(payload) {
  if (!inputUrl) return;
  const url = inputUrl;
  if (payload.key && JUMPS_QUEUE.has(payload.key)) { post(url, payload); return; }
  sending = sending.then(() => post(url, payload));
}

function typing() { return document.activeElement === preEl; }
// flash(msg) — a rejected keystroke says so in the head line (this overlay's
// status line already) and then gets out of the way. A dropped key does not
// deserve a dialog, but it must not disappear in silence either.
let flashTimer = null;
function flash(msg) {
  hintEl.textContent = '⚠ ' + msg;
  hintEl.classList.remove('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(setHint, 4000);
}
// The head line doubles as the focus indicator and as the way OUT: once the
// pane has focus Escape belongs to the terminal (Claude's own composer uses
// it), so the close affordance has to be stated somewhere the eye already is.
function setHint() {
  const on = typing() && !!inputUrl;
  preEl.classList.toggle('typing', on);
  hintEl.textContent = on
    ? 'typing — keys go to the pane · Esc too · ✕ or click outside to close'
    : (inputUrl ? 'click the screen to type' : '');
  hintEl.classList.toggle('on', on);
}
preEl.addEventListener('focus', setHint);
preEl.addEventListener('blur', setHint);

preEl.addEventListener('keydown', (e) => {
  if (!inputUrl) return;
  const payload = keyForEvent(e);
  if (!payload) return; // browser/OS chord: leave it alone (Ctrl-V, ⌘W, F5…)
  e.preventDefault();
  e.stopPropagation(); // main.js closes the pane on Escape — not while typing
  sendInput(payload);
});

// Paste rides the literal path: sendLiteral switches to a bracketed paste for
// multi-line text, so newlines land as part of the paste instead of as Enters.
preEl.addEventListener('paste', (e) => {
  if (!inputUrl) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData || {}).getData('text');
  if (text) sendInput({ text });
});

function open(url, title, inputAt) {
  stop();
  inputUrl = inputAt;
  titleEl.textContent = title;
  preEl.hidden = false;
  msgEl.hidden = true;
  preEl.textContent = 'connecting…';
  setLive(false);
  overlay.hidden = false;
  setHint();
  keeper = keepStream({ connect: () => connect(url), staleMs: STALE_MS });
}

function connect(url) {
  if (es) es.close();
  setLive(false);
  es = new EventSource(url);
  const mine = es;
  const alive = () => { if (keeper) keeper.alive(); };
  es.addEventListener('ping', alive);
  es.onopen = () => { if (keeper) keeper.opened(); };
  es.addEventListener('frame', (e) => {
    alive();
    let frame;
    try { frame = JSON.parse(e.data); } catch (err) { return; }
    // Frames are whole-screen snapshots: replace, don't append. Stick to the
    // bottom only when the user was already there — a scroll-up into the
    // scrollback must survive the next frame.
    const stick = preEl.scrollTop + preEl.clientHeight >= preEl.scrollHeight - 12;
    preEl.innerHTML = ansiToHtml(String(frame));
    if (stick) preEl.scrollTop = preEl.scrollHeight;
    setLive(true);
  });
  es.addEventListener('caps', (e) => {
    let c = {};
    try { c = JSON.parse(e.data); } catch (err) { /* keep the default */ }
    if (c.input === false) { inputUrl = null; setHint(); }
    // No tmux session behind an event-log pane: nothing for a terminal to attach to.
    if (c.attach === false) { termTarget = null; drawTerm(); drawCopy(); }
  });
  es.addEventListener('unsupported', () => showMsg('this harness has no live pane view'));
  es.addEventListener('busy', () => showMsg('too many live panes open — close one and try again'));
  es.addEventListener('no-pane', (e) => {
    let reason = '';
    try { reason = (JSON.parse(e.data) || {}).reason || ''; } catch (err) { /* plain message */ }
    showMsg('no live pane' + (reason ? ' — ' + reason : ''));
  });
  // EventSource retries only while CONNECTING; the keeper reopens a CLOSED stream.
  es.onerror = () => { setLive(false); if (keeper) keeper.error(mine); };
}

// ---------- tabs ----------
// A card may offer several windows of its worker's session (an orchestrator and
// the agents running beside it). One window renders no tabs at all, so the
// drawer is byte-for-byte what it was before this existed.
//
// The names come from the CARD, and the server only honours a window the card
// itself advertised — a tab can never become a way to watch something the card
// does not own.
const tabsEl = document.getElementById('pane-tabs');

function paneWindows(c) {
  const v = c && c.attributes && c.attributes.pane;
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const w of list) {
    const name = String(w).trim();
    if (/^[A-Za-z0-9_.-]{1,80}$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function drawTabs(names, current, onPick) {
  tabsEl.textContent = '';
  tabsEl.hidden = names.length < 2;
  if (tabsEl.hidden) return;
  for (const name of names) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pane-tab' + (name === current ? ' on' : '');
    b.textContent = name;
    b.onclick = () => onPick(name);
    tabsEl.appendChild(b);
  }
}

export function openCardPane(cardId, window_) {
  const c = card(cardId);
  const at = (c && c.attributes) || {};
  const names = paneWindows(c);
  const pick = window_ && names.includes(window_) ? window_ : names[0];
  const base = '/api/cards/' + encodeURIComponent(cardId) + '/pane/';
  const q = pick ? '?window=' + encodeURIComponent(pick) : '';
  drawTabs(names, pick, (name) => openCardPane(cardId, name));
  const w = workerFor(cardId);
  termTarget = cardTarget(c, w, pick);
  resume = resumeOf(w && w.ref);
  open(base + 'stream' + q, String(at.session || (c && c.title) || cardId), base + 'input' + q);
  drawTerm();
  drawCopy();
}
export function openLieutenantPane(id) {
  const l = lieutenant(id);
  const base = '/api/lieutenants/' + encodeURIComponent(id) + '/pane/';
  drawTabs([], null, () => {}); // a lieutenant is one session, never tabbed
  termTarget = lieutenantTarget(l);
  resume = resumeOf(l && l.ref);
  open(base + 'stream', String((l && l.ref && l.ref.session) || (l && l.name) || id), base + 'input');
  drawTerm();
  drawCopy();
}
export function closePane() {
  stop();
  inputUrl = null;
  drawTabs([], null, () => {});
  termTarget = null;
  resume = null;
  preEl.blur();
  overlay.hidden = true;
  drawTerm();
  drawCopy();
}
export function paneOpen() { return !overlay.hidden; }

document.getElementById('pane-close').onclick = closePane;
overlay.onclick = (e) => { if (e.target === overlay) closePane(); };
