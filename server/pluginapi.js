'use strict';
// pluginapi — the HTTP face of the plugin system: the catalog the UI renders
// from, the overlay it writes, commands run on a card, activities and their
// logs, checks, a plugin's own routes and its browser module.
//
// Every route here reads the host's catalog (plugins.js), never the raw one:
// a plugin whose `when` failed to compile reads disabled there, with its error.
//
// What the browser receives is data only. A command's shell line and env stay
// on the server — the UI gets the form, the title and, for a link, the
// unexpanded template.
//
// A command run re-checks the card against the command's menu `when`s. The UI
// hides what does not apply, but the UI is not the auth boundary: a stale page
// or a curl must not run "Deploy" on a card the plugin said it never fits.
//
// Node built-ins only.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const manifests = require('./manifests.js');
const { planRun, loadPure } = require('./commands.js');

const ACTIVITY_RE = /^\/api\/activities\/([^/]+)\/(log|stream|cancel)$/;
const COMMAND_RE = /^\/api\/commands\/([^/]+)\/(prepare|run)$/;
const X_RE = /^\/api\/x\/([^/]+)(?:\/(.*))?$/;
const STATIC_RE = /^\/plugins\/([^/]+)\/(.+)$/;
const JS_MIME = 'text/javascript; charset=utf-8';

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function errText(e) { return String((e && e.message) || e); }

let cardviewP = null;
// The UI's own card view model: `when` on the server must read the SAME
// context the menu was filtered with, or a command the UI offered is refused.
function loadCardview() {
  if (!cardviewP) cardviewP = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'cardview.js')).href);
  return cardviewP;
}

// What a manifest command looks like to the browser: no exec, no env.
function publicCommand(c) {
  const out = { id: c.id, plugin: c.plugin, key: c.key, title: c.title, form: c.form || {},
    tracked: !!c.tracked, rank: c.rank };
  for (const k of ['icon', 'description', 'prepare']) if (c[k] !== undefined) out[k] = c[k];
  if (c.run === 'server') out.run = 'server';
  else if (isObj(c.run) && typeof c.run.open === 'string') out.open = c.run.open;
  else out.run = 'exec';
  return out;
}

function publicCheck(c) {
  const out = Object.assign({}, c);
  delete out.exec;
  return out;
}

/**
 * Overlay body validation: {plugins?: {<id>: {enabled?, config?} | null},
 * contributions?: {<key>: {enabled?, rank?} | null}}. null removes an entry.
 * -> null when fine, else the error sentence.
 */
function badOverlay(body) {
  if (!isObj(body)) return 'body must be an object {plugins?, contributions?}';
  for (const k of Object.keys(body)) if (k !== 'plugins' && k !== 'contributions') return 'unknown key "' + k + '"';
  if (body.plugins !== undefined) {
    if (!isObj(body.plugins)) return 'plugins must be an object keyed by plugin id';
    for (const [id, v] of Object.entries(body.plugins)) {
      if (!manifests.PLUGIN_ID_RE.test(id)) return 'bad plugin id "' + id + '"';
      if (v === null) continue;
      if (!isObj(v)) return 'plugins.' + id + ' must be an object {enabled?, config?} or null';
      for (const k of Object.keys(v)) if (k !== 'enabled' && k !== 'config') return 'plugins.' + id + ': unknown key "' + k + '"';
      if (v.enabled !== undefined && v.enabled !== null && typeof v.enabled !== 'boolean') return 'plugins.' + id + '.enabled must be true or false';
      if (v.config !== undefined && v.config !== null && !isObj(v.config)) return 'plugins.' + id + '.config must be an object';
    }
  }
  if (body.contributions !== undefined) {
    if (!isObj(body.contributions)) return 'contributions must be an object keyed by contribution key';
    for (const [key, v] of Object.entries(body.contributions)) {
      if (!/^[a-z]+:\S+$/.test(key)) return 'bad contribution key "' + key + '" (want <kind>:<id>)';
      if (v === null) continue;
      if (!isObj(v)) return 'contributions["' + key + '"] must be an object {enabled?, rank?} or null';
      for (const k of Object.keys(v)) if (k !== 'enabled' && k !== 'rank') return 'contributions["' + key + '"]: unknown key "' + k + '"';
      if (v.enabled !== undefined && v.enabled !== null && typeof v.enabled !== 'boolean') return 'contributions["' + key + '"].enabled must be true or false';
      if (v.rank !== undefined && v.rank !== null && !Number.isFinite(v.rank)) return 'contributions["' + key + '"].rank must be a number';
    }
  }
  return null;
}

