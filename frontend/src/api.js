// Central API helpers.
//
// The frontend is served by the backend on the SAME origin in production, so we
// use relative URLs and derive the WebSocket origin from the page. For local
// dev against a separate backend, set VITE_API_BASE (e.g. http://localhost:8000).
export const BASE = import.meta.env.VITE_API_BASE || "";

function wsBase() {
  if (BASE) return BASE.replace(/^http/, "ws");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

// --- token helpers -------------------------------------------------------- //
function candidateToken() {
  try {
    return JSON.parse(sessionStorage.getItem("session"))?.token || "";
  } catch {
    return "";
  }
}
function candidateAuth() {
  const t = candidateToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function getProctorToken() {
  return sessionStorage.getItem("proctor_token") || "";
}
export function setProctorToken(t) {
  if (t) sessionStorage.setItem("proctor_token", t);
  else sessionStorage.removeItem("proctor_token");
}

// --- candidate ------------------------------------------------------------ //
export async function login(name, examCode) {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, exam_code: examCode }),
  });
  if (!r.ok) throw new Error((await r.json()).detail || "Login failed");
  return r.json();
}

export async function sendFlag(sessionId, type, detail, severity = "medium") {
  try {
    await fetch(`${BASE}/api/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...candidateAuth() },
      body: JSON.stringify({ session_id: sessionId, type, detail, severity }),
    });
  } catch {
    /* best-effort; don't interrupt the exam */
  }
}

export async function sendSnapshot(sessionId, blob) {
  try {
    const fd = new FormData();
    fd.append("session_id", sessionId);
    fd.append("image", blob, "frame.jpg");
    await fetch(`${BASE}/api/snapshot`, {
      method: "POST", headers: { ...candidateAuth() }, body: fd,
    });
  } catch {
    /* best-effort */
  }
}

export async function heartbeat(sessionId) {
  try {
    const fd = new FormData();
    fd.append("session_id", sessionId);
    await fetch(`${BASE}/api/heartbeat`, {
      method: "POST", headers: { ...candidateAuth() }, body: fd,
    });
  } catch {
    /* best-effort */
  }
}

export async function submit(sessionId, answers) {
  const r = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...candidateAuth() },
    body: JSON.stringify({ session_id: sessionId, answers }),
  });
  if (!r.ok) throw new Error("Submit failed");
  return r.json();
}

// --- proctor -------------------------------------------------------------- //
export async function proctorLogin(password) {
  const r = await fetch(`${BASE}/api/proctor/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error((await r.json()).detail || "Login failed");
  const data = await r.json();
  setProctorToken(data.token);
  return data;
}

export async function fetchSessions() {
  const r = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${getProctorToken()}` },
  });
  if (r.status === 401 || r.status === 403) {
    setProctorToken("");
    throw new Error("unauthorized");
  }
  return r.json();
}

export function proctorWsUrl() {
  return `${wsBase()}/ws/proctor?token=${encodeURIComponent(getProctorToken())}`;
}

// Live-frame URL for the proctor view. `bust` forces the browser to refetch.
export function snapshotUrl(sessionId, bust) {
  return `${BASE}/api/snapshot/${sessionId}?t=${bust}&token=${encodeURIComponent(getProctorToken())}`;
}
