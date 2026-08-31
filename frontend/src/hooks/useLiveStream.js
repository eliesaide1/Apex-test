import { useCallback, useEffect, useRef, useState } from "react";
import { candidateWsUrl, fetchRtcConfig } from "../api";

/**
 * Raise the encoder's *starting* bitrate in the offer SDP.
 *
 * WebRTC probes upward from a very conservative default, and with
 * `maintain-framerate` it buys that headroom by cutting resolution. Measured
 * on this app: the live view opened at 320x180 and only reached 720p after
 * ~20 seconds — long enough that a proctor glancing at it just sees a blurry
 * picture and concludes the whole thing is low quality.
 *
 * Telling Chrome to start near the target collapses that ramp. Editing SDP by
 * hand is a blunt instrument, so every step is defensive: anything unexpected
 * and we return the original text untouched rather than risk a broken offer.
 */
function boostStartBitrate(sdp, { start = 1500, min = 600, max = 2500 } = {}) {
  try {
    const lines = sdp.split(/\r\n|\n/);
    const mIndex = lines.findIndex((l) => l.startsWith("m=video"));
    if (mIndex === -1) return sdp;
    // End of the video section = next m= line, or end of SDP.
    let end = lines.findIndex((l, i) => i > mIndex && l.startsWith("m="));
    if (end === -1) end = lines.length;

    // Only real video codecs get these parameters. The video section also
    // carries retransmission and error-correction payloads (rtx / red / ulpfec
    // / flexfec) whose fmtp lines have their own grammar — appending
    // x-google-* to `a=fmtp:97 apt=96` corrupts it, and the far end then
    // rejects the whole offer, which kills the connection outright.
    const CODECS = /^(VP8|VP9|H264|H265|AV1)$/i;
    const payloads = [];
    for (let i = mIndex; i < end; i++) {
      const m = /^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\//.exec(lines[i]);
      if (m && CODECS.test(m[2])) payloads.push(m[1]);
    }
    if (!payloads.length) return sdp;

    const params =
      `x-google-start-bitrate=${start};x-google-min-bitrate=${min};x-google-max-bitrate=${max}`;

    // Walk backwards so inserted lines don't shift the indices still to come.
    for (let i = end - 1; i >= mIndex; i--) {
      const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(lines[i]);
      if (fmtp && payloads.includes(fmtp[1]) && !lines[i].includes("x-google-start-bitrate")) {
        lines[i] = `a=fmtp:${fmtp[1]} ${fmtp[2]};${params}`;
        payloads.splice(payloads.indexOf(fmtp[1]), 1);
      }
    }
    // Codecs that had no fmtp line at all need one created.
    for (const pt of payloads) {
      const at = lines.findIndex((l, i) =>
        i >= mIndex && i < end && l.startsWith(`a=rtpmap:${pt} `));
      if (at !== -1) { lines.splice(at + 1, 0, `a=fmtp:${pt} ${params}`); end += 1; }
    }

    // Bandwidth ceiling for the video section, directly after its c= line.
    const cIndex = lines.findIndex((l, i) => i > mIndex && i < end && l.startsWith("c="));
    if (cIndex !== -1 && !lines.slice(mIndex, end).some((l) => l.startsWith("b=AS:"))) {
      lines.splice(cIndex + 1, 0, `b=AS:${max}`);
    }
    return lines.join("\r\n");
  } catch {
    return sdp;   // never risk a broken offer for a bitrate tweak
  }
}

/**
 * Candidate side of the real-time (WebRTC) view.
 *
 * Holds a signalling WebSocket open for the whole exam. It carries no media and
 * no exam data — the server only uses it to tell us "a proctor wants to watch",
 * and to shuttle SDP/ICE between the two browsers. When a proctor starts
 * watching we publish the SAME camera/mic tracks the snapshot pipeline already
 * uses (no second getUserMedia, so no second permission prompt) and the media
 * flows peer-to-peer, never through the server. That is what makes it real time
 * rather than the ~3s snapshot cadence.
 *
 * Audio is asymmetric on purpose. The candidate's camera and mic go up
 * continuously for as long as a proctor is watching. The return direction
 * carries nothing until the proctor holds their push-to-talk button, and the
 * candidate has no way to talk back: there is no button on this side, and this
 * hook never sends `rtc-talk`. So the candidate hears the proctor only while
 * the proctor chooses to be heard.
 *
 * `talkRef` is a shared {on, lastAt} record the mic pipeline reads, so clips
 * recorded while the proctor was speaking are not judged as the candidate
 * talking (see useWebcam).
 */
