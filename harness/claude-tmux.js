'use strict';
// claude-tmux — the claude PROFILE of the tmux adapter (tmux-adapter.js runs
// the verbs). This file holds only claude facts: the launch line, the screens
// a launch walks through, the Stop-hook install, and the claude-only slash
// commands.
//
// HarnessRef: { harness: 'claude', session: 'bc-<id>', window?, cwd, resumeId }
//   resumeId — the claude session uuid, set at spawn via `--session-id <uuid>`
//              (verified 2.1.202) and refreshed from Stop-hook payloads.
//
// Launch: `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude
// --dangerously-skip-permissions --session-id <uuid>` (mined from firstmate's
// fm-spawn.sh). A fresh cwd shows the folder-trust dialog even in bypass mode;
// the settle accepts it.
//
// Turn boundaries: prepare() installs a Stop hook in
// <cwd>/.claude/settings.local.json running harness/turnend-hook.js, which
// appends to <stateDir>/<key>.turnend.jsonl and POSTs the callback URL.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const s = require('./tmux-session.js');
const { claudeStatus } = require('./agent-status.js');
const { tmuxAdapter } = require('./tmux-adapter.js');

const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
const TRUST_RE = /Yes, I trust this folder|Quick safety check/;

// RESUME_RE — the picker `claude --resume` shows when the transcript is big
// enough to be worth warning about:
//
//     Resuming the full session will consume a substantial portion of
//     your usage limits. We recommend resuming from a summary.
//     ❯ 1. Resume from summary (recommended)
//       2. Resume full session as-is
//
// It cost three lieutenants a morning. Supervision found them dead, called
// resume, hit this screen, waited 45s for a UI that was never coming, and gave
// up after three tries — and the ones it hit were exactly the ones worth saving,
// because the picker only appears when there is a lot to lose.
//
// Enter takes option 1, the preselected one, and summary is the right default
// for an UNATTENDED revival: option 2 is spending a substantial slice of the
// captain's usage limit, and nothing should do that while nobody is watching.
// He can always resume one by hand and choose otherwise.
const RESUME_RE = /Resume from summary|Resume full session as-is/;

// UI_READY_RE matches signatures only the main UI renders (composer prompt,
// busy footer, permission-mode footer) and the trust screen does not.
//
// ⚠ It is nearly wrong on the resume picker, which draws its own `❯` — and is
// saved only by `\n❯` demanding column zero while the picker indents. Do not
// relax that anchor: the picker would then read as READY and every unattended
// revival would leave a lieutenant sitting on an unanswered menu forever.
const UI_READY_RE = /bypass permissions|esc (to )?interrupt|\n❯/i;

// FATAL_RE — what a pane shows when this launch is never going to come up, so
// waiting the remaining 44 seconds only delays a wrong guess:
//
//   root       claude refuses --dangerously-skip-permissions as uid 0 (unless
//              IS_SANDBOX=1 / bubblewrap) and exits — verified in the binary.
//   first run  a claude nobody has ever run parks on its own setup wizard
//              (theme picker) BEFORE it asks about credentials. Enter is NOT
//              sent at it: answering a stranger's setup wizard blind is how you
//              pick their theme, their login method and their telemetry answer
//              for them.
//   missing    the shell answering "command not found" — no binary at all.
//   bypass     the one-time "WARNING: Claude Code running in Bypass Permissions
//              mode" consent modal, raised BY --dangerously-skip-permissions.
//              Its preselected option is `1. No, exit`, so it is emphatically
//              not one to answer with a blind Enter, and it is not ours to
//              accept on anyone's behalf: it is a person saying yes to an agent
//              that skips permission prompts on their machine.
const FATAL_RE = /cannot be used with root\/sudo privileges|Choose the text style|To change this later, run \/theme|claude: command not found|command not found: claude|Bypass Permissions mode|Yes, I accept/;
const SETTLE = { trustRe: TRUST_RE, resumeRe: RESUME_RE, readyRe: UI_READY_RE, fatalRe: FATAL_RE, label: 'claude' };

