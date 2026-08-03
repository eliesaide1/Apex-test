import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSessions, fetchAnswers, fetchFlags, dismissFlag, clearFlags,
  deleteSession, sendCandidateMessage, snapshotUrl,
  fetchRtcConfig,
  proctorLogin, getProctorToken, setProctorToken,
} from "../api";
import { useSignalling } from "../hooks/useSignalling";

const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

/** How long a negotiation may sit unfinished before we retry it. */
const NEGOTIATION_TIMEOUT_MS = 12000;
/** How many times to re-issue the watch request before reporting failure. */
const MAX_NEGOTIATION_RETRIES = 2;

/**
 * Watch and hear one candidate in real time, over WebRTC.
 *
 * Media flows peer-to-peer straight from the candidate's browser, so this is
 * sub-second for both video and audio — unlike the snapshot/clip pipeline,
 * which stays running underneath as the always-on layer that feeds the card
 * thumbnails, the mic meter and the talking detector for every candidate at
 * once, and as the fallback when a peer connection can't be established.
 *
 * `wsRef` is the dashboard's existing proctor socket, reused as the signalling
 * channel. Returns the live MediaStream plus a coarse connection state.
 */
function useLiveFeed(sessionId, wsRef, sendSignal, generation) {
  const [stream, setStream] = useState(null);
  const [state, setState] = useState("idle");   // idle|connecting|live|failed|unavailable
  const [stats, setStats] = useState(null);
  const [reason, setReason] = useState("");     // why it is not live, in words
  const pcRef = useRef(null);

  // Poll the browser's own WebRTC stats so picture quality and delay are
  // visible numbers rather than a matter of opinion. This is also what tells
  // you whether a poor picture is the network (low bitrate, loss, relayed) or
  // the far end simply not sending much.
  useEffect(() => {
    if (!sessionId) { setStats(null); return; }
    let last = null;
    const id = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      let report;
      try { report = await pc.getStats(); } catch { return; }
      const next = {};
      report.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          next.w = r.frameWidth; next.h = r.frameHeight;
          next.fps = r.framesPerSecond;
          next.videoBytes = r.bytesReceived;
          next.lost = r.packetsLost;
          next.recv = r.packetsReceived;
          next.jitterMs = r.jitterBufferDelay && r.jitterBufferEmittedCount
            ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 : null;
        }
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          next.audioBytes = r.bytesReceived;
        }
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
          next.rttMs = r.currentRoundTripTime != null
            ? r.currentRoundTripTime * 1000 : null;
          // candidate-pair carries IDs, not the types themselves — reading
          // r.localCandidateType directly just yields undefined.
          next.localType = report.get(r.localCandidateId)?.candidateType;
          next.remoteType = report.get(r.remoteCandidateId)?.candidateType;
        }
      });
      // Bitrate needs two samples.
      const totalBytes = (next.videoBytes || 0) + (next.audioBytes || 0);
      const now = Date.now();
      if (last && now > last.t) {
        next.kbps = Math.round(((totalBytes - last.bytes) * 8) / (now - last.t));
      }
      last = { t: now, bytes: totalBytes };
      // "relay" on either end means the media is going through a TURN server.
      next.relayed = next.localType === "relay" || next.remoteType === "relay";
      setStats(next);
    }, 1000);
    return () => clearInterval(id);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) { setStream(null); setState("idle"); setReason(""); return; }

    let closed = false;
    let pc = null;
    let attempt = 0;
    let watchdog = null;
    const pending = [];        // ICE that arrives before the remote description

    // Queued when the socket is down, so a reconnect delivers it rather than
    // the message vanishing. rtc-watch is the exception: this effect re-issues
    // it on every new socket generation, so queueing it too would start a
    // second, overlapping negotiation.
    const send = (msg, opts) => sendSignal({ ...msg, session_id: sessionId }, opts);

    const dropPeer = () => {
      try { pc?.close(); } catch { /* already closed */ }
      pc = null;
      pcRef.current = null;
      pending.length = 0;
      setStream(null);
    };

    // Nothing in WebRTC guarantees a stalled negotiation ever resolves, and the
    // old code set no deadline at all: one lost signalling message left this
    // view on "connecting…" indefinitely, with no retry and nothing said. Give
    // it a deadline, retry, then state plainly what failed.
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (closed || pc?.connectionState === "connected") return;
        if (attempt < MAX_NEGOTIATION_RETRIES) {
          attempt += 1;
          setReason(`no response yet — retrying (${attempt}/${MAX_NEGOTIATION_RETRIES})`);
          dropPeer();
          send({ kind: "rtc-watch" }, { queue: false });
          armWatchdog();
        } else {
          setState("failed");
          setReason("the candidate's browser never completed the connection");
        }
      }, NEGOTIATION_TIMEOUT_MS);
    };

    async function onOffer(msg) {
      const { iceServers } = await fetchRtcConfig().catch(() => ({ iceServers: [] }));
      pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      // Do NOT pre-add transceivers here. Applying the remote offer creates
      // them, already recvonly because we add no local tracks of our own — and
      // pre-adding produced a second, dead pair (getReceivers() showed four
      // entries for two tracks). The candidate never hears the proctor either
      // way: we never attach a track to send.

      const incoming = new MediaStream();
      pc.ontrack = (e) => {
        incoming.addTrack(e.track);
        setStream(incoming);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ kind: "rtc-ice", candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (!pc || closed) return;
        const s = pc.connectionState;
        if (s === "connected") {
          clearTimeout(watchdog);        // negotiation succeeded; stop retrying
          setState("live");
          setReason("");
        } else if (s === "failed") {
          setState("failed");
          setReason("no network path between the two browsers (ICE failed)");
        } else if (s === "disconnected") setState("connecting");
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      for (const c of pending.splice(0)) {
        await pc.addIceCandidate(c).catch(() => {});
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ kind: "rtc-answer", sdp: pc.localDescription.sdp });
    }

    const onMessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.session_id && msg.session_id !== sessionId) return;

      if (msg.kind === "rtc-offer") {
        setState("connecting");
        // Report what actually went wrong instead of a bare "failed" — a
        // rejected SDP and an unreachable peer used to look identical here.
        onOffer(msg).catch((err) => {
          setState("failed");
          setReason(`could not apply the candidate's offer: ${err?.message || err}`);
        });
      } else if (msg.kind === "rtc-ice" && msg.candidate) {
        if (pc && pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
        else pending.push(msg.candidate);
      } else if (msg.kind === "rtc-error") {
        // The candidate's browser failed to build or publish its offer. Without
        // this it simply never sent one and we waited out the clock.
        clearTimeout(watchdog);
        setState("failed");
        setReason(msg.detail ? `candidate side: ${msg.detail}` : "the candidate's browser could not start streaming");
      } else if (msg.kind === "rtc-unavailable") {
        clearTimeout(watchdog);
        setState("unavailable");
        setReason("the candidate's exam page is not connected");
      } else if (msg.kind === "rtc-ended") {
        clearTimeout(watchdog);
        setState("idle");
        setReason("");
        setStream(null);
      }
    };

    // Bind to the CURRENT socket. `generation` changes whenever the signalling
    // hook reconnects, which re-runs this effect so the listener follows the
    // new socket and the watch request is re-issued — previously the listener
    // stayed attached to a dead socket and nothing ever arrived again.
    const ws = wsRef.current;
    ws?.addEventListener("message", onMessage);
    setState("connecting");
    setReason("");
    attempt = 0;
    send({ kind: "rtc-watch" }, { queue: false });
    armWatchdog();

    return () => {
      closed = true;
      clearTimeout(watchdog);
      ws?.removeEventListener("message", onMessage);
      send({ kind: "rtc-stop" }, { queue: false });
      try { pcRef.current?.close(); } catch { /* already closed */ }
      pcRef.current = null;
      setStream(null);
      setState("idle");
      setReason("");
    };
  }, [sessionId, wsRef, sendSignal, generation]);

  return { stream, state, stats, reason };
}

