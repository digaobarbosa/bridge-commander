'use strict';
// Fixture: registers, then throws — what it registered must be unwound.
const rec = () => globalThis.__bcPluginFixture;

module.exports = {
  activate(ctx) {
    rec().activated.push('failing');
    ctx.commands.handle('failing.x', { run: () => ({ ok: true }) });
    ctx.watchers.register({ id: 'w', intervalMs: 10, tick: () => {} });
    throw new Error('cannot start');
  },
};
