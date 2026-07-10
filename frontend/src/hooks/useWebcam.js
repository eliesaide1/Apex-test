import { useEffect, useRef, useState } from "react";
import { sendSnapshot } from "../api";

/**
 * Phase 2: request the webcam, show a live preview, and upload a JPEG snapshot
 * every `intervalMs`. The backend (Phase 3) runs CV on each frame to detect a
 * phone, a second person, or the candidate looking away.
 */
export function useWebcam(sessionId, { intervalMs = 3000 } = {}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | live | denied | error

  useEffect(() => {
    if (!sessionId) return;
    let stream, timer, cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 }, audio: false,
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus("live");

        timer = setInterval(capture, intervalMs);
      } catch (e) {
        setStatus(e && e.name === "NotAllowedError" ? "denied" : "error");
      }
    })();

    function capture() {
      const v = videoRef.current, c = canvasRef.current;
      if (!v || !c || v.videoWidth === 0) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((blob) => blob && sendSnapshot(sessionId, blob), "image/jpeg", 0.7);
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [sessionId, intervalMs]);

  return { videoRef, canvasRef, status };
}
