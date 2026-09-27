// card detail: attributes header + markdown body + event timeline (chat lives in the chat panel)
import { S, card, lieutenants, lieutenantColor, cardActivityTs, cardRecency, kindEmoji, render, toggleFilter, filterSelected } from './state.js';
import { cardFacts, orderHtml, archiveReasonHtml } from './cardview.js';
import { esc, hhmm, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, cardArtifacts, artifactsHtml, cardStripHtml, uriBasename, uriDir, setHtmlIfChanged, playbookAttrHtml, classifyFile, attachmentKind } from './util.js';
import { md, mdEnhance, copyText } from './md.js';
import { api } from './api.js';
import { labelChipHtml, openLabelPicker, saveCardLabels } from './labels.js';
import { openCardThread, syncChatToMain } from './chat.js';
import { openFile, closeFile, fileKey, fileDirty, fileMerges, fileResolve, fileUpdate, fileNotice } from './filepane.js';
import { openCardMenu, detailActionsHtml } from './cardactions.js';
import { runCommand } from './commandui.js';
import { entries, hasEntries } from './slots.js';
import { renderPluginSection } from './plugins.js';
import { cardContext } from './cardview.js';
import { archivedCard, unarchive } from './archive.js';
import { openPopover } from './popover.js';

const isDesktop = () => window.innerWidth > 760; // matches the chat.js layout breakpoint

const el = document.getElementById('detail');
const titleEl = document.getElementById('dt-title');
const titleInput = document.getElementById('dt-title-input');
let editingTitle = false; // true while the inline title editor is open (guards re-render clobber)

// ---------- the panel's second subject ----------
// The ⚡ screen's schedules and hooks open in THIS panel, not in one that looks
// like it: same slide-in, same ✕, same drag-to-resize width, same full-screen
// at a phone width. Two panels would be two of all of that to keep in step.
//
// `aux` is the subject; the module that owns it paints the body, because the
// firings of a schedule are that module's business and not this file's. It
// repaints on every render, so a board event keeps the panel current the same
// way it keeps a card current.
let aux = null; // {key, emoji, title, sub, paint(el), onClose?}
const auxEl = document.getElementById('dt-aux');

export function openAuxDetail(a) {
  if (S.openCardId) closeDetail(); // one panel, one subject
  const prev = aux;
  aux = a;
  if (prev && prev.onClose && prev.key !== a.key) prev.onClose();
  render();
}
// The panel is going back to being a card's, or going away: let the subject's
// owner know, so the card it came from stops saying it is showing.
function dropAux() {
  if (!aux) return;
  const a = aux;
  aux = null;
  el.classList.remove('dt-aux-on');
  auxEl.hidden = true;
  auxEl.textContent = '';
  if (a.onClose) a.onClose();
}
export function auxDetailKey() { return aux ? aux.key : ''; }
// The owner re-read its data and wants the panel to say so. Cheap enough to be
// unconditional — the paint is a list of a few lines.
export function repaintAuxDetail() { if (aux) renderAux(); }

function renderAux() {
  el.hidden = false;
  el.classList.remove('frozen');
  el.classList.add('dt-aux-on');
  document.getElementById('dt-talk').hidden = true;
  document.getElementById('dt-menu-btn').hidden = true;
  document.getElementById('dt-unarch').hidden = true;
  setHtmlIfChanged(pactEl, ''); // plugin buttons are a card's, not a schedule's
  const emojiEl = document.getElementById('dt-emoji');
  if (emojiEl.textContent !== (aux.emoji || '')) emojiEl.textContent = aux.emoji || '';
  if (titleEl.textContent !== aux.title) titleEl.textContent = aux.title;
  titleEl.title = ''; // a schedule is not renamed from here
  const subEl = document.getElementById('dt-sub');
  if (subEl.textContent !== (aux.sub || '')) subEl.textContent = aux.sub || '';
  auxEl.hidden = false;
  aux.paint(auxEl);
}

export function openDetail(id) {
  dropAux(); // a card is the other subject this panel takes
  S.openCardId = id;
  // Desktop: selecting a card also syncs the left chat into that card's thread,
  // so its detail (right) and conversation (left) show side by side. Reuses the
  // one thread-switch owner; silent = no mobile tab-flip / focus steal. Mobile
  // keeps the tab layout untouched (chat switches only via the talk button).
  if (isDesktop()) { openCardThread(id, { silent: true }); return; } // openCardThread renders
  render();
}
// Archived snapshots open in the SAME panel, read-only: no chat sync (there is
// no live thread target behind a frozen card — its thread shows inline instead).
export function openArchivedDetail(id) {
  dropAux();
  S.openCardId = id;
  render();
}
// opts.keepChat: leave the chat on this card's thread instead of returning it
// to the lieutenant — for closing the panel on the way INTO the card's own
// file screen, where the conversation is still about this card.
export function closeDetail(opts) {
  if (aux) {
    dropAux();
    el.hidden = true;
    render();
    return;
  }
  const wasId = S.openCardId;
  S.openCardId = null;
  if (editingTitle) stopTitleEdit();
  if (editingBody) stopBodyEdit();
  el.hidden = true;
  // Desktop: closing a card-synced detail returns the left chat to the owning
  // lieutenant's main conversation rather than stranding it on the closed card.
  if (!(opts && opts.keepChat) && isDesktop() && wasId && S.chatMode && S.chatMode.mode === 'card' && S.chatMode.id === wasId) {
    syncChatToMain(); // renders
    return;
  }
  render();
}
export function detailOpen() { return !!S.openCardId || !!aux; }

document.getElementById('dt-close').onclick = closeDetail;

