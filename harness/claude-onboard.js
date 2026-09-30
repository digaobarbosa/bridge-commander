'use strict';
// claude-onboard — what the claude profile tells a stranger on the first run:
// the line a person runs by hand, how to install the CLI, why root is refused,
// and what a failed spawn's pane means. cli/firstrun.js frames these; the
// claude facts live here so nothing outside the harness names the CLI.
//
// Every branch below is a signature seen in a real container (see the history
// of cli/firstrun.js, where these texts were born).

// handRunLine(mode, {root}) — the launch a PERSON runs to clear the setup
// screens: the spawn's own flag, so the hand run meets the same screens. As
// root the bypass line needs IS_SANDBOX=1, the escape hatch --allow-root
// passes to the spawn; without it the line dies on the very refusal it is
// meant to get past. Outside bypass there is no root refusal.
function handRunLine(mode, opts = {}) {
  const m = mode || 'auto';
  if (m !== 'bypass') return 'claude --permission-mode ' + m;
  return (opts.root ? 'IS_SANDBOX=1 ' : '') + 'claude --dangerously-skip-permissions';
}

// The curl installer needs no root: `npm i -g` on a stock image writes into a
// root-owned prefix and fails with EACCES for the normal user the root block
// just told them to become.
const INSTALL_HINT = '  curl -fsSL https://claude.ai/install.sh | bash    # installs to ~/.local/bin — no root needed\n'
  + '  # It does NOT edit your PATH. Afterwards:\n'
  + '  export PATH="$HOME/.local/bin:$PATH" && echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc\n'
  + '  # (npm i -g @anthropic-ai/claude-code also works, but as a normal user it needs a\n'
  + '  #  user-local prefix: npm config set prefix ~/.npm-global, and that dir on PATH)';

// The consent screen exists only for the skip-permissions launch.
function setupScreens(mode) {
  return mode === 'bypass'
    ? '(a theme picker, a login, a trust question about this folder, and a\n'
      + 'one-time bypass-permissions consent screen that only the launch flag raises):\n'
    : '(a theme picker, a login, and a trust question about this folder):\n';
}

// Claude Code refuses --dangerously-skip-permissions as uid 0 and exits, so as
// root there is no lieutenant to be had. Asked only in bypass mode.
function rootBlock() {
  return 'you are running as root, and Claude Code refuses --dangerously-skip-permissions as root.\n'
    + 'Bridget is a real claude session, so as root she cannot start and you would be left with a\n'
    + 'board nobody is on. Two honest ways forward:\n\n'
    + '  1. RECOMMENDED — do the first run as a normal user:\n'
    + '       useradd -m dev && su - dev\n'
    + '     Then, as that user: install the skill (npx skills add …), install the agent CLI in a\n'
    + '     way that needs no root (curl -fsSL https://claude.ai/install.sh | bash puts it in\n'
    + '     ~/.local/bin — `npm i -g` would fail with EACCES for them), and run this again.\n\n'
    + '  2. This is a throwaway box (a container you will delete) and you accept the risk:\n'
    + '       bc-axi init --onboard --allow-root\n'
    + '     That launches her with IS_SANDBOX=1, which is the escape hatch claude itself checks.\n'
    + '     It turns off a guard that exists because an agent with skipped permissions running as\n'
    + '     root can do anything to the machine. Never on a box you care about.\n\n'
    + 'ASK the person which one. Do not pick --allow-root for them.';
}

// diagnose(text, {here, mode, handRun}) -> {cause, headline, fix} | null.
// `handRun(mode)` is the framed hand-run line ("  cd <ws> && …"). null means
// the pane matched nothing claude-specific; the caller's fallback takes over.
function diagnose(text, ctx = {}) {
  const t = String(text || '');
  const here = ctx.here || '<the workspace folder>';
  const mode = ctx.mode || 'auto';
  const handRun = ctx.handRun || ((m) => '  cd ' + here + ' && ' + handRunLine(m));
  const bypass = mode === 'bypass';
  const hit = (re, cause, headline, fix) => (re.test(t) ? { cause, headline, fix } : null);
  // First, because it is the one screen our own launch line raises and the one
  // no hand-run of plain `claude` can ever clear. Only the bypass launch raises
  // it, so its recipe is the bypass line whatever the config says now.
  return hit(/Bypass Permissions mode|Yes, I accept/, 'bypass',
    'her pane is on Claude Code\'s one-time bypass-permissions consent screen. That warning is\n'
      + 'raised BY the --dangerously-skip-permissions flag the spawn uses, so running plain `claude`\n'
      + 'never sees it — and it is not mine to accept for anyone: it is consent to an agent that\n'
      + 'skips permission prompts on this machine.',
    'Have the person run the launch line itself, once, and answer 2 (Yes, I accept) — then /exit\n'
      + 'and run the SAME command again:\n'
      + handRun('bypass') + '\n'
      + '(The preselected option on that screen is "No, exit", so it is theirs to answer, not mine.)')
  || hit(/Quick safety check|trust this folder|Accessing workspace/, 'trust',
    'her pane is on Claude Code\'s folder-trust question for the workspace — it asks about any\n'
      + 'directory it has not already trusted, and it comes BEFORE login.',
    'Trust is inherited from a trusted ancestor, so running `claude` in their home directory MAY\n'
      + 'have cleared it (a workspace under ~ usually is) — but it may not have. Run it in the\n'
      + 'workspace itself, answer the question, quit with /exit, then run the SAME command again:\n'
      + handRun(mode)
      + (bypass ? '\n(The flag is in there so this one sitting also clears the consent screen behind it.)' : ''))
  || hit(/cannot be used with root\/sudo privileges/, 'root',
    'claude refuses --dangerously-skip-permissions as root, and exited.',
    'Do the first run as a normal user (`useradd -m dev && su - dev`), or, on a throwaway box,\n'
      + 're-run with --allow-root — see the block that command prints before it starts.')
  || hit(/Choose the text style|run \/theme|Let's get started/, 'setup',
    'the `claude` CLI has never been run on this machine — her pane is parked on its setup wizard\n'
      + '(theme picker), which comes BEFORE any login question.',
    'Run it once by hand IN THE WORKSPACE, answer its questions (there is a folder-trust one about\n'
      + 'this directory after the theme), quit with /exit, then run the SAME command again:\n'
      + handRun(mode))
  || hit(/command not found|ENOENT|not found: claude|claude: No such file/, 'missing',
    'the agent CLI is not installed — the shell answered "command not found".',
    'Install it and run the SAME command again:\n  npm i -g @anthropic-ai/claude-code')
  || hit(/\/login|Invalid API key|not authenticated|Please run .*login|Sign in|log in to/i, 'auth',
    'the `claude` CLI is installed but not logged in — her pane is on its login screen.',
    'Log in once by hand in the workspace, then run the SAME command again:\n'
      + '  cd ' + here + ' && claude   (and follow its login)');
}

module.exports = { handRunLine, INSTALL_HINT, setupScreens, rootBlock, diagnose };
