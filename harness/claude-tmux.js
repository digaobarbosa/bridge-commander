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
// --permission-mode <mode> --session-id <uuid>` (mined from firstmate's
// fm-spawn.sh). <mode> is opts.permissionMode (default 'auto'); 'bypass' is the
// old `--dangerously-skip-permissions` launch. Every other mode keeps claude's
// permission prompts, and the PermissionRequest hook relays them to the board.
// A fresh cwd shows the folder-trust dialog in every mode; the settle accepts it.
//
// Turn boundaries: prepare() installs a Stop hook in
// <cwd>/.claude/settings.local.json running harness/turnend-hook.js, which
// appends to <stateDir>/<key>.turnend.jsonl and POSTs the callback URL. With a
// callback URL it also installs the PermissionRequest hook running
// harness/permission-hook.js, which holds the prompt open on /api/permission.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { claudeStatus } = require('./agent-status.js');
const { tmuxAdapter } = require('./tmux-adapter.js');
const { shellQuote } = require('./util.js');
const { installHooks, installStatusLine, writeOutputStyle } = require('./claude-settings.js');
const onboard = require('./claude-onboard.js');

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
// busy footer, permission-mode footer) and the trust screen does not. The
// footer depends on the mode: "bypass permissions on", "auto mode on",
// "accept edits on"; default mode shows none, so only `\n❯` catches it.
//
// ⚠ It is nearly wrong on the resume picker, which draws its own `❯` — and is
// saved only by `\n❯` demanding column zero while the picker indents. Do not
// relax that anchor: the picker would then read as READY and every unattended
// revival would leave a lieutenant sitting on an unanswered menu forever.
const UI_READY_RE = /bypass permissions|auto mode on|accept edits on|esc (to )?interrupt|\n❯/i;

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
//              mode" consent modal, raised BY --dangerously-skip-permissions
//              (permissionMode 'bypass' only; other modes never show it).
//              Its preselected option is `1. No, exit`, so it is emphatically
//              not one to answer with a blind Enter, and it is not ours to
//              accept on anyone's behalf: it is a person saying yes to an agent
//              that skips permission prompts on their machine.
// (`env: claude: No such file` is the missing binary under a profile with
// env, whose launch runs through `exec env`.)
const FATAL_RE = /cannot be used with root\/sudo privileges|Choose the text style|To change this later, run \/theme|claude: command not found|command not found: claude|env: .?claude.?: No such file|Bypass Permissions mode|Yes, I accept/;
// DECLINE_RE — a menu whose cursor sits on a "No". Claude 2.1.282 preselects
// "No, exit" on the folder-trust screen, where Enter quits claude to the shell
// and the launch times out at 45s. The settle walks the cursor off it first.
const DECLINE_RE = /❯\s*(\d+\.\s*)?No\b/;
const SETTLE = { trustRe: TRUST_RE, resumeRe: RESUME_RE, readyRe: UI_READY_RE, fatalRe: FATAL_RE,
  declineRe: DECLINE_RE, label: 'claude' };

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

// launchPrefix(mode, allowRoot) — everything on a claude line before the
// session flags: the sandbox consent, the switch that kills claude's dim
// prompt-suggestion ghost text (it would read as pending composer input), and
// the permission flags. Only bypass needs the root escape hatch: claude's uid-0
// refusal is about skipping permissions, and no other mode skips them.
function launchPrefix(mode, allowRoot) {
  const bypass = mode === 'bypass';
  return (bypass ? sandboxPrefix(allowRoot) : '')
    + 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude '
    + (bypass ? '--dangerously-skip-permissions' : '--permission-mode ' + shellQuote(mode));
}
// A spawn without a mode, or a record from before modes existed, runs in 'auto'.
function permissionModeOf(v) {
  return typeof v === 'string' && v ? v : 'auto';
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

// The launch modes config.json may name. Anything else reads as the first
// one: a typo must not turn into a flag claude refuses to start on.
const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'bypass'];

// describe(request) — one line the captain can judge a permission ask from:
// the field that carries the risk for the tools that have one. '' lets the
// core fall back to the input itself.
function describePermission(req) {
  const tool = req && req.tool_name;
  const i = req && req.tool_input && typeof req.tool_input === 'object' ? req.tool_input : {};
  const pick = (k) => (typeof i[k] === 'string' && i[k].trim() ? i[k].trim() : '');
  if (tool === 'Bash') return pick('command');
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return pick('file_path') || pick('notebook_path');
  }
  if (tool === 'WebFetch') return pick('url');
  return '';
}

// Context window per model — matched by substring so versioned ids
// (claude-fable-5, claude-opus-4-8, …) hit without an exhaustive list. A
// derived profile prepends its own pairs; unknown models get the default.
const CONTEXT_WINDOWS = [
  ['fable', 1000000],
  ['opus', 200000],
  ['sonnet', 200000],
  ['haiku', 200000],
];

// ---------- interrupt: the queued input claude would submit after the Esc ----------
// Messages typed into a busy claude wait in a queue, and an Esc submits every
// one of them as a new turn (verified 2.1.283). The board's own wake lines are
// what piles up there, and a lieutenant woken by one re-drains the order the
// captain just stopped. So before the Esc: pull the queue into the composer
// (Up, which claude offers only while the composer is EMPTY) and clear it when
// every line is a board nudge. Anything else is someone's words: it stays in
// the composer, where the Esc does not submit it.
const QUEUED_HINT_RE = /Press up to edit queued messages/;
// The lines server/delivery.js types (wakeLine, the respawn nudge).
const NUDGE_RE = /^\[bridge-commander\] .* — run: bc-axi drain$/;
const RULE_RE = /^─{10,}\s*$/;

