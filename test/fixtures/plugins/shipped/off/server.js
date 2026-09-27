'use strict';
// Fixture: disabled in its manifest — must never run.
module.exports = { activate() { globalThis.__bcPluginFixture.activated.push('off'); } };
