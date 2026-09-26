#!/usr/bin/env node
'use strict';
// smoke.js — REAL end-to-end smoke for a tmux harness (claude or codex).
//
// Requires tmux and an authenticated CLI for the harness; SKIPS (exit 0, loud
// message) when that CLI is not on PATH. Costs a few real turns.
//
//   node harness/smoke.js [claude|codex]            # default: claude
//   node harness/smoke.js codex --resume            # + kill → resume → recall
//
// What it proves:
//   1. spawn() settles past the trust dialog and returns a serializable ref —
//      claude's carries its resumeId at birth, codex's none (the first
//      turn-end delivers the thread-id)
//   2. onTurnEnd() fires via the relay (no pane polling); the event carries the
//      session id, the key, and the agent's last words in `text`
//   3. the relay recorded <key>.session-id; resumable() is true
//   4. send() submits and the follow-up gets a reply
//   5. (--resume) h.kill → resume() → the agent recalls the first marker, on
//      the SAME session id
//   6. h.kill flips alive() to false
//
// State lives in a temp stateDir, so nothing touches ~/.bridge-commander or a
// workspace; the session, stateDir and workdir are removed on exit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getHarness } = require('./port.js');
const t = require('./tmux.js');
const { paneTarget, stateKey } = require('./tmux-session.js');

const NAME = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'claude';
const WITH_RESUME = process.argv.includes('--resume');
const TURN_TIMEOUT_MS = 180000;
const MARK = 'BC_SMOKE_' + NAME.toUpperCase();

function step(msg) {
  console.log(`[smoke ${NAME}] ${msg}`);
}

function waitTurnEnd(h, ref, label, opts) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for turn end (${label})`));
    }, TURN_TIMEOUT_MS);
    const unsub = h.onTurnEnd(ref, (event) => {
      clearTimeout(timer);
      unsub();
      resolve(event);
    }, opts);
  });
}

async function paneHas(ref, needle, label) {
  const pane = await t.capture(paneTarget(ref.session, ref.window), 80);
  if (!pane.includes(needle)) throw new Error(`${label}: expected pane to contain "${needle}"; pane tail:\n${pane}`);
  step(`${label}: found "${needle}"`);
}

async function main() {
  if (!['claude', 'codex'].includes(NAME)) throw new Error(`unknown harness "${NAME}" (claude | codex)`);
  try {
    execFileSync(NAME, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.log(`[smoke ${NAME}] SKIP — ${NAME} CLI not on PATH`);
    return;
  }
  const h = getHarness(NAME);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-state-'));
  const opts = { stateDir };
  step(`workdir ${cwd}, stateDir ${stateDir}`);
  let ref = null;
  let ok = false;
  try {
    // 1. spawn
    step('spawning...');
    ref = await h.spawn(cwd, `Reply with exactly: ${MARK}_OK`, opts);
    step(`spawned ${ref.session} resumeId=${ref.resumeId === undefined ? '(none yet)' : ref.resumeId}`);
    if (JSON.stringify(ref) !== JSON.stringify(JSON.parse(JSON.stringify(ref)))) throw new Error('ref is not JSON-serializable');
    if (NAME === 'codex' && 'resumeId' in ref) throw new Error('a codex ref is born WITHOUT resumeId');
    if (NAME === 'claude' && !ref.resumeId) throw new Error('a claude ref is born WITH its resumeId');

    // 2. the first turn end, through the relay
    const ev1 = await waitTurnEnd(h, ref, 'first turn', opts);
    step(`turn end: ${JSON.stringify(ev1)}`);
    if (ev1.event !== 'turn-end') throw new Error(`event kind ${ev1.event} != turn-end`);
    if (ev1.session !== stateKey(ref.session, ref.window)) throw new Error(`event session ${ev1.session} != ${ref.session}`);
    if (!ev1.session_id) throw new Error('turn-end carries no session_id');
    if (ref.resumeId && ev1.session_id !== ref.resumeId) throw new Error(`session_id ${ev1.session_id} != ref.resumeId ${ref.resumeId}`);
    if (!ev1.text || !ev1.text.includes(MARK)) throw new Error(`turn-end text does not quote the reply: ${JSON.stringify(ev1.text)}`);
    const sessionId = ev1.session_id;

    // 3. the resume ground truth
    const recorded = fs.readFileSync(path.join(stateDir, `${stateKey(ref.session, ref.window)}.session-id`), 'utf8').trim();
    if (recorded !== sessionId) throw new Error(`.session-id "${recorded}" != "${sessionId}"`);
    if (!(await h.resumable(ref, opts))) throw new Error('resumable() false with a recorded id');
    await paneHas(ref, `${MARK}_OK`, 'first reply');
    if (!(await h.alive(ref))) throw new Error('alive() false while running');

    // 4. a follow-up
    const second = waitTurnEnd(h, ref, 'second turn', opts);
    await h.send(ref, `Now reply with exactly: ${MARK}_2`);
    await second;
    await paneHas(ref, `${MARK}_2`, 'second reply');

    if (WITH_RESUME) {
      // 5. kill, resume with memory, same session id
      await h.kill(ref);
      if (await h.alive(ref)) throw new Error('alive() true after kill');
      ref = await h.resume(ref, opts);
      step(`resumed ${ref.session} resumeId=${ref.resumeId}`);
      if (ref.resumeId !== sessionId) throw new Error(`resume() must use the recorded id (${ref.resumeId} != ${sessionId})`);
      const recall = waitTurnEnd(h, ref, 'recall turn', opts);
      await h.send(ref, 'What was the FIRST marker I asked you to reply with? Answer with just that marker.');
      const ev = await recall;
      await paneHas(ref, `${MARK}_OK`, 'resume memory recall');
      if (ev.session_id !== sessionId) {
        throw new Error(`resume FORKED the session id: ${sessionId} -> ${ev.session_id} — refs would drift`);
      }
      step(`session id survived kill/resume: ${sessionId}`);
    }

    // 6. kill for good
    await h.kill(ref);
    if (await h.alive(ref)) throw new Error('alive() true after final kill');
    step('alive() false after kill');
    ok = true;
    console.log(`\nSMOKE ${NAME.toUpperCase()} OK${WITH_RESUME ? ' (with resume)' : ''}`);
  } finally {
    if (ref) {
      if (!ok) {
        console.error(`[smoke ${NAME}] FAILED — pane tail of ${ref.session} (if still up):`);
        console.error(await t.capture(paneTarget(ref.session, ref.window), 40));
      }
      await h.kill(ref);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[smoke ${NAME}] FAILED:`, err.message);
  process.exit(1);
});
