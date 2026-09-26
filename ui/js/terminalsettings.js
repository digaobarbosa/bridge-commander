// terminalsettings.js — the wiring under terminal.js: the settings select, its
// persistence in this browser, and a change signal for the 👁 drawer's ⌨.
import { OPENERS, terminalMode } from './terminal.js';

const KEY = 'bc-terminal';
const sel = document.getElementById('term-opener');
const listeners = new Set();

let mode = 'off';
try { mode = terminalMode(localStorage.getItem(KEY)); } catch (e) {}

for (const o of OPENERS) {
  const opt = document.createElement('option');
  opt.value = o.key;
  opt.textContent = o.label;
  sel.appendChild(opt);
}
sel.value = mode;
sel.onchange = () => {
  mode = terminalMode(sel.value);
  try { mode === 'off' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch (e) {}
  for (const fn of listeners) fn(mode);
};

export function getTerminalMode() { return mode; }
export function onTerminalMode(fn) { listeners.add(fn); }