// Merge per id: an entry's fields merge, a null field or a null entry goes.
// The CLI's `plugins enable x` then never clobbers x's config or anyone else.
function mergeOverlay(cur, body) {
  const out = { plugins: Object.assign({}, cur.plugins), contributions: Object.assign({}, cur.contributions) };
  for (const part of ['plugins', 'contributions']) {
    for (const [id, v] of Object.entries(body[part] || {})) {
      if (v === null) { delete out[part][id]; continue; }
      const next = Object.assign({}, isObj(out[part][id]) ? out[part][id] : {});
      for (const [k, x] of Object.entries(v)) {
        if (x === null) delete next[k];
        else next[k] = x;
      }
      if (Object.keys(next).length) out[part][id] = next;
      else delete out[part][id];
    }
  }
  return out;
}

/**
 * createPluginApi(deps) -> { handle(req, res, url) → Promise<boolean>, context(card) → Promise<ctx> }
 *   host                 server/plugins.js createPluginHost
 *   runs                 server/runs.js createRuns
 *   checks               server/checks.js createChecks
 *   stateDir, workspace  where the overlay lives; the workspace root commands default to
 *   board()              the live board
 *   findCard(id)         a live card
 *   publicCard(card)     the card as served (derived status), what cardContext reads
 *   listHarnesses()      harness/port.js
 *   pluginsVersion()     the counter reload bumps
 *   reload()             re-read the catalog and everything built from it (async)
 *   profilesKey()        which profile contributions the catalog enables NOW (a string)
 *   profilesAtBoot       the same, as it was when the profiles were registered
 *   sendJson, readBody, sseFrame, SSE_HEADERS, mime  the server's own plumbing
 *   log(msg)
 */
