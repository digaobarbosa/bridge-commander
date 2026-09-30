// activities — the taskbar and the activity panel. A tracked command run is an
// activity (board.activities, newest first, running first); the taskbar at the
// foot of the board region lists what is running (spinner) and the last few
// that ended (✓ / ✗), and a click opens the panel: the log, streamed while the
// run goes, and ⏹ cancel for a running one.
//
// The taskbar stays in the board region on a phone too: the topbar there is
// already title + 🔍 + the collapsed switcher + 🔔 + ⚙️, and a strip of chips
// that scrolls sideways fits above the tab bar without taking any of them.
import { S, card as cardById } from './state.js';
import { esc, agoSpanHtml, setHtmlIfChanged, refreshAgoLabels } from './util.js';
import { openModal } from './modal.js';

export const FINISHED_SHOWN = 3;
const GLYPH = { running: '', ok: '✓', failed: '✗', timeout: '⌛', canceled: '⏹' };

let barEl = null;
let openCardFn = () => {};
/** Hand over the taskbar element and the card opener. Called once, at boot. */
export function initActivities({ bar, openCard }) {
  barEl = bar;
  if (openCard) openCardFn = openCard;
  bar.onclick = (e) => {
    const chip = e.target.closest('[data-activity]');
    if (chip) openActivity(chip.dataset.activity);
  };
}

export function activities(doc = S.doc) { return ((doc && doc.activities) || []).filter((a) => a && a.id); }
export function activity(id, doc = S.doc) { return activities(doc).find((a) => a.id === id) || null; }

/** What the taskbar shows: every running run, then the latest FINISHED_SHOWN ended ones. Pure. */
export function taskbarItems(list) {
  const running = list.filter((a) => a.status === 'running');
  const ended = list.filter((a) => a.status !== 'running')
    .sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')))
    .slice(0, FINISHED_SHOWN);
  return running.concat(ended);
}

function statusCls(st) { return GLYPH[st] !== undefined ? st : 'failed'; }

export function renderTaskbar() {
  if (!barEl) return;
  const items = taskbarItems(activities());
  barEl.hidden = !items.length;
  const html = items.map((a) => {
    const st = statusCls(a.status);
    const c = a.card ? cardById(a.card) : null;
    const name = a.title || a.command || a.id;
    return '<button type="button" class="tb-act tb-' + st + '" data-activity="' + esc(a.id) + '" title="' +
      esc(name + ' — ' + a.status + (c ? ' · ' + (c.title || c.id) : '') + (a.error ? ' · ' + a.error : '')) + '">' +
      (st === 'running' ? '<span class="spin"></span>' : '<span class="tb-glyph">' + GLYPH[st] + '</span>') +
      '<span class="tb-name">' + esc(name) + '</span>' +
      (a.card ? '<span class="tb-card">' + esc(a.card) + '</span>' : '') + '</button>';
  }).join('');
  setHtmlIfChanged(barEl, '<span class="tb-head">activities</span>' + html);
  if (panel) paintPanelHead();
}

// ---------- the panel ----------

let panel = null; // { id, modal, pre, head, es, done, text, timer }

function paintPanelHead() {
  const a = activity(panel.id);
  const st = a ? statusCls(a.status) : 'failed';
  const c = a && a.card ? cardById(a.card) : null;
  setHtmlIfChanged(panel.head,
    '<span class="tb-act tb-' + st + ' ap-status">' + (st === 'running' ? '<span class="spin"></span>' : '<span class="tb-glyph">' + GLYPH[st] + '</span>') +
    esc(a ? a.status : 'unknown') + '</span>' +
    (a && a.plugin ? '<span class="ap-meta">' + esc(a.plugin) + '</span>' : '') +
    (c ? '<button type="button" class="ap-card" data-card="' + esc(c.id) + '">' + esc(c.title || c.id) + '</button>' : '') +
    (a && a.startedAt ? '<span class="ap-meta" title="started">⏱ ' + agoSpanHtml(a.startedAt) + '</span>' : '') +
    (a && a.error ? '<span class="ap-err">' + esc(a.error) + '</span>' : ''));
  refreshAgoLabels(panel.head); // the panel paints outside the render pass that fills [data-ago]
  const cardBtn = panel.head.querySelector('.ap-card');
  if (cardBtn) cardBtn.onclick = () => { const id = cardBtn.dataset.card; closePanel(); openCardFn(id); };
  const cancel = panel.modal.el.querySelector('.ap-cancel');
  if (cancel) cancel.hidden = !(a && a.status === 'running');
}

