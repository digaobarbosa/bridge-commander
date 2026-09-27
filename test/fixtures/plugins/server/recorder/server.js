'use strict';
// Test fixture: a boot plugin that writes every event it hears to events.jsonl
// in its own folder, decorates cards labelled `deco`, and answers one command
// and two routes.
const fs = require('fs');
const path = require('path');

const EVENTS = ['card-created', 'card-moved', 'card-archived', 'worker-started', 'worker-done', 'worker-died', 'activity-ended'];

module.exports = {
  activate(ctx) {
    const file = path.join(ctx.plugin.dir, 'events.jsonl');
    for (const name of EVENTS) {
      ctx.events.on(name, (p) => {
        const row = { event: name, card: p.card ? p.card.id : null };
        if (p.from) Object.assign(row, { from: p.from, to: p.to });
        if (p.activity) Object.assign(row, { activity: p.activity.id, status: p.activity.status });
        fs.appendFileSync(file, JSON.stringify(row) + '\n');
      });
    }
    ctx.decorate((card) => ((card.labels || []).includes('deco')
      ? { badges: [{ text: 'R', tone: 'info', tooltip: 'recorded' }], attrs: { seen: card.id } } : null));
    ctx.commands.handle('recorder.greet', {
      prepare: (req) => ({ name: req.card.title }),
      run: (req) => ({ ok: true, message: ctx.plugin.config.greeting + ' ' + req.input.name + ' on ' + req.card.id }),
    });
    ctx.routes.handle('GET', 'hello', () => ({ hi: true, cards: ctx.api.board().cards.length }));
    ctx.routes.handle('POST', 'echo', (req, res, body) => ({ got: body }));
  },
};