// Click-outside dismiss (desktop side-panel only). On mobile the detail is
// full-screen (100vw), so there is no "outside" — the ✕ and Escape stay the only
// close affordances there. A click that lands outside #detail closes it, reusing
// the one closeDetail path (which also returns the left chat to the lieutenant on
// desktop). Excluded from "outside": the left chat pane (#chat — on desktop it
// shows the selected card's own thread, so it's part of the card context, not
// outside — and the lieutenant switcher dropdown lives inside it), a .tile (its
// own handler switches to that card's detail — a switch, not a close), the transient
// popovers (move menu, label picker, notif/settings panels) so dismissing one of
// those never also closes the detail, and the floating stop-speaking bubble
// (stopping TTS is not a navigation intent). Net effect: only a click on the
// BOARD area (columns / empty space) closes via click-outside.
// If a rename is in progress, commit it (like Enter/blur) before
// closing rather than discarding it: commitTitleEdit reads card(S.openCardId) so
// it must run before closeDetail nulls it, and it clears editingTitle so
// closeDetail's own stopTitleEdit is then a no-op — no double-fire.
document.addEventListener('click', (e) => {
  if ((!S.openCardId && !aux) || !isDesktop()) return;
  const t = e.target;
  // A click on a control that removed itself on the way out reaches document
  // with a DETACHED target: every closest() below then misses and the detail
  // closes as collateral. A node that is no longer in the page can't tell us
  // anything about where the click landed — ignore it.
  if (!t.isConnected) return;
  if (el.contains(t)) return;                 // inside the panel — stays open
  if (t.closest && (
    t.closest('#chat') ||                     // left chat = the selected card's thread; part of its context
    t.closest('.tile') ||                     // another card — switch, handled by its onclick
    t.closest('.sc-row') ||                   // a ⚡ card — its own handler switches the subject
    t.closest('.hk-row') ||                   // …and a ▶ on a hook is not a navigation intent
    t.closest('#log-overlay') ||              // a firing's log sits above the panel
    t.closest('#table tbody tr') ||           // table/archive rows switch cards the same way
    t.closest('#archive tbody tr') ||
    t.closest('#lt-overlay') ||               // new-lieutenant modal
    t.closest('.popover') ||                  // transient popovers dismiss on their own
    t.closest('#notif-panel') ||
    t.closest('#settings-panel') ||
    t.closest('#label-picker') ||
    t.closest('#av-overlay') ||               // artifact viewer sits above the detail
    t.closest('.bc-modal-overlay') ||         // a command form or an activity log opened from it
    t.closest('#taskbar') ||                  // …and the taskbar that opens those logs
    t.closest('#toast-stack') ||
    t.closest('#mmd-overlay') ||              // fullscreen mermaid diagram overlay
    t.closest('.speech-transport') ||         // floating speech transport (and its buttons)
    t.closest('[data-label-add]')
  )) return;
  if (editingTitle) commitTitleEdit();        // save the in-progress rename first
  closeDetail();
});
// 💬 talk — the card command table's talk action (cardactions.js) lands here,
// from the header button and from any card's menu alike.
export function talkOnCard(id) {
  if (!id) return;
  // Desktop already shows the thread on the left (synced on select), so just
  // focus that thread — keep the detail open for the side-by-side view. Mobile
  // has no side-by-side, so switch the chat tab to the thread as before.
  if (isDesktop()) { openCardThread(id); return; }
  if (S.openCardId) closeDetail();
  openCardThread(id);
}
document.getElementById('dt-talk').onclick = () => talkOnCard(S.openCardId);
// ---------- the collapsed line, and the artifacts accordion ----------
// Both are per-card view state, and the card viewer remembers nothing across
// cards: opening a different card collapses the line again and re-opens
// artifacts. `foldCardId` is what tells a re-render (SSE push) apart from a
// card switch, so a repaint never clobbers a toggle he just made.
const stripEl = document.getElementById('dt-strip');
let foldCardId = null;
let foldOpen = false;   // the attribute/label/timeline fold under the line
let artsOpen = true;    // the artifacts accordion — open on every card
function toggleFold() {
  foldOpen = !foldOpen;
  applyFold();
}
function applyFold() {
  stripEl.classList.toggle('open', foldOpen);
  document.getElementById('dt-fold').hidden = !foldOpen;
}
stripEl.onclick = toggleFold;
stripEl.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFold(); }
};

// ⋯ — the same card menu the tile and the table row open (cardactions.js)
document.getElementById('dt-menu-btn').onclick = (e) => {
  if (S.openCardId) openCardMenu(S.openCardId, e.currentTarget);
};
// the plugin buttons (detail.actions/v1) — one delegated handler, the markup is repainted
const pactEl = document.getElementById('dt-pactions');
pactEl.onclick = (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (b && S.openCardId) runCommand(b.dataset.cmd, S.openCardId);
};

// ---------- plugin sections (detail.sections/v1) ----------
// Below the built-in sections, each in its own box: the plugin's module is
// imported the first time one is shown and its render(el, card, state) runs on
// every repaint, inside the slot error boundary. The boxes are rebuilt only
// when the card or the set of sections changes, so a plugin's DOM survives a
// board push.
const secEl = document.getElementById('dt-sections');
let secMounts = { sig: '', list: [] };
function clearSections() {
  for (const m of secMounts.list) if (m.dispose) m.dispose();
  secMounts = { sig: '', list: [] };
  if (secEl.firstChild) secEl.textContent = '';
}
function renderSections(c, arch) {
  // a frozen snapshot is not something a plugin acts on
  const list = arch || !hasEntries('detail.sections/v1') ? [] : entries('detail.sections/v1', cardContext(c, S.doc));
  const sig = c.id + '|' + list.map((e) => e.key).join(',');
  if (sig !== secMounts.sig) {
    clearSections();
    secMounts.sig = sig;
    for (const entry of list) {
      const box = document.createElement('section');
      box.className = 'dt-psec';
      box.dataset.key = entry.key;
      const head = document.createElement('div');
      head.className = 'dt-events-head dt-psec-head';
      head.textContent = (entry.icon ? entry.icon + ' ' : '') + entry.title;
      if (entry.plugin) {
        const by = document.createElement('span');
        by.className = 'dt-psec-by';
        by.textContent = entry.plugin;
        head.appendChild(by);
      }
      const body = document.createElement('div');
      body.className = 'dt-psec-body';
      box.append(head, body);
      secEl.appendChild(box);
      secMounts.list.push({ entry, el: body, dispose: null });
    }
  }
  for (const m of secMounts.list) {
    const d = renderPluginSection(m.entry, m.el, c);
    if (d) m.dispose = d;
  }
}

