'use strict';
// plugins — the host that runs a plugin's server.js: activation, the ctx it is
// handed, and the unwinding when it goes.
//
// A plugin's manifest is data (manifests.js) and most plugins stop there. Code
// is the escape hatch, and it runs on intent: a plugin with `activation: 'boot'`
// starts with the board, every other one on the first command handler or route
// the board asks it for. Events and decorations only reach a plugin that is
// already running, so a plugin that observes the board says `activation: 'boot'`.
//
// Every registration returns a disposer and is ALSO remembered per plugin, so
// deactivate() unwinds everything the plugin did, even what it forgot to undo.
//
// A plugin's failure is its own. A throwing activate, event handler or decorator
// is caught, logged with the plugin id, and never stops the next plugin — the
// same rule the hooks follow (a hook never fails the lifecycle it observes).
// Events are observe-only: a handler gets a copy of the payload and its return
// value is ignored.
//
// Every `when` a manifest carries (menus, badges, sections) is compiled at
// reload. A bad predicate disables THAT plugin with the error on it — loud in
// status() and GET /api/plugins, never a board that fails to boot.
//
// Node built-ins only.
const path = require('path');
const { loadPure } = require('./commands.js');

const EVENTS = ['card-created', 'card-moved', 'card-archived', 'worker-started', 'worker-done', 'worker-died', 'activity-ended'];
const DECORATION_CACHE_MAX = 5000;
const BADGES_MAX = 8;

