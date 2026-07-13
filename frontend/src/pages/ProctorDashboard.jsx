import { useEffect, useRef, useState } from "react";
import {
  fetchSessions, fetchAnswers, snapshotUrl, proctorWsUrl, proctorLogin,
  getProctorToken, setProctorToken,
} from "../api";

const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal answers-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{session.candidate_name}</strong>
            <span className="muted"> · {answered}/{total} answered
              {data?.submitted ? " · submitted" : ""}</span>
          </div>
          <button className="ghost" onClick={onClose}>✕ Close</button>
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
  const [feed, setFeed] = useState([]);
  const [tick, setTick] = useState(0);   // drives live camera refresh
  const [expandedId, setExpandedId] = useState(null);   // candidate camera shown large
  const [answersId, setAnswersId] = useState(null);     // candidate answers shown
  const wsRef = useRef(null);

  const expanded = sessions.find((s) => s.session_id === expandedId) || null;
  const answersSession = sessions.find((s) => s.session_id === answersId) || null;

  useEffect(() => {
    if (!authed) return;
    const load = () =>
      fetchSessions().then(setSessions).catch((e) => {
        if (e.message === "unauthorized") setAuthed(false);
      });
    load();
    const poll = setInterval(load, 3000);          // refresh presence + drop-offs
    const cam = setInterval(() => setTick((t) => t + 1), 2500); // refresh camera frames

    const ws = new WebSocket(proctorWsUrl());
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      setFeed((f) => [{ ...msg, at: Date.now() }, ...f].slice(0, 100));
      load();
    };
    return () => { clearInterval(poll); clearInterval(cam); ws.close(); };
  }, [authed]);

  if (!authed) return <ProctorLogin onAuthed={() => setAuthed(true)} />;

  return (
    <div className="dash">
      <header className="bar"><strong>Proctor dashboard</strong>
        <span className="muted">live · {sessions.filter((s) => s.online).length} online</span>
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

              <div className="cinfo">
                <div className="chead">
                  <strong>{s.candidate_name}</strong>
                  <span className={`dot ${s.submitted ? "done" :
                                   s.online ? "on" : "off"}`}>
                    {s.submitted ? "submitted" :
                     s.online ? "online" : `dropped · ${Math.round(s.seconds_since_seen)}s`}
                  </span>
                </div>

                <div className="cstats">
                  <span>Answered: {s.answered ?? 0}/{s.total_questions ?? "—"}</span>
                  <span className={high ? "hi" : ""}>Flags: {s.flags.length}
                    {high ? ` (${high} high)` : ""}</span>
                  <span>Last seen: {fmtTime(s.last_seen)}</span>
                </div>

                <button className="ghost view-answers"
                        onClick={() => setAnswersId(s.session_id)}>
                  📄 View answers
                </button>

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
    </div>
  );
}