// ---------- inline title rename ----------
function startTitleEdit() {
  const c = card(S.openCardId);
  if (!c || editingTitle) return;
  editingTitle = true;
  titleInput.value = c.title || c.id;
  titleEl.hidden = true;
  titleInput.hidden = false;
  titleInput.focus();
  titleInput.select();
}
function stopTitleEdit() {
  editingTitle = false;
  titleInput.hidden = true;
  titleEl.hidden = false;
}
async function commitTitleEdit() {
  if (!editingTitle) return;
  const c = card(S.openCardId);
  const to = titleInput.value.trim();
  stopTitleEdit();
  if (!c) return;
  if (!to || to === (c.title || '')) { render(); return; } // reject empty / no-op
  try { await api.patchCard(c.id, { title: to }); } // SSE board push repaints tile + detail live
  catch (e) { alert(e.message); render(); }
}
titleEl.onclick = startTitleEdit;
titleInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopTitleEdit(); render(); }
};
titleInput.onblur = commitTitleEdit;

// ---------- inline body (description) edit ----------
// Mirrors the title editor: an editingBody flag guards re-render clobber while
// the textarea is open; save persists through the same PATCH path as any body
// update, and the SSE board push repaints the rendered markdown live.
const bodyEl = document.getElementById('dt-body');
const bodyEditBtn = document.getElementById('dt-body-edit');
const bodyEditor = document.getElementById('dt-body-editor');
const bodyInput = document.getElementById('dt-body-input');
let editingBody = false;
function startBodyEdit() {
  const c = card(S.openCardId);
  if (!c || editingBody) return;
  editingBody = true;
  bodyInput.value = c.body || '';
  bodyEl.hidden = true;
  bodyEditBtn.hidden = true;
  bodyEditor.hidden = false;
  bodyInput.focus();
}
function stopBodyEdit() {
  editingBody = false;
  bodyEditor.hidden = true;
  bodyEl.hidden = false;
  bodyEditBtn.hidden = false;
}
async function commitBodyEdit() {
  if (!editingBody) return;
  const c = card(S.openCardId);
  const to = bodyInput.value;
  stopBodyEdit();
  if (!c || to === (c.body || '')) { render(); return; } // no-op
  try { await api.patchCard(c.id, { body: to }); }
  catch (e) { alert(e.message); render(); }
}
bodyEditBtn.onclick = startBodyEdit;
document.getElementById('dt-body-save').onclick = commitBodyEdit;
document.getElementById('dt-body-cancel').onclick = () => { stopBodyEdit(); render(); };
bodyInput.onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitBodyEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopBodyEdit(); render(); }
};

// ---------- artifact viewer (popup) ----------
const avOverlay = document.getElementById('av-overlay');
const avModal = document.getElementById('av-modal');
const avName = document.getElementById('av-name');
const avBody = document.getElementById('av-body');
const avImgWrap = document.getElementById('av-img-wrap');
const avImg = document.getElementById('av-img');
const avVideoWrap = document.getElementById('av-video-wrap');
const avVideo = document.getElementById('av-video');
const avAudioWrap = document.getElementById('av-audio-wrap');
const avAudio = document.getElementById('av-audio');
const avFrame = document.getElementById('av-frame');
const avExpand = document.getElementById('av-expand');
const avDownload = document.getElementById('av-download');
const avSrcBtn = document.getElementById('av-src');
const avCopyBtn = document.getElementById('av-copy');
const avEditBtn = document.getElementById('av-edit');
// Reset the shared overlay to a clean text-mode state (used by both openers).
function avReset(name, uri) {
  avUri = uri || '';
  avName.textContent = name;
  avName.title = uri || name;
  avImgWrap.hidden = true;
  avImg.removeAttribute('src');
  avVideoWrap.hidden = true;
  avVideo.pause();
  avVideo.removeAttribute('src');
  avVideo.load(); // actually drop the previous stream (removeAttribute alone doesn't)
  avAudioWrap.hidden = true;
  avAudio.pause();
  avAudio.removeAttribute('src');
  avAudio.load(); // actually drop the previous stream (removeAttribute alone doesn't)
  avFrame.hidden = true;
  avFrame.removeAttribute('src'); // drop the previous page so it can't linger
  avBody.hidden = false;
  avBody.className = '';
  avDownload.hidden = true;
  avMd = null;
  avShowSrc = false;
  avSrcBtn.hidden = true;
  avSrcBtn.classList.remove('on');
  avText = null;
  avCopyBtn.hidden = true;
  avCopyBtn.textContent = '⧉';
  avCopyBtn.classList.remove('ok');
  avEditBtn.hidden = true;
  avEditable = null;
  avModal.classList.remove('expanded'); // each open starts at the default size
  avOverlay.hidden = false;
}
// Markdown preview with a rendered ⇄ source toggle (the </> button in the
// head). avMd holds the raw text while a markdown preview is up; the toggle
// re-renders in place, so it also survives expand/restore.
let avMd = null, avShowSrc = false;
// The uri of whatever the viewer is on, kept for the whole open: it is the
// document a relative image in a markdown preview resolves against (a chat
// attachment has no directory, so it resolves nothing).
let avUri = '';
// The full text source currently in the viewer (markdown or plain) — what the
// head ⧉ copies, regardless of the rendered ⇄ source toggle. Text-only: image /
// video / audio / iframe / download states never set it, so the button stays
// hidden there.
let avText = null;
function avCopyable(text) { avText = text; avCopyBtn.hidden = false; }
avCopyBtn.onclick = () => copyText(avText == null ? '' : avText).then((ok) => {
  avCopyBtn.textContent = ok ? '✓' : '✗';
  avCopyBtn.classList.toggle('ok', ok);
  setTimeout(() => { avCopyBtn.textContent = '⧉'; avCopyBtn.classList.remove('ok'); }, 1500);
});
function showMarkdown(text) {
  avMd = text;
  avSrcBtn.hidden = false;
  avCopyable(text);
  renderAvMd();
}
function renderAvMd() {
  avSrcBtn.classList.toggle('on', avShowSrc);
  if (avShowSrc) { avBody.className = ''; avBody.textContent = avMd; }
  else { avBody.className = 'md'; avBody.innerHTML = md(avMd, uriDir(avUri)); mdEnhance(avBody); }
}
avSrcBtn.onclick = () => { avShowSrc = !avShowSrc; renderAvMd(); };

