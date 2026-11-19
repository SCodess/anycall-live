// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone,
  PhoneCall,
  PhoneDisconnect,
  Microphone,
  MicrophoneSlash,
  Users,
  Clock,
  ClockCounterClockwise,
  WifiHigh,
  WifiNone,
  Circle,
  ArrowRight,
  X,
} from "@phosphor-icons/react";

const SIGNALING_SERVER =
  import.meta.env.VITE_SIGNALING_SERVER || "http://localhost:3000";

const socket = io(SIGNALING_SERVER, {
  autoConnect: true,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

try {
  window.__SIGNAL_SOCKET = socket;
} catch (e) {}

/*
 * Voice-call audio profile
 * ------------------------
 * - 48 kHz mono capture (Opus native rate) with echo / noise removal + AGC.
 * - Opus tuned for speech: in-band FEC on, DTX off, 96 kbps ceiling.
 * - Lowest possible receiver jitter buffer for delay.
 * - Public STUN + TURN fallback so the media path is direct whenever possible.
 */
const ICE_SERVERS = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
      "stun:stun.cloudflare.com:3478",
    ],
  },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    voiceIsolation: { ideal: true },
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
    latency: { ideal: 0 },
  },
  video: false,
};

const OPUS_PARAMS = {
  minptime: "10",
  useinbandfec: "1",
  usedtx: "0",
  maxaveragebitrate: "96000",
  stereo: "0",
  "sprop-stereo": "0",
};

