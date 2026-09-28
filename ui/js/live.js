// live.js — the board's SSE stream, shared by the flat board and the 3D room.
//
// After a server restart the stream can be CLOSED for good (a proxy's 502) or
// sit half-open and silent. Two defenses:
//  - streamkeeper.js: reopen a CLOSED stream at once with backoff, and treat
//    >STALE_MS of silence as dead (the server pings every 5s);
//  - boot-id: the board payload carries the server instance id, so a restart is
//    detected even on a fast auto-retry reconnect.
// Every (re)open also refetches the full board: events missed while stale are
// gone for good, and the refetch is what heals the tab.
import { S, applyBoard, onBoard } from './state.js';
import { api } from './api.js';
import { keepStream } from './streamkeeper.js';

const STALE_MS = 12000; // the server's 5s ping + margin
let serverBoot = null;
// Recorded on every doc, whichever path brought it in (SSE, refetch, chat echo).
onBoard((doc) => { serverBoot = doc.boot || serverBoot; });

function refetchBoard() {
  api.board().then(applyBoard).catch(() => {}); // still down — the next reopen retries
}

/**
 * Open the board stream and keep it alive. Every board document goes through
 * applyBoard. onConnection(on) runs whenever S.connected flips; onArtifact(ev)
 * receives the SSE `artifact` events (an artifact written through the board).
 */
export function startLive({ onConnection = () => {}, onArtifact = null } = {}) {
  let es = null;
  let keeper = null;
  const setConnected = (on) => { S.connected = on; onConnection(on); };
  function connect() {
    if (es) es.close();
    if (keeper) setConnected(false); // a reopen: the old stream is gone
    es = new EventSource('/api/events');
    es.addEventListener('board', (e) => {
      keeper.alive();
      const doc = JSON.parse(e.data);
      const restarted = serverBoot && doc.boot && doc.boot !== serverBoot;
      applyBoard(doc);
      if (restarted) refetchBoard(); // new server instance — make sure we hold its current state
    });
    // Not a board payload: no re-render, nothing else reacts.
    es.addEventListener('artifact', (e) => {
      keeper.alive();
      if (onArtifact) try { onArtifact(JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener('ping', () => keeper.alive());
    es.onopen = () => {
      keeper.opened();
      setConnected(true);
      refetchBoard(); // anything pushed while we were away is unrecoverable — resync
    };
    const mine = es;
    es.onerror = () => { setConnected(false); keeper.error(mine); };
  }
  keeper = keepStream({ connect, staleMs: STALE_MS });
}