// ---------- editing a text artifact ----------
// The viewer stays what it was born as: something you open and close in ten
// seconds. Editing is where you stay, so ✎ LEAVES the popup — it hands the file
// to the file screen (filepane.js), which takes the board's place with the chat
// still at its side. This module is the part that knows the file is a card
// artifact; the screen and the editor below it never learn that.
//
// Saving writes the file for real (PUT /api/artifact), carrying the version the
// GET handed out. Two things are kept per uri: the draft (so leaving the screen
// and coming back never loses typing) and the version last seen on disk, which
// is what makes a concurrent write a 409 on the screen instead of a silent
// overwrite.
const drafts = new Map();   // uri -> edited text, until it is saved
const versions = new Map(); // uri -> sha256 of the content this browser read
let avEditable = null;      // { uri, name, markdown, content } while a text artifact is up

// Offer ✎ for the text we just put in the viewer (markdown or plain source).
function avEditableText(uri, name, markdown, content) {
  avEditable = { uri, name, markdown, content };
  avEditBtn.hidden = false;
}
// Put text in the viewer body — markdown rendered (with the ⇄ toggle) or plain.
// Both the first open and a live update below go through here.
function avShowText(markdown, text) {
  if (markdown) return showMarkdown(text);
  avBody.className = '';
  avBody.textContent = text;
  avCopyable(text);
}
// Hand a file to the file screen — the ✎ route and the drawing route both come
// through here. `extra` carries what differs (markdown / draw, and the text).
function toFileScreen(uri, name, extra) {
  const c = card(S.openCardId);
  closeArtifact();
  // The card panel is a board-area overlay and the board is what we are
  // leaving — but the chat must NOT follow it back to the lieutenant: it stays
  // on this card's thread, which is where the conversation about this file goes.
  closeDetail({ keepChat: true });
  openFile(Object.assign({
    key: uri,
    name,
    crumb: c && {
      label: cardEmoji(c) + ' ' + (c.title || c.id),
      title: 'back to this card',
      onClick: () => { closeFile(); openDetail(c.id); },
    },
    onChange: (text) => drafts.set(uri, text),
    onSave: (text, svg) => saveArtifactText(uri, text, svg, c && c.id),
  }, extra));
}
avEditBtn.onclick = () => {
  if (!avEditable) return;
  const { uri, name, markdown, content } = avEditable;
  toFileScreen(uri, name, {
    markdown,
    content: drafts.has(uri) ? drafts.get(uri) : content,
    saved: content, // what is on disk — a restored draft is still unsaved typing
  });
};
// A drawing is not something you glance at and close — it is a surface you stay
// in, like editing. So it skips the popup entirely and opens straight on the
// file screen, where the canvas takes the board's place with the chat at its side.
async function openDrawing(uri, name) {
  let r;
  try { r = await api.artifact(uri); }
  catch (e) {
    avReset(name, uri);
    avBody.textContent = '⚠ cannot open this drawing — ' + e.message;
    return;
  }
  if (!drafts.has(uri)) versions.set(uri, r.version || '');
  toFileScreen(uri, name, {
    draw: true,
    content: drafts.has(uri) ? drafts.get(uri) : r.content,
    saved: r.content,
  });
}
// The save the file screen calls. Resolves with the line it should show, or
// rejects with the one it should show in red — the screen prints what it is
// told and never learns what an artifact is.
async function saveArtifactText(uri, text, svg, cardId) {
  try {
    return await landed(uri, await api.saveArtifact(uri, text, versions.get(uri) || ''), text, svg, cardId);
  } catch (e) {
    // 409: someone (or something) else wrote this file since we read it.
    if (e.status !== 409) throw e;
    const disk = e.body && e.body.content;
    // A DRAWING resolves this itself, because that is the whole reason it merges
    // shape by shape: take their copy, merge it with his, and write THAT against
    // the version the refusal just handed us — in the same breath, so the pin
    // never exists on its own. It must not: the canvas saves itself on a timer,
    // so a pinned version with no merge behind it is a clean overwrite of
    // somebody's work that no human ever chose.
    if (fileMerges() && fileKey() === uri) {
      const merged = disk == null ? null : fileResolve(disk);
      if (merged == null) {
        // Unreadable, or nothing to merge into. Then the refusal STANDS — and
        // the version stays where it was, so the next automatic save is refused
        // again instead of going through clean.
        throw new Error('this file changed on disk and could not be merged — nothing was written, and your drawing is still here.');
      }
      const r = await api.saveArtifact(uri, merged, e.body.version);
      const note = await landed(uri, r, merged, svg, cardId);
      return { note: '↻ the other hand got there first — merged and ' + note, saved: merged };
    }
    // Text cannot be merged, so a human decides. He reads this, and clicking 💾
    // again is that decision — which is the only reason pinning is sound here.
    if (e.body && e.body.version) versions.set(uri, e.body.version);
    throw new Error('this file changed on disk since you opened it — nothing was written, and your text is still here. ' +
      'Save again to overwrite the disk version, or copy your text out first.');
  }
}
// A write landed: remember the version it produced, drop the draft, and put the
// picture beside it. Returns the line to show.
async function landed(uri, r, text, svg, cardId) {
  versions.set(uri, r.version);
  drafts.delete(uri); // what is on disk IS this text now
  if (avEditable && avEditable.uri === uri) avEditable.content = text;
  const also = svg ? await saveSvg(uri, svg, cardId) : '';
  return 'saved — ' + r.bytes + ' bytes on disk' + also;
}
// A drawing renders in Excalidraw and nowhere else, which would make it
// invisible in card bodies, reports and explains — where mermaid already shows.
// So every save also drops the picture next to the file as <name>.excalidraw.svg
// and lists it on the card, which is what makes it servable and viewable.
//
// It is DERIVED output, not the deliverable: it goes through the same guarded
// write, but a 409 on it just means someone else's render got there first, and
// the newest drawing is the one that should be showing — so it is redone once
// against what is on disk. Nothing here can turn a saved drawing into a failed
// save; the worst it does is say the picture is missing.
async function saveSvg(uri, svg, cardId) {
  const su = uri + '.svg';
  try {
    const text = await svg(); // taken now, of what actually landed — not of a scene we did not write
    if (cardId) await api.addArtifact(cardId, su, uriBasename(su)); // idempotent; also what makes it writable
    try {
      versions.set(su, (await api.saveArtifact(su, text, versions.get(su) || '')).version);
    } catch (e) {
      if (e.status !== 409 || !e.body || !e.body.version) throw e;
      versions.set(su, (await api.saveArtifact(su, text, e.body.version)).version);
    }
    return ' + svg';
  } catch (e) {
    return ' (no svg — ' + (e && e.message ? e.message : 'export failed') + ')';
  }
}
// The other hand wrote a file (SSE `artifact` from a landed PUT: {uri, version,
// by}). Four hands means the screen follows by itself — a reload button here
// would make this two hands taking turns.
//   buffer clean → take the new text in place, changed lines marked. No asking:
//                  there is nothing of his to lose, so there is no decision.
//   buffer dirty → say it and let HIM choose. The one case that earns a click.
// The write's own client hears its echo and does nothing (`by`), and the version
// check covers the case where two clients already agree on the text.
export async function artifactWritten(ev) {
  const uri = ev && ev.uri;
  if (!uri || (ev.by && ev.by === api.clientId)) return; // our own save coming back
  // Two screens can be on this file: the file screen (editing) and the viewer
  // popup (a glance). They are never both on it — ✎ closes the popup on its way
  // to the screen — so whichever one is showing it is the one that follows.
  const onFileScreen = fileKey() === uri;
  const inViewer = () => artifactOpen() && avEditable && avEditable.uri === uri;
  if (!onFileScreen && !inViewer()) return; // nothing of ours is open on it; a later open re-reads anyway
  if (versions.get(uri) === ev.version) return;
  let r;
  try { r = await api.artifact(uri); } catch (e) { return; } // gone or unreadable — the save will say so
  if (!onFileScreen) {
    // The popup is read-only, so there is nothing of his to lose and nothing to
    // ask — unless a draft is open on this file (typed on the file screen, still
    // unsaved, and what the popup is showing). Then it is left alone, version and
    // all, so saving that draft is still the 409 it should be.
    if (inViewer() && !drafts.has(uri)) {
      versions.set(uri, r.version);
      avEditable.content = r.content;
      avShowText(avEditable.markdown, r.content);
    }
    return;
  }
  if (fileKey() !== uri) return; // he left the screen while we were fetching
  const take = (note) => {
    versions.set(uri, r.version);
    drafts.delete(uri);
    if (avEditable && avEditable.uri === uri) avEditable.content = r.content;
    fileUpdate(r.content, note);
  };
  // A drawing never has to choose: the shapes merge, and the ones he has his
  // hands on are left alone. That is the whole point of merging by element —
  // there is nothing of his to lose, dirty or not, so there is nothing to ask.
  if (!fileDirty() || fileMerges()) return take('↻ the other hand wrote this file');
  // Dirty: his text is NOT touched and the version stays pinned to what his
  // draft started from, so saving it is still a 409 — the last line of defense
  // holds even if he ignores this line entirely.
  fileNotice('⚠ the other hand wrote this file while you have unsaved text here — nothing of yours was touched.',
    'warn', [
      { label: '↻ show me theirs', title: 'load the version on disk, changed lines marked — your unsaved text goes', onClick: () => take('↻ loaded the version on disk') },
      { label: '✋ keep mine', title: 'leave your text alone (saving it will ask you to confirm the overwrite)', onClick: () => {} },
    ]);
}

