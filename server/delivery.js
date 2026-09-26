'use strict';
// The delivery engine: one durable queue per lieutenant under ONE global seq,
// its two cursors, the coalesced wake, and the owed projection the board shows.
//
//   <dir>/<lt>.jsonl    the queue, append-only; the write-ahead truth
//   <dir>/<lt>.ack      committed cursor: items <= it are handled (only ack removes)
//   <dir>/<lt>.drained  highest seq a drain SERVED; feeds queued/seen, never gates delivery
//
// At-least-once: drain serves everything past the ack cursor and never moves it.
// The server is the only writer, so the files are read once at boot and an
// in-memory index answers every read after that. Each write lands on disk
// before the index moves.
const fs = require('fs');
const path = require('path');
const { readJsonl, sealJsonl } = require('./jsonl.js');

// Items are serialized with `seq` first, so even a torn line names its seq.
const TORN_SEQ = /^\{"seq":(\d+)/;

function wakeLine(n) { return '[bridge-commander] ' + n + ' pending item(s) — run: bc-axi drain'; }

/**
 * Open the delivery engine over a queue directory (read once, here).
 * @param {object} o
 * @param {string} o.dir queue directory
 * @param {(lt: string, text: string) => (Promise<any>|false)} o.send types a wake line
 *   into the lieutenant's session; `false` = it has no session to wake.
 * @param {() => number} [o.clock] epoch ms
 * @param {number} [o.wakeTtlMs] a wake older than this no longer holds back the next one
 * @param {(msg: string) => void} [o.log]
 */
function createDelivery({ dir, send, clock = Date.now, wakeTtlMs = 90000, log = (m) => console.error(m) }) {
  const queues = new Map(); // lt -> { ack, drained, items } — items = pending only (seq > ack)
  const latestMsg = new Map(); // target -> { seq, lt } of its latest kind:'message' delivery
  const nudged = new Map(); // lt -> epoch ms of the last wake sent since its last drain/ack
  let head = 0;

  const file = (lt, ext) => path.join(dir, lt + ext);
  const bump = (seq) => { if (seq > head) head = seq; };
  function queue(lt) {
    let q = queues.get(lt);
    if (!q) { q = { ack: 0, drained: 0, items: [] }; queues.set(lt, q); }
    return q;
  }
  function readCursor(lt, ext) {
    try { return parseInt(fs.readFileSync(file(lt, ext), 'utf8'), 10) || 0; } catch (e) { return 0; }
  }
  function index(lt, it) {
    bump(it.seq);
    if (it.kind === 'message' && it.target) {
      const cur = latestMsg.get(it.target);
      if (!cur || it.seq > cur.seq) latestMsg.set(it.target, { seq: it.seq, lt });
    }
    const q = queue(lt);
    if (it.seq > q.ack) q.items.push(it);
  }

  // Boot. head also counts torn seqs and cursors: a reissued seq at or below an
  // ack cursor would read as already handled and never be served.
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { /* no queues yet */ }
  const ids = new Set();
  for (const f of names) { const m = /^(.+)\.(jsonl|ack|drained)$/.exec(f); if (m) ids.add(m[1]); }
  for (const lt of ids) {
    const q = queue(lt);
    q.ack = readCursor(lt, '.ack');
    q.drained = readCursor(lt, '.drained');
    bump(q.ack);
    bump(q.drained);
    sealJsonl(file(lt, '.jsonl'));
    let torn = 0;
    const items = readJsonl(file(lt, '.jsonl'), (line) => {
      torn++;
      const m = TORN_SEQ.exec(line);
      if (m) bump(Number(m[1]));
    });
    for (const it of items) if (it && Number.isInteger(it.seq)) index(lt, it);
    if (torn) log('[bridge-commander] queue ' + lt + ': skipped ' + torn + ' torn line(s)');
  }

  /**
   * Append one QueueItem (write-ahead), then wake its lieutenant.
   * @returns {object} the item, with its seq
   */
  function push(lt, rec) {
    const item = Object.assign({ seq: head + 1, ts: new Date(clock()).toISOString(), lieutenant: lt }, rec);
    fs.appendFileSync(file(lt, '.jsonl'), JSON.stringify(item) + '\n');
    index(lt, item);
    nudge(lt);
    return item;
  }

  /**
   * Unacked items of one lieutenant, or of every queue (seq-ordered) with no lt.
   * @returns {object[]}
   */
  function pending(lt) {
    if (lt) { const q = queues.get(lt); return q ? q.items.slice() : []; }
    const all = [];
    for (const q of queues.values()) all.push(...q.items);
    return all.sort((a, b) => a.seq - b.seq);
  }

  /**
   * A lieutenant's drain: its pending items. It re-arms the wake and moves the
   * drained cursor (seen), never the ack cursor.
   * @returns {{items: object[], seen: boolean}} seen = the drained cursor moved
   */
  function drain(lt) {
    nudged.delete(lt);
    const items = pending(lt);
    const last = items.length ? items[items.length - 1].seq : 0;
    const q = queues.get(lt);
    if (!q || last <= q.drained) return { items, seen: false };
    fs.writeFileSync(file(lt, '.drained'), String(last));
    q.drained = last;
    return { items, seen: true };
  }

  // Which queue holds seq. An acked seq is no longer in memory; a re-ack of one
  // is rare enough to pay for a file scan.
  function holder(seq) {
    if (seq < 1 || seq > head) return null;
    for (const [lt, q] of queues) if (q.items.some((it) => it.seq === seq)) return lt;
    for (const lt of queues.keys()) if (readJsonl(file(lt, '.jsonl')).some((it) => it && it.seq === seq)) return lt;
    return null;
  }

  /**
   * Commit lt's cursor to seq: every item <= seq in lt's queue is handled.
   * The seq must be in lt's own queue. Re-acking an older seq is a no-op.
   * @returns {{ok: true, lieutenant: string, ack: number}|{error: string, code: number}}
   */
  function ack(lt, seq) {
    const owner = holder(seq);
    if (!owner) return { error: 'unknown seq: ' + seq, code: 400 };
    if (owner !== lt) return { error: 'seq ' + seq + ' is not in your queue (belongs to ' + owner + ')', code: 409 };
    const q = queue(lt);
    if (seq > q.ack) {
      fs.writeFileSync(file(lt, '.ack'), String(seq));
      q.ack = seq;
      q.items = q.items.filter((it) => it.seq > seq);
    }
    nudged.delete(lt); // handled: a fresh append wakes anew
    return { ok: true, lieutenant: lt, ack: q.ack };
  }

  /**
   * Wake lt once for its pending items. Coalesced: no second wake while one
   * sent less than wakeTtlMs ago is outstanding — "sent" is not "delivered",
   * so an old one no longer holds the next back. A failed send re-arms.
   * @returns {boolean} true when a wake went out
   */
  function nudge(lt) {
    const n = pending(lt).length;
    if (!n) return false;
    const last = nudged.get(lt);
    if (last !== undefined && clock() - last <= wakeTtlMs) return false;
    let sent;
    try { sent = send(lt, wakeLine(n)); } catch (e) { sent = Promise.reject(e); }
    if (sent === false) return false;
    const at = clock();
    nudged.set(lt, at);
    Promise.resolve(sent).catch(() => { if (nudged.get(lt) === at) nudged.delete(lt); });
    return true;
  }

  /** Forget the last wake: a new session owes a drain; its predecessor's memory is gone. */
  function resetNudge(lt) { nudged.delete(lt); }

  /** Retire: delete lt's queue and cursors, on disk and in memory. */
  function forget(lt) {
    for (const ext of ['.jsonl', '.ack', '.drained']) {
      try { fs.unlinkSync(file(lt, ext)); } catch (e) { /* none */ }
    }
    queues.delete(lt);
    nudged.delete(lt);
    for (const [target, m] of latestMsg) if (m.lt === lt) latestMsg.delete(target);
  }

  /**
   * Is the latest captain message to target still owed a handling?
   * @param {string} target `lieutenant:<id>` or `card:<id>`
   * @returns {null|'queued'|'seen'} null = acked or never delivered; 'queued' =
   *   not drained yet; 'seen' = drained, not acked (the turn is underway)
   */
  function owed(target) {
    const m = latestMsg.get(target);
    const q = m && queues.get(m.lt);
    if (!q || m.seq <= q.ack) return null;
    return m.seq > q.drained ? 'queued' : 'seen';
  }

  return { push, pending, drain, ack, nudge, resetNudge, forget, owed, head: () => head };
}

module.exports = { createDelivery, wakeLine };
