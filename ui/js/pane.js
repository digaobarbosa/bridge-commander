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
import { ansiToHtml } from './ansi.js';
import { keyForEvent } from './panekeys.js';
import { terminalLink, cardTarget, lieutenantTarget } from './terminal.js';
import { getTerminalMode, onTerminalMode } from './terminalsettings.js';
import { push as toast } from './toast.js';

const overlay = document.getElementById('pane-overlay');
const titleEl = document.getElementById('pane-title');
const liveEl = document.getElementById('pane-live');
const preEl = document.getElementById('pane-body');
const msgEl = document.getElementById('pane-msg');
const hintEl = document.getElementById('pane-hint');
const termEl = document.getElementById('pane-term');
let es = null;
let inputUrl = null;
let termTarget = null;          // { session, window } of what the drawer shows

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

function stop() { if (es) { es.close(); es = null; } }
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
function post(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  }).then((r) => {
    // A 4xx/5xx is a RESOLVED fetch, so .catch() never sees it: without this a
    // rejected keystroke is preventDefaulted away from the browser and then
    // vanishes with no trace anywhere.
    if (!r.ok) return r.json().catch(() => ({})).then((b) => { throw new Error(b.error || 'HTTP ' + r.status); });
    return null;
  }).catch((e) => { flash(String((e && e.message) || e)); });
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
  es = new EventSource(url);
  es.addEventListener('frame', (e) => {
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
  es.addEventListener('unsupported', () => showMsg('this harness has no live pane view'));
  es.addEventListener('busy', () => showMsg('too many live panes open — close one and try again'));
  es.addEventListener('no-pane', (e) => {
    let reason = '';
    try { reason = (JSON.parse(e.data) || {}).reason || ''; } catch (err) { /* plain message */ }
    showMsg('no live pane' + (reason ? ' — ' + reason : ''));
  });
  es.onerror = () => setLive(false); // EventSource reconnects on its own
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
  termTarget = cardTarget(c, workerFor(cardId), pick);
  open(base + 'stream' + q, String(at.session || (c && c.title) || cardId), base + 'input' + q);
  drawTerm();
}
export function openLieutenantPane(id) {
  const l = lieutenant(id);
  const base = '/api/lieutenants/' + encodeURIComponent(id) + '/pane/';
  drawTabs([], null, () => {}); // a lieutenant is one session, never tabbed
  termTarget = lieutenantTarget(l);
  open(base + 'stream', String((l && l.ref && l.ref.session) || (l && l.name) || id), base + 'input');
  drawTerm();
}
export function closePane() {
  stop();
  inputUrl = null;
  drawTabs([], null, () => {});
  termTarget = null;
  preEl.blur();
  overlay.hidden = true;
  drawTerm();
}
export function paneOpen() { return !overlay.hidden; }

document.getElementById('pane-close').onclick = closePane;
overlay.onclick = (e) => { if (e.target === overlay) closePane(); };