/** One-line readout of what the live connection is actually delivering. */
function LiveStats({ stats, state }) {
  if (state !== "live" || !stats) return null;
  const loss = stats.recv
    ? ((stats.lost || 0) / (stats.recv + (stats.lost || 0)) * 100) : 0;
  return (
    <span className="live-stats">
      {stats.w ? `${stats.w}×${stats.h}` : "—"}
      {stats.fps != null && ` · ${Math.round(stats.fps)}fps`}
      {stats.kbps != null && ` · ${stats.kbps > 1000
        ? (stats.kbps / 1000).toFixed(1) + " Mbps" : stats.kbps + " kbps"}`}
      {stats.rttMs != null && ` · ${Math.round(stats.rttMs)}ms rtt`}
      {loss > 0.5 && <b className="bad"> · {loss.toFixed(1)}% loss</b>}
      {stats.relayed && <b className="relay"> · TURN relay</b>}
      {/* WebRTC's congestion controller probes upward from a low bitrate, so a
          fresh connection spends ~15s below full resolution. Say so, otherwise
          a picture that is still climbing reads as a broken one. */}
      {stats.w > 0 && stats.w < 1280 && <b className="ramp"> · sharpening…</b>}
    </span>
  );
}

/** Attaches a MediaStream to a muted <video>. Muted elements are never blocked
 *  by the autoplay policy; all audio goes through useAudioSink instead. */
