import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { submit } from "../api";
import { useProctoring, enterFullscreen } from "../hooks/useProctoring";
import { useWebcam } from "../hooks/useWebcam";
import Watermark from "../components/Watermark.jsx";

export default function Exam() {
  const nav = useNavigate();
  const session = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem("session")); }
    catch { return null; }
  }, []);

  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(session?.exam?.duration_seconds ?? 0);
  const [submitting, setSubmitting] = useState(false);

  const doSubmit = useCallback(async (reason) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await submit(session.session_id, answers);
      sessionStorage.setItem("result", JSON.stringify({ ...res, reason }));
    } catch { /* ignore */ }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    nav("/result");
  }, [answers, session, submitting, nav]);

  const { warnings, lastEvent, maxWarnings } = useProctoring(
    session?.session_id,
    { maxWarnings: 6, onForceSubmit: (t) => doSubmit(`auto-submitted: ${t}`) }
  );
  const { videoRef, canvasRef, status } = useWebcam(session?.session_id);

  // Countdown timer -> auto-submit at zero
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { clearInterval(id); doSubmit("time expired"); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [session, doSubmit]);

  if (!session) {
    return <div className="center"><div className="card">
      No active session. <a href="/">Return to login</a>.
    </div></div>;
  }

  const { exam, candidate_name } = session;
  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");

  function pick(qid, cid) {
    setAnswers((a) => ({ ...a, [qid]: cid }));
  }

  return (
    <div className="exam">
      <Watermark text={`${candidate_name} · ${session.session_id.slice(0, 8)}`} />

      <header className="bar">
        <strong>{exam.title}</strong>
        <div className="bar-right">
          <span className={`pill ${warnings ? "warn" : ""}`}>
            Warnings {warnings}/{maxWarnings}
          </span>
          <span className={`pill cam-${status}`}>
            Cam: {status}
          </span>
          <span className="timer">{mm}:{ss}</span>
        </div>
      </header>

      {!document.fullscreenElement && (
        <div className="banner" onClick={() => enterFullscreen()}>
          ⚠ You left fullscreen. Click here to return — leaving is logged.
        </div>
      )}
      {lastEvent && Date.now() - lastEvent.at < 4000 && (
        <div className="banner alert">⚠ Logged: {lastEvent.type} — {lastEvent.detail}</div>
      )}

      <main className="questions">
        {exam.questions.map((q, i) => (
          <div className="q" key={q.id}>
            <div className="q-text"><span className="q-num">{i + 1}</span>{q.text}</div>
            {q.choices.map((c) => (
              <label key={c.id}
                className={`choice ${answers[q.id] === c.id ? "sel" : ""}`}>
                <input type="radio" name={q.id}
                  checked={answers[q.id] === c.id}
                  onChange={() => pick(q.id, c.id)} />
                {c.text}
              </label>
            ))}
          </div>
        ))}

        <button className="submit" disabled={submitting}
          onClick={() => doSubmit("manual")}>
          {submitting ? "Submitting…" : "Submit exam"}
        </button>
      </main>

      {/* Webcam preview (small, corner). Hidden canvas used for snapshots. */}
      <div className="cam-preview">
        <video ref={videoRef} muted playsInline />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {status === "denied" && <div className="cam-msg">Camera denied</div>}
      </div>
    </div>
  );
}
