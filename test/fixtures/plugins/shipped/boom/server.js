'use strict';
// Fixture: a plugin whose every callback fails, sync and async.
const rec = () => globalThis.__bcPluginFixture;

module.exports = {
  activate(ctx) {
    rec().activated.push('boom');
    ctx.events.on('card-moved', () => { throw new Error('boom sync'); });
    ctx.events.on('card-moved', async () => { throw new Error('boom async'); });
    ctx.decorate(() => { throw new Error('boom decorate'); });
  },
};