// Open any file the artifact routes will serve on the file screen, through the
// SAME drafts, versions and 409 handling a card artifact gets — which is what
// makes the config screen's playbooks an editing surface without a second
// editor, a second file API or a second lost-update story behind them.
// `opts` adds what the caller knows: `crumb` (where this came from) and
// `readOnly` — the line a save is refused with, for a file that has to be
// copied somewhere writable first.
export async function openArtifactFile(uri, name, opts) {
  const o = opts || {};
  const r = await api.artifact(uri);
  if (!drafts.has(uri)) versions.set(uri, r.version || '');
  openFile({
    key: uri,
    name,
    markdown: classifyFile(name) === 'markdown',
    content: drafts.has(uri) ? drafts.get(uri) : r.content,
    saved: r.content, // a restored draft is still unsaved typing
    crumb: o.crumb,
    onChange: (text) => drafts.set(uri, text),
    onSave: o.readOnly
      ? () => Promise.reject(new Error(o.readOnly))
      : (text) => saveArtifactText(uri, text, null, null),
  });
  return r;
}

// An artifact entry may carry a content-type hint ({uri, label, type}) — e.g.
// the auto-attached worker brief is markdown in a `.prompt` file. The hint
// wins; the extension regex is the fallback.
const isMdArtifact = (art, name) => (art && art.type) === 'markdown' || classifyFile(name) === 'markdown';
export async function openArtifact(uri) { // exported for the test; the UI reaches it by click
  const name = uriBasename(uri) || uri;
  const kind = classifyFile(name);
  if (kind === 'drawing') return openDrawing(uri, name); // a drawing opens as a canvas, not as its JSON
  avReset(name, uri);
  avBody.textContent = 'loading…';
  // A promoted chat attachment resolves through the attachment viewer (images
  // preview inline, text shows content, binary downloads) rather than the
  // text-only /api/artifact path.
  const c = card(S.openCardId);
  const at = c && (c.attributes || {}).artifacts && (c.attributes.artifacts.find((a) => a && a.uri === uri));
  const title = (at && at.label) || name; // the curated label shows as the viewer title
  avName.textContent = title;
  const am = /^attachment:\/\/(.+)$/.exec(uri);
  if (am) {
    return openAttachment({ id: am[1], name: (at && at.label) || name, mime: '', type: at && at.type });
  }
  // Non-attachment artifact (file:// / bare path). Dispatch by extension: an
  // image renders inline from the raw byte serve; text/markdown keeps the text
  // preview; a known binary offers a download instead of "no preview".
  const rawUrl = '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1';
  const offerDownload = (msg) => {
    avBody.hidden = false; avImgWrap.hidden = true; avImg.removeAttribute('src');
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.className = ''; avBody.textContent = msg;
  };
  if (kind === 'image') {
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avImgWrap.hidden = false; avImg.src = rawUrl; avImg.alt = title;
    return;
  }
  if (kind === 'video') {
    // Inline player fed by the same raw serve the ⬇ button uses. No autoplay.
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avVideoWrap.hidden = false; avVideo.src = rawUrl;
    return;
  }
  if (kind === 'audio') {
    // Inline player fed by the same raw serve the ⬇ button uses. No autoplay.
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avAudioWrap.hidden = false; avAudio.src = rawUrl;
    return;
  }
  if (kind === 'html') {
    // A rendered .html/.htm page (teach-me, report): show it live in an iframe fed
    // by the *directory* serve, not the raw query — a page needs a folder for its
    // relative references to sit in, so `./audio.wav` beside it loads instead of
    // asking the board for /api/audio.wav. These pages want room — open expanded.
    const f = uri.replace(/^file:\/\//, ''), cut = f.lastIndexOf('/');
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avImgWrap.hidden = true;
    avFrame.hidden = false;
    avFrame.src = '/artifacts/' + encodeURIComponent(f.slice(0, cut)) + '/' + encodeURIComponent(f.slice(cut + 1));
    avModal.classList.add('expanded');
    return;
  }
  if (kind === 'binary') return offerDownload('No inline preview for this file type. Use ⬇ to download.');
  // Text / markdown (or unknown) → the existing text preview. A genuine binary
  // (null bytes → 415) or over-cap text (413, "too large") falls through to a
  // download offer, carrying the server's message.
  try {
    const r = await api.artifact(uri);
    const markdown = isMdArtifact(at, name);
    // An unsaved draft is what the captain last typed — show that, not the copy
    // on disk. The version follows the same rule: while a draft is open it stays
    // pinned to the disk state the draft was started from, so a write that lands
    // underneath it is still a 409 when he finally saves.
    if (!drafts.has(uri)) versions.set(uri, r.version || '');
    const text = drafts.has(uri) ? drafts.get(uri) : r.content;
    avShowText(markdown, text);
    avEditableText(uri, name, markdown, r.content); // ✎ turns the preview into an editor
  } catch (e) {
    offerDownload('⚠ no preview — ' + e.message + ' (use ⬇ to download)'); // binary / too large / unreadable
  }
}
// Open a chat attachment: images preview inline, text-ish types show their
// content, everything else downloads. Served straight from /api/attachments/:id
// (never /api/artifact — an attachment need not be a promoted card artifact).
export async function openAttachment(att) {
  const url = '/api/attachments/' + encodeURIComponent(att.id);
  const name = att.name || '';
  avReset(name || att.id, name);
  avDownload.href = url;
  avDownload.setAttribute('download', name || 'file');
  avDownload.hidden = false;
  const showImage = () => { avBody.hidden = true; avImgWrap.hidden = false; avImg.src = url; avImg.alt = name; };
  const showVideo = () => { avBody.hidden = true; avVideoWrap.hidden = false; avVideo.src = url; };
  const showAudio = () => { avBody.hidden = true; avAudioWrap.hidden = false; avAudio.src = url; };
  const showText = (text) => {
    if (isMdArtifact(att, name)) showMarkdown(text);
    else { avBody.className = ''; avBody.textContent = text; avCopyable(text); }
  };
  const shows = { image: showImage, video: showVideo, audio: showAudio };
  const noPreview = () => { avBody.textContent = 'No inline preview for this file type. Use ⬇ to download.'; };
  // Decide from mime/extension when possible; a promoted artifact carries only
  // {uri, label}, so its mime may be unknown — then consult the served
  // Content-Type before falling back to a download.
  const kind = attachmentKind(att.mime, name);
  if (shows[kind]) return shows[kind]();
  if (kind === 'binary') return noPreview();
  avBody.textContent = 'loading…';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // the name said text, or nothing: an undecided one (a promoted image with a
    // custom label) is settled by what the server says it is
    const served = kind || attachmentKind((r.headers.get('content-type') || '').split(';')[0], '');
    if (shows[served]) return shows[served]();
    if (served === 'text') return showText(await r.text());
    noPreview();
  } catch (e) { avBody.textContent = '⚠ no preview — ' + e.message + ' (use ⬇ to download)'; }
}
// A close hook lets main.js run one deferred render when the viewer closes
// (renders are skipped while it's open — see the reading-mode guard). Mirrors
// state.js onRender: a setter avoids a circular import back into main.js.
let onCloseFn = () => {};
export function onArtifactClose(fn) { onCloseFn = fn; }
export function closeArtifact() { avOverlay.hidden = true; avVideo.pause(); avAudio.pause(); onCloseFn(); }
export function artifactOpen() { return !avOverlay.hidden; }
document.getElementById('av-close').onclick = closeArtifact;
// Maximize / restore the viewer (pure CSS class toggle — see #av-modal.expanded).
avExpand.onclick = () => { avModal.classList.toggle('expanded'); };
avOverlay.onclick = (e) => { if (e.target === avOverlay) closeArtifact(); };

