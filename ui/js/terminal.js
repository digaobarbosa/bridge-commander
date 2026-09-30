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
  { key: 'copy', label: 'copy terminal command', link: (cmd) => ({ copy: cmd }) },
];

export function terminalMode(stored) {
  return OPENERS.some((o) => o.key === stored) ? stored : 'off';
}

// terminalLink(mode, target) -> { href } | { copy } | null
// target: { session, window? } — null when the mode is off or the names are unsafe.
export function terminalLink(mode, target) {
  return openerLink(mode, safeAttach(target));
}

// openerLink(mode, cmd) -> the opener's { href } | { copy } for any vetted
// command: an acp session has no tmux, so its way into a terminal is the resume.
export function openerLink(mode, cmd) {
  const opener = OPENERS.find((o) => o.key === mode);
  return opener && opener.link && cmd ? opener.link(cmd) : null;
}

// safeAttach(target) -> the attach command, or null when the names are unsafe.
export function safeAttach(target) {
  if (!target) return null;
  const { session, window: win } = target;
  if (!session || !NAME_RE.test(session)) return null;
  if (win && !NAME_RE.test(win)) return null;
  return attachCommand(session, win || null);
}

// POSIX single quotes: nothing inside them expands, and a quote closes, gets
// escaped, and reopens.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The prefix is profile data, but it still lands unquoted in a shell line.
const CLI_RE = /^[A-Za-z0-9_./-]+( [A-Za-z0-9_./-]+)*$/;

// resumeCommand(cli, cwd, id) -> the command that reopens a conversation
// outside the board, or null. The CLI finds a conversation by project dir, so
// the cd is part of the address, not a convenience.
export function resumeCommand(cli, cwd, id) {
  if (!cli || !CLI_RE.test(cli) || !cwd || !UUID_RE.test(String(id || ''))) return null;
  return `cd ${shellQuote(cwd)} && ${cli} ${id}`;
}

// refResume(ref, cli) — cli is the ref's harness profile handResume ('' = none).
export function refResume(ref, cli) {
  return ref ? resumeCommand(cli, ref.cwd, ref.resumeId) : null;
}

// appResumeLink(app, id) -> the desktop app link that opens this conversation,
// or null. `app` is profile data ({label, url with {id}}); the id is a uuid,
// so nothing else can be smuggled into the scheme's query.
const APP_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9_./?=&%-]*\{id\}[A-Za-z0-9_./?=&%-]*$/;
export function appResumeLink(app, id) {
  if (!app || typeof app.url !== 'string' || !APP_URL_RE.test(app.url) || !UUID_RE.test(String(id || ''))) return null;
  return app.url.replace('{id}', id);
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

/** Saved conversations outlive the worker and its stage. Current goes first. */
export function cardSessions(c) {
  const list = (c && Array.isArray(c.sessions) ? c.sessions : []).filter((s) =>
    s && typeof s.provider === 'string' && s.provider && UUID_RE.test(String(s.id || '')));
  return list.slice().sort((a, b) => Number(b.key === c.currentSession) - Number(a.key === c.currentSession));
}

/** Resolve navigation without treating a saved tmux address as a live process. */
export function sessionNavigation(s, worker, mode, profile = {}) {
  if (!s || !s.provider || !UUID_RE.test(String(s.id || ''))) return null;
  const prefix = profile.cli || s.resumeCli;
  const cmd = resumeCommand(prefix, s.cwd, s.id);
  if (s.local !== true) return { cmd, reason: `This session belongs to ${s.host || 'another machine'}. Open it there; local launch is unavailable.`, remote: true };
  const ref = worker && worker.ref;
  const matching = s.origin === 'managed' && ref && ref.resumeId === s.id;
  const live = matching && (worker.live === true || (worker.live === undefined &&
    ((!worker.paused && !worker.flagged) || worker.expectExit)));
  const attach = live && safeAttach(adapterIsTmux(profile) ? ref : null);
  const appProfile = profile.app || s.resumeApp;
  const app = s.surface === 'app' ? appResumeLink(appProfile, s.id) : null;
  const reason = s.cwdAvailable === false
    ? `The checkout is missing: ${s.cwd}. Restore this directory before continuing development.`
    : s.cwdAvailable !== true ? `Checkout availability is unknown: ${s.cwd}. Refresh the board before resuming in a terminal.` : '';
  // Desktop navigation can still restore the conversation when its checkout is gone.
  if (app) return { href: app, cmd: reason || live || (matching && worker.live === null) ? null : cmd,
    reason, live: !!live, label: appProfile.label || s.provider };
  if (matching && worker.live === null) return {
    cmd: null, live: null, reason: 'Cannot verify whether the managed session is still running. Try again before resuming in a terminal.',
  };
  if (attach) return { ...openerLink(mode, attach), cmd: attach, live: true, watch: true, reason: '' };
  // ACP workers have no attach target. Watch the board's client while it runs.
  if (live) return { live: true, watch: true, reason: '' };
  if (reason) return { cmd: null, reason };
  return { ...openerLink(mode, cmd), cmd, reason: '', live: false };
}
function adapterIsTmux(profile) { return profile.adapter !== 'acp'; }
