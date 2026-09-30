// The board region's mode rules, pure. views.js (the main/v1 registry) asks
// them with its live lists; the defaults are the built-in set, so the rules
// read the same with or without plugins.
//
// Board and table are two views over the live cards, 🧊 is the archived
// snapshots, ⚡ the clock and its scripts: those four are the built-in
// switcher, and the choice sticks per browser. 'file' and 'settings' are the
// screens — entered by opening a file or from the gear, and never remembered,
// so a reload comes back to the last switcher mode.
export const MODE_BTN = { board: 'vs-board', table: 'vs-table', archive: 'vs-arch', auto: 'vs-auto' };
export const SCREENS = ['file', 'settings'];
const BUILTIN_SWITCHER = Object.keys(MODE_BTN);

/**
 * The mode a request lands on: a switcher mode or a screen; anything else is
 * `fallback` (the kanban, unless the captain switched it off).
 */
export function boardModeFor(mode, switcher = BUILTIN_SWITCHER, screens = SCREENS, fallback = 'board') {
  return switcher.includes(mode) || screens.includes(mode) ? mode : fallback;
}

/**
 * The switcher mode a stored value names, or `fallback`. Both what a reload
 * restores and the way out of a screen (⟵ and the phone's Board tab).
 */
export function switcherModeFor(stored, switcher = BUILTIN_SWITCHER, fallback = 'board') {
  return switcher.includes(stored) ? stored : fallback;
}
