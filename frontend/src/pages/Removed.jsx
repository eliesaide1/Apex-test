import { useNavigate } from "react-router-dom";

/**
 * Where a candidate lands when a proctor removes them.
 *
 * Deliberately a separate route rather than an overlay on the exam: navigating
 * here unmounts the exam entirely, which releases the camera and microphone,
 * closes the sockets, and — the point of the exercise — takes the questions out
 * of the page instead of merely covering them up.
 */
export default function Removed() {
  const nav = useNavigate();
  return (
    <div className="center">
      <div className="card removed-card">
        <div className="mg-icon">⛔</div>
        <h1>Your exam has been ended</h1>
        <p>
          A proctor removed you from this exam. Your answers have been discarded
          and you cannot continue or start again.
        </p>
        <p className="muted">
          If you believe this is a mistake, speak to your proctor — they can let
          you back in, and you would begin a new attempt from the first question.
        </p>
        <button onClick={() => nav("/", { replace: true })}>Close</button>
      </div>
    </div>
  );
}