// composerLines(screen) -> the text lines inside the composer box: between the
// last two horizontal rules, prompt glyph and indent stripped, blanks dropped.
function composerLines(screen) {
  const lines = String(screen || '').split('\n');
  const rules = [];
  lines.forEach((l, i) => { if (RULE_RE.test(l)) rules.push(i); });
  if (rules.length < 2) return null;
  return lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1])
    .map((l) => l.replace(/^❯\s?/, '').trim()).filter(Boolean);
}

async function beforeInterrupt(target, t) {
  const before = composerLines(await t.capture(target, 0));
  if (!before || before.length !== 1 || !QUEUED_HINT_RE.test(before[0])) return;
  await t.sendKey(target, 'Up');
  await t.sleep(300);
  const queued = composerLines(await t.capture(target, 0));
  if (!queued || !queued.length || !queued.every((l) => NUDGE_RE.test(l))) return;
  // C-u clears the cursor's line; BSpace then joins it to the one above.
  for (let i = queued.length - 1; i >= 0; i--) {
    await t.sendKey(target, 'C-u');
    if (i) await t.sendKey(target, 'BSpace');
  }
}

const profile = {
  name: 'claude',
  beforeInterrupt,
  settle: SETTLE,
  // `--session-id <uuid>` makes the resume id known at birth (verified 2.1.202).
  idAtBirth: () => crypto.randomUUID(),
  // opts.installHooks: false — the cwd already carries workspace-level hooks,
  // and a settings file holds only ONE bc entry per event (claude-settings.js).
  async prepare(cwd, key, ctx) {
    if (ctx.opts.installHooks !== false) await installHooks(cwd, key, ctx.stateDir, ctx.callbackUrl);
  },
  launch: (ctx) => launchPrefix(permissionModeOf(ctx.permissionMode), ctx.allowRoot)
    + ` --session-id ${ctx.resumeId}`
    + (ctx.extra ? ' ' + ctx.extra : ''),
  // `--resume <id>` keeps the SAME id (no fork), so the ref survives any number
  // of death/resume cycles. No id: a fresh claude, memory lost. The mode is the
  // spawn's (replayed by the adapter), so an agent never comes back looser.
  resumeLaunch: (id, ctx) => launchPrefix(permissionModeOf(ctx.permissionMode), ctx.allowRoot)
    + (id ? ` --resume ${id}` : '')
    + (ctx.extra ? ' ' + ctx.extra : ''),
  // ctx.profile is the MERGED profile, so a derived one's windows apply.
  status: (ref, ctx) => claudeStatus(ref, {
    contextWindows: ctx && ctx.profile && ctx.profile.contextWindows,
    windowOverrides: ctx && ctx.profile && ctx.profile.windowOverrides,
  }),
  noStatusHint: 'session transcript not found',
  commands: ownCommands,
  handlers: { [OUTPUT_STYLE]: setOutputStyle },
  passthrough: ['/autocompact'],

  // ---- typed options: --model / --effort (both verified in `claude --help`) ----
  options: ['model', 'effort'],
  modelArgs: ({ model, effort } = {}) => [].concat(model ? ['--model', model] : [], effort ? ['--effort', effort] : []),

  // ---- data the core reads through profileInfo() ----
  permissions: { modes: PERMISSION_MODES, describe: describePermission },
  requirements: { bins: ['claude'], tmux: true, rootBypass: true },
  installHint: onboard.INSTALL_HINT,
  contextWindows: CONTEXT_WINDOWS,
  // What a human types to reopen a conversation by hand: none of the board's
  // launch flags, since the captain runs it in their own terminal.
  handResume: 'claude --resume',

  // ---- first run (cli/firstrun.js frames these) ----
  handRunLine: onboard.handRunLine,
  setupScreens: onboard.setupScreens,
  rootBlock: onboard.rootBlock,
  diagnose: onboard.diagnose,

  // detectSelf(env) — claude exports CLAUDECODE (and CLAUDE_SESSION_ID when it
  // has one) to the commands it runs; that is how `bc-axi init` knows its caller.
  detectSelf: (env) => (env && (env.CLAUDECODE || env.CLAUDE_SESSION_ID)
    ? { resumeId: env.CLAUDE_SESSION_ID || '' } : null),
  // Where the worker-duties skill is linked so a claude worker can load it.
  skillsDir: (home) => path.join(home || os.homedir(), '.claude', 'skills'),
  // The workspace-level Stop + PermissionRequest hooks and the statusLine, for
  // every claude whose cwd is the workspace (the founder included).
  async installWorkspace(ws, env = {}) {
    await installHooks(ws, 'ws', env.stateDir, env.callbackUrl);
    await installStatusLine(ws);
    return [
      'turn-end + permission hooks installed (.claude/settings.local.json -> /api/turn-end, /api/permission)',
      'statusLine installed (.claude/settings.local.json -> real context window sidecar)',
    ];
  },
  // `bc-axi open` self-heals the statusLine wiring on every open.
  refreshWorkspace: (ws) => installStatusLine(ws),
};

module.exports = { ...tmuxAdapter(profile),
  // The JS base a derived JSON profile `extends` (harness/profiles.js).
  profile, PERMISSION_MODES, describePermission,
  // Exported for the tests that pin the style list against a temp directory and
  // the built-ins against the binary.
  outputStyles, BUILTIN_OUTPUT_STYLES,
  composerLines, NUDGE_RE,
  // Exported for the test that pins them against REAL captured screens. These
  // regexes decide whether an unattended revival works or sits on a menu until
  // it is given up on, and that is not a judgement to make by reading them.
  SETTLE };