// ---------- owner menu (reassign the owning lieutenant) ----------
// Lists the OTHER lieutenants by name with their color dot; picking one
// PATCHes {owner} and the SSE board push repaints chip + tile live. Opened by
// the ✎ on the owner chip, which only renders while no worker is bound (the
// server refuses owner changes otherwise).
function openOwnerMenu(cardId, anchor) {
  const c = card(cardId);
  // the ✎ may be stale: a worker can bind between the paint and the click
  if (!c || !cardFacts(c, S.doc).canEditOwner) return;
  const others = lieutenants().filter((l) => l.id !== c.owner);
  openPopover(anchor, [
    { head: 'hand card to' },
    ...(others.length ? [] : [{ note: 'no other lieutenant' }]),
    ...others.map((l) => ({ label: l.name || l.id, dot: lieutenantColor(l.id), onClick: () => patchOrSay(cardId, { owner: l.id }) })),
  ], { id: 'owner-menu' });
}
async function patchOrSay(cardId, body) {
  try { await api.patchCard(cardId, body); } catch (e) { alert(e.message); }
}

// ---------- playbook menu (pick the playbook card.start renders) ----------
// The list is fetched on every open, never cached: playbooks/ is a folder the
// captain edits, and a playbook dropped in a minute ago must be pickable now.
// "none" is offered on purpose — clearing the playbook is a real state, it just
// means the card cannot start.
async function openPlaybookMenu(cardId, anchor) {
  const c = card(cardId);
  // the same rule the ✎ is drawn by (cardFacts) — a card that moved while the
  // panel was open must not pick up an editor through a stale button
  if (!c || !cardFacts(c, S.doc).canEditPlaybook) return;
  const pop = openPopover(anchor, [{ head: 'playbook' }], { id: 'playbook-menu' });
  let ids = [];
  try { ids = (await api.playbooks()).playbooks || []; }
  catch (e) { ids = []; }
  if (!pop.isOpen()) return; // closed while the fetch was in flight
  pop.set([
    { head: 'playbook' },
    ...(ids.length ? [] : [{ note: 'no playbooks in playbooks/' }]),
    ...['', ...ids].map((id) => ({ label: id || '— none', current: id === (c.playbook || ''),
      onClick: () => patchOrSay(cardId, { playbook: id }) })),
  ]);
}

