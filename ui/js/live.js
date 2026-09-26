// live.js — the board's SSE stream, shared by the flat board and the 3D room.
//
// A half-open connection after a server restart can sit silent forever without
// ever firing onerror, leaving a zombie tab. Two defenses:
//  - staleness watchdog: the server emits a named `ping` every 25s, so >STALE_MS
//    of total silence means the stream is dead — tear it down and reconnect;
//  - boot-id: the board payload carries the server instance id, so a restart is
//    detected even on a fast auto-retry reconnect.
// Every (re)open also refetches the full board: events missed while stale are
// gone for good, and the refetch is what heals the tab.
import { S, applyBoard, onBoard } from './state.js';
import { api } from './api.js';

const STALE_MS = 40000;
let serverBoot = null;
// Recorded on every doc, whichever path brought it in (SSE, refetch, chat echo).
onBoard((doc) => { serverBoot = doc.boot || serverBoot; });

function refetchBoard() {
  api.board().then(applyBoard).catch(() => {}); // still down — the watchdog retries
}

/**
 * Open the board stream and keep it alive. Every board document goes through
 * applyBoard. onConnection(on) runs whenever S.connected flips; onArtifact(ev)
 * receives the SSE `artifact` events (an artifact written through the board).
 */
export function startLive({ onConnection = () => {}, onArtifact = null } = {}) {
  let es = null;
  let lastEventAt = Date.now();
  const setConnected = (on) => { S.connected = on; onConnection(on); };
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('board', (e) => {
      lastEventAt = Date.now();
      const doc = JSON.parse(e.data);
      const restarted = serverBoot && doc.boot && doc.boot !== serverBoot;
      applyBoard(doc);
      if (restarted) refetchBoard(); // new server instance — make sure we hold its current state
    });
    // Not a board payload: no re-render, nothing else reacts.
    es.addEventListener('artifact', (e) => {
      lastEventAt = Date.now();
      if (onArtifact) try { onArtifact(JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener('ping', () => { lastEventAt = Date.now(); });
    es.onopen = () => {
      lastEventAt = Date.now();
      setConnected(true);
      refetchBoard(); // anything pushed while we were away is unrecoverable — resync
    };
    es.onerror = () => setConnected(false);
  }
  connect();
  setInterval(() => {
    if (Date.now() - lastEventAt <= STALE_MS) return;
    lastEventAt = Date.now(); // one reconnect per stale window
    setConnected(false);
    connect();
  }, 5000);
}
