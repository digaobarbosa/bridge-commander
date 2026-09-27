'use strict';
// Fixture: a lazy plugin — it should start only when the board asks it for something.
const rec = () => globalThis.__bcPluginFixture;

module.exports = {
  async activate(ctx) {
    rec().activated.push('lazy');
    await new Promise((r) => setTimeout(r, 20)); // a slow start: concurrent asks must share it
    ctx.commands.handle('lazy.hi', { run: () => ({ ok: true }) });
    ctx.routes.handle('post', 'echo', (req, res, body) => body);
  },
};
