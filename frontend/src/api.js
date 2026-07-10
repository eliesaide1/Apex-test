// Central API helpers. Change BASE if the backend runs elsewhere.
export const BASE = "http://localhost:8000";
export const WS_BASE = "ws://localhost:8000";

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
      headers: { "Content-Type": "application/json" },
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
    await fetch(`${BASE}/api/snapshot`, { method: "POST", body: fd });
  } catch {
    /* best-effort */
  }
}

export async function heartbeat(sessionId) {
  try {
    const fd = new FormData();
    fd.append("session_id", sessionId);
    await fetch(`${BASE}/api/heartbeat`, { method: "POST", body: fd });
  } catch {
    /* best-effort */
  }
}

// Live-frame URL for the proctor view. `bust` forces the browser to refetch.
export function snapshotUrl(sessionId, bust) {
  return `${BASE}/api/snapshot/${sessionId}?t=${bust}`;
}

export async function submit(sessionId, answers) {
  const r = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, answers }),
  });
  if (!r.ok) throw new Error("Submit failed");
  return r.json();
}

export async function fetchSessions() {
  const r = await fetch(`${BASE}/api/sessions`);
  return r.json();
}
