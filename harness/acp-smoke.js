#!/usr/bin/env node
'use strict';
// acp-smoke — a MANUAL end-to-end check of the acp adapter against a real ACP
// agent fetched through npx. Needs the network and the agent's own login;
// CI never runs it.
//
//   node harness/acp-smoke.js codex            # npx @agentclientprotocol/codex-acp
//   node harness/acp-smoke.js claude           # npx @agentclientprotocol/claude-agent-acp
//   node harness/acp-smoke.js claude-acp       # a shipped profile, exactly as plugins/ declares it
//   node harness/acp-smoke.js <npm package>    # any other ACP agent
//
// spawn (brief) → turn end with text → send → turn end → kill → alive false.
// --cancel adds: a long turn → interrupt (session/cancel) once it has output → a cancelled turn end.
// --resume adds: stop the host → alive false → resume → recall the first reply.
// BC_ACP_SMOKE_MODEL=<value> pins the model (the agent's `model` config option).
// BC_ACP_SMOKE_EFFORT=<value> pins the effort (its `thought_level` config option).
// Prints the rendered event log and `ACP SMOKE OK` on success.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acpAdapter, stopHost } = require('./acp-adapter.js');

const PACKAGES = {
  // @zed-industries/codex-acp stopped at 0.16.0 and hangs in session/new on
  // today's model catalog; the successor lives under @agentclientprotocol.
  codex: '@agentclientprotocol/codex-acp',
  claude: '@agentclientprotocol/claude-agent-acp',
};
const TURN_MS = Number(process.env.BC_ACP_SMOKE_TURN_MS) || 240 * 1000;

// A shipped acp profile by name, so the smoke runs the pinned versions the
// board would launch rather than whatever npx resolves today.
function shippedProfile(name) {
  const root = path.join(__dirname, '..', 'plugins');
  for (const dir of fs.readdirSync(root)) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(root, dir, 'plugin.json'), 'utf8')); } catch { continue; }
    const p = ((m.contributes || {}).profiles || []).find((x) => x.name === name && x.adapter === 'acp');
    if (p) return p;
  }
  return null;
}

