// modal — the host for every generic modal: a command's form, an activity's
// log. Modals form a stack: Escape (main.js, right after the artifact viewer)
// closes the top one, a click on its backdrop closes it, and opening one puts
// the focus in its first field. Nothing exists in the DOM until the first
// modal opens, so the module imports without a page.
//
// openModal({ title, body, actions, onSubmit, onClose, cls }) -> handle
//   body     — a DOM node or an html string (the caller escapes it)
//   actions  — [{ label, primary?, danger?, onClick(handle) }] in the footer
//   onSubmit — makes the box a <form>: Enter in a field or the primary button runs it
// handle = { el, body, close(), isOpen(), setError(text), setBusy(on, label?) }

const stack = []; // open modals, oldest first

export function openModal(opts = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'bc-modal-overlay';
  const box = document.createElement(opts.onSubmit ? 'form' : 'div');
  box.className = 'bc-modal' + (opts.cls ? ' ' + opts.cls : '');
  // our own validation speaks inline (fields.validateValues); the browser's
  // bubble would block the submit before it ever ran
  if (opts.onSubmit) box.noValidate = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'bc-modal-head';
  const title = document.createElement('div');
  title.className = 'bc-modal-title';
  title.textContent = opts.title || '';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'bc-modal-x';
  x.title = 'close';
  x.textContent = '✕';
  head.append(title, x);

  const body = document.createElement('div');
  body.className = 'bc-modal-body';
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else if (opts.body) body.append(opts.body);

  const err = document.createElement('div');
  err.className = 'bc-modal-err';
  err.hidden = true;

  const foot = document.createElement('div');
  foot.className = 'bc-modal-foot';
  box.append(head, body, err, foot);
  overlay.append(box);

  const entry = { overlay, opts };
  let primaryBtn = null;
  const handle = {
    el: box,
    body,
    close: () => close(entry),
    isOpen: () => stack.includes(entry),
    setError(text) {
      err.textContent = text || '';
      err.hidden = !text;
    },
    setBusy(on, label) {
      for (const b of foot.querySelectorAll('button')) b.disabled = !!on;
      if (primaryBtn) {
        if (on) { primaryBtn.dataset.label = primaryBtn.dataset.label || primaryBtn.textContent; primaryBtn.textContent = label || 'working…'; }
        else if (primaryBtn.dataset.label) primaryBtn.textContent = primaryBtn.dataset.label;
      }
      box.classList.toggle('busy', !!on);
    },
  };
  entry.handle = handle;

  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.type = a.primary && opts.onSubmit ? 'submit' : 'button';
    b.className = 'bc-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    if (a.primary) primaryBtn = b;
    if (b.type === 'button') b.onclick = () => (a.onClick ? a.onClick(handle) : handle.close());
    foot.append(b);
  }
  foot.hidden = !foot.children.length;
  if (opts.onSubmit) box.onsubmit = (e) => { e.preventDefault(); if (!box.classList.contains('busy')) opts.onSubmit(handle); };

  x.onclick = () => close(entry);
  // mousedown AND click on the backdrop itself: a drag that starts in a field
  // and ends outside the box must not close the form under the captain
  let downOnBackdrop = false;
  overlay.onmousedown = (e) => { downOnBackdrop = e.target === overlay; };
  overlay.onclick = (e) => { if (e.target === overlay && downOnBackdrop) close(entry); downOnBackdrop = false; };

  document.body.appendChild(overlay);
  stack.push(entry);
  focusFirst(box);
  return handle;
}

/** Put the focus in the first field of `root`, else on its first button. */
export function focusFirst(root) {
  const f = root.querySelector('.bc-modal-body input:not([type="hidden"]):not([disabled]), .bc-modal-body select, .bc-modal-body textarea')
    || root.querySelector('.bc-modal-foot button.primary') || root.querySelector('button');
  if (f && f.focus) try { f.focus(); } catch (e) {}
}

function close(entry) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  entry.overlay.remove();
  if (entry.opts.onClose) try { entry.opts.onClose(entry.handle); } catch (e) {}
}

/** Close the top modal. True when there was one — Escape stops there. */
export function closeTopModal() {
  if (!stack.length) return false;
  close(stack[stack.length - 1]);
  return true;
}
export function modalOpen() { return stack.length > 0; }
