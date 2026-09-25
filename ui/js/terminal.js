// terminal.js — "open this agent in a real terminal": which opener this browser
// uses and the link or command it hands out. DOM-free at import, so it loads
// straight into Node; terminalsettings.js is the wiring.
//
// Per browser, not per board: the terminal is a fact about the machine the
// board is being looked at from, and a phone has none. Off by default, and off
// renders nothing, so the drawer is what it always was.
//
// An opener is one entry in OPENERS. Adding a terminal is adding an entry —
// there is no other place to touch.

// Joins the agent's session as a grouped session instead of attaching to it:
// switching windows or detaching there never moves the agent's own view, and
// destroy-unattached drops the group when the terminal closes.
export function attachCommand(session, window_) {
  let cmd = `tmux new-session -t ${session} \\; set destroy-unattached on`;
  if (window_) cmd += ` \\; select-window -t ${window_}`;
  return cmd;
}

// Names are interpolated into a shell command, so anything that is not a plain
// tmux name gets no link at all rather than an escaped one.
const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;

export const OPENERS = [
  { key: 'off', label: 'off' },
  // iTerm2's own URL scheme: it shows the command and asks before running it.
  { key: 'iterm2', label: 'iTerm2 (macOS)', link: (cmd) => ({ href: 'iterm2:/command?c=' + encodeURIComponent(cmd) }) },
  // Works anywhere: the command lands on the clipboard for any terminal.
  { key: 'copy', label: 'copy tmux command', link: (cmd) => ({ copy: cmd }) },
];

export function terminalMode(stored) {
  return OPENERS.some((o) => o.key === stored) ? stored : 'off';
}

// terminalLink(mode, target) -> { href } | { copy } | null
// target: { session, window? } — null when the mode is off or the names are unsafe.
export function terminalLink(mode, target) {
  const opener = OPENERS.find((o) => o.key === mode);
  if (!opener || !opener.link || !target) return null;
  const { session, window: win } = target;
  if (!session || !NAME_RE.test(session)) return null;
  if (win && !NAME_RE.test(win)) return null;
  return opener.link(attachCommand(session, win || null));
}

// Where an agent lives, from what the board payload already carries: a
// lieutenant's ref, a card's worker ref, or a card's session attribute (a card
// tracking a session the board did not spawn) with the drawer's current tab.
export function lieutenantTarget(l) {
  const r = l && l.ref;
  return r && r.session ? { session: String(r.session), window: r.window ? String(r.window) : null } : null;
}
export function cardTarget(c, worker, pickedWindow) {
  const r = worker && worker.ref;
  if (r && r.session) return { session: String(r.session), window: r.window ? String(r.window) : null };
  const s = c && c.attributes && c.attributes.session;
  return s ? { session: String(s), window: pickedWindow || null } : null;
}
