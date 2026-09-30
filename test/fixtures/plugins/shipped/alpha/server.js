'use strict';
// Fixture: a boot plugin that touches every ctx surface and records what it saw.
const rec = () => globalThis.__bcPluginFixture;

module.exports = {
  activate(ctx) {
    rec().activated.push('alpha');
    rec().ctx.alpha = ctx;
    ctx.commands.handle('alpha.go', {
      prepare: () => ({ greeting: ctx.plugin.config.greeting }),
      run: (req) => ({ ok: true, message: 'went ' + req.card.id }),
    });
    ctx.events.on('card-moved', (p) => {
      rec().events.push(['alpha', p.card.id]);
      p.card.id = 'MUTATED';
    });
    ctx.decorate((card) => { rec().decorated.push(card.id); return { badges: [{ text: 'α', tone: 'info' }], attrs: { seen: card.id } }; });
    ctx.watchers.register({ id: 'poll', intervalMs: 1000, tick: () => {} });
    ctx.routes.handle('GET', '/ping', (req, res) => 'pong');
  },
  deactivate() { rec().deactivated.push('alpha'); },
};
