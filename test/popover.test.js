'use strict';
// ui/js/popover.js — the one manager behind the move, owner, playbook,
// lieutenant ⋯ and mode menus: it stays inside the window, a click outside or
// Escape closes it, and several open at once form a stack.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom } = require('./fake-dom.js');

const { body, el } = installDom({ width: 800, height: 600 });
const mod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'popover.js')).href);
const tick = () => new Promise((r) => setTimeout(r, 5));
const open = () => body.children.filter((n) => n.classList.contains('popover'));

test.afterEach(async () => { const { closeTopPopover } = await mod; while (closeTopPopover()); });

test('a menu that would spill past the window edge is pulled back inside it', async () => {
  const { clampToViewport } = await mod;
  assert.deepStrictEqual(clampToViewport(100, 100, 200, 150, 800, 600), { left: 100, top: 100 }, 'fits: untouched');
  assert.deepStrictEqual(clampToViewport(700, 500, 200, 150, 800, 600), { left: 592, top: 442 }, 'bottom-right corner');
  assert.deepStrictEqual(clampToViewport(-40, -10, 200, 150, 800, 600), { left: 8, top: 8 }, 'off the top-left');
});

test('a right-click in the corner of an 800×600 window opens the menu inside it', async () => {
  const { openPopover } = await mod;
  const pop = openPopover({ x: 790, y: 590 }, [{ head: 'move to' }, { label: 'Done', onClick() {} }]);
  assert.strictEqual(pop.el.style.left, (800 - 120 - 8) + 'px');
  assert.strictEqual(pop.el.style.top, (600 - 60 - 8) + 'px');
});

test('opened from a button, it sits under it — or lines up with its right edge', async () => {
  const { openPopover } = await mod;
  const btn = el('button');
  btn.box = { left: 300, top: 20, width: 40, height: 20 };
  assert.strictEqual(openPopover(btn, [{ label: 'x', onClick() {} }]).el.style.top, '44px', '4px under the button');
  const right = openPopover(btn, [{ label: 'x', onClick() {} }], { align: 'right' });
  assert.strictEqual(right.el.style.left, (340 - 120) + 'px', 'right edges meet');
});

test('picking an item closes the menu and does the thing; the current one is inert', async () => {
  const { openPopover } = await mod;
  const picked = [];
  const pop = openPopover({ x: 10, y: 10 }, [
    { head: 'move to' },
    { label: '● Backlog', current: true },
    { label: 'Done', onClick: () => picked.push('done') },
    { sep: true },
    { label: '✕ archive', danger: true, onClick: () => picked.push('archive') },
  ]);
  const [cur, done, archive] = pop.el.buttons();
  assert.deepStrictEqual(pop.el.buttons().map((b) => b.textContent), ['● Backlog', 'Done', '✕ archive']);
  assert.ok(cur.disabled, 'the column the card is in is not a move');
  assert.ok(archive.classList.contains('danger'));
  done.click();
  assert.deepStrictEqual(picked, ['done']);
  assert.ok(!pop.isOpen() && !open().length, 'and the menu is gone');
});

test('a click outside closes it — but not the click that opened it', async () => {
  const { openPopover } = await mod;
  const pop = openPopover({ x: 10, y: 10 }, [{ label: 'a', onClick() {} }]);
  el().click(); // the opening click, still bubbling up to the document
  assert.ok(pop.isOpen(), 'the opening click does not close what it opened');
  await tick();
  pop.el.click(); // a click inside the menu itself
  assert.ok(pop.isOpen(), 'a click inside keeps it');
  el().click();
  assert.ok(!pop.isOpen(), 'a click anywhere else closes it');
});

test('Escape closes the newest popover first, one per press', async () => {
  const { openPopover, closeTopPopover } = await mod;
  const a = openPopover({ x: 10, y: 10 }, [{ label: 'a', onClick() {} }]);
  const b = openPopover({ x: 50, y: 50 }, [{ label: 'b', onClick() {} }]);
  assert.strictEqual(closeTopPopover(), true);
  assert.ok(!b.isOpen() && a.isOpen(), 'the top one went, the one under it stays');
  assert.strictEqual(closeTopPopover(), true);
  assert.ok(!a.isOpen());
  assert.strictEqual(closeTopPopover(), false, 'nothing open: Escape falls through to the next thing');
});

test('reopening a menu replaces it, and a menu can fill in once its list arrives', async () => {
  const { openPopover, closePopover } = await mod;
  openPopover({ x: 10, y: 10 }, [{ head: 'playbook' }], { id: 'playbook-menu' });
  const pop = openPopover({ x: 10, y: 10 }, [{ head: 'playbook' }], { id: 'playbook-menu' });
  assert.strictEqual(open().length, 1, 'one playbook menu, not two');
  pop.set([{ head: 'playbook' }, { note: 'no playbooks in playbooks/' }]);
  assert.strictEqual(pop.el.textContent, 'playbookno playbooks in playbooks/');
  assert.strictEqual(closePopover('playbook-menu'), true);
  assert.strictEqual(closePopover('playbook-menu'), false, 'the toggle: closed means nothing left to close');
});
