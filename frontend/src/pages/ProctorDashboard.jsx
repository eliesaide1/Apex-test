import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSessions, fetchAnswers, fetchFlags, dismissFlag, clearFlags,
  deleteSession, sendCandidateMessage, snapshotUrl, proctorWsUrl,
  fetchRtcConfig,
  proctorLogin, getProctorToken, setProctorToken,
} from "../api";

const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

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
function useLiveFeed(sessionId, wsRef) {
  const [stream, setStream] = useState(null);
  const [state, setState] = useState("idle");   // idle|connecting|live|failed|unavailable
  const pcRef = useRef(null);

  useEffect(() => {
    if (!sessionId) { setStream(null); setState("idle"); return; }

    let closed = false;
    let pc = null;
    const pending = [];        // ICE that arrives before the remote description

    const send = (msg) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...msg, session_id: sessionId }));
      }
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
        if (s === "connected") setState("live");
        else if (s === "failed") setState("failed");
        else if (s === "disconnected") setState("connecting");
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
        onOffer(msg).catch(() => setState("failed"));
      } else if (msg.kind === "rtc-ice" && msg.candidate) {
        if (pc && pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
        else pending.push(msg.candidate);
      } else if (msg.kind === "rtc-unavailable") {
        setState("unavailable");
      } else if (msg.kind === "rtc-ended") {
        setState("idle");
        setStream(null);
      }
    };

    const ws = wsRef.current;
    ws?.addEventListener("message", onMessage);
    setState("connecting");
    send({ kind: "rtc-watch" });

    return () => {
      closed = true;
      ws?.removeEventListener("message", onMessage);
      send({ kind: "rtc-stop" });
      try { pcRef.current?.close(); } catch { /* already closed */ }
      pcRef.current = null;
      setStream(null);
      setState("idle");
    };
  }, [sessionId, wsRef]);

  return { stream, state };
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
            ? "Real-time peer-to-peer video and audio · Esc to close"
            : live?.state === "connecting"
              ? `Negotiating the live connection — showing the latest snapshot (${
                  session.snapshot_age != null ? `${Math.round(session.snapshot_age)}s old` : "—"}) · Esc to close`
              : `Snapshot fallback · updates every ~2.5s · frame ${
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
  const wsRef = useRef(null);

  // One candidate live at a time — overlapping mics are unusable, and each live
  // view costs that candidate an upstream video stream.
  // Opening the enlarged camera also streams that candidate, so the modal and
  // the Listen button share a single peer connection.
  const liveId = expandedId || listeningId;
  const live = useLiveFeed(liveId, wsRef);
  // Exactly one element makes sound, whether or not the enlarged view is open.
  const audio = useAudioSink(live.stream);
  const toggleListen = useCallback(
    (id) => setListeningId((cur) => (cur === id ? null : id)), []);

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

  useEffect(() => {
    if (!authed) return;
    const load = () =>
      fetchSessions().then(setSessions).catch((e) => {
        if (e.message === "unauthorized") setAuthed(false);
      });
    load();
    const poll = setInterval(load, 3000);          // refresh presence + drop-offs
    const cam = setInterval(() => setTick((t) => t + 1), 2500); // refresh camera frames

    // WebSocket gives instant refresh on new events; the feed itself is derived
    // from the polled sessions, so a message just triggers an immediate reload.
    // The same socket carries WebRTC signalling (see useLiveFeed) — those
    // messages are not exam events, so they must not trigger a reload.
    const ws = new WebSocket(proctorWsUrl());
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        if (String(JSON.parse(e.data).kind || "").startsWith("rtc-")) return;
      } catch { /* fall through and reload */ }
      load();
    };
    return () => { clearInterval(poll); clearInterval(cam); ws.close(); };
  }, [authed]);

  if (!authed) return <ProctorLogin onAuthed={() => setAuthed(true)} />;

  return (
    <div className="dash">
      <header className="bar"><strong>Proctor dashboard</strong>
        <span className="muted">live · {sessions.filter((s) => s.online).length} online</span>
        {liveId && (
          <span className={`listen-chip ${live.state === "live" && !audio.blocked ? "playing" : ""}`}>
            <span aria-hidden="true">🔊</span>
            Live: <b>{sessions.find((s) => s.session_id === liveId)
              ?.candidate_name ?? "candidate"}</b>
            <em className="listen-err">
              {live.state === "live" ? "real-time"
                : live.state === "connecting" ? "connecting…"
                : live.state === "failed" ? "connection failed"
                : live.state === "unavailable" ? "candidate offline" : ""}
            </em>
            {/* Browsers block audio until the page has been interacted with.
                Never swallow that — offer the click that unblocks it. */}
            {audio.blocked && (
              <button className="ghost sound-blocked" onClick={audio.enable}>
                🔇 Sound blocked — click to enable
              </button>
            )}
            <button className="ghost listen-stop"
                    onClick={() => { setListeningId(null); setExpandedId(null); }}>
              Stop
            </button>
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
              <CameraTile session={s} tick={tick}
                          live={liveId === s.session_id ? live : null}
                          onExpand={() => setExpandedId(s.session_id)} />

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
