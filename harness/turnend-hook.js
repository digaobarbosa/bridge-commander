#!/usr/bin/env node
'use strict';
// turnend-hook.js — claude's Stop-hook entry point (payload JSON on stdin).
// Installed .claude/settings.local.json files name THIS path, so it stays;
// the work is turnend-relay.js.
//
// Usage (as a hook command): node turnend-hook.js <stateDir> <key> [url]

const { relay } = require('./turnend-relay.js');
const { readStdin } = require('./util.js');

async function main() {
  const [stateDir, key, url] = process.argv.slice(2);
  if (!stateDir || !key) return;
  let raw = {};
  try {
    raw = JSON.parse(await readStdin());
  } catch {
    // no/bad payload: still record the turn boundary
  }
  await relay({ harness: 'claude', stateDir, key, url: url || process.env.BC_TURNEND_URL || '', raw });
}

main().then(() => process.exit(0), () => process.exit(0));
