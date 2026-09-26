// The board region's modes. Board and table are two views over the live cards,
// 🧊 is the archived snapshots, ⚡ the clock and its scripts: those four are the
// switcher, and the choice sticks per browser. 'file' and 'settings' are the
// screens — entered by opening a file or from the gear, and never remembered,
// so a reload comes back to the last switcher mode.
export const MODE_BTN = { board: 'vs-board', table: 'vs-table', archive: 'vs-arch', auto: 'vs-auto' };
export const SCREENS = ['file', 'settings'];

/** The mode a request lands on: a switcher mode or a screen; anything else is the kanban. */
export function boardModeFor(mode) {
  return MODE_BTN[mode] || SCREENS.includes(mode) ? mode : 'board';
}

/**
 * The switcher mode a stored value names, or the kanban. Both what a reload
 * restores and the way out of a screen (⟵ and the phone's Board tab).
 */
export function switcherModeFor(stored) {
  return MODE_BTN[stored] ? stored : 'board';
}