// ms from t0 to the first agent output (message, thought or tool call) after
// log line `from` — the time a captain waits before the pane shows anything.
function firstOutputMs(file, from, t0) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(from); } catch { return null; }
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const k = e.kind === 'update' && e.update && e.update.sessionUpdate;
    if (k === 'agent_message_chunk' || k === 'agent_thought_chunk' || k === 'tool_call') return Date.parse(e.ts) - t0;
  }
  return null;
}
const logLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
async function main() {
  const which = process.argv[2] || 'codex';
  const shipped = shippedProfile(which);
  const pkg = PACKAGES[which] || which;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-acp-smoke-st-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-acp-smoke-cwd-'));
  process.env.BC_ACP_REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-acp-smoke-reg-'));
  const h = acpAdapter(shipped ? { ...shipped, name: 'acp-' + which }
    : { name: 'acp-' + which, command: 'npx', args: ['-y', pkg] });
  console.log('agent:', shipped ? [shipped.command, ...shipped.args].join(' ') : 'npx -y ' + pkg);
  const log = path.join(stateDir, 'acp-smoke.acp.jsonl');
  const turnEnds = [];
  let ref = null;
  let off = () => {};
  const waitTurns = async (n) => {
    const deadline = Date.now() + TURN_MS;
    while (turnEnds.length < n) {
      if (Date.now() > deadline) throw new Error(`no turn end #${n} within ${TURN_MS}ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return turnEnds[n - 1];
  };
  try {
    const t0 = Date.now();
    const probe = { harness: 'acp-' + which, session: 'acp-smoke', cwd };
    off = h.onTurnEnd(probe, (ev) => turnEnds.push(ev), { stateDir });
    // BC_ACP_SMOKE_MODEL pins the model through the agent's `model` config
    // option, the way opts.model does for a card.
    const model = process.env.BC_ACP_SMOKE_MODEL;
    const effort = process.env.BC_ACP_SMOKE_EFFORT;
    const pins = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    ref = await h.spawn(cwd, 'Reply with exactly the words: ACP SMOKE ONE. Do not run any tools.',
      { session: 'bc-smoke', stateDir, ...pins });
    console.log('spawned', JSON.stringify(ref), `in ${Date.now() - t0}ms`);
    console.log('profileInfo options:', JSON.stringify(h.profileInfo().options));
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'acp-smoke.acp-state.json'), 'utf8'));
      const m = (st.configOptions || []).find((o) => o.category === 'model' || o.id === 'model');
      const values = m ? (m.options || []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value) : [];
      console.log('config options:', (st.configOptions || []).map((o) => `${o.id}${o.category ? '(' + o.category + ')' : ''}=${o.currentValue}`).join(' ') || 'none');
      console.log('model option:', m ? `${m.id}=${m.currentValue} of [${values.join(', ')}]` : 'none');
    } catch { /* no state yet */ }
    const first = await waitTurns(1);
    console.log('turn 1:', first.stop_reason, JSON.stringify(first.text), `first output ${firstOutputMs(log, 0, t0)}ms, turn end ${Date.now() - t0}ms after spawn`);
    await h.send(ref, 'Now reply with exactly the words: ACP SMOKE TWO. Do not run any tools.');
    const second = await waitTurns(2);
    console.log('turn 2:', second.stop_reason, JSON.stringify(second.text));
    console.log('status:', JSON.stringify(await h.status(ref, { stateDir })));
    console.log('commands:', h.commands(ref).map((c) => c.name).join(' '));
    console.log('resumable:', await h.resumable(ref, { stateDir }));
    if (process.argv.includes('--cancel')) {
      const from = logLines(log);
      const tc = Date.now();
      const nCancel = turnEnds.length + 1;
      await h.send(ref, 'Write the numbers from 1 to 400, one per line, as plain text. Do not run any tools.');
      let out = null;
      while ((out = firstOutputMs(log, from, tc)) === null) {
        if (Date.now() - tc > TURN_MS) throw new Error('the long turn showed no output');
        await new Promise((r) => setTimeout(r, 100));
      }
      await h.interrupt(ref);
      const cancelled = await waitTurns(nCancel);
      console.log('cancel:', cancelled.stop_reason, `first output ${out}ms, turn end ${Date.now() - tc}ms after the prompt`);
      if (cancelled.stop_reason !== 'cancelled') throw new Error('the interrupted turn ended ' + cancelled.stop_reason);
      if (!(await h.alive(ref))) throw new Error('the session died on cancel');
    }
    if (process.argv.includes('--resume')) {
      // The host dying takes the agent with it, as a reboot would.
      await stopHost(stateDir);
      if (await h.alive(ref)) throw new Error('alive after the host stopped');
      const tr = Date.now();
      const back = await h.resume(ref, { stateDir, ...pins });
      console.log('resumed', JSON.stringify(back), 'same id:', back.resumeId === ref.resumeId, `in ${Date.now() - tr}ms`);
      const nRecall = turnEnds.length + 1;
      await h.send(back, 'What exact words did you reply with first in this conversation? Reply with only those words.');
      const third = await waitTurns(nRecall);
      console.log('recall:', third.stop_reason, JSON.stringify(third.text), `turn end ${Date.now() - tr}ms after resume`);
      if (!/ACP SMOKE ONE/.test(third.text || '')) throw new Error('the resumed session did not remember');
    }
    console.log('--- pane ---\n' + (await h.paneSnapshot(ref, { stateDir })) + '\n------------');
    await h.kill(ref);
    if (await h.alive(ref)) throw new Error('alive after kill');
    if (!/ACP SMOKE ONE/.test(first.text || '') || !/ACP SMOKE TWO/.test(second.text || '')) {
      throw new Error('the agent did not say what it was asked to say');
    }
    console.log('ACP SMOKE OK');
  } catch (e) {
    console.error('ACP SMOKE FAILED:', e.message);
    try { console.error('--- pane ---\n' + (ref ? await h.paneSnapshot(ref, { stateDir }) : '')); } catch { /* none */ }
    try { console.error('--- agent stderr ---\n' + fs.readFileSync(path.join(stateDir, 'acp-smoke.acp.stderr.log'), 'utf8').slice(-3000)); } catch { /* none */ }
    process.exitCode = 1;
  } finally {
    off(); // the turn-end watcher would keep the process up
    await stopHost(stateDir);
    for (const d of [stateDir, cwd, process.env.BC_ACP_REGISTRY]) fs.rmSync(d, { recursive: true, force: true });
  }
}

main();
