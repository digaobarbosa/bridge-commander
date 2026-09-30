'use strict';
// A DOM just big enough for the list panels and the popovers: elements that
// hold children and text, a click that bubbles to the document, and a box size
// for placement. The tests read what the captain reads — text and buttons.
class FakeEl {
  constructor(tag, text) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = text || '';
    this.className = '';
    this.title = '';
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.disabled = false;
    this.onclick = null;
    this.box = { left: 0, top: 0, width: 120, height: 60 };
    this.scrolled = false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }
  append(...xs) { for (const x of xs) this.appendChild(typeof x === 'string' ? new FakeEl('#text', x) : x); }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parentNode) return;
    const sib = this.parentNode.children;
    sib.splice(sib.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n) {
    for (; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  get classList() {
    const has = (c) => this.className.split(/\s+/).includes(c);
    return { contains: has };
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  scrollIntoView() { this.scrolled = true; }
  /** Every descendant (depth first) matching `pred`. */
  findAll(pred) {
    const out = [];
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      out.push(...c.findAll(pred));
    }
    return out;
  }
  /** Descendants carrying class `cls`. */
  byClass(cls) { return this.findAll((n) => n.classList.contains(cls)); }
  /** The buttons under this node, by their visible text. */
  buttons() { return this.findAll((n) => n.tagName === 'BUTTON'); }
  /** A click the way a browser delivers it: target first, then up, then the document. */
  click() {
    const e = { target: this, stopped: false, stopPropagation() { this.stopped = true; } };
    if (this.tagName === 'BUTTON' && this.disabled) return e; // a disabled button takes no click
    for (let n = this; n && !e.stopped; n = n.parentNode) if (n.onclick) n.onclick(e);
    if (!e.stopped) for (const fn of docListeners) fn(e);
    return e;
  }
}

let docListeners = [];

/** Install a fresh fake document and window on globalThis. */
function installDom({ width = 800, height = 600 } = {}) {
  docListeners = [];
  const body = new FakeEl('body');
  globalThis.document = {
    body,
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (type, fn) => { if (type === 'click') docListeners.push(fn); },
  };
  globalThis.window = { innerWidth: width, innerHeight: height };
  return { body, el: (tag = 'div') => new FakeEl(tag) };
}

module.exports = { installDom, FakeEl };
