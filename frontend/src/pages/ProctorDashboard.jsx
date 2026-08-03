import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSessions, fetchAnswers, fetchFlags, dismissFlag, clearFlags,
  deleteSession, sendCandidateMessage, snapshotUrl, proctorWsUrl,
  fetchAudioClips, fetchAudioClip,
  proctorLogin, getProctorToken, setProctorToken,
} from "../api";

const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

/**
 * Listen in on one candidate's microphone.
 *
 * The candidate uploads short self-contained clips, so "live audio" here is
 * just a play queue: poll for clips newer than the last one we played, fetch
 * each as a blob, and play them back-to-back. Audio therefore runs roughly one
 * clip (~4s) behind real time — fine for hearing whether someone is talking,
 * and it needs no WebRTC/TURN infrastructure.
 *
 * Only one candidate can be audible at a time (`listeningId` in the dashboard),
 * so there is exactly one queue and one <audio> element in flight.
 */
function useListen(sessionId) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId) return;
    const el = new Audio();
    el.autoplay = false;
    let stopped = false;
    let lastSeq = 0;          // highest clip we have queued
    let queue = [];           // object URLs waiting to play
    let busy = false;         // an element is mid-playback

    const playNext = () => {
      if (stopped || busy) return;
      const url = queue.shift();
      if (!url) { setPlaying(false); return; }
      busy = true;
      setPlaying(true);
      el.src = url;
      el.play().catch(() => { setError("Click Listen again to allow audio."); });
      el.onended = el.onerror = () => {
        URL.revokeObjectURL(url);
        busy = false;
        playNext();
      };
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const { clips } = await fetchAudioClips(sessionId, lastSeq);
        // On first poll, start from the newest clip only — otherwise we would
        // play out the whole backlog and fall ~40s behind immediately.
        const wanted = lastSeq === 0 ? clips.slice(-1) : clips;
        for (const c of wanted) {
          if (stopped) return;
          lastSeq = Math.max(lastSeq, c.seq);
          try {
            queue.push(URL.createObjectURL(await fetchAudioClip(sessionId, c.seq)));
          } catch { /* clip aged out of the ring buffer — skip it */ }
        }
        if (lastSeq === 0 && clips.length === 0) lastSeq = 0;
        setError("");
        playNext();
      } catch {
        setError("No audio from this candidate yet.");
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
      el.pause();
      el.src = "";
      queue.forEach(URL.revokeObjectURL);
      queue = [];
    };
  }, [sessionId]);

  return { playing, error };
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

/** Live webcam thumbnail for one candidate — refreshes on a timer. Click to expand. */
function CameraTile({ session, tick, onExpand }) {
  if (!session.has_snapshot) {
    return <div className="cam-tile cam-none">no camera</div>;
  }
  return (
    <div className="cam-tile" onClick={onExpand} title="Click to enlarge">
      <img src={snapshotUrl(session.session_id, tick)} alt="candidate" />
      <span className="cam-age">{Math.round(session.snapshot_age)}s ago</span>
      <span className="cam-expand">⛶</span>
    </div>
  );
}

/** Enlarged live camera overlay for one candidate, with a true-fullscreen toggle. */
function CameraModal({ session, tick, onClose }) {
  const ref = useRef(null);

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
            <button className="ghost" onClick={goFullscreen}>⛶ Fullscreen</button>
            <button className="ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>
        {session.has_snapshot ? (
          <img className="modal-img" src={snapshotUrl(session.session_id, tick)} alt="candidate" />
        ) : (
          <div className="modal-img cam-none">no camera</div>
        )}
        <div className="modal-foot">
          Live · updates every ~2.5s · frame {session.snapshot_age != null
            ? `${Math.round(session.snapshot_age)}s old` : "—"} · Esc to close
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
  const [listeningId, setListeningId] = useState(null); // candidate we can hear
  const wsRef = useRef(null);

  // One candidate audible at a time — a room full of overlapping mics is
  // unusable, and it keeps bandwidth to a single clip stream.
  const listen = useListen(listeningId);
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
    const ws = new WebSocket(proctorWsUrl());
    wsRef.current = ws;
    ws.onmessage = () => load();
    return () => { clearInterval(poll); clearInterval(cam); ws.close(); };
  }, [authed]);

  if (!authed) return <ProctorLogin onAuthed={() => setAuthed(true)} />;

  return (
    <div className="dash">
      <header className="bar"><strong>Proctor dashboard</strong>
        <span className="muted">live · {sessions.filter((s) => s.online).length} online</span>
        {listeningId && (
          <span className={`listen-chip ${listen.playing ? "playing" : ""}`}>
            <span aria-hidden="true">🔊</span>
            Listening to <b>{sessions.find((s) => s.session_id === listeningId)
              ?.candidate_name ?? "candidate"}</b>
            {listen.error && <em className="listen-err">{listen.error}</em>}
            <button className="ghost listen-stop"
                    onClick={() => setListeningId(null)}>Stop</button>
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
                <button className={`ghost listen-btn ${listeningId === s.session_id ? "on" : ""}`}
                        disabled={!s.has_audio}
                        title={s.has_audio ? "Hear this candidate's microphone"
                                           : "No microphone audio received yet"}
                        onClick={() => toggleListen(s.session_id)}>
                  <span aria-hidden="true">{listeningId === s.session_id ? "🔊" : "🎧"}</span>
                  {listeningId === s.session_id ? " Listening" : " Listen"}
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

      {expanded && (
        <CameraModal session={expanded} tick={tick}
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