export function useLiveStream(sessionId, streamRef, streamReady, pausedRef, talkRef) {
  const [live, setLive] = useState(false);
  // The proctor's voice. Rendered by the exam page as a plain <audio>.
  const proctorAudioRef = useRef(null);
  const [proctorTalking, setProctorTalking] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  // Browsers can refuse to start audio without a user gesture. Never swallow
  // that: the exam page offers a click that retries playback from a real one.
  const playProctorAudio = useCallback(() => {
    const el = proctorAudioRef.current;
    if (!el || !el.srcObject) return;
    el.muted = false;
    el.volume = 1;
    el.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
  }, []);

  useEffect(() => {
    if (!sessionId || !streamReady) return;

    let ws, pc, closed = false, retry;

    const setPaused = (v) => { if (pausedRef) pausedRef.current = v; };

    const setTalking = (on) => {
      if (talkRef) talkRef.current = { on, lastAt: Date.now() };
      setProctorTalking(on);
    };

    const closePeer = () => {
      if (pc) {
        try { pc.close(); } catch { /* already gone */ }
        pc = null;
      }
      const el = proctorAudioRef.current;
      if (el) el.srcObject = null;
      setPaused(false);
      setLive(false);
      // The proctor cannot still be talking to us with the connection gone —
      // leaving this set would suppress the candidate's own talking detection
      // for the rest of the exam.
      setTalking(false);
      setAudioBlocked(false);
    };

    const send = (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    async function startPeer() {
      closePeer();
      const stream = streamRef.current;
      if (!stream) return;

      const { iceServers } = await fetchRtcConfig().catch(() => ({ iceServers: [] }));
      pc = new RTCPeerConnection({ iceServers });

      // The proctor's voice arrives on the return direction of the audio
      // m-line, which they enable when answering. Nothing plays until they
      // actually hold their talk button — until then that direction carries no
      // track at all — so this cannot be used to listen in on the proctor.
      pc.ontrack = (e) => {
        if (e.track.kind !== "audio") return;
        const el = proctorAudioRef.current;
        if (!el) return;
        el.srcObject = e.streams[0] || new MediaStream([e.track]);
        playProctorAudio();
      };

      stream.getTracks().forEach((t) => {
        // Tell the encoder this is moving footage, not a slide deck, so it
        // spends its budget on frame rate instead of still-frame sharpness.
        if (t.kind === "video") t.contentHint = "motion";
        pc.addTrack(t, stream);
      });

      pc.onicecandidate = (e) => {
        if (e.candidate) send({ kind: "rtc-ice", candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        const connected = pc.connectionState === "connected";
        setLive(connected);
        setPaused(connected);   // suspend snapshot uploads while streaming
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          setLive(false);
          setPaused(false);
        }
      };

      const offer = await pc.createOffer();
      offer.sdp = boostStartBitrate(offer.sdp);
      await pc.setLocalDescription(offer);

      // Without this the encoder picks a conservative default bitrate and will
      // trade frame rate away first — which reads as a laggy, stuttering
      // picture. `maintain-framerate` tells it to drop resolution instead, so
      // motion stays smooth on a constrained uplink.
      const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (videoSender) {
        const params = videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 2_500_000;   // 2.5 Mbps ceiling
        params.encodings[0].maxFramerate = 30;
        params.degradationPreference = "maintain-framerate";
        await videoSender.setParameters(params).catch(() => {
          /* older browsers ignore some of these — not fatal */
        });
      }
      send({ kind: "rtc-offer", sdp: pc.localDescription.sdp,
             type: pc.localDescription.type });
    }

    function connect() {
      ws = new WebSocket(candidateWsUrl());

      ws.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.kind === "rtc-start") {
          // Tell the proctor when we cannot publish. Swallowing this meant the
          // offer was simply never sent, and their dashboard waited on a
          // connection that was never coming.
          startPeer().catch((err) => {
            send({ kind: "rtc-error", detail: String(err?.message || err).slice(0, 200) });
            closePeer();
          });
        } else if (msg.kind === "rtc-stop") {
          closePeer();
        } else if (msg.kind === "rtc-answer" && pc) {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
            .catch(() => {});
        } else if (msg.kind === "rtc-ice" && pc && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.kind === "rtc-talk") {
          setTalking(!!msg.on);
          // A track that arrived while playback was blocked stays silent until
          // something calls play() again; a fresh press is the natural moment.
          if (msg.on) playProctorAudio();
        }
      };

      // Keep the socket alive through proxies, and reconnect if it drops so a
      // proctor can still start watching later in the exam.
      const ping = setInterval(() => send({ kind: "ping" }), 25000);
      ws.onclose = () => {
        clearInterval(ping);
        closePeer();
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      closePeer();
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [sessionId, streamRef, streamReady, talkRef, playProctorAudio]);

  return { live, proctorAudioRef, proctorTalking, audioBlocked,
           enableProctorAudio: playProctorAudio };
}