function append(text) {
  if (!panel || !text) return;
  const pre = panel.pre;
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  panel.text += text;
  pre.textContent = panel.text;
  pre.classList.remove('log-empty');
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}
// A `chunk` event's data: the text, as a JSON string or {text|chunk}; raw text otherwise.
export function chunkText(data) {
  try {
    const v = JSON.parse(data);
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return String(v.text != null ? v.text : v.chunk != null ? v.chunk : '');
  } catch (e) { /* not JSON: the text itself */ }
  return String(data || '');
}

function ended() {
  if (!panel) return;
  panel.done = true;
  if (!panel.text) { panel.pre.textContent = 'no output recorded'; panel.pre.classList.add('log-empty'); }
}

// The stream first; when it cannot be had (an older server, a proxy that
// buffers SSE), poll the log by offset until it says done.
function follow(id) {
  const p = panel;
  const running = (activity(id) || {}).status === 'running';
  if (!running || typeof EventSource === 'undefined') return poll(id, 0);
  const es = new EventSource('/api/activities/' + encodeURIComponent(id) + '/stream');
  p.es = es;
  let got = false;
  es.addEventListener('chunk', (e) => { got = true; if (panel === p) append(chunkText(e.data)); });
  es.addEventListener('end', () => { es.close(); if (panel === p) ended(); });
  es.onerror = () => {
    es.close();
    if (panel !== p || p.done) return;
    // a stream that never spoke is not a stream: read the log from the start
    if (!got) poll(id, 0);
    else { p.text = ''; poll(id, 0); }
  };
}
async function poll(id, from) {
  const p = panel;
  if (!p || p.done) return;
  try {
    const r = await fetch('/api/activities/' + encodeURIComponent(id) + '/log?from=' + from);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (panel !== p) return;
    append(j.text || '');
    if (j.done) return ended();
    p.timer = setTimeout(() => poll(id, Number.isFinite(j.size) ? j.size : from), 1000);
  } catch (e) {
    if (panel !== p) return;
    append('\n⚠ log unavailable: ' + e.message + '\n');
    ended();
  }
}

function closePanel() { if (panel) panel.modal.close(); }

/** Open the panel on activity `id`: status, card, the log (live while it runs), ⏹ cancel. */
export function openActivity(id) {
  if (panel) closePanel();
  const a = activity(id);
  const box = document.createElement('div');
  box.className = 'ap-wrap';
  const head = document.createElement('div');
  head.className = 'ap-head';
  const pre = document.createElement('pre');
  pre.className = 'ap-log';
  pre.textContent = 'reading the log…';
  box.append(head, pre);
  const modal = openModal({
    title: (a && (a.title || a.command)) || id,
    cls: 'bc-activity-modal',
    body: box,
    actions: [
      { label: '⏹ cancel', danger: true, onClick: (h) => cancel(id, h) },
      { label: 'close' },
    ],
    onClose: () => {
      if (!panel || panel.modal !== modal) return;
      if (panel.es) panel.es.close();
      clearTimeout(panel.timer);
      panel = null;
    },
  });
  const cancelBtn = modal.el.querySelector('.bc-modal-foot .danger');
  if (cancelBtn) cancelBtn.classList.add('ap-cancel');
  panel = { id, modal, pre, head, es: null, done: false, text: '', timer: null };
  pre.textContent = '';
  paintPanelHead();
  follow(id);
  return modal;
}
export function activityPanelId() { return panel ? panel.id : ''; }

async function cancel(id, h) {
  h.setError('');
  try {
    const r = await fetch('/api/activities/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status);
  } catch (e) { h.setError('cancel failed: ' + e.message); }
}
