import { useEffect, useRef, useState } from "react";
import { sendFlag, heartbeat } from "../api";

/**
 * Client-side anti-cheating guards for the browser.
 *
 * What a browser CAN do (implemented here): detect tab/window switches, focus
 * loss, fullscreen exit, right-click, copy/cut/paste, and common shortcut &
 * PrintScreen keys — then warn the candidate and log a flag to the backend.
 *
 * What a browser CANNOT do (by design): truly block OS screenshots, kill
 * AnyDesk/TeamViewer, or stop the user from leaving the OS. Those need a
 * native/kiosk wrapper (Electron/Tauri) — the webcam AI (Phase 3) is what
 * actually catches that class of cheating.
 */
export function useProctoring(sessionId, { maxWarnings = 5, onForceSubmit, active = true } = {}) {
  const [warnings, setWarnings] = useState(0);
  const [lastEvent, setLastEvent] = useState(null);
  const warnRef = useRef(0);
  const awayAtRef = useRef(null);   // when the candidate left the exam view

  // Kept current every render so the listeners (attached once) see live state
  // without re-subscribing. Navigation guards only count while `active`, i.e.
  // once the camera+mic are granted and the exam is really running — this stops
  // the startup permission-prompt / fullscreen cascade from firing false flags.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!sessionId) return;
    let blurTimer = null;

    function flag(type, detail, severity = "medium") {
      warnRef.current += 1;
      setWarnings(warnRef.current);
      setLastEvent({ type, detail, at: Date.now() });
      sendFlag(sessionId, type, detail, severity);
      if (warnRef.current >= maxWarnings && onForceSubmit) onForceSubmit(type);
    }

    // Mark the start of a drop-off (leaving the exam view). No-op until active.
    function markAway(type, detail) {
      if (!activeRef.current) return;
      if (awayAtRef.current == null) awayAtRef.current = Date.now();
      flag(type, detail, "high");
    }
    // Candidate returned — log how long they were gone.
    function markReturn() {
      if (awayAtRef.current == null) return;
      const secs = Math.round((Date.now() - awayAtRef.current) / 1000);
      awayAtRef.current = null;
      const sev = secs >= 10 ? "high" : "medium";
      // away_return carries the drop-off duration for the proctor timeline
      sendFlag(sessionId, "away_return", `Returned after ${secs}s away`, sev);
      setLastEvent({ type: "away_return", detail: `Away ${secs}s`, at: Date.now() });
    }

    // Tab hidden / minimized (a real tab switch — logged immediately).
    const onVisibility = () => {
      if (document.hidden) markAway("tab_switch", "Tab hidden / switched away");
      else markReturn();
    };
    // Window lost focus (alt-tab). Debounced: only counts if it stays unfocused
    // ~1.5s, so a notification / permission prompt / quick blip doesn't flag.
    const onBlur = () => {
      if (!activeRef.current) return;
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => markAway("focus_loss", "Window lost focus"), 1500);
    };
    const onFocus = () => { clearTimeout(blurTimer); markReturn(); };
    // Fullscreen exited (ignored until the exam is active).
    const onFullscreenChange = () => {
      if (!activeRef.current) return;
      if (!document.fullscreenElement)
        flag("fullscreen_exit", "Left fullscreen", "high");
    };
    // Right-click
    const onContextMenu = (e) => {
      e.preventDefault();
      flag("context_menu", "Right-click blocked", "low");
    };
    // Copy / cut / paste
    const onCopy = (e) => { e.preventDefault(); flag("copy", "Copy blocked", "medium"); };
    const onCut = (e) => { e.preventDefault(); flag("cut", "Cut blocked", "medium"); };
    const onPaste = (e) => { e.preventDefault(); flag("paste", "Paste blocked", "medium"); };

    // Key-based: PrintScreen, devtools, print, save, common exfil shortcuts
    const onKeyDown = (e) => {
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      if (k === "PrintScreen") {
        flag("printscreen", "PrintScreen pressed", "high");
        // best-effort: clobber whatever just went to the clipboard
        navigator.clipboard?.writeText("").catch(() => {});
      }
      if (k === "F12") { e.preventDefault(); flag("devtools", "F12 blocked", "high"); }
      if (ctrl && e.shiftKey && (k === "I" || k === "J" || k === "C")) {
        e.preventDefault(); flag("devtools", `Ctrl+Shift+${k} blocked`, "high");
      }
      if (ctrl && (k === "p" || k === "P")) { e.preventDefault(); flag("print", "Print blocked", "medium"); }
      if (ctrl && (k === "s" || k === "S")) { e.preventDefault(); flag("save", "Save blocked", "low"); }
      if (ctrl && (k === "u" || k === "U")) { e.preventDefault(); flag("view_source", "View source blocked", "low"); }
      // Win+Shift+S (Windows snip) — can't truly block, but log the attempt
      if (e.metaKey && e.shiftKey && (k === "s" || k === "S")) {
        flag("snip_attempt", "Win+Shift+S (snip) attempt", "high");
      }
    };

    // Heartbeat so the proctor dashboard can tell "online" from "dropped off".
    heartbeat(sessionId);
    const hb = setInterval(() => heartbeat(sessionId), 5000);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      clearInterval(hb);
      clearTimeout(blurTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionId, maxWarnings, onForceSubmit]);

  return { warnings, lastEvent, maxWarnings };
}

/** Request fullscreen; returns true on success. */
export async function enterFullscreen(el = document.documentElement) {
  try {
    await el.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    return false;
  }
}