function createPluginApi(deps) {
  const { host, runs, checks, sendJson, readBody, sseFrame, SSE_HEADERS } = deps;
  const log = deps.log || ((m) => console.error(m));

  function catalog() { return host.catalog() || { plugins: [], overlay: { plugins: {}, contributions: {} } }; }
  function contributions() { return manifests.contributions(catalog()); }
  function pluginEntry(id) { return catalog().plugins.find((p) => p.id === id) || null; }

  async function context(card) {
    const { cardContext } = await loadCardview();
    const b = deps.board();
    return cardContext(deps.publicCard(card), { workers: b.workers, projects: b.projects });
  }

  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return { __bad: 'body is not valid JSON' }; }
  }

  // ---------- GET /api/plugins ----------
  function listing() {
    const cat = catalog();
    const status = new Map(host.status().map((s) => [s.id, s]));
    const c = contributions();
    const plugins = cat.plugins.map((p) => {
      const s = status.get(p.id) || {};
      const out = {
        id: p.id, name: p.name, description: p.description, version: p.version, source: p.source,
        enabled: !!p.enabled, error: p.error || s.error || null, active: !!s.active,
        config: p.config || {}, configSchema: (p.manifest && p.manifest.config) || {},
      };
      if (p.ui && p.enabled && !p.error) out.ui = '/plugins/' + p.id + '/' + p.ui;
      return out;
    });
    const disabled = Object.entries(cat.overlay.contributions || {})
      .filter(([, v]) => isObj(v) && v.enabled === false).map(([k]) => k).sort();
    return {
      plugins,
      contributions: {
        commands: c.commands.map(publicCommand), menus: c.menus, badges: c.badges,
        views: c.views, sections: c.sections, checks: c.checks.map(publicCheck),
      },
      harnesses: deps.listHarnesses(),
      disabled,
      pluginsVersion: deps.pluginsVersion(),
    };
  }

  // ---------- PUT /api/plugins/overlay ----------
  async function putOverlay(req, res) {
    const body = await readJson(req);
    if (body.__bad) return sendJson(res, 400, { error: body.__bad });
    const bad = badOverlay(body);
    if (bad) return sendJson(res, 400, { error: bad });
    const next = mergeOverlay(manifests.readOverlay(deps.stateDir, log), body);
    // Config is validated against the plugin's own schema: a value the plugin
    // never declared is a typo that would otherwise sit in the file, ignored.
    const { validateValues } = await loadPure();
    for (const [id, v] of Object.entries(next.plugins)) {
      const p = pluginEntry(id);
      if (!p || !p.manifest || !isObj(v.config)) continue;
      for (const k of Object.keys(v.config)) {
        if (!(k in p.manifest.config)) return sendJson(res, 400, { error: 'plugin ' + id + ' has no config field "' + k + '"' });
      }
      const checked = validateValues(p.manifest.config, Object.assign({}, p.config, v.config));
      if (checked.error) return sendJson(res, 400, { error: 'plugin ' + id + ' config: ' + checked.error, field: checked.field });
    }
    fs.mkdirSync(deps.stateDir, { recursive: true });
    manifests.writeOverlay(deps.stateDir, next);
    await deps.reload();
    // Profiles are harness registrations made once at boot; a toggle that
    // changes them only takes effect on the next start.
    return sendJson(res, 200, { ok: true, overlay: next, pluginsVersion: deps.pluginsVersion(),
      restartNeeded: deps.profilesKey() !== deps.profilesAtBoot });
  }

  // ---------- commands ----------
  function commandOf(id) { return contributions().commands.find((c) => c.id === id) || null; }

  async function cardFor(body) {
    const id = String(body.card || '').trim();
    if (!id) return { error: 'card required', code: 400 };
    const card = deps.findCard(id);
    if (!card) return { error: 'unknown card: ' + id, code: 404 };
    return { card, ctx: await context(card) };
  }

  // A plugin sees a copy: its handler cannot write into the board by accident.
  function reqFor(card, ctx, input, command) {
    const p = pluginEntry(command.plugin);
    return { card: structuredClone(deps.publicCard(card)), context: ctx, input, config: Object.assign({}, (p && p.config) || {}) };
  }

  async function prepare(id, req, res) {
    const command = commandOf(id);
    if (!command) return sendJson(res, 404, { error: 'unknown command: ' + id });
    const body = await readJson(req);
    if (body.__bad) return sendJson(res, 400, { error: body.__bad });
    const c = await cardFor(body);
    if (c.error) return sendJson(res, c.code, { error: c.error });
    const { defaultsFor } = await loadPure();
    let values = defaultsFor(command.form || {});
    if (command.prepare === 'server') {
      const h = await host.handler(id);
      if (h && h.prepare) {
        try {
          const got = await h.prepare(reqFor(c.card, c.ctx, {}, command));
          values = defaultsFor(command.form || {}, Object.assign({}, values, isObj(got) ? got : {}));
        } catch (e) {
          log('plugin ' + command.plugin + ': prepare of ' + id + ' failed: ' + errText(e));
          return sendJson(res, 500, { error: 'plugin ' + command.plugin + ' failed to prepare ' + id + ': ' + errText(e) });
        }
      }
    }
    return sendJson(res, 200, { values });
  }

  // Every menu entry that places this command; none = a palette-only command,
  // which asked for no card shape and so fits any card.
  async function allowed(id, ctx) {
    const { matches } = await loadPure();
    const entries = Object.values(contributions().menus).flat().filter((e) => e.command === id);
    if (!entries.length) return true;
    return entries.some((e) => { try { return matches(e.when, ctx); } catch (err) { return false; } });
  }

  async function run(id, req, res) {
    const command = commandOf(id);
    if (!command) return sendJson(res, 404, { error: 'unknown command: ' + id });
    const body = await readJson(req);
    if (body.__bad) return sendJson(res, 400, { error: body.__bad });
    const c = await cardFor(body);
    if (c.error) return sendJson(res, c.code, { error: c.error });
    if (!(await allowed(id, c.ctx))) {
      return sendJson(res, 403, { error: 'command ' + id + ' does not apply to card ' + c.card.id + ' (no menu entry of it matches the card)' });
    }
    const p = pluginEntry(command.plugin);
    const plan = await planRun(command, { context: c.ctx, input: body.input, config: (p && p.config) || {}, workspace: deps.workspace, pluginDir: p && p.dir });
    if (plan.error) {
      const out = { error: plan.error };
      if (plan.field) out.field = plan.field;
      if (plan.missing && plan.missing.length) out.missing = plan.missing;
      return sendJson(res, plan.code || 400, out);
    }
    if (plan.kind === 'open') return sendJson(res, 200, { ok: true, url: plan.url });
    if (plan.kind === 'server') {
      const h = await host.handler(id);
      if (!h || !h.run) return sendJson(res, 501, { error: 'plugin ' + command.plugin + ' has no server handler for ' + id });
      try {
        const out = await h.run(reqFor(c.card, c.ctx, plan.input, command));
        const r = { ok: !(isObj(out) && out.ok === false) };
        if (isObj(out) && typeof out.message === 'string') r.message = out.message;
        return sendJson(res, 200, r);
      } catch (e) {
        log('plugin ' + command.plugin + ': run of ' + id + ' failed: ' + errText(e));
        return sendJson(res, 500, { error: 'plugin ' + command.plugin + ' failed to run ' + id + ': ' + errText(e) });
      }
    }
    let started;
    try {
      started = runs.start({
        plugin: command.plugin, command: id, title: command.title, card: c.card.id, owner: c.card.owner,
        shell: plan.shell, cwd: plan.cwd, env: plan.env, timeoutMs: plan.timeoutMs, tracked: plan.tracked,
      });
    } catch (e) { return sendJson(res, 500, { error: errText(e) }); }
    if (deps.onRunStarted) deps.onRunStarted(started, plan.tracked);
    // An untracked run is fire-and-forget: the answer names it, the board never lists it.
    return sendJson(res, 200, plan.tracked ? { ok: true, activity: started } : { ok: true, activity: null, run: started });
  }

  // ---------- activities ----------
  function stream(id, req, res, url) {
    const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
    const first = runs.readLog(id, { from });
    if (!first) return sendJson(res, 404, { error: 'unknown activity: ' + id });
    res.writeHead(200, SSE_HEADERS);
    // What is already in the log, then the live tail. Both reads are sync, so
    // no chunk can land between them and be lost or doubled.
    if (first.text) res.write(sseFrame('chunk', { text: first.text }));
    let closed = false;
    const finish = (run) => {
      if (closed) return;
      closed = true;
      res.write(sseFrame('end', run || runs.get(id) || { id }));
      res.end();
    };
    const off = runs.subscribe(id, (text) => { if (!closed) res.write(sseFrame('chunk', { text })); }, finish);
    // A log with no run behind it (a restart forgot the process) is already over.
    if (!closed && !runs.get(id)) finish(null);
    req.on('close', () => { closed = true; off(); });
  }

  // ---------- /plugins/<id>/<file> ----------
  function serveUi(id, rel, res) {
    const p = pluginEntry(id);
    if (!p || !p.enabled || p.error || !p.ui) return sendJson(res, 404, { error: 'not found' });
    let file;
    try { file = decodeURIComponent(rel); } catch (e) { return sendJson(res, 400, { error: 'bad path' }); }
    const parts = file.split(/[\\/]/);
    if (path.isAbsolute(file) || parts.includes('..') || parts.includes('') || file.includes('\0')) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const norm = parts.join('/');
    // The browser half and its own folder, nothing else: server.js and
    // plugin.json sit in the same directory and are not the browser's business.
    if (norm !== p.ui.replace(/^\.\//, '') && !norm.startsWith('ui/')) return sendJson(res, 404, { error: 'not found' });
    const abs = path.join(p.dir, norm);
    let real;
    try { real = fs.realpathSync(abs); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    let root;
    try { root = fs.realpathSync(p.dir); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    // A symlink out of the plugin folder is a way out of it.
    if (!real.startsWith(root + path.sep)) return sendJson(res, 404, { error: 'not found' });
    let data;
    try {
      if (!fs.statSync(real).isFile()) return sendJson(res, 404, { error: 'not found' });
      data = fs.readFileSync(real);
    } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    const ext = path.extname(real).toLowerCase();
    const type = ext === '.js' || ext === '.mjs' ? JS_MIME : (deps.mime[ext] || 'application/octet-stream');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  }

  // ---------- /api/x/<plugin>/<subpath> ----------
  async function pluginRoute(pluginId, subpath, req, res) {
    const fn = await host.route(pluginId, req.method, subpath);
    if (!fn) return sendJson(res, 404, { error: 'no route ' + req.method + ' /api/x/' + pluginId + '/' + subpath });
    const raw = await readBody(req);
    let body = raw;
    if (raw) { try { body = JSON.parse(raw); } catch (e) { /* not JSON: the plugin gets the text */ } }
    else body = null;
    try {
      const out = await fn(req, res, body);
      // A handler that answered itself is done; one that returned a value gets it as JSON.
      if (!res.headersSent && !res.writableEnded) {
        if (out === undefined) { res.writeHead(204); res.end(); }
        else sendJson(res, 200, out);
      }
    } catch (e) {
      log('plugin ' + pluginId + ': route ' + req.method + ' ' + subpath + ' failed: ' + errText(e));
      if (!res.headersSent) sendJson(res, 500, { error: 'plugin ' + pluginId + ' failed: ' + errText(e) });
      else if (!res.writableEnded) res.end();
    }
  }

  /** Route one request. -> Promise<boolean>: false = not a plugin route, keep looking. */
  async function handle(req, res, url) {
    const p = url.pathname;
    const route = req.method + ' ' + p;
    if (route === 'GET /api/plugins') { sendJson(res, 200, listing()); return true; }
    if (route === 'PUT /api/plugins/overlay') { await putOverlay(req, res); return true; }
    let m = COMMAND_RE.exec(p);
    if (m && req.method === 'POST') {
      let id;
      try { id = decodeURIComponent(m[1]); } catch (e) { sendJson(res, 400, { error: 'bad command id' }); return true; }
      if (m[2] === 'prepare') await prepare(id, req, res);
      else await run(id, req, res);
      return true;
    }
    if (route === 'GET /api/activities') {
      const card = url.searchParams.get('card') || '';
      const limit = parseInt(url.searchParams.get('limit') || '0', 10) || 30;
      sendJson(res, 200, { activities: runs.list({ card, limit }) });
      return true;
    }
    m = ACTIVITY_RE.exec(p);
    if (m) {
      const id = m[1];
      if (m[2] === 'log' && req.method === 'GET') {
        const r = runs.readLog(id, { from: url.searchParams.get('from') || 0 });
        if (!r) sendJson(res, 404, { error: 'unknown activity: ' + id });
        else sendJson(res, 200, r);
        return true;
      }
      if (m[2] === 'stream' && req.method === 'GET') { stream(id, req, res, url); return true; }
      if (m[2] === 'cancel' && req.method === 'POST') {
        if (!runs.get(id)) sendJson(res, 404, { error: 'unknown activity: ' + id });
        else sendJson(res, 200, { ok: runs.cancel(id) });
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === 'GET /api/checks') {
      const phase = url.searchParams.get('phase') || undefined;
      if (phase !== undefined && !manifests.CHECK_PHASES.includes(phase)) {
        sendJson(res, 400, { error: 'phase must be one of ' + manifests.CHECK_PHASES.join('|') });
        return true;
      }
      sendJson(res, 200, { checks: await checks.run(phase) });
      return true;
    }
    m = X_RE.exec(p);
    if (m) { await pluginRoute(m[1], m[2] || '', req, res); return true; }
    m = STATIC_RE.exec(p);
    if (m && req.method === 'GET') { serveUi(m[1], m[2], res); return true; }
    return false;
  }

  return { handle, context };
}

module.exports = { createPluginApi, badOverlay, mergeOverlay, publicCommand };
