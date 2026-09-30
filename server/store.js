'use strict';
// store — the board in memory, the board on disk, and the ONE door a change
// goes through: mutate, save once, announce once.
//
//   board.json   the canonical state; written whole, temp file + rename
//
// A change is `mutate(fn)`: fn runs against the live board and returns a domain
// result. `{error}` means it refused, and a refusal must leave nothing behind —
// the domain functions validate every field before they touch the board, so a
// refusal here writes nothing and announces nothing. There is no rollback and no
// deep clone: the board is large and validate-first already holds the line.
// Anything else is saved once and announced once.
//
// The announcement (the full board pushed over SSE) is coalesced: every change
// in one tick of the event loop costs ONE rebuild of the served board, not one
// per change — a supervision pass or a hook burst used to push it N times.
//
// The store also mints events: it owns the board's seq, so every timeline entry
// and the "a card changed" stamp that goes with it are made here.
//
// Node built-ins only.
const fs = require('fs');

/**
 * Open the board's store. Nothing is read until load().
 * @param {object} deps
 * @param {string} deps.file board.json path
 * @param {(doc: object) => object} deps.normalize repairs a parsed board.json
 * @param {() => object} deps.fresh the empty board (no file, or an unreadable one)
 * @param {(board: object) => object} [deps.serialize] what lands on disk (default: the board)
 * @param {() => Object<string, {emoji: string, level: number}>} deps.kinds the effective kinds map
 * @param {() => void} deps.publish push the board to every connected client
 * @param {() => string} deps.now ISO timestamp
 * @param {(fn: () => void) => void} [deps.defer] when a coalesced publish runs (default setImmediate)
 * @param {(msg: string) => void} [deps.log]
 */
function createStore(deps) {
  const serialize = deps.serialize || ((b) => b);
  const defer = deps.defer || setImmediate;
  const log = deps.log || ((m) => console.error(m));
  let board = null;
  let publishing = false;

  /** Read board.json into memory (normalized), or start fresh. -> the live board */
  function load() {
    try { board = deps.normalize(JSON.parse(fs.readFileSync(deps.file, 'utf8'))); }
    catch (e) { board = deps.fresh(); }
    return board;
  }

  /** Write the board to disk, atomically: a crash mid-write leaves the old file whole. */
  function save() {
    board.updated = deps.now();
    const tmp = deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(serialize(board), null, 2));
    fs.renameSync(tmp, deps.file);
  }

  /** Schedule one board push; every call before it runs rides the same push. */
  function broadcast() {
    if (publishing) return;
    publishing = true;
    defer(() => {
      publishing = false; // before the push: a change made while it runs gets its own
      // Off the request's stack now, so a throw here would take the process down.
      try { deps.publish(); } catch (e) { log('board broadcast failed: ' + String((e && e.message) || e)); }
    });
  }

  /** Save now, announce once — for a change already made to the live board. */
  function commit() {
    save();
    broadcast();
  }

  /**
   * The door for a change: run fn(board); a `{error}` result is a refusal and
   * writes nothing, anything else is committed. A promise from fn is awaited.
   * A throw propagates and writes nothing.
   * @param {(board: object) => any} fn
   * @returns {any|Promise<any>} fn's result
   */
  function mutate(fn) {
    const settle = (r) => {
      if (!(r && r.error)) commit();
      return r;
    };
    const r = fn(board);
    return r && typeof r.then === 'function' ? r.then(settle) : settle(r);
  }

  /**
   * Mint a timeline entry (not yet placed anywhere). Level: an explicit 1|2
   * wins, else the kind's level from the effective map, else the caller's
   * default, else 2. A kind in no map is kept as an opaque token.
   * @param {object} body {text, actor?, kind?, level?}
   * @param {object} [defaults] {kind?, level?, actor?}
   * @returns {{seq, ts, level, text, actor, kind?}}
   */
  function event(body, defaults) {
    const d = defaults || {};
    const kindRaw = body.kind == null ? '' : String(body.kind).trim();
    const kind = kindRaw ? kindRaw.slice(0, 60) : (d.kind || null);
    const known = kind ? deps.kinds()[kind] : null;
    const level = body.level === 2 ? 2 : body.level === 1 ? 1
      : known ? known.level
      : (d.level === 1 || d.level === 2 ? d.level : 2);
    const ev = {
      seq: ++board.seq, ts: deps.now(), level,
      text: String(body.text || '').slice(0, 2000),
      actor: String(body.actor || d.actor || 'agent').slice(0, 60),
    };
    if (kind) ev.kind = kind;
    return ev;
  }

  /** Put an already-minted event on a card's timeline and mark the card changed. */
  function pushCardEvent(card, ev) {
    card.events.push(ev);
    card.updated = deps.now();
    return ev;
  }

  /** Mint an event onto a card's timeline (see event()). -> the event */
  function cardEvent(card, fields, defaults) {
    return pushCardEvent(card, event(fields, defaults));
  }

  /** Mint an event onto the board-level stream (see event()). -> the event */
  function boardEvent(fields, defaults) {
    const ev = event(fields, defaults);
    board.events.push(ev);
    return ev;
  }

  return {
    load, board: () => board, save, broadcast, commit, mutate,
    event, cardEvent, pushCardEvent, boardEvent,
  };
}

module.exports = { createStore };