function useAttachStream(stream) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => {});
  }, [stream]);
  return ref;
}

/**
 * The single element that actually makes sound, wherever the live view is shown.
 *
 * Browsers refuse to start audio without a user gesture, and a rejected play()
 * is easy to swallow — which is exactly what made "Listen" look connected while
 * being completely silent. So the rejection is surfaced as `blocked`, and the
 * UI offers a button that calls play() straight from a real click.
 */
function useAudioSink(stream) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    if (!stream) { setBlocked(false); return; }
    el.muted = false;
    el.volume = 1;
    el.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  }, [stream]);

  const enable = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = false;
    el.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  };

  return { ref, blocked, enable };
}

/** Mic loudness bar — lets a proctor spot talking without listening in.
 *  `speaking` is the backend's own verdict (its threshold adapts per room), so
 *  the bar never disagrees with what actually raises a flag. */
function MicMeter({ level, age, speaking, listening }) {
  const stale = age == null || age > 12;
  const pct = stale ? 0 : Math.min(100, level * 320);
  return (
    <span className={`mic-meter wide ${!stale && speaking ? "loud" : ""} ${listening ? "on" : ""}`}
          title={stale ? "No recent audio"
                       : `Mic level ${level.toFixed(2)}${speaking ? " — talking" : ""}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Lists a candidate's warnings/flags; lets the proctor dismiss or clear them. */
function WarningsModal({ session, onClose, onChanged }) {
  const [flags, setFlags] = useState(null);
  const [err, setErr] = useState("");

  const load = () =>
    fetchFlags(session.session_id).then((d) => setFlags(d.flags)).catch(() => setErr("Could not load warnings."));

  useEffect(() => {
    load();
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [session.session_id]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function dismiss(id) {
    try { await dismissFlag(session.session_id, id); await load(); onChanged?.(); } catch {}
  }
  async function clearAll() {
    if (!window.confirm(`Clear all warnings for ${session.candidate_name}?`)) return;
    try { await clearFlags(session.session_id); await load(); onChanged?.(); } catch {}
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal answers-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{session.candidate_name}</strong>
            <span className="muted"> · {flags?.length ?? 0} warning(s)</span>
          </div>
          <div className="modal-actions">
            {flags?.length > 0 &&
              <button className="ghost remove-btn" onClick={clearAll}>Clear all</button>}
            <button className="ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>
        <div className="answers-body">
          {err && <div className="error">{err}</div>}
          {!flags && !err && <div className="muted">Loading…</div>}
          {flags && flags.length === 0 && <div className="muted">No warnings.</div>}
          {flags && flags.map((f) => (
            <div className={`warn-row sev-${f.severity}`} key={f.id}>
              <span className="warn-time">{fmtTime(f.ts)}</span>
              <span className={`warn-sev ${f.severity}`}>{f.severity}</span>
              <span className="warn-type"><strong>{f.type}</strong>{f.detail ? ` — ${f.detail}` : ""}</span>
              <button className="ghost warn-x" title="Dismiss"
                      onClick={() => dismiss(f.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Reads a candidate's saved answers. Closes on backdrop click or Esc. */
function AnswersModal({ session, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetchAnswers(session.session_id)
      .then((d) => alive && setData(d))
      .catch(() => alive && setErr("Could not load answers."));
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => { alive = false; document.removeEventListener("keydown", onKey); };
  }, [session.session_id, onClose]);

  const answered = data?.items.filter((i) => i.answer.trim()).length ?? 0;
  const total = data?.items.length ?? 0;

  function downloadPdf() {
    if (!data) return;
    const esc = (s) => String(s).replace(/[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const rows = data.items.map((it, i) => `
      <div class="q">
        <div class="qh">Q${i + 1} · Section ${esc(it.section)} · ${it.points} pt${it.points > 1 ? "s" : ""}</div>
        <div class="qt">${esc(it.text)}</div>
        <div class="a ${it.answer.trim() ? "" : "empty"}">${it.answer.trim() ? esc(it.answer) : "— no answer —"}</div>
      </div>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>${esc(data.candidate_name)} — Apex AI Assessment</title>
      <style>
        body{font:13px/1.5 system-ui,Arial,sans-serif;color:#111;margin:32px;}
        h1{font-size:18px;margin:0 0 2px;} h2{font-size:15px;margin:0 0 2px;}
        .meta{color:#555;margin-bottom:18px;font-size:12px;}
        .q{margin-bottom:16px;page-break-inside:avoid;}
        .qh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666;}
        .qt{font-weight:600;white-space:pre-wrap;margin:2px 0 6px;}
        .a{white-space:pre-wrap;border:1px solid #ccc;border-radius:6px;padding:8px 10px;background:#fafafa;}
        .a.empty{color:#999;font-style:italic;}
      </style></head><body>
      <h1>Apex AI — Backend Technical Assessment</h1>
      <h2>${esc(data.candidate_name)}</h2>
      <div class="meta">${answered}/${total} answered${data.submitted ? " · submitted" : ""} · generated ${new Date().toLocaleString()}</div>
      ${rows}
      </body></html>`;
    // Hidden iframe (not a pop-up, so blockers can't stop it). srcdoc + onload
    // guarantees we only print once the content is fully laid out.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    const done = () => { if (iframe.parentNode) document.body.removeChild(iframe); };
    iframe.onload = () => {
      try {
        iframe.contentWindow.onafterprint = done;
        iframe.contentWindow.focus();
        iframe.contentWindow.print();   // print dialog -> choose "Save as PDF"
        setTimeout(done, 120000);       // safety cleanup
      } catch {
        done();
        window.alert("Could not open the print dialog for the PDF.");
      }
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal answers-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{session.candidate_name}</strong>
            <span className="muted"> · {answered}/{total} answered
              {data?.submitted ? " · submitted" : ""}</span>
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={downloadPdf} disabled={!data}>⬇ Download PDF</button>
            <button className="ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>
        <div className="answers-body">
          {err && <div className="error">{err}</div>}
          {!data && !err && <div className="muted">Loading…</div>}
          {data?.items.map((it, i) => (
            <div className="ans" key={it.question_id}>
              <div className="ans-q">
                <span className="q-num">{i + 1}</span>
                <span className="q-body">{it.text}</span>
                <span className="q-points">{it.points} pt{it.points > 1 ? "s" : ""}</span>
              </div>
              {it.answer.trim()
                ? <pre className="ans-a">{it.answer}</pre>
                : <div className="ans-a empty">— no answer —</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Password gate shown until the proctor authenticates. */
function ProctorLogin({ onAuthed }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await proctorLogin(pw);
      onAuthed();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>Proctor sign-in</h1>
        <p className="muted">Restricted — live candidate monitoring.</p>
        <label>Proctor password</label>
        <input type="password" value={pw} autoFocus
               onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        {err && <div className="error">{err}</div>}
        <button disabled={busy || !pw}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

/** Candidate thumbnail. Shows the real-time stream while this candidate is
 *  live, otherwise the periodic snapshot (which is ~3s behind by design). */
function CameraTile({ session, tick, onExpand, live }) {
  const showLive = !!live?.stream;
  const videoRef = useAttachStream(showLive ? live.stream : null);

  if (!showLive && !session.has_snapshot) {
    return <div className="cam-tile cam-none">no camera</div>;
  }
  return (
    <div className="cam-tile" onClick={onExpand} title="Click to enlarge">
      {showLive
        // Muted on purpose — sound comes from the single audio sink, so it
        // can never double up with the enlarged view.
        ? <video ref={videoRef} autoPlay playsInline muted />
        : <img src={snapshotUrl(session.session_id, tick)} alt="candidate" />}
      <span className={`cam-age ${showLive ? "live" : ""}`}>
        {showLive ? "● LIVE" : `${Math.round(session.snapshot_age)}s ago`}
      </span>
      <span className="cam-expand">⛶</span>
    </div>
  );
}

/** Enlarged camera overlay. Shows the real-time WebRTC stream when it is up,
 *  and falls back to the ~3s snapshot while it connects or if it can't. */
function CameraModal({ session, tick, onClose, live }) {
  const ref = useRef(null);
  const videoRef = useAttachStream(live?.stream);
  const showLive = !!live?.stream && (live.state === "live" || live.state === "connecting");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goFullscreen = () => {
    const el = ref.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{session.candidate_name}</strong>
            <span className={`dot ${session.submitted ? "done" :
                             session.online ? "on" : "off"}`}>
              {session.submitted ? "submitted" :
               session.online ? "online" : `dropped · ${Math.round(session.seconds_since_seen)}s`}
            </span>
          </div>
          <div className="modal-actions">
            <span className={`rtc-state ${live?.state || "idle"}`}>
              {live?.state === "live" ? "● REAL-TIME"
                : live?.state === "connecting" ? "connecting…"
                : live?.state === "failed" ? "peer connection failed"
                : live?.state === "unavailable" ? "candidate offline"
                : "snapshot"}
            </span>
            <button className="ghost" onClick={goFullscreen}>⛶ Fullscreen</button>
            <button className="ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>
        {showLive ? (
          // Muted: audio comes from the dashboard's single audio sink.
          <video className="modal-img" ref={videoRef} autoPlay playsInline muted />
        ) : session.has_snapshot ? (
          <img className="modal-img" src={snapshotUrl(session.session_id, tick)} alt="candidate" />
        ) : (
          <div className="modal-img cam-none">no camera</div>
        )}
        <div className="modal-foot">
          {live?.state === "live"
            ? <>Real-time peer-to-peer · <LiveStats stats={live.stats} state={live.state} /> · Esc to close</>
            : live?.state === "connecting"
              ? `Negotiating the live connection${live?.reason ? ` — ${live.reason}` : ""} — showing the latest snapshot (${
                  session.snapshot_age != null ? `${Math.round(session.snapshot_age)}s old` : "—"}) · Esc to close`
              /* The fallback used to describe itself without ever saying why
                 the real-time view was unavailable. */
              : `Snapshot fallback${live?.reason ? ` — ${live.reason}` : ""} · updates every ~2.5s · frame ${
                  session.snapshot_age != null ? `${Math.round(session.snapshot_age)}s old` : "—"} · Esc to close`}
        </div>
      </div>
    </div>
  );
}

/** Drop-off timeline: when the candidate left the exam view and for how long. */
function Dropoffs({ dropoffs }) {
  if (!dropoffs.length) return <div className="muted small">No drop-offs.</div>;
  return (
    <ul className="dropoffs">
      {dropoffs.slice(-6).reverse().map((d, i) => (
        <li key={i} className={d.type === "away_return" ? "back" : "left"}>
          <span className="do-time">{fmtTime(d.ts)}</span>
          <span className="do-type">
            {d.type === "away_return" ? "↩ returned" :
             d.type === "tab_switch" ? "⇥ left tab" :
             d.type === "fullscreen_exit" ? "⤢ left fullscreen" : "✦ lost focus"}
          </span>
          {d.detail && <span className="do-detail">{d.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function ProctorDashboard() {
  const [authed, setAuthed] = useState(!!getProctorToken());
  const [sessions, setSessions] = useState([]);
  const [tick, setTick] = useState(0);   // drives live camera refresh
  const [expandedId, setExpandedId] = useState(null);   // candidate camera shown large
  const [answersId, setAnswersId] = useState(null);     // candidate answers shown
  const [warningsId, setWarningsId] = useState(null);   // candidate warnings shown
  const [listeningId, setListeningId] = useState(null); // candidate streamed live

  const load = useCallback(
    () => fetchSessions().then(setSessions).catch((e) => {
      if (e.message === "unauthorized") setAuthed(false);
    }),
    [],
  );

  // The signalling socket also carries the live flag feed. WebRTC messages are
  // not exam events, so they must not trigger a session reload.
  const onSignal = useCallback((e) => {
    try {
      if (String(JSON.parse(e.data).kind || "").startsWith("rtc-")) return;
    } catch { /* fall through and reload */ }
    load();
  }, [load]);

  // Owns the socket: pings it, reconnects it, and queues sends across the gap.
  const { wsRef, send: sendSignal, generation: wsGen, connected: wsConnected } =
    useSignalling(authed, onSignal);

  // One candidate live at a time — overlapping mics are unusable, and each live
  // view costs that candidate an upstream video stream.
  // Opening the enlarged camera also streams that candidate, so the modal and
  // the Listen button share a single peer connection.
  const liveId = expandedId || listeningId;
  const live = useLiveFeed(liveId, wsRef, sendSignal, wsGen);
  // Exactly one element makes sound, whether or not the enlarged view is open.
  const audio = useAudioSink(live.stream);
  // Going live opens the enlarged view too — a 132px thumbnail is not what
  // anyone means by "watch the candidate".
  const goLive = useCallback((id) => {
    setListeningId(id);
    setExpandedId(id);
  }, []);
  const stopLive = useCallback(() => {
    setListeningId(null);
    setExpandedId(null);
  }, []);
  const toggleListen = useCallback((id) => {
    setListeningId((cur) => {
      if (cur === id) { setExpandedId(null); return null; }
      setExpandedId(id);
      return id;
    });
  }, []);

  const refresh = () => fetchSessions().then(setSessions).catch(() => {});

  const expanded = sessions.find((s) => s.session_id === expandedId) || null;
  const answersSession = sessions.find((s) => s.session_id === answersId) || null;
  const warningsSession = sessions.find((s) => s.session_id === warningsId) || null;

  // Live feed is derived from the polled sessions, so it always shows history
  // (not just events that arrived after this dashboard connected).
  const feed = useMemo(() => {
    const items = [];
    sessions.forEach((s) => {
      s.flags.forEach((f) => items.push({
        kind: "flag", candidate_name: s.candidate_name, type: f.type,
        detail: f.detail, severity: f.severity, at: f.ts * 1000,
      }));
      if (s.submitted) items.push({
        kind: "submit", candidate_name: s.candidate_name,
        answered: s.answered, total: s.total_questions,
        flags: s.flags.length, at: s.last_seen * 1000,
      });
    });
    return items.sort((a, b) => b.at - a.at).slice(0, 100);
  }, [sessions]);

  async function messageCandidate(s) {
    const text = window.prompt(`Message to ${s.candidate_name} (pops up on their screen):`);
    if (!text || !text.trim()) return;
    try { await sendCandidateMessage(s.session_id, text.trim()); }
    catch { window.alert("Could not send the message."); }
  }

  async function removeCandidate(s) {
    if (!window.confirm(
      `Remove ${s.candidate_name}? This permanently deletes their answers, ` +
      `flags, and camera frame.`)) return;
    try {
      await deleteSession(s.session_id);
      setSessions((prev) => prev.filter((x) => x.session_id !== s.session_id));
      if (answersId === s.session_id) setAnswersId(null);
      if (expandedId === s.session_id) setExpandedId(null);
    } catch { /* ignore */ }
  }

  // Presence and camera frames come from HTTP polling; the socket (above) only
  // makes updates arrive sooner. Keeping them independent is deliberate — it is
  // why the dashboard still shows accurate cards when signalling is down.
  useEffect(() => {
    if (!authed) return;
    load();
    const poll = setInterval(load, 3000);          // refresh presence + drop-offs
    const cam = setInterval(() => setTick((t) => t + 1), 2500); // refresh camera frames
    return () => { clearInterval(poll); clearInterval(cam); };
  }, [authed, load]);

  if (!authed) return <ProctorLogin onAuthed={() => setAuthed(true)} />;

  return (
    <div className="dash">
      <header className="bar"><strong>Proctor dashboard</strong>
        <span className="muted">live · {sessions.filter((s) => s.online).length} online</span>
        {/* The live view cannot work without this socket, and it used to fail
            invisibly — the cards kept updating over HTTP while every attempt to
            watch a candidate hung on "connecting…". */}
        {!wsConnected && (
          <span className="ws-down" title="The live-view signalling channel is down. Cards still update over HTTP.">
            ⚠ signalling offline — reconnecting…
          </span>
        )}
        {liveId && (
          <span className={`listen-chip ${live.state === "live" && !audio.blocked ? "playing" : ""}`}>
            <span aria-hidden="true">🔊</span>
            Live: <b>{sessions.find((s) => s.session_id === liveId)
              ?.candidate_name ?? "candidate"}</b>
            <em className="listen-err">
              {live.state === "live"
                ? <LiveStats stats={live.stats} state={live.state} />
                /* Say WHY, not just that it failed — a dead signalling socket
                   and an unreachable peer are different problems. */
                : live.reason
                  || (live.state === "connecting" ? "connecting…"
                    : live.state === "failed" ? "connection failed"
                    : live.state === "unavailable" ? "candidate offline" : "")}
            </em>
            {/* Browsers block audio until the page has been interacted with.
                Never swallow that — offer the click that unblocks it. */}
            {audio.blocked && (
              <button className="ghost sound-blocked" onClick={audio.enable}>
                🔇 Sound blocked — click to enable
              </button>
            )}
            {!expandedId && (
              <button className="ghost listen-stop"
                      onClick={() => setExpandedId(liveId)}>Show video</button>
            )}
            <button className="ghost listen-stop" onClick={stopLive}>Stop</button>
          </span>
        )}
        <button className="ghost" style={{ marginLeft: "auto" }}
          onClick={() => { setProctorToken(""); setAuthed(false); }}>Sign out</button>
      </header>

      <div className="cards">
        {sessions.length === 0 && (
          <div className="muted" style={{ padding: 20 }}>No candidates yet.</div>
        )}
        {sessions.map((s) => {
          const high = s.flags.filter((f) => f.severity === "high").length;
          const dropped = !s.online && !s.submitted;
          return (
            <div key={s.session_id}
                 className={`ccard ${dropped ? "dropped" : ""} ${high ? "has-high" : ""}`}>
              {/* Clicking the tile also marks the candidate live, so closing
                  the enlarged view keeps the peer connection up. Tearing it
                  down would mean sitting through the encoder's ramp-up to full
                  resolution again on every reopen. */}
              <CameraTile session={s} tick={tick}
                          live={liveId === s.session_id ? live : null}
                          onExpand={() => goLive(s.session_id)} />

              {/* Actions and the timeline are siblings of .cinfo, not children,
                  so they span the card's full width instead of being squeezed
                  into the narrow column beside the camera tile. */}
              <div className="cinfo">
                <div className="chead">
                  <strong className="cname" title={s.candidate_name}>{s.candidate_name}</strong>
                  <span className={`dot ${s.submitted ? "done" :
                                   s.online ? "on" : "off"}`}>
                    {s.submitted ? "submitted" :
                     s.online ? "online" : `dropped · ${Math.round(s.seconds_since_seen)}s`}
                  </span>
                </div>

                <div className="cstats">
                  <span className="cstat">Answered <b>{s.answered ?? 0}/{s.total_questions ?? "—"}</b></span>
                  <button className={`flags-link ${high ? "hi" : ""}`}
                          disabled={!s.flags.length}
                          onClick={() => setWarningsId(s.session_id)}
                          title="Click to view / fix warnings">
                    Flags <b>{s.flags.length}</b>{high ? ` · ${high} high` : ""}
                  </button>
                  <span className="cstat mic">
                    Mic
                    <MicMeter level={s.audio_level ?? 0} age={s.audio_age}
                              speaking={s.speaking}
                              listening={listeningId === s.session_id} />
                  </span>
                  <span className="cstat seen">Seen {fmtTime(s.last_seen)}</span>
                </div>
              </div>

              <div className="card-actions">
                {/* Reflects the real connection state, so a failed peer
                    connection can never look like a working one. */}
                <button className={`ghost listen-btn ${liveId === s.session_id ? "on" : ""}`}
                        disabled={!s.can_stream}
                        title={s.can_stream
                          ? "Watch and hear this candidate in real time"
                          : "Candidate is not connected for live streaming"}
                        onClick={() => toggleListen(s.session_id)}>
                  <span aria-hidden="true">{liveId === s.session_id ? "🔴" : "▶"}</span>
                  {liveId !== s.session_id ? " Live"
                    : live.state === "live" ? (audio.blocked ? " Muted" : " Live")
                    : live.state === "connecting" ? " Connecting…"
                    : live.state === "failed" ? " Failed"
                    : live.state === "unavailable" ? " Offline" : " Live"}
                </button>
                <button className="ghost view-answers"
                        onClick={() => setAnswersId(s.session_id)}>
                  <span aria-hidden="true">📄</span> Answers
                </button>
                <button className="ghost msg-btn"
                        onClick={() => messageCandidate(s)}>
                  <span aria-hidden="true">✉</span> Message
                </button>
                <button className="ghost remove-btn"
                        onClick={() => removeCandidate(s)}>
                  <span aria-hidden="true">✕</span> Remove
                </button>
              </div>

              <div className="ctimeline">
                <div className="do-title">Drop-off timeline</div>
                <Dropoffs dropoffs={s.dropoffs} />
              </div>
            </div>
          );
        })}
      </div>

      <section className="feedwrap">
        <h2>Live flag feed</h2>
        <ul className="feed">
          {feed.length === 0 && <li className="muted">Waiting for events…</li>}
          {feed.map((e, i) => (
            <li key={i} className={`feed-item sev-${e.severity || ""}`}>
              <span className="feed-time">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="feed-name">{e.candidate_name}</span>
              {e.kind === "submit"
                ? <> submitted — {e.answered}/{e.total} answered ({e.flags} flags)</>
                : <> <strong>{e.type}</strong> {e.detail ? `— ${e.detail}` : ""}</>}
            </li>
          ))}
        </ul>
      </section>

      {/* The one element that makes sound. Every <video> on this page is muted
          so audio can never double up or be lost between views. */}
      <audio ref={audio.ref} autoPlay playsInline style={{ display: "none" }} />

      {expanded && (
        <CameraModal session={expanded} tick={tick} live={live}
                     onClose={() => setExpandedId(null)} />
      )}
      {answersSession && (
        <AnswersModal session={answersSession}
                      onClose={() => setAnswersId(null)} />
      )}
      {warningsSession && (
        <WarningsModal session={warningsSession}
                       onClose={() => setWarningsId(null)}
                       onChanged={refresh} />
      )}
    </div>
  );
}
