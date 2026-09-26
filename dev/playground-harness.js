'use strict';
// Preloaded into the playground's server (node --require). Every harness name
// the board or the UI can ask for answers with the fake one, so nothing done
// in the playground can start a real agent or reach into tmux.
const path = require('node:path');
const { registerHarness } = require(path.join(__dirname, '..', 'harness', 'port.js'));
const fake = require(path.join(__dirname, '..', 'harness', 'fake.js'));

for (const name of ['claude', 'codex']) registerHarness(name, fake);
