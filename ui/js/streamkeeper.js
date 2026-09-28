// streamkeeper.js — keep one EventSource alive, for the board stream and the 👁 pane.
//
// EventSource retries on its own only while it is CONNECTING. Two cases defeat that:
//  - CLOSED: a non-200 answer (a proxy's 502 while the server restarts) fails the
//    connection for good. We reopen it ourselves, with backoff.
//  - half-open: a proxy that never passes the close on leaves the stream silent and
//    fires no error. The server pings every 5 s, so longer silence means it is dead.
const CLOSED = 2; // EventSource.CLOSED — not a global under node, where the tests run

/** backoffMs(attempt) -> 1 s, 2 s, 4 s, 8 s, then 10 s for good. */
export function backoffMs(attempt) {
  return Math.min(10000, 1000 * 2 ** attempt);
}

/**
 * keepStream({ connect, staleMs, checkMs }) — call connect() now, and again whenever
 * the stream is CLOSED or stale. connect() builds the EventSource and wires its
 * listeners; each listener reports back:
 *   alive()   on every event (frame, board, ping…) — the stream is not stale;
 *   opened()  in onopen — the backoff starts over;
 *   error(es) in onerror — reopens with backoff when es is CLOSED.
 * stop() ends every timer; nothing reconnects after it.
 */
export function keepStream({ connect, staleMs, checkMs = 1000 }) {
  let attempt = 0;
  let lastAt = Date.now();
  let retry = null;
  let stopped = false;

  function reconnect() {
    clearTimeout(retry);
    retry = null;
    lastAt = Date.now(); // one reconnect per stale window
    connect();
  }
  const watchdog = setInterval(() => {
    if (!stopped && Date.now() - lastAt > staleMs) reconnect();
  }, checkMs);
  connect();

  return {
    alive() { lastAt = Date.now(); },
    opened() { attempt = 0; lastAt = Date.now(); },
    error(es) {
      if (stopped || retry || !es || es.readyState !== CLOSED) return;
      retry = setTimeout(() => { retry = null; if (!stopped) reconnect(); }, backoffMs(attempt++));
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
    },
  };
}
