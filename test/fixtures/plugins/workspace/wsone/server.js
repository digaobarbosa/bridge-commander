'use strict';
// Fixture: a workspace plugin — no internal tier, and no other plugin's commands.
const rec = () => globalThis.__bcPluginFixture;

module.exports = {
  activate(ctx) {
    rec().activated.push('wsone');
    rec().ctx.wsone = ctx;
    try { ctx.commands.handle('alpha.go', { run: () => ({ ok: true }) }); }
    catch (e) { rec().errors.push(e.message); }
    try { ctx.events.on('card-moverd', () => {}); }
    catch (e) { rec().errors.push(e.message); }
  },
};
