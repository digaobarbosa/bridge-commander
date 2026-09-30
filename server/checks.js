'use strict';
// checks — "is this machine ready?" questions, asked at a phase (init, boot,
// card-start) and answered {ok, message, fix}. Plugins declare them in
// plugin.json (a binary on PATH, or a shell command) or register them in code;
// `bc-axi init` and the board's health panel only ever read run(phase).
//
// Node built-ins only.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const SEVERITIES = ['error', 'warn'];
const EXEC_TIMEOUT_MS = 10000;

/**
 * which(name, env?) -> absolute path | null. A pure PATH scan: the `which`
 * binary is itself not guaranteed (minimal containers), and a check that needs
 * one binary to look for another would fail for the wrong reason.
 */
function which(name, env = process.env) {
  if (typeof name !== 'string' || !name) return null;
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat([''])
    : [''];
  const isExe = (f) => {
    try {
      if (!fs.statSync(f).isFile()) return false;
      fs.accessSync(f, fs.constants.X_OK);
      return true;
    } catch (e) { return false; }
  };
  if (name.includes('/') || name.includes(path.sep)) {
    const f = path.resolve(name);
    return isExe(f) ? f : null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      if (isExe(f)) return f;
    }
  }
  return null;
}

/** exec(cmd, {cwd, timeout}) -> {code, stdout, stderr, timedOut}. Never rejects. */
function shExec(cmd, { cwd, timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile('/bin/sh', ['-c', cmd], { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      const timedOut = !!(err && err.killed);
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      // A spawn failure (a missing cwd) has no output of its own; say why.
      const spawnErr = err && typeof err.code !== 'number' && !timedOut ? String(err.message) : '';
      resolve({ code, stdout: stdout || '', stderr: stderr || spawnErr, timedOut });
    });
  });
}

function firstLine(...texts) {
  for (const t of texts) {
    const line = String(t || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line) return line;
  }
  return '';
}

/**
 * createChecks(deps) -> { register, fromManifest, run }
 *   log(msg)                  where a check that throws is reported
 *   which(name)               -> path | null (default: the PATH scan above)
 *   exec(cmd, {cwd, timeout}) -> {code, stdout, stderr, timedOut}
 *   timeoutMs                 a check that has not answered by then fails
 *
 * register({id, plugin, phase, title, severity, run}) -> dispose()
 *   run() -> {ok, message?, fix?} (sync or async)
 * run(phase?) -> [{id, plugin, title, severity, ok, message, fix, ms}]
 *   every check of the phase (all of them when omitted), in parallel.
 */
function createChecks({
  log = (msg) => console.error(msg), which: whichDep = which, exec = shExec, timeoutMs = 15000,
} = {}) {
  const all = new Map(); // plugin/id -> registration

  function register(reg) {
    const { id, plugin = '', phase = 'boot', title, severity = 'warn', run } = reg || {};
    if (typeof id !== 'string' || !id) throw new Error('check id required');
    if (typeof run !== 'function') throw new Error('check ' + id + ': run must be a function');
    if (!SEVERITIES.includes(severity)) throw new Error('check ' + id + ': severity must be ' + SEVERITIES.join('|'));
    // Keyed by plugin as well: two plugins may each ship a check named "gh".
    const key = plugin + '/' + id;
    if (all.has(key)) throw new Error('check ' + key + ' is already registered');
    const r = { id, plugin, phase, title: title || id, severity, run };
    all.set(key, r);
    return function dispose() { if (all.get(key) === r) all.delete(key); };
  }

  // A manifest check is data: `bin` (found on PATH) or `exec` (a shell command
  // run in the plugin's folder: exit 0 = ok, first output line = message).
  function fromManifest(check, { plugin, dir } = {}) {
    const hint = check.hint || null;
    let run;
    if (check.bin) {
      run = () => {
        const found = whichDep(check.bin);
        return found
          ? { ok: true, message: check.bin + ' found at ' + found }
          : { ok: false, message: check.bin + ' not found on PATH', fix: hint };
      };
    } else {
      run = async () => {
        const out = await exec(check.exec, { cwd: dir, timeout: check.timeoutMs || EXEC_TIMEOUT_MS });
        const line = firstLine(out.stdout, out.stderr);
        if (out.code === 0) return { ok: true, message: line };
        const why = out.timedOut ? 'timed out' : 'exited ' + out.code;
        return { ok: false, message: line || why, fix: hint };
      };
    }
    return {
      id: check.id, plugin: plugin || check.plugin || '', phase: check.phase || 'boot',
      title: check.title || check.id, severity: check.severity || 'warn', run,
    };
  }

  async function runOne(r) {
    const t0 = Date.now();
    let res;
    let timer = null;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, message: 'no answer after ' + timeoutMs + 'ms' }), timeoutMs);
        if (timer.unref) timer.unref();
      });
      res = await Promise.race([Promise.resolve().then(() => r.run()), timeout]);
    } catch (e) {
      const msg = String((e && e.message) || e);
      try { log('check ' + r.plugin + '/' + r.id + ' threw: ' + msg); } catch (_) { /* keep going */ }
      res = { ok: false, message: msg };
    } finally {
      clearTimeout(timer);
    }
    res = res || {};
    return {
      id: r.id, plugin: r.plugin, title: r.title, severity: r.severity,
      ok: !!res.ok, message: res.message || '', fix: res.ok ? null : (res.fix || null), ms: Date.now() - t0,
    };
  }

  function run(phase) {
    const picked = [...all.values()].filter((r) => phase === undefined || r.phase === phase);
    return Promise.all(picked.map(runOne));
  }

  return { register, fromManifest, run };
}

module.exports = { createChecks, which, shExec };
