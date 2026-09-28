'use strict';
// turnend-relay — the ONE turn-end relay. turnend-hook.js (claude's Stop hook,
// payload on stdin) and codex-notify.js (codex's notify program, payload as the
// last argv) are thin entry points into it; installed hooks and launch lines
// name those two paths, so they stay.
//
// Both harnesses produce the same TurnEndEvent:
//   { ts, session: <key>, harness, event: 'turn-end', session_id, cwd, tmux_session, text? }
//   session_id  — the harness's resume id (claude session uuid / codex thread-id)
//   tmux_session — the pane's own tmux session, '' outside tmux (server attribution)
//   text        — what the agent last said, trimmed and capped; absent when it
//                 said nothing (the server's worker-stall alert quotes it)
//
// relay() does three things, all best-effort — a relay must never wedge its agent:
//   1. records session_id at <stateDir>/<key>.session-id (resume's ground truth)
//   2. appends the event to <stateDir>/<key>.turnend.jsonl (what onTurnEnd tails)
//   3. POSTs it to the callback URL, when there is one (the server's channel)

const fs = require('node:fs');
const path = require('node:path');
const { tmuxSession } = require('./util.js');
const { codexRolloutFile, codexSessionsDir } = require('./agent-status.js');

const TEXT_MAX = 300;

// Where each harness keeps the three facts in its own payload. `type`, when
// set, is the only payload kind that is a turn boundary.
const PAYLOADS = {
  claude: { id: 'session_id', text: 'last_assistant_message' },
  codex: { id: 'thread-id', text: 'last-assistant-message', type: 'agent-turn-complete' },
};

/**
 * normalize(harness, raw) -> { harness, event, session_id, cwd, text? } | null.
 * null = not a turn boundary. claude records a boundary even from an empty
 * payload (the hook fired, so a turn ended); codex drops other notify kinds.
 */
function normalize(harness, raw) {
  const f = PAYLOADS[harness];
  if (!f) throw new Error('turnend-relay: unknown harness ' + harness);
  const p = raw && typeof raw === 'object' ? raw : {};
  if (f.type && p.type !== f.type) return null;
  const ev = { harness, event: 'turn-end', session_id: p[f.id] || null, cwd: p.cwd || null };
  const said = p[f.text];
  if (typeof said === 'string' && said.trim()) ev.text = said.trim().slice(0, TEXT_MAX);
  return ev;
}

/** record(stateDir, key, event) — write the session-id file and append the event line. Never throws. */
function record(stateDir, key, event) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (event.session_id) fs.writeFileSync(path.join(stateDir, `${key}.session-id`), event.session_id + '\n');
    fs.appendFileSync(path.join(stateDir, `${key}.turnend.jsonl`), JSON.stringify(event) + '\n');
  } catch {
    // the relay never fails its agent
  }
}

/** post(url, event) — best-effort POST with a short timeout; the file is the reliable channel. */
async function post(url, event) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // callback is best-effort
  }
}

/** relay({ harness, stateDir, key, url, raw }) -> TurnEndEvent | null — normalize, record, POST. */
async function relay({ harness, stateDir, key, url, raw }) {
  if (!stateDir || !key) return null;
  const n = normalize(harness, raw);
  if (!n) return null;
  // codex also notifies for its own side threads (e.g. the task-title one).
  // Only the conversation writes a rollout; any other thread-id would replace
  // the resume id and ring a false turn-end.
  if (harness === 'codex' && n.session_id && !codexRolloutFile(n.session_id, codexSessionsDir())) return null;
  const event = { ts: new Date().toISOString(), session: key, ...n, tmux_session: tmuxSession() };
  record(stateDir, key, event);
  await post(url, event);
  return event;
}

module.exports = { normalize, record, post, relay, TEXT_MAX };