function tuneOpusSdp(sdp) {
  if (!sdp) return sdp;
  const rtpmap = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
  if (!rtpmap) return sdp;

  const pt = rtpmap[1];
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const extra = Object.entries(OPUS_PARAMS)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");

  if (fmtpRe.test(sdp)) {
    return sdp.replace(fmtpRe, (line, existing) => {
      const kept = existing
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !(p.split("=")[0] in OPUS_PARAMS));
      return `a=fmtp:${pt} ${[...kept, extra].join(";")}`;
    });
  }

  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt}\\s+opus/48000/2[^\\r\\n]*)`),
    `$1\r\na=fmtp:${pt} ${extra}`
  );
}

function preferOpus(pc) {
  try {
    if (typeof RTCRtpSender === "undefined" || !RTCRtpSender.getCapabilities) {
      return;
    }
    const caps = RTCRtpSender.getCapabilities("audio");
    if (!caps || !caps.codecs || !caps.codecs.length) return;

    const opus = caps.codecs.filter((c) => /opus/i.test(c.mimeType));
    const rest = caps.codecs.filter((c) => !/opus/i.test(c.mimeType));
    if (!opus.length) return;

    const ordered = [...opus, ...rest];
    pc.getTransceivers().forEach((transceiver) => {
      try {
        transceiver.setCodecPreferences(ordered);
      } catch (e) {}
    });
  } catch (e) {}
}

async function applyAudioSenderParams(pc) {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "audio") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 96000;
      params.encodings[0].priority = "high";
      params.encodings[0].networkPriority = "high";
      await sender.setParameters(params);
    } catch (e) {}
  }
}

function tuneAudioReceivers(pc) {
  if (!pc) return;
  pc.getReceivers().forEach((receiver) => {
    if (receiver.track && receiver.track.kind !== "audio") return;
    try {
      receiver.jitterBufferTarget = 0;
    } catch (e) {}
    try {
      receiver.playoutDelayHint = 0;
    } catch (e) {}
  });
}

function plainSdp(description) {
  if (!description) return null;
  return { type: description.type, sdp: description.sdp };
}

async function playAudioElement(el, tries = 3) {
  if (!el) return false;
  el.muted = false;
  el.volume = 1;
  for (let i = 0; i < tries; i++) {
    try {
      await el.play();
      return true;
    } catch (e) {
      if (i < tries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  return false;
}

// Audio Visualizer Component
const AudioVisualizer = ({ active }) => {
  const heights = [18, 30, 22, 34, 16];
  return (
    <div className="visualizer-container">
      {heights.map((height, i) => (
        <motion.div
          key={i}
          className="visualizer-bar"
          animate={
            active
              ? { height: [8, height, 8], opacity: 0.85 }
              : { height: 8, opacity: 0.4 }
          }
          transition={{
            duration: 0.55 + i * 0.06,
            repeat: active ? Infinity : 0,
            repeatType: "reverse",
            delay: i * 0.08,
          }}
        />
      ))}
    </div>
  );
};

export default function App() {
  const remoteAudioRef = useRef(null);
  const chatBoxRef = useRef(null);
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const lastRemoteStreamIdRef = useRef(null);
  const disconnectTimerRef = useRef(null);

  const pendingSDPRef = useRef([]);
  const pendingCandidatesRef = useRef([]);

  const localIdRef = useRef(null);
  const currentPartnerRef = useRef(null);
  const autoActiveRef = useRef(false);
  const allowIncomingRef = useRef(true);
  const preparingRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [isInCall, setIsInCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [onlineList, setOnlineList] = useState([]);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyList, setHistoryList] = useState([]);
  const [autoActive, setAutoActive] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [partnerId, setPartnerId] = useState(null);
  const [allowIncoming, setAllowIncoming] = useState(true);

  useEffect(() => {
    autoActiveRef.current = autoActive;
  }, [autoActive]);

  useEffect(() => {
    allowIncomingRef.current = allowIncoming;
  }, [allowIncoming]);

  // Call duration timer
  useEffect(() => {
    let interval;
    if (isInCall) {
      interval = setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(interval);
  }, [isInCall]);

  // Keep the newest message visible
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages]);

  // Browsers may block audio until the first tap/click. Unlock the remote
  // element on the first user gesture so the other person is heard instantly.
  useEffect(() => {
    const unlock = () => {
      playAudioElement(remoteAudioRef.current);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  function debug(...args) {
    console.debug("[anycall]", ...args);
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }

  function shortId(id) {
    if (!id) return "anon";
    return id.slice(0, 6);
  }

  function fmtTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString();
  }

  function setPartner(id) {
    currentPartnerRef.current = id || null;
    setPartnerId(id || null);
  }

  // Only real chat messages ever go into the chat box. There are no system
  // log lines, no sender labels and no other text in that panel.
  function addMessage({ text: body, me }) {
    if (typeof body !== "string" || !body.trim()) return;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: body,
      me: !!me,
      time: Date.now(),
    };
    setMessages((prev) => [...prev, message]);
  }

  function flushPendingCandidatesFor(peerId) {
    const remaining = [];
    for (const item of pendingCandidatesRef.current) {
      if (!item.from || item.from === peerId) {
        try {
          if (pcRef.current && pcRef.current.signalingState !== "closed") {
            pcRef.current.addIceCandidate(
              new RTCIceCandidate(item.candidate)
            );
          } else {
            remaining.push(item);
          }
        } catch (e) {
          remaining.push(item);
        }
      } else {
        remaining.push(item);
      }
    }
    pendingCandidatesRef.current = remaining;
  }

  function setupDataChannel(dc) {
    dcRef.current = dc;

    dc.onopen = () => {
      setChatReady(true);
      debug("data channel open");
    };
    dc.onclose = () => {
      if (pcRef.current && pcRef.current.connectionState === "connected") {
        // Media is still up, so server-side chat fallback keeps working.
        setChatReady(true);
      } else {
        setChatReady(false);
      }
      debug("data channel closed");
    };
    dc.onerror = () => debug("data channel error");
    dc.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data);
        if (
          payload &&
          payload.type === "chat" &&
          typeof payload.text === "string"
        ) {
          addMessage({ text: payload.text, me: false });
        }
      } catch (e) {
        // Ignore non-chat payloads.
      }
    };
  }

  function cleanupPeer() {
    try {
      if (dcRef.current) {
        try {
          dcRef.current.close();
        } catch (e) {}
        dcRef.current = null;
      }

      if (pcRef.current) {
        const pc = pcRef.current;
        pcRef.current = null;
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.ondatachannel = null;
        pc.onconnectionstatechange = null;
        try {
          pc.close();
        } catch (e) {}
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (e) {}
        });
        localStreamRef.current = null;
      }

      lastRemoteStreamIdRef.current = null;
    } catch (e) {
      debug("cleanupPeer error", e);
    }
  }

  function cleanupCall() {
    setIsInCall(false);
    setIncomingCall(null);
    setIsMuted(false);
    setChatReady(false);
    setPartner(null);

    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }

    pendingSDPRef.current = [];
    pendingCandidatesRef.current = [];

    if (remoteAudioRef.current) {
      try {
        remoteAudioRef.current.pause();
      } catch (e) {}
      remoteAudioRef.current.srcObject = null;
    }

    cleanupPeer();
    debug("call cleaned up");
  }

  async function createPeerWithMic(isCaller) {
    cleanupPeer();
    setChatReady(false);
    // Starting a new call clears the previous conversation so a new random
    // partner can never see the old 1-to-1 chat.
    setMessages([]);

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    pcRef.current = pc;

    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    pc.ontrack = async (event) => {
      const stream =
        event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);

      if (lastRemoteStreamIdRef.current === stream.id) return;
      lastRemoteStreamIdRef.current = stream.id;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 1;
        await playAudioElement(remoteAudioRef.current);
      }
      tuneAudioReceivers(pc);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && currentPartnerRef.current) {
        socket.emit("signal", {
          to: currentPartnerRef.current,
          data: { candidate: event.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      debug("connection state", state);

      if (state === "connected") {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        setIsInCall(true);
        setChatReady(true);
        tuneAudioReceivers(pc);
        applyAudioSenderParams(pc);
      } else if (state === "disconnected") {
        // Give ICE a few seconds to recover before dropping the call.
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = setTimeout(() => {
          if (pcRef.current === pc && pc.connectionState === "disconnected") {
            cleanupCall();
          }
        }, 10000);
      } else if (state === "failed") {
        cleanupCall();
      }
    };

    if (isCaller) {
      try {
        const dc = pc.createDataChannel("chat", { ordered: true });
        setupDataChannel(dc);
      } catch (e) {
        debug("createDataChannel failed", e);
      }
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      if (pcRef.current === pc) {
        cleanupPeer();
      } else {
        try {
          pc.close();
        } catch (e) {}
      }
      throw err;
    }

    // The call may have been ended while the mic permission prompt was open.
    if (pcRef.current !== pc) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      try {
        pc.close();
      } catch (e) {}
      throw new Error("Call cancelled");
    }

    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => {
      try {
        track.contentHint = "speech";
      } catch (e) {}
    });
    stream.getTracks().forEach((track) => {
      try {
        pc.addTrack(track, stream);
      } catch (e) {
        debug("addTrack failed", e);
      }
    });

    preferOpus(pc);
    tuneAudioReceivers(pc);
    debug("microphone ready", { caller: isCaller });
    return pc;
  }

  async function startOfferFlow(targetId) {
    if (!targetId) return;
    setPartner(targetId);

    let pc;
    try {
      pc = await createPeerWithMic(true);
    } catch (err) {
      if (!err || err.message !== "Call cancelled") {
        socket.emit("call-reject", {
          to: targetId,
          from: localIdRef.current,
        });
        cleanupCall();
      }
      return;
    }

    if (pcRef.current !== pc) return;

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription({
      type: offer.type,
      sdp: tuneOpusSdp(offer.sdp),
    });

    socket.emit("signal", {
      to: targetId,
      data: { sdp: plainSdp(pc.localDescription) },
    });

    tuneAudioReceivers(pc);
    applyAudioSenderParams(pc);
  }

  async function handleSignal({ id, data }) {
    if (!data) return;
    try {
      if (data.sdp) {
        const description = new RTCSessionDescription(data.sdp);

        if (description.type === "offer") {
          // If the callee is still preparing (mic permission prompt), wait for
          // that same peer instead of creating a second one.
          if (!pcRef.current && preparingRef.current) {
            try {
              await preparingRef.current;
            } catch (e) {}
          }

          if (!pcRef.current) {
            try {
              await createPeerWithMic(false);
            } catch (e) {
              socket.emit("call-reject", {
                to: id,
                from: localIdRef.current,
              });
              return;
            }
          }

          const pc = pcRef.current;
          if (!pc || pc.signalingState !== "stable") {
            pendingSDPRef.current.push({ sdp: data.sdp, from: id });
            return;
          }

          setPartner(id);
          await pc.setRemoteDescription(description);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription({
            type: answer.type,
            sdp: tuneOpusSdp(answer.sdp),
          });

          socket.emit("signal", {
            to: id,
            data: { sdp: plainSdp(pc.localDescription) },
          });

          tuneAudioReceivers(pc);
          applyAudioSenderParams(pc);
          flushPendingCandidatesFor(id);
          return;
        }

        if (description.type === "answer") {
          if (!pcRef.current) {
            pendingSDPRef.current.push({ sdp: data.sdp, from: id });
            return;
          }

          const pc = pcRef.current;
          const signalingState = pc.signalingState;
          if (
            signalingState === "have-local-offer" ||
            signalingState === "have-remote-offer"
          ) {
            setPartner(id);
            await pc.setRemoteDescription(description);
            tuneAudioReceivers(pc);
            applyAudioSenderParams(pc);
            flushPendingCandidatesFor(id);
          } else {
            pendingSDPRef.current.push({ sdp: data.sdp, from: id });
          }
          return;
        }
      }

      if (data.candidate) {
        if (!pcRef.current || pcRef.current.signalingState === "closed") {
          pendingCandidatesRef.current.push({
            candidate: data.candidate,
            from: id,
          });
          return;
        }
        try {
          await pcRef.current.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        } catch (e) {
          pendingCandidatesRef.current.push({
            candidate: data.candidate,
            from: id,
          });
        }
      }
    } catch (e) {
      debug("signal handler error", e);
    }
  }

  useEffect(() => {
    function onConnect() {
      localIdRef.current = socket.id;
      setConnected(true);
      debug("socket connected", socket.id);
    }

    function onDisconnect() {
      setConnected(false);
      debug("socket disconnected");
    }

    function onPresence({ list }) {
      setOnlineList(list || []);
    }

    function onHistory({ list }) {
      setHistoryList(list || []);
      setHistoryVisible(true);
    }

    async function onCallInvite({ from }) {
      if (!from) return;

      if (!allowIncomingRef.current) {
        socket.emit("call-reject", { to: from, from: localIdRef.current });
        return;
      }

      const busy =
        currentPartnerRef.current &&
        currentPartnerRef.current !== from &&
        pcRef.current;
      if (busy) {
        socket.emit("call-reject", { to: from, from: localIdRef.current });
        return;
      }

      setPartner(from);

      if (autoActiveRef.current) {
        if (!(pcRef.current && currentPartnerRef.current === from)) {
          try {
            await createPeerWithMic(false);
          } catch (e) {
            socket.emit("call-reject", {
              to: from,
              from: localIdRef.current,
            });
            setPartner(null);
            return;
          }
        }
        socket.emit("call-accept", {
          to: from,
          from: localIdRef.current,
        });
        setIncomingCall(null);
        return;
      }

      setIncomingCall({ from });
    }

    async function onAutoReady({ from }) {
      if (!from) return;
      if (pcRef.current && currentPartnerRef.current === from) return;

      setPartner(from);
      let preparation = null;
      try {
        preparation = createPeerWithMic(false);
        preparingRef.current = preparation;
        await preparation;
      } catch (e) {
        if (e && e.message !== "Call cancelled") {
          socket.emit("call-reject", { to: from, from: localIdRef.current });
          setPartner(null);
        }
      } finally {
        if (preparingRef.current === preparation) {
          preparingRef.current = null;
        }
      }
    }

    function onCallAccept({ from }) {
      if (!from) return;
      setPartner(from);
      startOfferFlow(from).catch((e) => debug("startOfferFlow error", e));
    }

    function onCallReject({ from }) {
      if (currentPartnerRef.current === from) cleanupCall();
    }

    function onCallHangup() {
      cleanupCall();
    }

    function onChat(payload) {
      if (!payload) return;
      const body =
        typeof payload.text === "string" ? payload.text : payload.message;
      const from = payload.from || payload.sender;
      if (typeof body !== "string" || !body.trim()) return;
      if (currentPartnerRef.current && from && from !== currentPartnerRef.current) {
        return;
      }
      addMessage({ text: body, me: false });
    }

    function onSignal(payload) {
      handleSignal(payload);
    }

    function onAutoComplete() {
      setAutoActive(false);
    }

    function onAutoStopped() {
      setAutoActive(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("presence", onPresence);
    socket.on("history", onHistory);
    socket.on("call-invite", onCallInvite);
    socket.on("auto-ready", onAutoReady);
    socket.on("call-accept", onCallAccept);
    socket.on("call-reject", onCallReject);
    socket.on("call-hangup", onCallHangup);
    socket.on("chat", onChat);
    socket.on("signal", onSignal);
    socket.on("auto-complete", onAutoComplete);
    socket.on("auto-stopped", onAutoStopped);

    // The socket may already be connected before React mounts.
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("presence", onPresence);
      socket.off("history", onHistory);
      socket.off("call-invite", onCallInvite);
      socket.off("auto-ready", onAutoReady);
      socket.off("call-accept", onCallAccept);
      socket.off("call-reject", onCallReject);
      socket.off("call-hangup", onCallHangup);
      socket.off("chat", onChat);
      socket.off("signal", onSignal);
      socket.off("auto-complete", onAutoComplete);
      socket.off("auto-stopped", onAutoStopped);
    };
    // Handlers only use refs and stable setters, so registering once is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function inviteCall(targetId) {
    if (!targetId || !connected) return;
    setPartner(targetId);
    socket.emit("call-invite", {
      to: targetId,
      from: localIdRef.current,
    });
  }

  async function acceptIncoming() {
    if (!incomingCall) return;
    const from = incomingCall.from;
    setPartner(from);

    try {
      await createPeerWithMic(false);
    } catch (err) {
      socket.emit("call-reject", { to: from, from: localIdRef.current });
      setIncomingCall(null);
      setPartner(null);
      return;
    }

    socket.emit("call-accept", { to: from, from: localIdRef.current });
    setIncomingCall(null);
    playAudioElement(remoteAudioRef.current);
  }

  function rejectIncoming() {
    if (!incomingCall) return;
    socket.emit("call-reject", {
      to: incomingCall.from,
      from: localIdRef.current,
    });
    setIncomingCall(null);
    setPartner(null);
  }

  function hangup() {
    const partner = currentPartnerRef.current;
    socket.emit("call-hangup", {
      from: localIdRef.current,
      to: partner || null,
    });
    cleanupCall();
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const tracks = localStreamRef.current.getAudioTracks();
    if (!tracks.length) return;
    const nextMuted = !isMuted;
    tracks.forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }

  function sendChat() {
    const body = text.trim();
    const partner = currentPartnerRef.current;
    if (!body || !partner) return;

    const payload = {
      type: "chat",
      sender: localIdRef.current,
      text: body,
    };

    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(payload));
      } catch (e) {
        socket.emit("chat", { to: partner, text: body });
      }
    } else {
      socket.emit("chat", { to: partner, text: body });
    }

    addMessage({ text: body, me: true });
    setText("");
  }

  function startAutoCall() {
    if (!connected) return;
    autoActiveRef.current = true;
    socket.emit("auto-call-start", { initiator: localIdRef.current });
    setAutoActive(true);
  }

  function stopAutoCall() {
    autoActiveRef.current = false;
    socket.emit("auto-call-stop", { initiator: localIdRef.current });
    setAutoActive(false);
  }

  function requestHistory() {
    socket.emit("get-history");
  }

  return (
    <div className="app-container">
      <div className="ambient-bg">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
      </div>

      <div className="app-content">
        <motion.header
          className="header"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="logo">
            <div className="logo-icon">
              <Phone size={24} weight="fill" />
            </div>
            <span className="logo-text">AnyCall</span>
          </div>
          <div className="status-badge">
            {connected ? (
              <>
                <WifiHigh size={16} color="#10B981" />
                <span>Connected</span>
              </>
            ) : (
              <>
                <WifiNone size={16} color="#EF4444" />
                <span>Disconnected</span>
              </>
            )}
          </div>
        </motion.header>

        <main className="main-content">
          <section className="call-column">
            <AnimatePresence mode="wait">
              {isInCall ? (
                <motion.div
                  key="call-card"
                  className="call-card"
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0 }}
                  transition={{ type: "spring", damping: 20 }}
                >
                  <div className="call-header">
                    <div className="call-avatar">
                      <Circle size={48} weight="fill" />
                      {isInCall && <span className="speaking-indicator"></span>}
                    </div>
                    <div className="call-info">
                      <h2>
                        {partnerId
                          ? `Calling ${shortId(partnerId)}`
                          : "In Call"}
                      </h2>
                      <div className="call-meta">
                        <Clock size={14} />
                        <span>{formatDuration(callDuration)}</span>
                      </div>
                    </div>
                    <AudioVisualizer active={isInCall} />
                  </div>
                  <div className="call-controls">
                    <button
                      className={`control-btn ${isMuted ? "muted" : ""}`}
                      onClick={toggleMute}
                      aria-label={
                        isMuted ? "Unmute microphone" : "Mute microphone"
                      }
                    >
                      {isMuted ? (
                        <MicrophoneSlash size={24} />
                      ) : (
                        <Microphone size={24} />
                      )}
                    </button>
                    <button
                      className="control-btn hangup"
                      onClick={hangup}
                      aria-label="Hang up"
                    >
                      <PhoneDisconnect size={28} weight="fill" />
                    </button>
                  </div>
                </motion.div>
              ) : incomingCall ? (
                <motion.div
                  key="incoming-card"
                  className="incoming-card"
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0 }}
                  transition={{ type: "spring", damping: 20 }}
                >
                  <div className="incoming-header">
                    <div className="ringing-animation">
                      <Circle size={64} weight="fill" />
                      <motion.span
                        className="ring"
                        animate={{ scale: [1, 1.5], opacity: [0.8, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                      />
                      <motion.span
                        className="ring ring-2"
                        animate={{ scale: [1, 1.5], opacity: [0.8, 0] }}
                        transition={{
                          duration: 1.5,
                          repeat: Infinity,
                          delay: 0.3,
                        }}
                      />
                    </div>
                    <div className="incoming-info">
                      <p className="incoming-label">Incoming Call</p>
                      <h2>{shortId(incomingCall.from)}</h2>
                    </div>
                  </div>
                  <div className="incoming-controls">
                    <button className="btn-decline" onClick={rejectIncoming}>
                      <PhoneDisconnect size={20} />
                      Decline
                    </button>
                    <button className="btn-accept" onClick={acceptIncoming}>
                      <Phone size={20} />
                      Accept
                    </button>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="idle-card"
                  className="idle-card"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="idle-content">
                    <div className="idle-icon">
                      <Phone size={48} weight="duotone" />
                    </div>
                    <h1>AnyCall Live</h1>
                    <p>
                      {connected
                        ? `${onlineList.length} online — start Auto Call to connect`
                        : "Connecting..."}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="controls-grid">
              <motion.div
                className="card"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <div className="card-header">
                  <Users size={20} />
                  <span>Online: {onlineList.length}</span>
                </div>
                <div className="card-actions">
                  {autoActive ? (
                    <button className="btn btn-danger" onClick={stopAutoCall}>
                      <PhoneDisconnect size={18} />
                      Stop Auto
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={startAutoCall}
                      disabled={!connected}
                    >
                      <PhoneCall size={18} />
                      Auto Call
                    </button>
                  )}
                  <button className="btn-ghost" onClick={requestHistory}>
                    <ClockCounterClockwise size={18} />
                    History
                  </button>
                </div>
                <div className="card-footer">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={allowIncoming}
                      onChange={(e) => {
                        allowIncomingRef.current = e.target.checked;
                        setAllowIncoming(e.target.checked);
                      }}
                    />
                    Allow incoming calls
                  </label>
                </div>
              </motion.div>
            </div>
          </section>

          <section className="card chat-card" aria-label="1-to-1 chat">
            <div className="chat-messages" ref={chatBoxRef} aria-live="polite">
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    className={`message ${message.me ? "me" : "other"}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    {message.text}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <form
              className="chat-input"
              onSubmit={(event) => {
                event.preventDefault();
                sendChat();
              }}
            >
              <input
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  chatReady
                    ? "Type a message..."
                    : "Connect to a person to chat"
                }
                disabled={!chatReady}
                maxLength={2000}
                autoComplete="off"
              />
              <button
                type="submit"
                className="btn"
                disabled={!chatReady || !text.trim()}
                aria-label="Send message"
              >
                <ArrowRight size={18} />
              </button>
            </form>
          </section>
        </main>
      </div>

      <AnimatePresence>
        {historyVisible && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setHistoryVisible(false)}
          >
            <motion.div
              className="modal-content"
              initial={{ scale: 0.9, y: 50 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 50 }}
              transition={{ type: "spring", damping: 20 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-header">
                <h2>Call History</h2>
                <button
                  className="btn-icon"
                  onClick={() => setHistoryVisible(false)}
                >
                  <X size={20} />
                </button>
              </div>
              <div className="history-list">
                {historyList.length === 0 ? (
                  <div className="empty-state">
                    <ClockCounterClockwise size={48} weight="duotone" />
                    <p>No call history yet</p>
                  </div>
                ) : (
                  historyList.map((item) => (
                    <motion.div
                      key={item.id}
                      className="history-item"
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                    >
                      <div className="history-avatar">
                        <Circle size={24} weight="fill" />
                        {item.online && <span className="online-dot"></span>}
                      </div>
                      <div className="history-info">
                        <span className="history-id">
                          {shortId(item.id)}
                        </span>
                        <span className="history-time">
                          {fmtTime(item.last)}
                        </span>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => inviteCall(item.id)}
                        disabled={!item.online || !connected}
                      >
                        {item.online ? "Call" : "Offline"}
                      </button>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <audio ref={remoteAudioRef} autoPlay playsInline className="remote-audio" />
    </div>
  );
}