// mergeLocalSettings(cwd, mutate) — the read-modify-write of
// <cwd>/.claude/settings.local.json, in ONE place.
//
// Two writers own this file: installHooks (the Stop hook every turn boundary on
// the board rides on) and writeOutputStyle. Neither may clobber the other, so
// both read first and write the whole object back — and every decision about
// HOW that is done has to be the same on both sides. Kept apart, the second
// copy is free to drift: a different indent, or a corrupt file that one hand
// recovers from and the other throws on, and the drift shows up as a lieutenant
// that stopped reporting turn ends.
//
// A file that is missing, unparseable, or not a JSON object is replaced by {}:
// there is nothing to preserve in bytes nothing can read, and refusing to write
// would leave the caller with no hook and no style either.
function mergeLocalSettings(cwd, mutate) {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  fs.mkdirSync(dir, { recursive: true });
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    settings = null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  mutate(settings);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

// excludeLocalSettings(cwd) — hide .claude/settings.local.json from git
// (info/exclude) when cwd is a repo, so a file we wrote never dirties someone's
// worktree. Sits next to mergeLocalSettings for the same reason: every writer of
// that file has to make the same decisions about it, and a writer that skipped
// this step left the untracked file this step exists to prevent. Best-effort —
// not a repo, no permission, nothing to exclude, and the write still stands.
async function excludeLocalSettings(cwd) {
  try {
    const gitDir = (await new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'],
        { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    })).trim();
    const excl = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split('\n').includes('.claude/settings.local.json')) {
      fs.appendFileSync(excl, '.claude/settings.local.json\n');
    }
  } catch {
    // not a git repo — nothing to exclude
  }
}

// installHooks — write/merge the Stop hook into <cwd>/.claude/settings.local.json.
// Idempotent; preserves any existing settings/hooks. Also hides the file from
// git (info/exclude) when cwd is a repo, so it never dirties a worktree.
async function installHooks(cwd, session, stateDir, callbackUrl) {
  const command = ['node', s.shellQuote(HOOK_SCRIPT), s.shellQuote(stateDir), s.shellQuote(session)]
    .concat(callbackUrl ? [s.shellQuote(callbackUrl)] : [])
    .join(' ');
  mergeLocalSettings(cwd, (settings) => {
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    const ours = settings.hooks.Stop.some((m) =>
      Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command));
    if (!ours) {
      // Drop stale bc hook entries (e.g. a previous session in this cwd) first.
      settings.hooks.Stop = settings.hooks.Stop.filter((m) =>
        !(Array.isArray(m.hooks) && m.hooks.some((h) =>
          typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT))));
      settings.hooks.Stop.push({ hooks: [{ type: 'command', command }] });
    }
  });
  await excludeLocalSettings(cwd);
}

// sandboxPrefix(allowRoot) — claude refuses --dangerously-skip-permissions as
// uid 0 and exits, so as root there is no session to have unless the caller has
// said, in as many words, that this box is a throwaway. IS_SANDBOX=1 is the
// escape claude itself checks; it is never set on our own initiative. Off root
// the consent is inert, so spawn and resume both ask here rather than each
// deciding for themselves.
function sandboxPrefix(allowRoot) {
  const asRoot = allowRoot && typeof process.getuid === 'function' && process.getuid() === 0;
  return asRoot ? 'IS_SANDBOX=1 ' : '';
}

// The launch prefix every claude line carries: the sandbox consent (above) and
// the switch that kills claude's dim prompt-suggestion ghost text, which would
// otherwise read as pending composer input.
function launchPrefix(allowRoot) {
  return sandboxPrefix(allowRoot) + 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false ';
}

// ---------- slash commands ----------
// /autocompact is claude-specific (verified against the 2.1.207 binary — the
// public docs lag behind); like /compact it is a PASS-THROUGH typed into the
// session via verified submit. status reads the transcript claude already
// writes (agent-status.js).

