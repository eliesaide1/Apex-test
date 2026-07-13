import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { submit, saveAnswer, sendFlag, fetchMessages } from "../api";
import { useProctoring, enterFullscreen } from "../hooks/useProctoring";
import { useWebcam } from "../hooks/useWebcam";
import Watermark from "../components/Watermark.jsx";

const mmss = (secs) => {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export default function Exam() {
  const nav = useNavigate();
  const session = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem("session")); }
    catch { return null; }
  }, []);
  const sid = session?.session_id;

  // Flatten sections -> a linear list of questions, keeping section context.
  const flat = useMemo(() => {
    const out = [];
    session?.exam?.sections?.forEach((sec) => {
      sec.questions.forEach((q, qi) => {
        out.push({ ...q, section: sec, firstInSection: qi === 0 });
      });
    });
    return out;
  }, [session]);

  const [answers, setAnswers] = useState({});
  const [idx, setIdx] = useState(0);                 // current slide
  const [timeLeft, setTimeLeft] = useState(session?.exam?.duration_seconds ?? 0);
  const [qLeft, setQLeft] = useState(0);             // seconds left on the current question
  const [pendingSkip, setPendingSkip] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msgQueue, setMsgQueue] = useState([]);      // proctor messages awaiting OK
  const advanceRef = useRef(null);                   // latest advance() for the timer

  const total = flat.length;
  const current = flat[idx];
  const isLast = idx >= total - 1;

  const doSubmit = useCallback(async (reason) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await submit(sid, answers);
      sessionStorage.setItem("result", JSON.stringify({ ...res, reason }));
    } catch { /* ignore */ }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    nav("/result");
  }, [answers, sid, submitting, nav]);

  const { videoRef, canvasRef, camStatus, micStatus, camOn, micOn } = useWebcam(sid);
  const mediaReady = camOn && micOn;
  // Only start counting navigation warnings once the exam is truly active
  // (camera + mic granted). This avoids false flags from the startup
  // permission prompt and fullscreen transition.
  const { warnings, lastEvent, maxWarnings } = useProctoring(
    sid, { maxWarnings: 6, active: mediaReady,
           onForceSubmit: (t) => doSubmit(`auto-submitted: ${t}`) }
  );

  // Notify the proctor whenever the camera or mic drops or returns mid-exam.
  const prevCam = useRef(true), prevMic = useRef(true);
  useEffect(() => {
    if (!sid || camStatus === "idle") return;
    if (prevCam.current && !camOn) sendFlag(sid, "camera_off", "Camera turned off during exam", "high");
    else if (!prevCam.current && camOn) sendFlag(sid, "camera_on", "Camera restored", "low");
    prevCam.current = camOn;
  }, [camOn, camStatus, sid]);
  useEffect(() => {
    if (!sid || micStatus === "idle") return;
    if (prevMic.current && !micOn) sendFlag(sid, "mic_off", "Microphone turned off during exam", "high");
    else if (!prevMic.current && micOn) sendFlag(sid, "mic_on", "Microphone restored", "low");
    prevMic.current = micOn;
  }, [micOn, micStatus, sid]);

  // Poll for proctor messages -> queue them as popups.
  useEffect(() => {
    if (!sid) return;
    const id = setInterval(async () => {
      const { messages } = await fetchMessages(sid);
      if (messages && messages.length) setMsgQueue((q) => [...q, ...messages]);
    }, 4000);
    return () => clearInterval(id);
  }, [sid]);

  // Master countdown from the full duration -> auto-submit at zero. Runs
  // continuously, so time spent on every question is drawn from the same pool.
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

  // Per-question countdown — resets each slide; auto-advances when it hits zero
  // (an unanswered question is then forfeited).
  useEffect(() => {
    if (!current) return;
    setQLeft(current.time_limit_seconds);
    setPendingSkip(false);
    const id = setInterval(() => {
      setQLeft((t) => {
        if (t <= 1) { clearInterval(id); advanceRef.current?.(); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [idx]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) {
    return <div className="center"><div className="card">
      No active session. <a href="/">Return to login</a>.
    </div></div>;
  }

  const answeredCount = Object.values(answers).filter((v) => v && v.trim()).length;

  function onChange(val) {
    setAnswers((a) => ({ ...a, [current.id]: val }));
    setPendingSkip(false);
  }

  async function advance() {
    const val = (answers[current.id] ?? "").trim();
    // Persist the current answer before moving on (empty answers are simply not saved).
    if (val) {
      setSaving(true);
      try { await saveAnswer(sid, current.id, val); } catch { /* best-effort */ }
      setSaving(false);
    }
    if (isLast) { doSubmit("manual"); return; }
    setIdx((i) => i + 1);
  }

  function onPrimary() {
    const answered = (answers[current.id] ?? "").trim().length > 0;
    if (!answered && !pendingSkip) { setPendingSkip(true); return; }  // ask once
    advance();
  }

  // The countdown fires advanceRef.current() — keep it pointing at the latest closure.
  advanceRef.current = advance;

  const answered = (answers[current.id] ?? "").trim().length > 0;
  const primaryLabel = submitting || saving ? "Saving…"
    : pendingSkip ? `Skip — lose ${current.points} pt${current.points > 1 ? "s" : ""} (click to confirm)`
    : isLast ? (answered ? "Submit exam" : "Submit — skip this question")
    : (answered ? "Save & next question" : "Skip to next question");

  return (
    <div className="exam">
      <Watermark text={`${candidateName(session)} · ${sid.slice(0, 8)}`} />

      {msgQueue.length > 0 && (
        <div className="modal-backdrop msg-pop">
          <div className="msg-card">
            <div className="msg-title">✉ Message from proctor</div>
            <div className="msg-text">{msgQueue[0].text}</div>
            <button onClick={() => setMsgQueue((q) => q.slice(1))}>OK</button>
          </div>
        </div>
      )}

      <header className="bar">
        <strong>{session.exam.title}</strong>
        <div className="bar-right">
          <span className={`pill ${warnings ? "warn" : ""}`}>Warnings {warnings}/{maxWarnings}</span>
          <span className={`pill ${camOn ? "cam-live" : "cam-error"}`}>Cam: {camOn ? "on" : "off"}</span>
          <span className={`pill ${micOn ? "cam-live" : "cam-error"}`}>Mic: {micOn ? "on" : "off"}</span>
          <span className="timer" title="Total time remaining">⏳ {mmss(timeLeft)}</span>
        </div>
      </header>

      <div className="credits-strip">
        {session.exam.org} · {session.exam.authors?.map((a) => `${a.name} (${a.role})`).join(" · ")}
      </div>

      {!document.fullscreenElement && (
        <div className="banner" onClick={() => enterFullscreen()}>
          ⚠ You left fullscreen. Click here to return — leaving is logged.
        </div>
      )}
      {lastEvent && Date.now() - lastEvent.at < 4000 && (
        <div className="banner alert">⚠ Logged: {lastEvent.type} — {lastEvent.detail}</div>
      )}

      {!mediaReady ? (
        <div className="media-gate">
          <div className="media-gate-card">
            <div className="mg-icon">🔒</div>
            <h2>Camera &amp; microphone required</h2>
            <p>
              The exam is hidden because your{" "}
              {!camOn && !micOn ? "camera and microphone are" : !camOn ? "camera is" : "microphone is"} off.
              Re-enable {(!camOn && !micOn) ? "both devices" : "it"} to continue — the timer keeps running.
            </p>
            <ul className="mg-status">
              <li className={camOn ? "ok" : "bad"}>{camOn ? "✓" : "✕"} Camera — {camStatus}</li>
              <li className={micOn ? "ok" : "bad"}>{micOn ? "✓" : "✕"} Microphone — {micStatus}</li>
            </ul>
            {(camStatus === "denied" || micStatus === "denied") && (
              <p className="muted">
                Permission was denied. Click the camera/mic icon in your browser's address
                bar, allow access, then reload if needed.
              </p>
            )}
          </div>
        </div>
      ) : (
        <main className="slide-wrap">
          <div className="progress">
            <div className="progress-bar">
              <span style={{ width: `${((idx) / total) * 100}%` }} />
            </div>
            <div className="progress-meta">
              <span>Question {idx + 1} of {total} · {answeredCount} answered</span>
              <span className={`q-timer ${qLeft <= 30 ? "low" : ""}`} title="Time left on this question">
                ⏳ {mmss(qLeft)} left on this question
              </span>
            </div>
          </div>

          <div className="slide">
            <div className="slide-sec">{current.section.title} · {current.points} pt{current.points > 1 ? "s" : ""}</div>
            {current.firstInSection && current.section.instructions && (
              <p className="sec-instr">{current.section.instructions}</p>
            )}
            {current.firstInSection && current.section.scenario && (
              <pre className="sec-scenario">{current.section.scenario}</pre>
            )}

            <div className="slide-q">{current.text}</div>
            <textarea
              key={current.id}
              className="answer"
              rows={9}
              autoFocus
              value={answers[current.id] ?? ""}
              placeholder="Type your answer here…"
              onChange={(e) => onChange(e.target.value)}
            />

            {pendingSkip && (
              <div className="skip-warn">
                ⚠ This question has no answer. Moving on means you lose its{" "}
                {current.points} point{current.points > 1 ? "s" : ""} — you can't return. Click again to confirm.
              </div>
            )}

            <div className="slide-actions">
              <button className="submit" disabled={submitting || saving}
                onClick={onPrimary}>
                {primaryLabel}
              </button>
            </div>
            <div className="slide-note muted">
              Forward-only — you cannot return to a question once you move on.
            </div>
          </div>
        </main>
      )}

      {/* Webcam preview (small, corner). Hidden canvas used for snapshots. */}
      <div className="cam-preview">
        <video ref={videoRef} muted playsInline />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {(camStatus === "denied" || camStatus === "error") &&
          <div className="cam-msg">Camera {camStatus}</div>}
      </div>
    </div>
  );
}

function candidateName(session) {
  return session?.candidate_name ?? "candidate";
}
