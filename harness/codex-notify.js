#!/usr/bin/env node
'use strict';
// codex-notify.js — codex's notify entry point. codex-tmux.js wires it at launch:
//   -c notify='["node","<this script>","<stateDir>","<key>","<url>"]'
// and codex runs it at every turn boundary with the payload JSON APPENDED AS
// THE LAST ARGV (not stdin):
//   { "type": "agent-turn-complete", "thread-id": "<uuid>", "turn-id": "...",
//     "cwd": "/abs/worktree", "input-messages": [...], "last-assistant-message": "..." }
// Launch lines of live codex sessions name THIS path, so it stays; the work is
// turnend-relay.js.
//
// Usage (as the notify program): node codex-notify.js <stateDir> <key> [url] <payloadJSON>

const { relay } = require('./turnend-relay.js');

async function main() {
  const argv = process.argv;
  const stateDir = argv[2];
  const key = argv[3];
  // With a url wired the argv is [node, script, stateDir, key, url, payload],
  // without it one shorter.
  if (!stateDir || !key || argv.length < 5) return;
  const url = (argv.length >= 6 ? argv[4] : '') || process.env.BC_TURNEND_URL || '';
  let raw;
  try {
    raw = JSON.parse(argv[argv.length - 1]);
  } catch {
    return; // junk payload: nothing to relay
  }
  await relay({ harness: 'codex', stateDir, key, url, raw });
}

main().then(() => process.exit(0), () => process.exit(0));
