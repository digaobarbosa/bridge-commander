// One popover manager for every small menu on the board: the card's move menu,
// the owner and playbook pickers, the lieutenant ⋯ menu and the phone's mode
// dropdown. Each used to build its own div, clamp it to the window and register
// its own click-away; that is written once here.
//
// Popovers form a stack. A click outside closes every one it is outside of, from
// the top down; Escape (main.js) closes only the top one.

const stack = []; // open popovers, oldest first
let wired = false;

/**
 * Where a box of size w×h lands so it stays inside a vw×vh viewport: at (x, y)
 * when it fits, pushed back in to `margin` from the edge when it does not.
 */
export function clampToViewport(x, y, w, h, vw, vh, margin = 8) {
  return {
    left: Math.max(margin, Math.min(x, vw - w - margin)),
    top: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

/**
 * Open a popover. `anchor` is an element (the popover opens under it) or a
 * {x, y} point. `content` is a DOM node or a list of items:
 *   {head} a caption · {sep: true} a rule · {note} a quiet line ·
 *   {label, onClick, current, danger, dot, title} a button (no onClick = inert).
 * opts: {id} — reopening the same id replaces it; {align: 'right'} lines the
 * popover's right edge up with the anchor's; {onClose}.
 * Returns {el, close(), isOpen(), set(content)}; set() refills and re-clamps.
 */
export function openPopover(anchor, content, opts = {}) {
  if (opts.id) closePopover(opts.id);
  wire();
  const el = document.createElement('div');
  el.className = 'popover';
  if (opts.id) el.id = opts.id;
  // The anchor's box is read once: a board push may rebuild the anchor while the
  // popover is still filling (the playbook list), and a detached one measures 0.
  const at = anchor && typeof anchor.getBoundingClientRect === 'function'
    ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y - 4 };
  const entry = { el, at, opts, armed: false };
  const handle = {
    el,
    close: () => close(entry),
    isOpen: () => stack.includes(entry),
    set: (c) => { fill(el, c, handle); place(entry); },
  };
  fill(el, content, handle);
  document.body.appendChild(el);
  stack.push(entry);
  place(entry);
  // The click that opened it is still on its way up to the document; arming on
  // the next tick keeps that same click from closing it again.
  setTimeout(() => { entry.armed = true; }, 0);
  return handle;
}

/** Close the popover opened with this id. True when one was open. */
export function closePopover(id) {
  const entry = stack.find((p) => p.opts.id === id);
  if (entry) close(entry);
  return !!entry;
}

/** Close the most recently opened popover. True when there was one — Escape stops there. */
export function closeTopPopover() {
  if (!stack.length) return false;
  close(stack[stack.length - 1]);
  return true;
}

function close(entry) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  entry.el.remove();
  if (entry.opts.onClose) entry.opts.onClose();
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (e) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const p = stack[i];
      if (p.el.contains(e.target)) break; // inside this one: it and those under it stay
      if (p.armed) close(p);
    }
  });
}

function place({ el, at, opts }) {
  const box = el.getBoundingClientRect();
  const x = opts.align === 'right' ? at.right - box.width : at.left;
  const pos = clampToViewport(x, at.bottom + 4, box.width, box.height, window.innerWidth, window.innerHeight);
  el.style.left = pos.left + 'px';
  el.style.top = pos.top + 'px';
}

function fill(el, content, handle) {
  el.textContent = '';
  if (!Array.isArray(content)) { if (content) el.append(content); return; }
  for (const it of content) el.append(item(it, handle));
}

function item(it, handle) {
  if (it.head != null || it.note != null || it.sep) {
    const d = document.createElement('div');
    d.className = it.sep ? 'pop-sep' : it.head != null ? 'pop-head' : 'pop-note';
    if (!it.sep) d.textContent = it.head != null ? it.head : it.note;
    return d;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = [it.current && 'cur', it.danger && 'danger'].filter(Boolean).join(' ');
  if (it.title) b.title = it.title;
  if (it.dot) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = it.dot;
    b.append(dot);
  }
  b.append(it.label);
  if (it.onClick) b.onclick = (e) => { handle.close(); it.onClick(e); };
  else b.disabled = true;
  return b;
}
