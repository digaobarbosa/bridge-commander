'use strict';
// send() against REAL tmux: a pane on claude's permission dialog must not be
// typed into. Its cursor rests on "1. Yes", so a board wake (text + Enter)
// would approve whatever the agent asked, and the board would never know.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const t = require('../tmux.js');
const claude = require('../claude-tmux.js');

function haveTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}
const skip = haveTmux() ? false : 'tmux is not installed';
const SESSION = 'bc-sendguard-pane';

// A pane that paints `screen` and then records every byte typed at it.
async function paneShowing(screen, sink) {
  await t.tryTmux('kill-session', '-t', `=${SESSION}:`);
  const script = 'printf %s ' + JSON.stringify(screen) + '; exec cat > ' + JSON.stringify(sink);
  await t.tmux('new-session', '-d', '-s', SESSION, '-x', '120', '-y', '30', 'sh', '-c', script);
  const deadline = Date.now() + 10000;
  while (!(await t.capture(`=${SESSION}:`, 30)).includes('Do you want')) {
    if (Date.now() > deadline) break;
    await t.sleep(50);
  }
}

test('send refuses a pane on a permission prompt and types nothing into it', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sendguard-'));
  const sink = path.join(dir, 'typed.txt');
  try {
    await paneShowing(' Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n', sink);
    await assert.rejects(() => claude.send({ harness: 'claude', session: SESSION, cwd: dir }, 'wake up'),
      /permission prompt/);
    await t.sleep(300);
    assert.strictEqual(fs.readFileSync(sink, 'utf8'), '', 'not one key reached the dialog');
  } finally {
    await t.tryTmux('kill-session', '-t', `=${SESSION}:`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