// ---------- /output-style (claude only, and NOT a pass-through) ----------
// claude USED to answer `/output-style`; it does not any more. Verified against
// the 2.1.239 binary in a live pane: the composer answers "No commands match
// /output-style" and submitting the line comes back "Unknown command:
// /output-style". The binary's own migration table says it outright — "/output-
// style | Open /config → Output style. Output styles still exist as a feature;
// only the dedicated command was removed". /config is an INTERACTIVE dialog, so
// a pass-through here would park a worker on exactly the menu this command
// exists to keep it off.
//
// So the board does what claude itself does with the setting: it WRITES it, and
// says when it lands. outputStyle goes into <ref.cwd>/.claude/settings.local.json
// — the session's OWN cwd (a worker's worktree, a lieutenant's workspace), never
// ~/.claude/settings.json, which would repaint every claude on the machine.
//
// The setting is read when a session STARTS, so the running conversation keeps
// the style it was born with and the reply says WHEN the new one lands, without
// naming a command to get there. It cannot: /reset is a board command that only
// exists for lieutenant targets, so on a card thread the same reply would send
// the captain at a command the worker session refuses as unknown — a reply that
// teaches the board is broken is worse than one that says nothing. (Appending
// the hint server-side, where the target kind IS known, was considered and
// rejected: it would park knowledge of one harness command in the server
// forever to decorate one parenthetical.) The board does not restart a session
// on the captain's behalf — a kill takes that session's background work with it.
const OUTPUT_STYLE = '/output-style';

// The built-ins, pinned against the 2.1.239 binary's own style table (name and
// description lifted verbatim) rather than against memory — an earlier list
// that "everyone knows" was already wrong by two entries. `default` is the
// no-style entry; the other four are claude's built-in styles.
const BUILTIN_OUTPUT_STYLES = [
  { value: 'default', description: 'Claude completes coding tasks efficiently and provides concise responses' },
  { value: 'Proactive', description: 'Claude executes immediately, minimizes interruptions, and prefers action over planning' },
  { value: 'Concise', description: 'Claude responds tersely, leading with results and skipping preamble and narration' },
  { value: 'Explanatory', description: 'Claude explains its implementation choices and codebase patterns' },
  { value: 'Learning', description: 'Claude pauses and asks you to write small pieces of code for hands-on practice' },
];

// The `name:`/`description:` front matter of a style file. Deliberately a
// couple of lines and not a YAML dependency: these two scalars are the whole
// contract, and a file that does not have them still has a basename.
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// outputStyles(opts?) -> [{ value, description }] — what `/output-style` accepts
// HERE: the built-ins, plus every *.md under the SESSION's own
// <cwd>/.claude/output-styles/ (opts.cwd), plus every *.md under the user's
// ~/.claude/output-styles/. A style is named by its front-matter `name:` (the
// string the setting takes), and falls back to its basename when the file has
// none. An unreadable directory or file is not an error — it just means there
// are fewer custom styles to offer, and the command still works for the rest.
//
// The project directory is scanned because we WRITE the setting into that very
// .claude/ — a style file sitting next to the settings file we are editing, and
// being told it is unknown, was our own inconsistency and not a missing feature.
// Verified in a live pane: a style present only in <cwd>/.claude/output-styles/
// is honoured by the binary (the session reported `# Output Style: ProjOnly`).
//
// PRECEDENCE, also verified against the binary rather than inferred — the same
// `name:` in both directories with different bodies, and the session emitted the
// PROJECT one. So the project entry shadows the user entry, and the project
// directory is scanned first (first name in wins). Built-ins are seeded into
// `taken` before either, so no custom file can shadow a built-in name — the
// existing rule, unchanged.
function outputStyles(opts = {}) {
  const out = BUILTIN_OUTPUT_STYLES.map((st) => ({ ...st }));
  const userDir = opts.stylesDir || process.env.BC_CLAUDE_OUTPUT_STYLES_DIR
    || path.join(os.homedir(), '.claude', 'output-styles');
  const dirs = [];
  if (opts.cwd) dirs.push(path.join(opts.cwd, '.claude', 'output-styles'));
  dirs.push(userDir);
  const taken = new Set(out.map((st) => st.value.toLowerCase()));
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // no directory, no permission — never a throw, just fewer styles
    }
    for (const f of files) {
      let fm;
      try {
        fm = frontMatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue; // unreadable file — skip it, the rest of the list still stands
      }
      const value = fm.name || path.basename(f, '.md');
      if (!value || taken.has(value.toLowerCase())) continue;
      taken.add(value.toLowerCase());
      out.push({ value, description: fm.description || 'custom output style (' + f + ')' });
    }
  }
  return out;
}

