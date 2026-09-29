'use strict';
// Preloaded into the playground's server (node --require). Every harness name
// the board or the UI can ask for answers with the fake one, so nothing done
// in the playground can start a real agent or reach into tmux.
const path = require('node:path');
const { registerHarness, profileInfo } = require(path.join(__dirname, '..', 'harness', 'port.js'));
const fake = require(path.join(__dirname, '..', 'harness', 'fake.js'));

// The real profile's by-hand resume line survives the swap, so the 👁 drawer's
// copy menu shows what it would on a live board.
for (const name of ['claude', 'codex']) {
  const handResume = (profileInfo(name) || {}).handResume || '';
  registerHarness(name, handResume ? { ...fake, profileInfo: () => ({ ...fake.profileInfo(), handResume }) } : fake);
}
