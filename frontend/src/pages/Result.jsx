import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

export default function Result() {
  const nav = useNavigate();
  const result = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem("result")); }
    catch { return null; }
  }, []);

  if (!result) {
    return <div className="center"><div className="card">
      No result found. <a href="/">Back to login</a>.
    </div></div>;
  }

  const pct = Math.round((result.score / result.total) * 100);
  return (
    <div className="center">
      <div className="card">
        <h1>Exam submitted</h1>
        <div className="score">{result.score} / {result.total}</div>
        <div className="muted">{pct}% correct</div>
        {result.flags > 0 && (
          <div className="error" style={{ marginTop: 16 }}>
            {result.flags} proctoring flag(s) recorded — sent to review.
          </div>
        )}
        {result.reason && result.reason !== "manual" && (
          <div className="notice">Submission reason: {result.reason}</div>
        )}
        <button onClick={() => { sessionStorage.clear(); nav("/"); }}>
          Finish
        </button>
      </div>
    </div>
  );
}