// Opening the card clears its unread: level-1 events and lieutenant replies both
// derive from the same per-card read marker server-side, so one POST covers
// both. The chat panel only marks the thread when IT is visible (and only on
// unread messages), which misses the mobile detail view and event-only unread —
// this is the detail-side half. Debounced like chat.js maybeMarkRead: keyed by
// the newest unread-relevant ts so re-renders never spam the endpoint.
let lastMarked = { id: '', ts: '' };
function maybeMarkCardRead(c, f) {
  if (document.hidden) return;
  if (!f.unread) return; // server-derived; false once the marker lands
  const ts = cardActivityTs(c);
  if (lastMarked.id === c.id && lastMarked.ts === ts) return; // already sent
  lastMarked = { id: c.id, ts };
  api.markThreadRead('card:' + c.id).catch(() => { lastMarked = { id: '', ts: '' }; });
}

function attrHtml(k, v) {
  const isUrl = /^https?:\/\//.test(String(v));
  const val = isUrl
    ? '<a class="v" href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(String(v).replace(/^https?:\/\/(www\.)?/, '')) + '</a>'
    : '<span class="v">' + esc(String(v)) + '</span>';
  return '<span class="attr"><span class="k">' + esc(k) + '</span>' + val + '</span>';
}

export function renderDetail() {
  if (aux) { clearSections(); renderAux(); return; }
  el.classList.remove('dt-aux-on');
  auxEl.hidden = true;
  if (!S.openCardId) { el.hidden = true; clearSections(); return; }
  let c = card(S.openCardId);
  let arch = null; // the archive record when this is a frozen snapshot
  if (!c) {
    const frozen = archivedCard(S.openCardId);
    if (!frozen) { closeDetail(); return; }
    c = frozen.c;
    arch = frozen.arch;
  }
  el.hidden = false;
  el.classList.toggle('frozen', !!arch);
  // a different card = a fresh view: line collapsed, artifacts open
  if (foldCardId !== c.id) { foldCardId = c.id; foldOpen = false; artsOpen = true; }
  applyFold();
  // header actions per mode: live cards talk and move; a frozen snapshot's one
  // action is unarchive (restoring keeps the panel open — it becomes the live card)
  document.getElementById('dt-talk').hidden = !!arch;
  document.getElementById('dt-menu-btn').hidden = !!arch;
  const unBtn = document.getElementById('dt-unarch');
  unBtn.hidden = !arch;
  if (arch) unBtn.onclick = () => unarchive(c.id, unBtn);
  titleEl.title = arch ? '' : 'click to rename'; // rename is live-only (the editor no-ops on frozen ids)

  // every derived fact (worker, owner, order, archive reason, what is editable)
  // comes from the card view model the board and the table also draw from
  const f = cardFacts(c, S.doc, Date.now(), arch);
  const emojiEl = document.getElementById('dt-emoji');
  if (emojiEl.textContent !== f.emoji) emojiEl.textContent = f.emoji;
  if (!editingTitle && titleEl.textContent !== (c.title || c.id)) titleEl.textContent = c.title || c.id; // don't clobber an in-progress rename
  // sub line: id + timestamps, plus a worker-id chip when a worker is attached.
  // workerState is whitelisted in cardview, so no server value reaches the class
  // name; the id itself is esc()'d. Frozen snapshots carry no worker: they swap
  // the chip for when/why they were archived.
  setHtmlIfChanged(document.getElementById('dt-sub'),
    esc(c.id + ' · ' + c.type + ' · created ') + agoSpanHtml(c.created) + esc(' ago') +
    (arch
      ? esc(' · archived ') + agoSpanHtml(arch.ts) + esc(' ago') + archiveReasonHtml(f)
      : esc(' · updated ') + agoSpanHtml(cardRecency(c)) + esc(' ago')) +
    (f.workerId ? '<span class="dt-worker dt-worker-' + f.workerState + '" title="worker: ' + esc(f.workerState) + '">' + esc(f.workerId) + '</span>' : ''));

  // the collapsed line: what he needs before he needs anything else
  setHtmlIfChanged(stripEl, cardStripHtml(c, kindEmoji));

  // attributes header. The owner (the owning lieutenant) leads, in the
  // lieutenant's color and clickable as a filter. prs and artifacts are
  // structured lists with dedicated renderers below, so they are excluded from
  // the generic key:value chips.
  const at = c.attributes || {};
  const attrsEl = document.getElementById('dt-attrs');
  // data-card keys the markup to THIS card: the chip handlers below close over
  // c, so a same-looking attrs row on another card must not skip the rebuild
  const attrsChanged = setHtmlIfChanged(attrsEl,
    '<span class="attr attr-owner" data-card="' + esc(c.id) + '" title="click: filter by lieutenant · alt-click: exclude"><span class="k">lieutenant</span>' +
    '<span class="v" style="color:' + esc(lieutenantColor(c.owner)) + '">' + esc(f.ownerName) + '</span>' +
    // ✎ only while no worker is bound — the server's guard on owner PATCH.
    // Rendered in the markup (not appended after) so a worker binding/unbinding
    // changes the innerHTML signature and setHtmlIfChanged rebuilds the row.
    // Frozen snapshots never offer it: nothing about them is editable.
    (f.canEditOwner ? '<button type="button" class="owner-edit" title="change owner (only while no worker is bound)">✎</button>' : '') +
    '</span>' +
    // playbook: which one card.start renders. Shown always, editable only in
    // Backlog (cardFacts.canEditPlaybook). The ✎ is in the chip's own markup, so
    // it appears and disappears with the move without a special case here.
    playbookAttrHtml(c, f.canEditPlaybook) +
    orderHtml(f, 'attr') +
    Object.entries(at)
      .filter(([k]) => k !== 'emoji' && k !== 'prs' && k !== 'artifacts')
      .map(([k, v]) => attrHtml(k, v)).join('') +
    cardPrs(c).map((pr) => prChipHtml(pr, true)).join(''));
  const ownerChip = attrsChanged && attrsEl.querySelector('.attr-owner');
  if (ownerChip) {
    ownerChip.style.cursor = 'pointer';
    ownerChip.onclick = (e) => toggleFilter('owner', c.owner, e.altKey);
    const edit = ownerChip.querySelector('.owner-edit');
    if (edit) edit.onclick = (e) => {
      e.stopPropagation(); // the chip click is the owner filter, not the menu
      openOwnerMenu(c.id, edit);
    };
  }
  if (attrsChanged) {
    const playbookEdit = attrsEl.querySelector('.attr-playbook .owner-edit');
    if (playbookEdit) playbookEdit.onclick = (e) => {
      e.stopPropagation();
      openPlaybookMenu(c.id, playbookEdit);
    };
  }

  // labels (user-owned) — DOM-built, so guarded by a signature (card + each
  // chip's rendered markup, covering name/color/filter state) instead of an
  // innerHTML cache; the handlers close over c, hence c.id in the signature
  const labWrap = document.getElementById('dt-labels');
  const labSig = c.id + '|' + (arch ? 'frozen|' : '') + (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('');
  if (labWrap.__bcSig !== labSig) {
    labWrap.__bcSig = labSig;
    labWrap.textContent = '';
    for (const name of c.labels || []) {
      const chip = document.createElement('span');
      chip.className = 'dlabel';
      chip.innerHTML = labelChipHtml(name, filterSelected('label', name));
      chip.querySelector('.label').onclick = (e) => toggleFilter('label', name, e.altKey);
      if (!arch) { // frozen labels filter but never change
        const x = document.createElement('button');
        x.type = 'button'; x.textContent = '✕'; x.title = 'remove label';
        x.onclick = () => saveCardLabels(c.id, (c.labels || []).filter((v) => v !== name));
        chip.appendChild(x);
      }
      labWrap.appendChild(chip);
    }
    if (!arch) {
      const add = document.createElement('button');
      add.type = 'button';
      add.id = 'dt-label-add';
      add.setAttribute('data-label-add', '');
      add.textContent = '+ label';
      add.onclick = () => openLabelPicker(c.id, add);
      labWrap.appendChild(add);
    }
  }

  // body (don't clobber an in-progress description edit). mdEnhance runs
  // unconditionally: it is per-node guarded, so an unchanged body is a no-op,
  // and enhanced DOM (copy buttons, diagrams) never changes the cached html
  // string setHtmlIfChanged compares against.
  if (!editingBody) {
    setHtmlIfChanged(bodyEl, md(c.body || ''));
    mdEnhance(bodyEl);
    bodyEditBtn.hidden = !!arch; // description edit is live-only
  }

  // artifacts: attributes.artifacts [{uri, label}] — shown by FILENAME, not the
  // raw uri. http(s) uris open normally; anything else (file:// / local paths)
  // opens in the artifact viewer popup, served by GET /api/artifact.
  const artEl = document.getElementById('dt-artifacts');
  const artsChanged = setHtmlIfChanged(artEl, artifactsHtml(cardArtifacts(c)));
  if (artsChanged) artEl.querySelectorAll('.a-uri[data-view]').forEach((n) => {
    n.onclick = () => openArtifact(n.dataset.view);
  });
  // ...as an accordion, open by default. The block's own head is the summary;
  // a card with no artifacts renders nothing at all (.dt-artifacts:empty).
  artEl.classList.toggle('closed', !artsOpen);
  if (artsChanged) {
    const artsHead = artEl.querySelector('.dt-arts-head');
    if (artsHead) artsHead.onclick = () => {
      artsOpen = !artsOpen;
      artEl.classList.toggle('closed', !artsOpen);
    };
  }

  // frozen thread snapshot, inline: live cards converse in the chat panel, but
  // an archived card's thread is part of the snapshot — show it read-only here
  const thHead = document.getElementById('dt-thread-head');
  const thEl = document.getElementById('dt-thread');
  const showThread = !!arch && (c.thread || []).length > 0;
  thHead.hidden = thEl.hidden = !showThread;
  if (showThread) {
    setHtmlIfChanged(thEl, (c.thread || []).map((m) =>
      '<div class="ftm' + (m.author === 'user' ? ' mine' : '') + '">' +
      '<span class="fta">' + esc(m.author) + '</span>' +
      '<div class="ftb md">' + md(m.text || '') + '</div>' +
      '<span class="fts">' + hhmm(m.ts) + '</span></div>').join(''));
  }

  // event timeline (newest first)
  const evEl = document.getElementById('dt-events');
  const events = (c.events || []).slice().reverse();
  // kind emoji from the effective kinds map, for any level; unknown kind = no emoji
  setHtmlIfChanged(evEl, events.map((e) =>
    '<div class="ev lvl' + e.level + '"><span class="dot"></span><div class="bd">' +
    '<div class="tx">' + (kindEmoji(e.kind) ? esc(kindEmoji(e.kind)) + ' ' : '') + esc(e.text) + '</div>' +
    '<div class="sub">' + esc(e.actor || '') + ' · ' + hhmm(e.ts) + ' · ' + agoSpanHtml(e.ts) + ' ago</div>' +
    '</div></div>').join('') || '<div class="ev"><div class="bd"><div class="sub">no events yet</div></div></div>');

  // plugin buttons in the header, plugin sections under everything else
  setHtmlIfChanged(pactEl, arch ? '' : detailActionsHtml(c, S.doc));
  renderSections(c, arch);

  if (!arch) maybeMarkCardRead(c, f); // frozen snapshots have no read state to advance
}
