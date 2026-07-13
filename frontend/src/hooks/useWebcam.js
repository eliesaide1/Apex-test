import { useEffect, useRef, useState } from "react";
import { sendSnapshot } from "../api";

/**
 * Request the webcam AND microphone, show a live video preview, and upload a JPEG
 * snapshot every `intervalMs` for the proctor / CV pipeline.
 *
 * Both devices are REQUIRED. We monitor each track's liveness so the exam can
 * hide the questions the moment the camera or mic is turned off, and reveal them
 * again once both are back. Reliable "off" signals: permission revoked, device
 * unplugged, or track stopped/muted. (A browser cannot always detect an OS-level
 * soft-mute for privacy reasons — that's a platform limitation.)
 *
 * Returns:
 *   videoRef, canvasRef  — attach to <video>/<canvas>
 *   camStatus, micStatus — "idle" | "live" | "denied" | "error" | "off"
 *   camOn, micOn         — booleans for gating
 */
export function useWebcam(sessionId, { intervalMs = 3000 } = {}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [camStatus, setCamStatus] = useState("idle");
  const [micStatus, setMicStatus] = useState("idle");

  useEffect(() => {
    if (!sessionId) return;
    let stream, timer, poll, cancelled = false;

    const trackLive = (t) => !!t && t.readyState === "live" && !t.muted;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
          audio: true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const vTrack = stream.getVideoTracks()[0];
        const aTrack = stream.getAudioTracks()[0];

        const sync = () => {
          setCamStatus(trackLive(vTrack) ? "live" : "off");
          setMicStatus(trackLive(aTrack) ? "live" : "off");
        };
        sync();

        // React to hardware/permission changes on either track.
        [vTrack, aTrack].forEach((t) => {
          if (!t) return;
          t.addEventListener("ended", sync);
          t.addEventListener("mute", sync);
          t.addEventListener("unmute", sync);
        });
        // Belt-and-suspenders: some browsers don't fire mute/unmute reliably.
        poll = setInterval(sync, 1000);

        timer = setInterval(capture, intervalMs);
      } catch (e) {
        const denied = e && e.name === "NotAllowedError";
        setCamStatus(denied ? "denied" : "error");
        setMicStatus(denied ? "denied" : "error");
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
      clearInterval(poll);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [sessionId, intervalMs]);

  const camOn = camStatus === "live";
  const micOn = micStatus === "live";
  return { videoRef, canvasRef, camStatus, micStatus, camOn, micOn };
}
