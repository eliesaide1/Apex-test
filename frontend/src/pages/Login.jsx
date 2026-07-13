import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";
import { enterFullscreen } from "../hooks/useProctoring";

export default function Login() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("APEX-TEST");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function start(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const data = await login(name, code);
      sessionStorage.setItem("session", JSON.stringify(data));
      await enterFullscreen(); // must be inside the click gesture to be allowed
      nav("/exam");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={start}>
        <h1>ApexTestPortal</h1>
        <p className="muted">Secure proctored exam — internal training</p>

        <label>Full name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Jane Doe" autoFocus />

        <label>Exam code</label>
        <input value={code} onChange={(e) => setCode(e.target.value)}
               placeholder="APEX-TEST" />

        {err && <div className="error">{err}</div>}

        <button disabled={busy || !name.trim()}>
          {busy ? "Starting…" : "Start exam"}
        </button>

        <div className="notice">
          By starting you consent to webcam proctoring. The exam runs in
          fullscreen; leaving it, switching tabs, or copying is logged.
        </div>
      </form>
    </div>
  );
}
