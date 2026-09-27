'use strict';
// Fixture: must never run — its manifest carries a `when` that does not compile.
module.exports = { activate() { globalThis.__bcPluginFixture.activated.push('badwhen'); } };
