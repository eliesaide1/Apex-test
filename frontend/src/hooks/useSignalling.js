import { useCallback, useEffect, useRef, useState } from "react";
import { proctorWsUrl } from "../api";

/** Keep-alive cadence. Matches the candidate's socket (see useLiveStream). */
const PING_MS = 25000;
/** Reconnect backoff ceiling, so a server restart can't cause a storm. */
const MAX_BACKOFF_MS = 15000;

/**
 * The proctor dashboard's signalling socket.
 *
 * One socket carries both the live flag feed and all WebRTC signalling, so when
 * it dies quietly everything downstream stalls with no visible error. Two things
 * kill it in practice: a proxy closing it for being idle (Render and most load
 * balancers do this after ~60s without a frame — and this socket can easily sit
 * silent that long, because the dashboard's own refresh is HTTP polling), and
 * ordinary network blips.
 *
 * The candidate's socket already pings and reconnects; this gives the proctor's
 * the same treatment, plus two things the old inline version lacked:
 *
 *   - **Outgoing messages are queued, not dropped.** The previous code guarded
 *     every send with `readyState === OPEN` and silently discarded anything
 *     else, so one dead socket left every later "watch this candidate" click
 *     hanging on "connecting…" with nothing logged and no way to recover.
 *   - **`generation` increments on each new connection**, so subscribers can
 *     re-bind their listeners to the new socket and re-issue whatever they were
 *     in the middle of. Listeners bound to the old socket would never fire again.
 *
 * `queue: false` marks a message whose sender re-issues it on reconnect anyway
 * (rtc-watch); queueing those too would deliver a duplicate on top of the
 * re-issue and start two overlapping negotiations.
 */
export function useSignalling(enabled, onEvent) {
  const wsRef = useRef(null);
  const queueRef = useRef([]);
  const [generation, setGeneration] = useState(0);
  const [connected, setConnected] = useState(false);
  // Kept current so the socket's handler always calls the latest callback
  // without having to tear the connection down and rebuild it.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const send = useCallback((msg, { queue = true } = {}) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    if (queue) queueRef.current.push(msg);
    return false;
  }, []);

  useEffect(() => {
    if (!enabled) {
      queueRef.current = [];
      return;
    }
    let closed = false, retry = null, ping = null, attempt = 0;

    const connect = () => {
      let ws;
      try {
        ws = new WebSocket(proctorWsUrl());
      } catch {
        retry = setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        for (const m of queueRef.current.splice(0)) {
          try { ws.send(JSON.stringify(m)); } catch { /* dropped on close */ }
        }
        // Announce the new socket last, so subscribers re-binding in response
        // are looking at a connection that is already open and drained.
        setGeneration((g) => g + 1);
      };
      ws.onmessage = (e) => onEventRef.current?.(e);
      ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
      ws.onclose = () => {
        clearInterval(ping);
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++));
      };

      // The server ignores any message without a known kind + session_id, so
      // this is purely to stop a proxy calling the connection idle.
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "ping" }));
      }, PING_MS);
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  return { wsRef, send, generation, connected };
}