function errText(e) { return String((e && e.message) || e); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isThenable(v) { return !!v && typeof v.then === 'function'; }

// A decorator's answer, trimmed to what a card can render: badges are data
// ({text, tone?, tooltip?}), attrs a plain object. Anything else is dropped.
function cleanDecoration(d) {
  const out = { badges: [], attrs: {} };
  if (!isObj(d)) return out;
  if (Array.isArray(d.badges)) {
    for (const b of d.badges) {
      if (!isObj(b) || typeof b.text !== 'string' || !b.text) continue;
      const badge = { text: b.text.slice(0, 64) };
      if (typeof b.tone === 'string') badge.tone = b.tone;
      if (typeof b.tooltip === 'string') badge.tooltip = b.tooltip.slice(0, 500);
      out.badges.push(badge);
    }
  }
  if (isObj(d.attrs)) out.attrs = d.attrs;
  return out;
}

// What a `when` compile has to cover: every predicate the core evaluates
// without running plugin code.
function* predicates(manifest) {
  const c = manifest.contributes;
  for (const [slot, entries] of Object.entries(c.menus || {})) {
    for (const e of entries) yield ['menus["' + slot + '"] ' + e.command, e.when];
  }
  for (const kind of ['badges', 'sections']) {
    for (const e of c[kind] || []) yield [kind + ' ' + e.id, e.when];
  }
}

/**
 * The plugin host.
 * @param {object} deps
 * @param {() => {plugins: object[], overlay: object}} deps.catalog manifests.resolveCatalog, re-read on reload()
 * @param {(msg: string) => void} [deps.log]
 * @param {() => string} [deps.now] ISO timestamp
 * @param {object} deps.api what every ctx may reach: {board, findCard, queuePush, cardEvent, runs, commit}
 * @param {object} [deps.internal] handed only to shipped plugins, as ctx.internal
 * @param {{register: Function}} [deps.watchers] server/watchers.js
 * @param {(file: string) => object} [deps.load] require (tests inject)
 */
function createPluginHost(deps) {
  const log = deps.log || ((m) => console.error(m));
  const now = deps.now || (() => new Date().toISOString());
  const load = deps.load || ((file) => require(file));

  let cat = null;            // the effective catalog: bad-when plugins rewritten disabled
  let booted = false;
  const active = new Map();  // id -> {mod, disposers: Set, file, dir, since}
  const pending = new Map(); // id -> Promise of an activation in flight
  const failed = new Map();  // id -> activation error (sticky until reload)
  const handlers = new Map(); // commandId -> {plugin, prepare?, run?}
  const listeners = new Map(); // event -> [{plugin, fn}]
  const decorators = [];      // [{plugin, fn}]
  const routes = new Map();   // plugin \0 METHOD \0 subpath -> fn
  let decoCache = new Map();

  function tag(id, msg) { log('plugin ' + id + ': ' + msg); }
  function entry(id) { return cat ? cat.plugins.find((p) => p.id === id) || null : null; }
  function runnable(p) { return !!(p && p.enabled && !p.error && p.manifest && p.server); }

  // ---------- reload ----------

  /**
   * Re-read the catalog, compile every `when`, and stop what is gone, disabled
   * or moved. Once booted, start the boot plugins that became enabled.
   * @returns {Promise<void>}
   */
  async function reload() {
    const { compileWhen } = await loadPure();
    const fresh = deps.catalog();
    failed.clear();
    const plugins = fresh.plugins.map((p) => {
      if (!p.enabled || !p.manifest) return p;
      for (const [where, pred] of predicates(p.manifest)) {
        if (pred === undefined) continue;
        try { compileWhen(pred); }
        catch (e) {
          const error = 'when of ' + where + ': ' + errText(e);
          tag(p.id, 'disabled: ' + error);
          return Object.assign({}, p, { enabled: false, error });
        }
      }
      return p;
    });
    const prev = cat;
    cat = { plugins, overlay: fresh.overlay };
    for (const id of [...active.keys()]) {
      const p = entry(id);
      const was = prev && prev.plugins.find((x) => x.id === id);
      if (!runnable(p) || (was && (was.dir !== p.dir || was.server !== p.server))) await deactivate(id);
    }
    decoCache = new Map();
    if (booted) await bootActivate();
  }

  /** The catalog as the host sees it: a plugin whose `when` failed to compile reads disabled, with its error. */
  function catalog() { return cat; }

  // ---------- activation ----------

  function makeCtx(p, rec) {
    const own = (dispose) => {
      let done = false;
      const d = () => {
        if (done) return;
        done = true;
        rec.disposers.delete(d);
        try { dispose(); } catch (e) { tag(p.id, 'a disposer threw: ' + errText(e)); }
      };
      rec.disposers.add(d);
      return d;
    };
    const live = (what) => { if (rec.dead) throw new Error('plugin ' + p.id + ' is not active; cannot ' + what); };
    const ctx = {
      plugin: Object.freeze({ id: p.id, dir: p.dir, config: Object.freeze(Object.assign({}, p.config)) }),
      log: (msg) => tag(p.id, String(msg)),
      commands: {
        handle(commandId, impl) {
          live('handle a command');
          const cid = String(commandId || '');
          // Namespaced like the manifest's ids: one plugin cannot answer for another's command.
          if (!cid.startsWith(p.id + '.')) throw new Error('command "' + cid + '" must start with "' + p.id + '."');
          if (!isObj(impl) || (typeof impl.prepare !== 'function' && typeof impl.run !== 'function')) {
            throw new Error('commands.handle(' + cid + '): needs prepare() and/or run()');
          }
          if (handlers.has(cid)) throw new Error('command "' + cid + '" already has a handler');
          const h = { plugin: p.id };
          if (typeof impl.prepare === 'function') h.prepare = impl.prepare;
          if (typeof impl.run === 'function') h.run = impl.run;
          handlers.set(cid, h);
          return own(() => { if (handlers.get(cid) === h) handlers.delete(cid); });
        },
      },
      events: {
        on(name, fn) {
          live('listen');
          // A typo'd event name would be a listener that silently never fires.
          if (!EVENTS.includes(name)) throw new Error('unknown event "' + name + '" (known: ' + EVENTS.join(', ') + ')');
          if (typeof fn !== 'function') throw new Error('events.on(' + name + '): fn required');
          const l = { plugin: p.id, fn };
          if (!listeners.has(name)) listeners.set(name, []);
          listeners.get(name).push(l);
          return own(() => {
            const list = listeners.get(name) || [];
            const i = list.indexOf(l);
            if (i !== -1) list.splice(i, 1);
          });
        },
      },
      decorate(fn) {
        live('decorate');
        if (typeof fn !== 'function') throw new Error('decorate: fn required');
        const d = { plugin: p.id, fn };
        decorators.push(d);
        decoCache = new Map();
        return own(() => {
          const i = decorators.indexOf(d);
          if (i !== -1) decorators.splice(i, 1);
          decoCache = new Map();
        });
      },
      watchers: {
        register(spec) {
          live('register a watcher');
          if (!deps.watchers || typeof deps.watchers.register !== 'function') throw new Error('watchers are not available');
          if (!isObj(spec) || !spec.id || typeof spec.tick !== 'function') throw new Error('watchers.register: {id, intervalMs, tick} required');
          const dispose = deps.watchers.register(Object.assign({}, spec, { id: p.id + '/' + spec.id }));
          return own(() => { if (typeof dispose === 'function') dispose(); });
        },
      },
      routes: {
        handle(method, subpath, fn) {
          live('handle a route');
          if (typeof fn !== 'function') throw new Error('routes.handle: fn required');
          const key = routeKey(p.id, method, subpath);
          if (routes.has(key)) throw new Error('route ' + String(method).toUpperCase() + ' ' + subpath + ' already handled');
          routes.set(key, fn);
          return own(() => { if (routes.get(key) === fn) routes.delete(key); });
        },
      },
      api: deps.api,
    };
    // The internal tier is for what ships with the board: a surface that is not
    // stable yet is not a promise to a workspace's plugin.
    if (p.source === 'shipped' && deps.internal !== undefined) ctx.internal = deps.internal;
    return ctx;
  }

  /**
   * Start one plugin: require its server module and call activate(ctx). Never
   * rejects; a failure unwinds what it registered and lands in status().
   * A disabled plugin, or one without a server module, activates nothing.
   * @returns {Promise<void>}
   */
  function activate(id) {
    // Pending first: the record is in `active` from the start of the activation.
    if (pending.has(id)) return pending.get(id);
    if (active.has(id)) return Promise.resolve();
    const p = entry(id);
    if (!runnable(p) || failed.has(id)) return Promise.resolve();
    const job = (async () => {
      const file = path.join(p.dir, p.server);
      const rec = { mod: null, disposers: new Set(), file, dir: p.dir, since: now(), dead: false };
      active.set(id, rec);
      try {
        const mod = load(file);
        rec.mod = mod;
        if (!mod || typeof mod.activate !== 'function') throw new Error(p.server + ' exports no activate(ctx)');
        await mod.activate(makeCtx(p, rec));
      } catch (e) {
        failed.set(id, errText(e));
        tag(id, 'activation failed: ' + errText(e));
        await unwind(id, rec);
      }
    })();
    pending.set(id, job);
    return job.finally(() => pending.delete(id));
  }

  async function unwind(id, rec) {
    rec.dead = true;
    for (const d of [...rec.disposers].reverse()) d();
    if (rec.mod && typeof rec.mod.deactivate === 'function') {
      try { await rec.mod.deactivate(); } catch (e) { tag(id, 'deactivate threw: ' + errText(e)); }
    }
    // The next activation reads the file again: an edited plugin reloads without a restart.
    try { delete require.cache[require.resolve(rec.file)]; } catch (e) {}
    if (active.get(id) === rec) active.delete(id);
    decoCache = new Map();
  }

  /** Stop one plugin: every disposer (newest first), then its deactivate(). @returns {Promise<void>} */
  async function deactivate(id) {
    if (pending.has(id)) await pending.get(id);
    const rec = active.get(id);
    if (rec) await unwind(id, rec);
  }

  /** Start every enabled `activation: 'boot'` plugin (reads the catalog first if nothing has). @returns {Promise<void>} */
  async function bootActivate() {
    if (!cat) await reload();
    booted = true;
    for (const p of cat.plugins) {
      if (p.activation === 'boot' && runnable(p)) await activate(p.id);
    }
  }

  // ---------- what the board asks for ----------

  function declares(p, commandId) {
    return !!(p && p.manifest && p.manifest.contributes.commands.some((c) => c.id === commandId));
  }

  /** The server side of a command, activating its plugin on first use. -> Promise<{prepare?, run?} | null> */
  async function handler(commandId) {
    const cid = String(commandId || '');
    const owner = entry(cid.split('.')[0]);
    if (!runnable(owner)) return null;
    if (!handlers.has(cid) && declares(owner, cid)) await activate(owner.id);
    const h = handlers.get(cid);
    if (!h || h.plugin !== owner.id) return null;
    const out = {};
    if (h.prepare) out.prepare = h.prepare;
    if (h.run) out.run = h.run;
    return out;
  }

  function routeKey(pluginId, method, subpath) {
    return pluginId + '\0' + String(method || '').toUpperCase() + '\0' + String(subpath || '').replace(/^\/+/, '');
  }

  /** A plugin's route handler, activating the plugin on first use. -> Promise<fn(req, res, body) | null> */
  async function route(pluginId, method, subpath) {
    const p = entry(pluginId);
    if (!runnable(p)) return null;
    const key = routeKey(pluginId, method, subpath);
    if (!routes.has(key)) await activate(pluginId);
    return routes.get(key) || null;
  }

  /**
   * Tell the running plugins something happened. Observe-only: each handler
   * gets its own copy of the payload, and a throw (or a rejection) is logged
   * with the plugin id and goes no further. -> Promise that settles when every
   * handler did (callers may ignore it).
   */
  function emit(name, payload) {
    const list = [...(listeners.get(name) || [])];
    return Promise.all(list.map((l) => {
      let copy = payload;
      try { copy = structuredClone(payload); } catch (e) { /* not cloneable: the original, still unowned */ }
      const fail = (e) => tag(l.plugin, 'event ' + name + ' handler failed: ' + errText(e));
      try {
        const r = l.fn(copy);
        return isThenable(r) ? Promise.resolve(r).catch(fail) : undefined;
      } catch (e) { fail(e); return undefined; }
    })).then(() => {});
  }

  /**
   * Server-computed card data: {<pluginId>: {badges, attrs} | {error}}. Cached
   * per card.id + card.updated, so a decorator runs once per change of the
   * card, not once per client render. A plugin with nothing to say is absent.
   */
  function decorations(card, board) {
    if (!card || !decorators.length) return {};
    const key = String(card.id) + '\0' + String(card.updated || '');
    if (decoCache.has(key)) return decoCache.get(key);
    const out = {};
    for (const d of decorators) {
      if (out[d.plugin] && out[d.plugin].error) continue;
      let res;
      try {
        res = d.fn(card, board);
        if (isThenable(res)) {
          res.then(null, () => {});
          throw new Error('a decorator must answer synchronously');
        }
      } catch (e) {
        tag(d.plugin, 'decorator failed on ' + card.id + ': ' + errText(e));
        out[d.plugin] = { error: errText(e) };
        continue;
      }
      const clean = cleanDecoration(res);
      const acc = out[d.plugin] || { badges: [], attrs: {} };
      acc.badges = acc.badges.concat(clean.badges).slice(0, BADGES_MAX);
      acc.attrs = Object.assign(acc.attrs, clean.attrs);
      out[d.plugin] = acc;
    }
    for (const [id, v] of Object.entries(out)) {
      if (!v.error && !v.badges.length && !Object.keys(v.attrs).length) delete out[id];
    }
    if (decoCache.size >= DECORATION_CACHE_MAX) decoCache = new Map();
    decoCache.set(key, out);
    return out;
  }

  /** Every plugin in the catalog: is it running, and what went wrong. -> [{id, active, error?}] */
  function status() {
    if (!cat) return [];
    return cat.plugins.map((p) => {
      const s = { id: p.id, active: active.has(p.id) && !pending.has(p.id) };
      const error = p.error || failed.get(p.id);
      if (error) s.error = error;
      return s;
    });
  }

  return { reload, catalog, activate, deactivate, bootActivate, handler, route, emit, decorations, status, EVENTS };
}

module.exports = { createPluginHost, EVENTS };