// writeOutputStyle — one key, through the shared merge, because installHooks
// writes its Stop hook into this very file and must survive the write.
async function writeOutputStyle(cwd, style) {
  mergeLocalSettings(cwd, (settings) => { settings.outputStyle = style; });
  await excludeLocalSettings(cwd);
}

// commands(ref?) — the ref is what makes the style list this SESSION's list: a
// style installed in the worker's own worktree is offered to that worker and to
// nobody else. Without a ref only the user-level directory is scanned.
function ownCommands(ref) {
  return [
    { name: '/autocompact', description: 'set how full the context gets before auto-compaction' },
    {
      name: OUTPUT_STYLE,
      description: 'set this session\'s output style (applies on its next conversation)',
      args: outputStyles({ cwd: ref && ref.cwd }),
    },
  ];
}

async function setOutputStyle(ref, line, opts) {
  // Everything after the command name is ONE style name — a style file may
  // carry spaces in its `name:`, so the argument is not tokenized.
  const want = line.slice(OUTPUT_STYLE.length).trim();
  const styles = outputStyles({ stylesDir: opts.stylesDir, cwd: ref.cwd });
  const available = styles.map((st) => st.value).join(', ');
  // The bare form is refused rather than typed: claude has no /output-style
  // to answer it, and the whole point is that nobody has to remember the list.
  if (!want) throw new Error(OUTPUT_STYLE + ' needs a style name — available: ' + available);
  const hit = styles.find((st) => st.value.toLowerCase() === want.toLowerCase());
  // Refused before anything is written: a bad name must not silently sit in
  // the settings file waiting to surprise the next conversation.
  if (!hit) throw new Error('unknown output style "' + want + '" — available: ' + available);
  await writeOutputStyle(ref.cwd, hit.value);
  return 'output style set to ' + hit.value + ' — it applies the next time this session starts';
}

const profile = {
  name: 'claude',
  settle: SETTLE,
  // `--session-id <uuid>` makes the resume id known at birth (verified 2.1.202).
  idAtBirth: () => crypto.randomUUID(),
  // installHooks: false — the cwd already carries a workspace-level hook, and
  // installHooks keeps ONE bc entry per settings file.
  async prepare(cwd, key, ctx) {
    if (ctx.opts.installHooks !== false) await installHooks(cwd, key, ctx.stateDir, ctx.callbackUrl);
  },
  launch: (ctx) => launchPrefix(ctx.allowRoot)
    + `claude --dangerously-skip-permissions --session-id ${ctx.resumeId}`
    + (ctx.extra ? ' ' + ctx.extra : ''),
  // `--resume <id>` keeps the SAME id (no fork), so the ref survives any number
  // of death/resume cycles. No id: a fresh claude, memory lost.
  resumeLaunch: (id, ctx) => launchPrefix(ctx.allowRoot)
    + 'claude --dangerously-skip-permissions'
    + (id ? ` --resume ${id}` : '')
    + (ctx.extra ? ' ' + ctx.extra : ''),
  status: (ref) => claudeStatus(ref),
  noStatusHint: 'session transcript not found',
  commands: ownCommands,
  handlers: { [OUTPUT_STYLE]: setOutputStyle },
  passthrough: ['/autocompact'],
};

// installHooks is exported beyond the port so `bc-axi init` can install the
// workspace-level Stop hook (session-agnostic; the server dedupes by session_id).
module.exports = { ...tmuxAdapter(profile), installHooks,
  // Exported for the tests that pin the style list against a temp directory and
  // the built-ins against the binary.
  outputStyles, BUILTIN_OUTPUT_STYLES,
  // Exported for the test that pins them against REAL captured screens. These
  // regexes decide whether an unattended revival works or sits on a menu until
  // it is given up on, and that is not a judgement to make by reading them.
  SETTLE };
