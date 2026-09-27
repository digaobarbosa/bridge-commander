'use strict';
// rfslot — the server half of "Run in rfslot": prefill the form with a slot the
// card may take. The run itself is the manifest's exec line; this file only
// answers `prepare`, so the modal opens on a usable slot instead of a blank.
//
// `rfslot ls` prints one line per slot:
//   slot2  container up    loaded: master   lease: free                 RAM: …  services: …
//   cloud digao-a  suspended  owner: digao  loaded: master  lease: expired (digao)  …
// A lease reads `free`, `expired (<owner>)` or `<owner> until <time>`. Only the
// first two are ours to take (the rfslot skill: a slot leased to someone else
// is theirs, even if it looks idle).
const childProcess = require('child_process');

const SERVICES_DEFAULT = 'emulators app';
const LS_TIMEOUT_MS = 20000; // ls runs `docker stats --no-stream`, which takes seconds

/** Every slot `rfslot ls` printed. -> [{slot, cloud, container, lease, takeable}] */
function parseLs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^slot(\d+)\s+container\s+(\S+)/.exec(line) || /^cloud\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    // The lease column is padded; it ends at the next run of two spaces or at the end of the line.
    const l = /\blease:\s+(.*?)(?:\s{2,}|$)/.exec(line);
    const lease = l ? l[1].trim() : '';
    out.push({
      slot: m[1], cloud: line.startsWith('cloud'), container: m[2], lease,
      takeable: /^(free|expired)\b/.test(lease),
    });
  }
  return out;
}

/**
 * The slot to offer: the first takeable one whose container is not down (a
 * `use` on a down local slot fails until `rfslot up`), else the first takeable
 * one at all. -> slot string, or '' when none.
 */
function pickSlot(slots) {
  const takeable = slots.filter((s) => s.takeable);
  const ready = takeable.find((s) => !(s.container === 'down' && !s.cloud));
  return (ready || takeable[0] || { slot: '' }).slot;
}

/** Run `rfslot ls`. -> Promise<{text} | {error}>; never rejects. */
function rfslotLs(execFile) {
  return new Promise((resolve) => {
    execFile('rfslot', ['ls'], { timeout: LS_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve({ error: err.code === 'ENOENT' ? 'rfslot is not on the server PATH' : String(err.message || err) });
      resolve({ text: String(stdout) });
    });
  });
}

/**
 * The prepare handler. `execFile` is injectable for tests. The answer is only
 * form values (the prepare contract has no message channel), so what went
 * wrong goes to the plugin log and the slot field stays empty for the captain.
 */
function makePrepare(log, execFile = childProcess.execFile) {
  return async function prepare() {
    const values = { services: SERVICES_DEFAULT };
    const r = await rfslotLs(execFile);
    if (r.error) { log('prepare: ' + r.error + '; the slot is left for the captain to fill'); return values; }
    const slot = pickSlot(parseLs(r.text));
    if (!slot) { log('prepare: no slot with a free or expired lease; the slot is left for the captain to fill'); return values; }
    values.slot = slot;
    return values;
  };
}

function activate(ctx) {
  ctx.commands.handle('rfslot.deploy', { prepare: makePrepare(ctx.log) });
}

module.exports = { activate, parseLs, pickSlot, makePrepare };
