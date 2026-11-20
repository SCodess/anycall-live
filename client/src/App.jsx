// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone,
  PhoneCall,
  PhoneDisconnect,
  PhoneIncoming,
  PhoneOutgoing,
  Microphone,
  MicrophoneSlash,
  Users,
  Clock,
  ClockCounterClockwise,
  WifiHigh,
  WifiNone,
  ArrowRight,
  X,
  UserPlus,
  Flag,
  Prohibit,
  Funnel,
  Gear,
  ChatCircleDots,
  MagnifyingGlass,
  Check,
  Globe,
  Sparkle,
  GameController,
  ShieldCheck,
  CaretRight,
  Plus,
  Trash,
  List,
} from "@phosphor-icons/react";

const SIGNALING_SERVER =
  import.meta.env.VITE_SIGNALING_SERVER || "http://localhost:3000";
const API_BASE = SIGNALING_SERVER.replace(/\/$/, "");
const TOKEN_KEY = "anycall.guest.token";
const ADMIN_KEY = "anycall.admin.token";

const socket = io(SIGNALING_SERVER, {
  autoConnect: false,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

try {
  window.__SIGNAL_SOCKET = socket;
} catch (e) {}

/* -------------------------------------------------------------------------- */
/* Voice-call audio profile                                                    */
/* -------------------------------------------------------------------------- */
const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

const CUSTOM_TURN_URL = (import.meta.env.VITE_TURN_URL || "").trim();
const CUSTOM_TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || "";
const CUSTOM_TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL || "";

const ICE_SERVERS = [{ urls: STUN_SERVERS }];

if (CUSTOM_TURN_URL) {
  ICE_SERVERS.push({
    urls: CUSTOM_TURN_URL.split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    username: CUSTOM_TURN_USERNAME,
    credential: CUSTOM_TURN_CREDENTIAL,
  });
} else {
  console.warn(
    "[anycall] No TURN server configured. Calls across symmetric NAT may fail."
  );
}

try {
  window.__ANY_CALL_ICE = ICE_SERVERS;
} catch (e) {}

const CONNECT_TIMEOUT_MS = 20000;
const DISCONNECT_GRACE_MS = 6000;
const MAX_BUFFERED_CANDIDATES = 100;

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

/* -------------------------------------------------------------------------- */
/* UI helpers                                                                  */
/* -------------------------------------------------------------------------- */
async function apiRequest(path, { method = "GET", token, body, admin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers["x-admin-token"] = admin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err };
  }
}

const COUNTRIES = [
  ["BD", "Bangladesh"],
  ["IN", "India"],
  ["PK", "Pakistan"],
  ["NP", "Nepal"],
  ["LK", "Sri Lanka"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["IE", "Ireland"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["NL", "Netherlands"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["FI", "Finland"],
  ["DK", "Denmark"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["TR", "Turkey"],
  ["AE", "United Arab Emirates"],
  ["SA", "Saudi Arabia"],
  ["QA", "Qatar"],
  ["EG", "Egypt"],
  ["NG", "Nigeria"],
  ["ZA", "South Africa"],
  ["KE", "Kenya"],
  ["BR", "Brazil"],
  ["AR", "Argentina"],
  ["MX", "Mexico"],
  ["CL", "Chile"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["JP", "Japan"],
  ["KR", "South Korea"],
  ["CN", "China"],
  ["SG", "Singapore"],
  ["MY", "Malaysia"],
  ["ID", "Indonesia"],
  ["PH", "Philippines"],
  ["TH", "Thailand"],
  ["VN", "Vietnam"],
  ["RU", "Russia"],
  ["UA", "Ukraine"],
  ["IL", "Israel"],
  ["IR", "Iran"],
  ["IQ", "Iraq"],
];

const COUNTRY_NAMES = new Map(COUNTRIES);
const INTERESTS = [
  "Music",
  "Gaming",
  "Movies",
  "Travel",
  "Sports",
  "Food",
  "Tech",
  "Art",
  "Books",
  "Anime",
  "Nature",
  "Fitness",
];

const GENDERS = [
  ["any", "Any"],
  ["female", "Female"],
  ["male", "Male"],
  ["other", "Other"],
];

function flagOf(code) {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🌐";
  try {
    return String.fromCodePoint(
      ...[...code.toUpperCase()].map((char) => 127397 + char.charCodeAt(0))
    );
  } catch (e) {
    return "🌐";
  }
}

function countryName(code) {
  if (!code) return "Unknown country";
  return COUNTRY_NAMES.get(code) || code.toUpperCase();
}

function initialsOf(name) {
  if (!name) return "??";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function genderLabel(value) {
  if (value === "male") return "Male";
  if (value === "female") return "Female";
  if (value === "other") return "Other";
  return "";
}

function formatDuration(seconds) {
  const total = Math.max(0, seconds || 0);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return `${hours}:${String(rest).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatWhen(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const delta = Date.now() - date.getTime();
  if (delta < 60 * 1000) return "Just now";
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 24 * 60 * 60 * 1000) {
    return `${Math.floor(delta / 3600000)}h ago`;
  }
  if (delta < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(delta / 86400000)}d ago`;
  }
  return date.toLocaleDateString();
}

function normalizePartner(summary) {
  if (!summary) return null;
  return {
    guestId: summary.guestId || null,
    socketId:
      summary.socketId || (summary.id && !summary.guestId ? summary.id : null),
    name: summary.name || "Someone",
    avatar: Number.isFinite(Number(summary.avatar))
      ? Number(summary.avatar)
      : 0,
    gender: summary.gender || null,
    country: summary.country || null,
    flag: summary.flag || flagOf(summary.country),
    interests: Array.isArray(summary.interests) ? summary.interests : [],
  };
}

const AudioVisualizer = ({ active }) => {
  const heights = [18, 30, 22, 34, 16];
  return (
    <div className="visualizer" aria-hidden="true">
      {heights.map((height, i) => (
        <motion.span
          key={i}
          className="visualizer-bar"
          animate={
            active
              ? { height: [8, height, 8], opacity: 0.9 }
              : { height: 8, opacity: 0.35 }
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

function Avatar({ tone = 0, name = "", size = 48, online, ring }) {
  const safeTone = Math.abs(Number(tone) || 0) % 12;
  return (
    <span
      className={`avatar tone-${safeTone}${online ? " is-online" : ""}${
        ring ? " has-ring" : ""
      }`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="avatar-initials">{initialsOf(name)}</span>
      {online && <span className="avatar-online" />}
    </span>
  );
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

function CountrySelect({ id, value, onChange, anyLabel = "Any country" }) {
  return (
    <select
      id={id}
      className="input select"
      value={value || "any"}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="any">{anyLabel}</option>
      {COUNTRIES.map(([code, name]) => (
        <option key={code} value={code}>
          {flagOf(code)} {name}
        </option>
      ))}
    </select>
  );
}

function InterestPicker({ value, onChange, limit = 8 }) {
  const selected = Array.isArray(value) ? value : [];
  const toggle = (interest) => {
    if (selected.includes(interest)) {
      onChange(selected.filter((item) => item !== interest));
      return;
    }
    if (selected.length >= limit) return;
    onChange([...selected, interest]);
  };
  return (
    <div className="interest-picker">
      {INTERESTS.map((interest) => {
        const active = selected.includes(interest);
        return (
          <button
            key={interest}
            type="button"
            className={`chip ${active ? "active" : ""}`}
            onClick={() => toggle(interest)}
          >
            {active && <Check size={12} weight="bold" />}
            {interest}
          </button>
        );
      })}
    </div>
  );
}

function Modal({ open, onClose, title, subtitle, children, wide }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className={`modal-card${wide ? " wide" : ""}`}
            initial={{ scale: 0.94, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.94, y: 24, opacity: 0 }}
            transition={{ type: "spring", damping: 24, stiffness: 260 }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <div>
                <h2>{title}</h2>
                {subtitle && <p>{subtitle}</p>}
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FilterModal({ open, onClose, filters, onSave, saving }) {
  const [draft, setDraft] = useState({
    gender: "any",
    country: "any",
    interests: [],
  });

  useEffect(() => {
    if (!open) return;
    setDraft({
      gender: (filters && filters.gender) || "any",
      country: (filters && filters.country) || "any",
      interests: Array.isArray(filters && filters.interests)
        ? filters.interests
        : [],
    });
  }, [open, filters]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Match filters"
      subtitle="Filters are mutual. You only match someone when both of you fit."
    >
      <div className="form-grid">
        <label className="field">
          <span>I want to meet</span>
          <select
            className="input select"
            value={draft.gender}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, gender: event.target.value }))
            }
          >
            {GENDERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From country</span>
          <CountrySelect
            value={draft.country}
            onChange={(country) =>
              setDraft((prev) => ({ ...prev, country }))
            }
          />
        </label>
        <div className="field">
          <span>Shared interests</span>
          <InterestPicker
            value={draft.interests}
            onChange={(interests) =>
              setDraft((prev) => ({ ...prev, interests }))
            }
          />
          <small className="field-hint">
            At least one of these must overlap with the other person.
          </small>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={saving}
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving…" : "Save filters"}
        </button>
      </div>
    </Modal>
  );
}

function ReportModal({ open, onClose, partner, onSubmit, sending }) {
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");

  useEffect(() => {
    if (open) {
      setReason("harassment");
      setDetails("");
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Report ${partner?.name || "this person"}`}
      subtitle="Reports go to moderators with the guest identity and call id."
    >
      <div className="form-grid">
        <label className="field">
          <span>Reason</span>
          <select
            className="input select"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          >
            <option value="harassment">Harassment</option>
            <option value="sexual-content">Sexual content</option>
            <option value="hate">Hate speech</option>
            <option value="spam">Spam or scam</option>
            <option value="underage">Underage user</option>
            <option value="other">Something else</option>
          </select>
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea
            className="input textarea"
            value={details}
            maxLength={500}
            rows={4}
            placeholder="What happened?"
            onChange={(event) => setDetails(event.target.value)}
          />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={sending}
          onClick={() => onSubmit({ reason, details })}
        >
          {sending ? "Sending…" : "Send report"}
        </button>
      </div>
    </Modal>
  );
}

function BlockModal({ open, onClose, partner, onConfirm, sending }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Block ${partner?.name || "this person"}?`}
      subtitle="They will never be matched with you again. Your friendship is removed."
    >
      <div className="confirm-box">
        <Prohibit size={28} />
        <p>
          Blocking is mutual: neither of you can call, match or send friend
          requests to the other.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={sending}
          onClick={onConfirm}
        >
          {sending ? "Blocking…" : "Block person"}
        </button>
      </div>
    </Modal>
  );
}

const NAV_ITEMS = [
  { id: "call", label: "Call", icon: Phone },
  { id: "friends", label: "Friends", icon: Users },
  { id: "history", label: "History", icon: ClockCounterClockwise },
  { id: "games", label: "Games", icon: GameController },
  { id: "profile", label: "Profile", icon: Gear },
];

export default function App() {
  const remoteAudioRef = useRef(null);
  const chatBoxRef = useRef(null);
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const lastRemoteStreamIdRef = useRef(null);
  const disconnectTimerRef = useRef(null);
  const connectTimerRef = useRef(null);
  const iceRestartCountRef = useRef(0);
  const pendingCandidatesRef = useRef([]);

  const localIdRef = useRef(null);
  const currentPartnerRef = useRef(null);
  const callIdRef = useRef(null);
  const autoActiveRef = useRef(false);
  const allowIncomingRef = useRef(true);
  const preparingRef = useRef(null);
  const hadConnectedRef = useRef(false);
  const restoreAutoRef = useRef(false);
  const recoveringRef = useRef(false);
  const tokenRef = useRef("");
  const profileRef = useRef(null);
  const presenceRef = useRef([]);
  const toastTimerRef = useRef(null);

  const [profile, setProfile] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [connected, setConnected] = useState(false);
  const [identified, setIdentified] = useState(false);
  const [banned, setBanned] = useState(null);

  const [presence, setPresence] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [isInCall, setIsInCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [autoActive, setAutoActive] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [partner, setPartner] = useState(null);
  const [partnerId, setPartnerId] = useState(null);
  const [callNotice, setCallNotice] = useState("");

  const [tab, setTab] = useState("call");
  const [navOpen, setNavOpen] = useState(false);
  const [friends, setFriends] = useState({
    friends: [],
    incoming: [],
    outgoing: [],
  });
  const [historyList, setHistoryList] = useState([]);
  const [blocks, setBlocks] = useState([]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [sendingReport, setSendingReport] = useState(false);
  const [sendingBlock, setSendingBlock] = useState(false);
  const [toast, setToast] = useState(null);

  const [adminToken, setAdminToken] = useState(() => {
    try {
      return sessionStorage.getItem(ADMIN_KEY) || "";
    } catch (e) {
      return "";
    }
  });
  const [adminReports, setAdminReports] = useState([]);
  const [adminBusy, setAdminBusy] = useState(false);

  useEffect(() => {
    autoActiveRef.current = autoActive;
  }, [autoActive]);

  useEffect(() => {
    allowIncomingRef.current = !profile || profile.allowIncoming !== false;
  }, [profile]);

  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  // Call duration timer
  useEffect(() => {
    let interval;
    if (isInCall) {
      interval = setInterval(() => {
        setCallDuration((value) => value + 1);
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

  // Browsers may block audio until the first tap/click.
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

  function showToast(message) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }

  async function refreshFriends() {
    if (!tokenRef.current) return;
    const result = await apiRequest("/api/friends", {
      token: tokenRef.current,
    });
    if (result.ok && result.data) setFriends(result.data);
  }

  async function refreshHistory() {
    if (!tokenRef.current) return;
    const result = await apiRequest("/api/history", {
      token: tokenRef.current,
    });
    if (result.ok && result.data) {
      setHistoryList(Array.isArray(result.data.list) ? result.data.list : []);
    }
  }

  async function refreshBlocks() {
    if (!tokenRef.current) return;
    const result = await apiRequest("/api/blocks", {
      token: tokenRef.current,
    });
    if (result.ok && result.data) {
      setBlocks(Array.isArray(result.data.list) ? result.data.list : []);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Guest bootstrap                                                         */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let token = "";
      try {
        token = localStorage.getItem(TOKEN_KEY) || "";
      } catch (e) {
        token = "";
      }
      let me = null;
      if (token) {
        const result = await apiRequest("/api/me", { token });
        if (result.ok && result.data && result.data.profile) {
          me = result.data.profile;
        } else {
          token = "";
        }
      }
      if (!token) {
        const created = await apiRequest("/api/guest", {
          method: "POST",
          body: {},
        });
        if (!created.ok || !created.data || !created.data.token) {
          if (!cancelled) {
            setBootError("Could not start a guest session. Please retry.");
            setBooting(false);
          }
          return;
        }
        token = created.data.token;
        me = created.data.profile;
        try {
          localStorage.setItem(TOKEN_KEY, token);
        } catch (e) {}
      }
      if (cancelled) return;
      tokenRef.current = token;
      profileRef.current = me;
      setProfile(me);
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!profile) return;
    if (!socket.connected && !socket.active) socket.connect();
  }, [profile]);

  async function recoverGuestSession() {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    try {
      const created = await apiRequest("/api/guest", {
        method: "POST",
        body: {},
      });
      if (!created.ok || !created.data || !created.data.token) return;
      tokenRef.current = created.data.token;
      profileRef.current = created.data.profile;
      try {
        localStorage.setItem(TOKEN_KEY, created.data.token);
      } catch (e) {}
      setProfile(created.data.profile);
      socket.emit("identify", { token: created.data.token });
      showToast("Guest session restored.");
    } finally {
      recoveringRef.current = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* WebRTC                                                                  */
  /* ---------------------------------------------------------------------- */
  function setPartnerRef(id) {
    currentPartnerRef.current = id || null;
    setPartnerId(id || null);
  }

  function clearPartnerState() {
    currentPartnerRef.current = null;
    setPartnerId(null);
    setPartner(null);
  }

  function setCall(callId, socketId, summary) {
    callIdRef.current = callId || null;
    setPartnerRef(socketId);
    if (summary) setPartner(normalizePartner(summary));
    if (!socketId) setPartner(null);
  }

  function clearCallTimers() {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  }

  function startConnectTimer(pc) {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null;
      if (pcRef.current === pc && pc.connectionState !== "connected") {
        debug("connection timeout");
        failCall("connect-timeout");
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function failCall(reason) {
    const partnerSocket = currentPartnerRef.current;
    const callId = callIdRef.current;
    if (partnerSocket || callId) {
      socket.emit("call-hangup", {
        to: partnerSocket || null,
        callId: callId || null,
        reason: reason || "failed",
      });
    }
    if (reason === "connect-timeout") {
      setCallNotice("Could not connect. Please try again.");
    } else if (reason === "connection-lost") {
      setCallNotice("Connection lost. Please try again.");
    }
    cleanupCall();
  }

  function handleMediaFailure(error) {
    const denied =
      error &&
      (error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError" ||
        error.name === "SecurityError");
    setCallNotice(
      denied
        ? "Microphone permission is required to make a call."
        : "Could not start the microphone."
    );
    if (autoActiveRef.current) {
      autoActiveRef.current = false;
      setAutoActive(false);
      socket.emit("auto-call-stop", {});
    }
  }

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

  async function flushPendingCandidatesFor(pc, peerId, callId) {
    if (!pc || !pc.remoteDescription || pc.signalingState === "closed") return;
    const remaining = [];
    for (const item of pendingCandidatesRef.current) {
      if (item.from !== peerId) {
        remaining.push(item);
        continue;
      }
      if (item.callId && callId && item.callId !== callId) {
        continue;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(item.candidate));
      } catch (e) {
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
          if (
            payload.callId &&
            callIdRef.current &&
            payload.callId !== callIdRef.current
          ) {
            return;
          }
          if (
            payload.sender &&
            currentPartnerRef.current &&
            payload.sender !== currentPartnerRef.current
          ) {
            return;
          }
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
    clearPartnerState();

    clearCallTimers();
    callIdRef.current = null;
    iceRestartCountRef.current = 0;
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

  async function attemptIceRestart(pc, reason) {
    if (!pc || pcRef.current !== pc) return false;
    if (iceRestartCountRef.current >= 1) return false;
    const partnerSocket = currentPartnerRef.current;
    const callId = callIdRef.current;
    if (!partnerSocket) return false;

    iceRestartCountRef.current += 1;
    debug("ICE restart", reason);
    try {
      pc.restartIce();
      const offer = await pc.createOffer({
        iceRestart: true,
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      if (pcRef.current !== pc) return false;
      await pc.setLocalDescription({
        type: offer.type,
        sdp: tuneOpusSdp(offer.sdp),
      });
      socket.emit("signal", {
        to: partnerSocket,
        callId,
        data: { sdp: plainSdp(pc.localDescription) },
      });
      startConnectTimer(pc);
      return true;
    } catch (e) {
      debug("ICE restart failed", e);
      return false;
    }
  }

  async function createPeerWithMic(isCaller) {
    cleanupPeer();
    setChatReady(false);
    setCallNotice("");
    iceRestartCountRef.current = 0;
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
      if (pcRef.current !== pc) return;
      const stream =
        event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);

      if (lastRemoteStreamIdRef.current === stream.id) return;
      lastRemoteStreamIdRef.current = stream.id;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 1;
        const played = await playAudioElement(remoteAudioRef.current);
        if (!played) setCallNotice("Tap anywhere to hear the call.");
      }
      tuneAudioReceivers(pc);
    };

    pc.onicecandidate = (event) => {
      if (pcRef.current !== pc) return;
      if (event.candidate && currentPartnerRef.current) {
        socket.emit("signal", {
          to: currentPartnerRef.current,
          callId: callIdRef.current,
          data: { candidate: event.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      debug("connection state", state);

      if (state === "connected") {
        clearCallTimers();
        iceRestartCountRef.current = 0;
        setIsInCall(true);
        setChatReady(true);
        setCallNotice("");
        socket.emit("call-connected", { callId: callIdRef.current });
        tuneAudioReceivers(pc);
        applyAudioSenderParams(pc);
        playAudioElement(remoteAudioRef.current).then((played) => {
          if (!played) setCallNotice("Tap anywhere to hear the call.");
        });
      } else if (state === "disconnected") {
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = setTimeout(async () => {
          disconnectTimerRef.current = null;
          if (pcRef.current !== pc || pc.connectionState !== "disconnected") {
            return;
          }
          const restarted = await attemptIceRestart(pc, "disconnected");
          if (!restarted) {
            failCall("connection-lost");
            return;
          }
          disconnectTimerRef.current = setTimeout(() => {
            disconnectTimerRef.current = null;
            if (pcRef.current === pc && pc.connectionState !== "connected") {
              failCall("connection-lost");
            }
          }, DISCONNECT_GRACE_MS + 6000);
        }, DISCONNECT_GRACE_MS);
      } else if (state === "failed") {
        attemptIceRestart(pc, "failed").then((restarted) => {
          if (!restarted) failCall("connection-lost");
        });
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

  async function startOfferFlow(targetId, callId) {
    if (!targetId) return;
    const activeCallId = callId || callIdRef.current;
    callIdRef.current = activeCallId || null;

    let pc;
    try {
      pc = await createPeerWithMic(true);
    } catch (err) {
      if (!err || err.message !== "Call cancelled") {
        handleMediaFailure(err);
        socket.emit("call-reject", {
          to: targetId,
          callId: activeCallId,
          reason: "media-error",
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
      callId: activeCallId,
      data: { sdp: plainSdp(pc.localDescription) },
    });

    startConnectTimer(pc);
    tuneAudioReceivers(pc);
    applyAudioSenderParams(pc);
  }

  async function handleSignal({ id, callId, data }) {
    if (!data || !id) return;

    if (id !== currentPartnerRef.current) {
      debug("dropped signal from stale peer", id);
      return;
    }
    if (callId && callIdRef.current && callId !== callIdRef.current) {
      debug("dropped signal for stale call", callId);
      return;
    }
    if (!callIdRef.current && callId) callIdRef.current = callId;

    const activeCallId = callIdRef.current;

    try {
      if (data.sdp) {
        const description = new RTCSessionDescription(data.sdp);

        if (description.type === "offer") {
          if (
            pcRef.current &&
            pcRef.current.signalingState === "have-local-offer"
          ) {
            const polite = String(localIdRef.current) > String(id);
            if (!polite) {
              debug("SDP glare: keeping local offer");
              return;
            }
            try {
              await pcRef.current.setLocalDescription({ type: "rollback" });
            } catch (e) {
              debug("rollback failed", e);
            }
          }

          if (!pcRef.current && preparingRef.current) {
            try {
              await preparingRef.current;
            } catch (e) {}
          }

          if (!pcRef.current) {
            try {
              await createPeerWithMic(false);
            } catch (e) {
              handleMediaFailure(e);
              socket.emit("call-reject", {
                to: id,
                callId: activeCallId,
                reason: "media-error",
              });
              cleanupCall();
              return;
            }
          }

          const pc = pcRef.current;
          if (!pc || pc.signalingState === "closed") return;
          if (pc.signalingState !== "stable") {
            debug("ignored offer in state", pc.signalingState);
            return;
          }

          await pc.setRemoteDescription(description);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription({
            type: answer.type,
            sdp: tuneOpusSdp(answer.sdp),
          });

          socket.emit("signal", {
            to: id,
            callId: activeCallId,
            data: { sdp: plainSdp(pc.localDescription) },
          });

          startConnectTimer(pc);
          tuneAudioReceivers(pc);
          applyAudioSenderParams(pc);
          await flushPendingCandidatesFor(pc, id, activeCallId);
          return;
        }

        if (description.type === "answer") {
          const pc = pcRef.current;
          if (!pc || pc.signalingState !== "have-local-offer") {
            debug("ignored answer in state", pc && pc.signalingState);
            return;
          }
          await pc.setRemoteDescription(description);
          tuneAudioReceivers(pc);
          applyAudioSenderParams(pc);
          await flushPendingCandidatesFor(pc, id, activeCallId);
          return;
        }
      }

      if (data.candidate) {
        const pc = pcRef.current;
        const ready =
          pc && pc.signalingState !== "closed" && !!pc.remoteDescription;

        if (!ready) {
          if (pendingCandidatesRef.current.length < MAX_BUFFERED_CANDIDATES) {
            pendingCandidatesRef.current.push({
              candidate: data.candidate,
              from: id,
              callId: activeCallId,
            });
          }
          return;
        }

        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          if (pendingCandidatesRef.current.length < MAX_BUFFERED_CANDIDATES) {
            pendingCandidatesRef.current.push({
              candidate: data.candidate,
              from: id,
              callId: activeCallId,
            });
          }
        }
      }
    } catch (e) {
      debug("signal handler error", e);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Socket events                                                           */
  /* ---------------------------------------------------------------------- */
  function findPresenceBySocket(id) {
    return (presenceRef.current || []).find((item) => item.id === id) || null;
  }

  function partnerFromEvent(payload) {
    if (payload && payload.partner) return payload.partner;
    const item = payload ? findPresenceBySocket(payload.from) : null;
    return item || null;
  }

  useEffect(() => {
    function onConnect() {
      const isReconnect = hadConnectedRef.current;
      hadConnectedRef.current = true;
      localIdRef.current = socket.id;
      setConnected(true);
      setIdentified(false);
      debug("socket connected", socket.id, { isReconnect });

      if (isReconnect) {
        cleanupCall();
        restoreAutoRef.current = autoActiveRef.current;
      }
      if (tokenRef.current) socket.emit("identify", { token: tokenRef.current });
    }

    function onDisconnect() {
      setConnected(false);
      setIdentified(false);
      debug("socket disconnected");
      if (pcRef.current || callIdRef.current) cleanupCall();
    }

    function onIdentified({ profile: serverProfile } = {}) {
      setIdentified(true);
      if (serverProfile) {
        profileRef.current = serverProfile;
        setProfile(serverProfile);
      }
      refreshFriends();
      refreshHistory();
      refreshBlocks();
      if (restoreAutoRef.current && autoActiveRef.current) {
        restoreAutoRef.current = false;
        socket.emit("auto-call-start", {});
      }
    }

    function onIdentifyError() {
      recoverGuestSession().catch((err) =>
        debug("guest recovery failed", err)
      );
    }

    function onBanned({ reason } = {}) {
      setBanned(reason || "violation");
      setIdentified(false);
      cleanupCall();
      try {
        socket.disconnect();
      } catch (e) {}
    }

    function onPresence({ list } = {}) {
      setPresence(Array.isArray(list) ? list : []);
    }

    function onProfileUpdated({ profile: next } = {}) {
      if (!next) return;
      profileRef.current = next;
      setProfile(next);
    }

    function onHistory({ list } = {}) {
      setHistoryList(Array.isArray(list) ? list : []);
    }

    async function onCallInvite(payload = {}) {
      const from = payload.from;
      if (!from) return;
      const id = payload.callId || null;
      const summary = partnerFromEvent(payload);

      if (!allowIncomingRef.current) {
        socket.emit("call-reject", {
          to: from,
          callId: id,
          reason: "incoming-disabled",
        });
        return;
      }

      if (currentPartnerRef.current && currentPartnerRef.current !== from) {
        socket.emit("call-reject", {
          to: from,
          callId: id,
          reason: "busy",
        });
        return;
      }

      setCall(id, from, summary);

      if (autoActiveRef.current) {
        if (!pcRef.current) {
          try {
            await createPeerWithMic(false);
          } catch (e) {
            handleMediaFailure(e);
            socket.emit("call-reject", {
              to: from,
              callId: id,
              reason: "media-error",
            });
            cleanupCall();
            return;
          }
        }
        socket.emit("call-accept", { to: from, callId: id });
        setIncomingCall(null);
        return;
      }

      setIncomingCall({
        from,
        callId: id,
        partner: normalizePartner(summary),
      });
    }

    async function onAutoReady(payload = {}) {
      const from = payload.from;
      if (!from) return;
      const id = payload.callId || null;
      const summary = partnerFromEvent(payload);

      if (!autoActiveRef.current && !currentPartnerRef.current) {
        socket.emit("call-reject", {
          to: from,
          callId: id,
          reason: "auto-off",
        });
        return;
      }

      if (currentPartnerRef.current && currentPartnerRef.current !== from) {
        socket.emit("call-reject", {
          to: from,
          callId: id,
          reason: "busy",
        });
        return;
      }
      if (pcRef.current && currentPartnerRef.current === from) {
        if (!callIdRef.current && id) callIdRef.current = id;
        if (summary) setPartner(normalizePartner(summary));
        return;
      }

      setCall(id, from, summary);
      let preparation = null;
      try {
        preparation = createPeerWithMic(false);
        preparingRef.current = preparation;
        await preparation;
      } catch (e) {
        if (e && e.message !== "Call cancelled") {
          handleMediaFailure(e);
          socket.emit("call-reject", {
            to: from,
            callId: id,
            reason: "media-error",
          });
          cleanupCall();
        }
      } finally {
        if (preparingRef.current === preparation) {
          preparingRef.current = null;
        }
      }
    }

    function onCallRinging(payload = {}) {
      const to = payload.to;
      if (!to) return;
      if (currentPartnerRef.current && currentPartnerRef.current !== to) return;
      setCall(payload.callId || null, to, partnerFromEvent(payload));
    }

    function onCallAccept(payload = {}) {
      const from = payload.from;
      if (!from) return;
      const callId = payload.callId || null;
      const summary = partnerFromEvent(payload);
      if (currentPartnerRef.current && currentPartnerRef.current !== from) {
        return;
      }
      if (callId && callIdRef.current && callId !== callIdRef.current) {
        return;
      }
      if (
        pcRef.current &&
        currentPartnerRef.current === from &&
        pcRef.current.localDescription
      ) {
        debug("duplicate call-accept ignored");
        return;
      }
      const activeCallId = callId || callIdRef.current;
      if (summary) setPartner(normalizePartner(summary));
      setPartnerRef(from);
      callIdRef.current = activeCallId || null;
      startOfferFlow(from, activeCallId).catch((error) =>
        debug("startOfferFlow error", error)
      );
    }

    function onCallReject(payload = {}) {
      const from = payload.from;
      const callId = payload.callId;
      if (callId && callIdRef.current && callId !== callIdRef.current) return;
      if (!callId && callIdRef.current) return;
      if (from && currentPartnerRef.current && from !== currentPartnerRef.current) {
        return;
      }
      const reason = payload.reason;
      if (reason === "offline") {
        setCallNotice("That person is offline.");
      } else if (reason === "busy") {
        setCallNotice("That person is busy.");
      } else if (reason === "incoming-disabled") {
        setCallNotice("That person is not accepting calls.");
      } else if (reason === "media-error") {
        setCallNotice("The other person's microphone is unavailable.");
      } else if (reason === "blocked") {
        setCallNotice("You cannot call this person.");
      } else if (reason === "auto-off") {
        setCallNotice("");
      } else {
        setCallNotice("Call declined.");
      }
      cleanupCall();
    }

    function onCallHangup(payload = {}) {
      if (
        payload.callId &&
        callIdRef.current &&
        payload.callId !== callIdRef.current
      ) {
        return;
      }
      cleanupCall();
      refreshHistory();
    }

    function onChat(payload = {}) {
      const body =
        typeof payload.text === "string" ? payload.text : payload.message;
      const from = payload.from || payload.sender;
      if (typeof body !== "string" || !body.trim()) return;
      if (
        payload.callId &&
        callIdRef.current &&
        payload.callId !== callIdRef.current
      ) {
        return;
      }
      if (
        currentPartnerRef.current &&
        from &&
        from !== currentPartnerRef.current
      ) {
        return;
      }
      addMessage({ text: body, me: false });
    }

    function onSignal(payload) {
      handleSignal(payload);
    }

    function onAutoStopped() {
      autoActiveRef.current = false;
      setAutoActive(false);
    }

    function onFriendRequest({ from } = {}) {
      if (from) showToast(`${from.name || "Someone"} sent a friend request.`);
      refreshFriends();
    }

    function onFriendAccepted({ profile: accepted } = {}) {
      if (accepted) showToast(`${accepted.name || "Someone"} is now a friend.`);
      refreshFriends();
    }

    function onFriendRemoved() {
      refreshFriends();
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("identified", onIdentified);
    socket.on("identify-error", onIdentifyError);
    socket.on("banned", onBanned);
    socket.on("presence", onPresence);
    socket.on("profile-updated", onProfileUpdated);
    socket.on("history", onHistory);
    socket.on("call-invite", onCallInvite);
    socket.on("auto-ready", onAutoReady);
    socket.on("call-ringing", onCallRinging);
    socket.on("call-accept", onCallAccept);
    socket.on("call-reject", onCallReject);
    socket.on("call-hangup", onCallHangup);
    socket.on("chat", onChat);
    socket.on("signal", onSignal);
    socket.on("auto-stopped", onAutoStopped);
    socket.on("friend-request", onFriendRequest);
    socket.on("friend-accepted", onFriendAccepted);
    socket.on("friend-removed", onFriendRemoved);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("identified", onIdentified);
      socket.off("identify-error", onIdentifyError);
      socket.off("banned", onBanned);
      socket.off("presence", onPresence);
      socket.off("profile-updated", onProfileUpdated);
      socket.off("history", onHistory);
      socket.off("call-invite", onCallInvite);
      socket.off("auto-ready", onAutoReady);
      socket.off("call-ringing", onCallRinging);
      socket.off("call-accept", onCallAccept);
      socket.off("call-reject", onCallReject);
      socket.off("call-hangup", onCallHangup);
      socket.off("chat", onChat);
      socket.off("signal", onSignal);
      socket.off("auto-stopped", onAutoStopped);
      socket.off("friend-request", onFriendRequest);
      socket.off("friend-accepted", onFriendAccepted);
      socket.off("friend-removed", onFriendRemoved);
    };
    // Handlers only use refs and stable setters, so registering once is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "friends") refreshFriends();
    if (tab === "history") refreshHistory();
    if (tab === "profile") refreshBlocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */
  function inviteCall(targetSocketId) {
    if (!targetSocketId || !connected || !identified) return;
    if (currentPartnerRef.current || pcRef.current) return;
    setCallNotice("");
    socket.emit("call-invite", { to: targetSocketId });
  }

  async function acceptIncoming() {
    if (!incomingCall) return;
    const from = incomingCall.from;
    const callId = incomingCall.callId || callIdRef.current || null;
    setCall(callId, from, incomingCall.partner);
    setCallNotice("");

    try {
      await createPeerWithMic(false);
    } catch (err) {
      handleMediaFailure(err);
      socket.emit("call-reject", {
        to: from,
        callId,
        reason: "media-error",
      });
      cleanupCall();
      return;
    }

    socket.emit("call-accept", { to: from, callId });
    setIncomingCall(null);
    playAudioElement(remoteAudioRef.current);
  }

  function rejectIncoming() {
    if (!incomingCall) return;
    socket.emit("call-reject", {
      to: incomingCall.from,
      callId: incomingCall.callId || null,
      reason: "rejected",
    });
    cleanupCall();
  }

  function hangup() {
    socket.emit("call-hangup", {
      to: currentPartnerRef.current || null,
      callId: callIdRef.current || null,
      reason: "hangup",
    });
    cleanupCall();
    refreshHistory();
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
    const partnerSocket = currentPartnerRef.current;
    if (!body || !partnerSocket) return;

    const payload = {
      type: "chat",
      sender: localIdRef.current,
      callId: callIdRef.current || null,
      text: body,
    };

    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(payload));
      } catch (e) {
        socket.emit("chat", { to: partnerSocket, text: body });
      }
    } else {
      socket.emit("chat", { to: partnerSocket, text: body });
    }

    addMessage({ text: body, me: true });
    setText("");
  }

  function startAutoCall() {
    if (!connected || !identified) {
      showToast("Still connecting. Try again in a moment.");
      return;
    }
    if (currentPartnerRef.current || pcRef.current) return;
    setCallNotice("");
    autoActiveRef.current = true;
    socket.emit("auto-call-start", { initiator: localIdRef.current });
    setAutoActive(true);
  }

  function stopAutoCall() {
    autoActiveRef.current = false;
    socket.emit("auto-call-stop", { initiator: localIdRef.current });
    setAutoActive(false);
  }

  async function saveProfilePatch(patch, { silent } = {}) {
    if (!tokenRef.current) return false;
    setSavingProfile(true);
    const result = await apiRequest("/api/me", {
      method: "PATCH",
      token: tokenRef.current,
      body: patch,
    });
    setSavingProfile(false);
    if (!result.ok || !result.data || !result.data.profile) {
      showToast("Could not save. Please try again.");
      return false;
    }
    profileRef.current = result.data.profile;
    setProfile(result.data.profile);
    if (!silent) showToast("Saved.");
    return true;
  }

  async function saveFilters(filters) {
    const ok = await saveProfilePatch({ filters });
    if (ok) setFiltersOpen(false);
  }

  async function addFriend(targetGuestId) {
    if (!targetGuestId) {
      showToast("This person does not have a guest profile.");
      return;
    }
    if (friends.friends.some((friend) => friend.guestId === targetGuestId)) {
      showToast("Already friends.");
      return;
    }
    const result = await apiRequest("/api/friends/requests", {
      method: "POST",
      token: tokenRef.current,
      body: { toGuestId: targetGuestId },
    });
    if (!result.ok) {
      showToast(
        result.data && result.data.error === "blocked"
          ? "You cannot add this person."
          : "Could not send friend request."
      );
      return;
    }
    if (result.data && result.data.status === "friends") {
      showToast("Already friends.");
    } else {
      showToast("Friend request sent.");
    }
    refreshFriends();
  }

  async function acceptFriend(guestId) {
    const result = await apiRequest(
      `/api/friends/requests/${encodeURIComponent(guestId)}/accept`,
      { method: "POST", token: tokenRef.current }
    );
    if (result.ok) {
      showToast("Friend added.");
      refreshFriends();
    } else {
      showToast("Could not accept request.");
    }
  }

  async function declineFriend(guestId) {
    const result = await apiRequest(
      `/api/friends/requests/${encodeURIComponent(guestId)}/decline`,
      { method: "POST", token: tokenRef.current }
    );
    if (result.ok) refreshFriends();
  }

  async function removeFriend(guestId) {
    const result = await apiRequest(
      `/api/friends/${encodeURIComponent(guestId)}`,
      { method: "DELETE", token: tokenRef.current }
    );
    if (result.ok) {
      showToast("Friend removed.");
      refreshFriends();
    }
  }

  async function unblockGuest(guestId) {
    const result = await apiRequest(
      `/api/blocks/${encodeURIComponent(guestId)}`,
      { method: "DELETE", token: tokenRef.current }
    );
    if (result.ok) {
      showToast("Unblocked.");
      refreshBlocks();
    }
  }

  async function submitReport({ reason, details }) {
    if (!partner || !partner.guestId) {
      showToast("No profile to report.");
      return;
    }
    setSendingReport(true);
    const result = await apiRequest("/api/reports", {
      method: "POST",
      token: tokenRef.current,
      body: {
        targetGuestId: partner.guestId,
        reason,
        details,
        callId: callIdRef.current || null,
      },
    });
    setSendingReport(false);
    if (result.ok) {
      setReportOpen(false);
      showToast("Report sent to moderators.");
    } else {
      showToast("Could not send report.");
    }
  }

  async function confirmBlock() {
    if (!partner || !partner.guestId) {
      showToast("No profile to block.");
      return;
    }
    setSendingBlock(true);
    const result = await apiRequest(
      `/api/blocks/${encodeURIComponent(partner.guestId)}`,
      { method: "POST", token: tokenRef.current }
    );
    setSendingBlock(false);
    if (result.ok) {
      const name = partner.name;
      setBlockOpen(false);
      hangup();
      refreshFriends();
      refreshBlocks();
      showToast(`${name} blocked.`);
    } else {
      showToast("Could not block this person.");
    }
  }

  async function loadAdminReports() {
    if (!adminToken) {
      showToast("Enter the admin token first.");
      return;
    }
    setAdminBusy(true);
    const result = await apiRequest("/api/admin/reports", {
      admin: adminToken,
    });
    setAdminBusy(false);
    if (!result.ok) {
      showToast(
        result.status === 403 ? "Admin token rejected." : "Could not load reports."
      );
      return;
    }
    try {
      sessionStorage.setItem(ADMIN_KEY, adminToken);
    } catch (e) {}
    setAdminReports(Array.isArray(result.data && result.data.list) ? result.data.list : []);
    showToast("Reports loaded.");
  }

  async function banGuest(guestId) {
    if (!adminToken || !guestId) return;
    const result = await apiRequest("/api/admin/ban", {
      method: "POST",
      admin: adminToken,
      body: { guestId, reason: "moderator action" },
    });
    if (result.ok) {
      showToast("Guest banned.");
      setAdminReports((prev) =>
        prev.filter((report) => report.targetGuestId !== guestId)
      );
    } else {
      showToast("Could not ban this guest.");
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Derived view data                                                       */
  /* ---------------------------------------------------------------------- */
  const onlineOthers = presence.filter(
    (user) => !profile || user.guestId !== profile.id
  );
  const onlineCount = onlineOthers.length;
  const friendIds = new Set(friends.friends.map((friend) => friend.guestId));
  const isPartnerFriend = !!(partner && partner.guestId && friendIds.has(partner.guestId));
  const partnerOnlineSocket = (guestId) => {
    const found = presence.find((item) => item.guestId === guestId);
    return found ? found.id : null;
  };
  const ready = connected && identified;
  const callVisible = !!(incomingCall || partnerId);
  const isSearching = autoActive && !callVisible;
  const activeTab = NAV_ITEMS.find((item) => item.id === tab) || NAV_ITEMS[0];

  function openTab(nextTab) {
    setTab(nextTab);
    setNavOpen(false);
  }

  if (banned) {
    return (
      <div className="app banned-screen">
        <div className="banned-card">
          <Prohibit size={56} />
          <h1>Session blocked</h1>
          <p>
            This guest identity was banned by moderation
            {banned && banned !== "violation" ? ` (${banned})` : ""}. Clear this
            browser&apos;s site data to start with a new guest identity.
          </p>
        </div>
        <audio ref={remoteAudioRef} autoPlay playsInline className="remote-audio" />
      </div>
    );
  }

  if (booting) {
    return (
      <div className="app boot-screen">
        <div className="brand-mark large">
          <Phone size={30} weight="fill" />
        </div>
        <p>Starting your guest session…</p>
        <audio ref={remoteAudioRef} autoPlay playsInline className="remote-audio" />
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="app boot-screen">
        <div className="brand-mark large">
          <Phone size={30} weight="fill" />
        </div>
        <p>{bootError}</p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Retry
        </button>
        <audio ref={remoteAudioRef} autoPlay playsInline className="remote-audio" />
      </div>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */
  return (
    <div className="app">
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob one" />
        <span className="aurora-blob two" />
        <span className="aurora-blob three" />
      </div>

      <div className="shell">
        <aside className={`sidebar ${navOpen ? "open" : ""}`}>
          <div className="brand">
            <div className="brand-mark">
              <Phone size={20} weight="fill" />
            </div>
            <div className="brand-copy">
              <strong>AnyCall</strong>
              <span>Live voice chat</span>
            </div>
          </div>

          <nav className="nav" aria-label="Main">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const badge =
                item.id === "friends" ? friends.incoming.length : 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item ${tab === item.id ? "active" : ""}`}
                  onClick={() => openTab(item.id)}
                >
                  <Icon size={19} weight={tab === item.id ? "fill" : "regular"} />
                  <span>{item.label}</span>
                  {item.id === "games" && <em className="nav-tag">Soon</em>}
                  {badge > 0 && <em className="nav-badge">{badge}</em>}
                </button>
              );
            })}
          </nav>

          <div className="sidebar-presence">
            <div className="presence-head">
              <span className="live-dot" />
              <strong>{onlineCount} online</strong>
              <Users size={16} />
            </div>
            <div className="avatar-stack">
              {onlineOthers.slice(0, 5).map((user) => (
                <Avatar
                  key={user.guestId || user.id}
                  tone={user.avatar}
                  name={user.name}
                  size={30}
                />
              ))}
              {onlineCount === 0 && (
                <span className="presence-empty">Waiting for people to join</span>
              )}
            </div>
            <p className="presence-hint">
              {autoActive
                ? "Auto Call is on. You can keep browsing while we search."
                : "Turn on Auto Call to meet someone new."}
            </p>
          </div>

          <button
            type="button"
            className="profile-chip"
            onClick={() => openTab("profile")}
          >
            <Avatar
              tone={profile?.avatar}
              name={profile?.name}
              size={38}
              online={ready}
            />
            <span className="profile-chip-copy">
              <strong>{profile?.name || "Guest"}</strong>
              <small>
                {profile?.country
                  ? `${flagOf(profile.country)} ${countryName(profile.country)}`
                  : "Guest identity"}
              </small>
            </span>
            <CaretRight size={15} />
          </button>
        </aside>

        {navOpen && (
          <button
            type="button"
            className="nav-scrim"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
        )}

        <main className="main">
          <header className="topbar">
            <button
              type="button"
              className="icon-btn menu-btn"
              onClick={() => setNavOpen((value) => !value)}
              aria-label="Open navigation"
            >
              <List size={20} />
            </button>
            <div className="topbar-title">
              <span className="eyebrow">
                {tab === "call" ? "Voice lounge" : activeTab.label}
              </span>
              <h1>{activeTab.label}</h1>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={() => setFiltersOpen(true)}
                aria-label="Match filters"
                title="Match filters"
              >
                <Funnel size={18} />
              </button>
              <div className="online-pill">
                <span className="live-dot" />
                {onlineCount} online
              </div>
              <div
                className={`status-badge ${ready ? "is-online" : "is-waiting"}`}
              >
                {ready ? (
                  <WifiHigh size={15} />
                ) : (
                  <WifiNone size={15} />
                )}
                <span>{ready ? "Connected" : "Connecting"}</span>
              </div>
            </div>
          </header>

          {tab === "call" && (
            <div className="call-layout">
              <div className="stage-column">
                {callVisible ? (
                  <section className="call-card" aria-label="Current call">
                    <div className="call-card-top">
                      <span
                        className={`live-pill ${
                          incomingCall ? "incoming" : isInCall ? "live" : "connecting"
                        }`}
                      >
                        <span className="live-dot" />
                        {incomingCall
                          ? "Incoming call"
                          : isInCall
                          ? "Live call"
                          : "Connecting"}
                      </span>
                      <div className="call-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          title="Add friend"
                          aria-label="Add friend"
                          disabled={!partner?.guestId || isPartnerFriend}
                          onClick={() => addFriend(partner?.guestId)}
                        >
                          <UserPlus size={17} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Report"
                          aria-label="Report"
                          disabled={!partner?.guestId}
                          onClick={() => setReportOpen(true)}
                        >
                          <Flag size={17} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="Block"
                          aria-label="Block"
                          disabled={!partner?.guestId}
                          onClick={() => setBlockOpen(true)}
                        >
                          <Prohibit size={17} />
                        </button>
                      </div>
                    </div>

                    <div className="call-card-body">
                      <div
                        className={`partner-orb ${
                          incomingCall || !isInCall ? "ringing" : "speaking"
                        }`}
                      >
                        <Avatar
                          tone={partner?.avatar}
                          name={partner?.name}
                          size={122}
                          ring
                        />
                        {!incomingCall && (
                          <AudioVisualizer active={isInCall} />
                        )}
                      </div>

                      <h2 className="partner-name">
                        {partner?.name || "Someone"}
                      </h2>
                      <div className="partner-meta">
                        <span>
                          {flagOf(partner?.country)}{" "}
                          {partner?.country
                            ? countryName(partner.country)
                            : "Country hidden"}
                        </span>
                        {partner?.gender && (
                          <>
                            <span className="dot-sep">·</span>
                            <span>{genderLabel(partner.gender)}</span>
                          </>
                        )}
                        {isPartnerFriend && (
                          <>
                            <span className="dot-sep">·</span>
                            <span className="friend-flag">
                              <Check size={12} weight="bold" /> Friend
                            </span>
                          </>
                        )}
                      </div>

                      {partner?.interests?.length > 0 && (
                        <div className="partner-tags">
                          {partner.interests.slice(0, 4).map((interest) => (
                            <span key={interest} className="tag">
                              {interest}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="call-status-line">
                        {incomingCall
                          ? "wants to talk with you"
                          : isInCall
                          ? formatDuration(callDuration)
                          : "Setting up a secure audio path…"}
                      </div>

                      {callNotice && (
                        <div className="notice call-notice">{callNotice}</div>
                      )}

                      {incomingCall ? (
                        <div className="incoming-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={rejectIncoming}
                          >
                            <PhoneDisconnect size={18} />
                            Decline
                          </button>
                          <button
                            type="button"
                            className="btn primary"
                            onClick={acceptIncoming}
                          >
                            <Phone size={18} weight="fill" />
                            Accept
                          </button>
                        </div>
                      ) : (
                        <div className="call-controls">
                          <button
                            type="button"
                            className={`control-btn ${isMuted ? "muted" : ""}`}
                            onClick={toggleMute}
                            aria-label={
                              isMuted ? "Unmute microphone" : "Mute microphone"
                            }
                          >
                            {isMuted ? (
                              <MicrophoneSlash size={22} />
                            ) : (
                              <Microphone size={22} />
                            )}
                            <span>{isMuted ? "Unmute" : "Mute"}</span>
                          </button>

                          <button
                            type="button"
                            className="control-btn hangup"
                            onClick={hangup}
                            aria-label="Hang up"
                          >
                            <PhoneDisconnect size={24} weight="fill" />
                            <span>Hang up</span>
                          </button>

                          <button
                            type="button"
                            className="control-btn"
                            onClick={() => addFriend(partner?.guestId)}
                            disabled={!partner?.guestId || isPartnerFriend}
                            aria-label="Add friend"
                          >
                            <UserPlus size={22} />
                            <span>{isPartnerFriend ? "Friends" : "Add"}</span>
                          </button>
                        </div>
                      )}

                      {autoActive && !incomingCall && (
                        <button
                          type="button"
                          className="auto-status"
                          onClick={stopAutoCall}
                        >
                          <span className="live-dot" />
                          Auto Call is on · Stop Auto
                        </button>
                      )}

                      {!autoActive && !incomingCall && (
                        <button
                          type="button"
                          className="auto-status"
                          onClick={startAutoCall}
                        >
                          <PhoneCall size={13} />
                          Auto Call off · Turn on
                        </button>
                      )}
                    </div>
                  </section>
                ) : (
                  <section className="stage idle-stage" aria-label="Start a call">
                    <div className="stage-copy">
                      <span className="eyebrow">
                        <Sparkle size={14} weight="fill" /> Random voice chat
                      </span>
                      <h1>
                        Meet someone new,
                        <br />
                        <em>right now.</em>
                      </h1>
                      <p>
                        One tap connects you to a real person who is also looking
                        to talk. No profiles to swipe, no waiting rooms.
                      </p>

                      <div className="hero-actions">
                        {isSearching ? (
                          <button
                            type="button"
                            className="btn primary big"
                            onClick={stopAutoCall}
                          >
                            <span className="spinner" />
                            Stop Auto
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn primary big"
                            onClick={startAutoCall}
                            disabled={!ready}
                          >
                            <PhoneCall size={20} weight="fill" />
                            Auto Call
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn ghost big"
                          onClick={() => setFiltersOpen(true)}
                        >
                          <Funnel size={18} />
                          Filters
                        </button>
                      </div>

                      {callNotice && (
                        <div className="notice call-notice">{callNotice}</div>
                      )}

                      <div className="hero-foot">
                        <div className="avatar-stack">
                          {onlineOthers.slice(0, 6).map((user) => (
                            <Avatar
                              key={user.guestId || user.id}
                              tone={user.avatar}
                              name={user.name}
                              size={32}
                            />
                          ))}
                        </div>
                        <p>
                          {isSearching
                            ? "Searching for a compatible person…"
                            : onlineCount > 0
                            ? `${onlineCount} ${
                                onlineCount === 1 ? "person is" : "people are"
                              } online now`
                            : "You are first here — invite a friend"}
                        </p>
                      </div>
                    </div>

                    <div className="stage-art" aria-hidden="true">
                      <span className="orbit orbit-one" />
                      <span className="orbit orbit-two" />
                      <span className="orbit orbit-three" />
                      <div className="stage-orb">
                        {isSearching ? (
                          <div className="radar">
                            <MagnifyingGlass size={34} />
                            <span className="radar-ring" />
                            <span className="radar-ring delay" />
                          </div>
                        ) : (
                          <Avatar
                            tone={profile?.avatar}
                            name={profile?.name}
                            size={94}
                          />
                        )}
                      </div>
                      <span className="float-chip chip-one">
                        {flagOf(onlineOthers[0]?.country)} voice
                      </span>
                      <span className="float-chip chip-two">
                        <ChatCircleDots size={14} /> live chat
                      </span>
                      <span className="float-chip chip-three">
                        <ShieldCheck size={14} /> guest safe
                      </span>
                    </div>
                  </section>
                )}

                <div className="quick-row">
                  <button
                    type="button"
                    className="quick-card"
                    onClick={() => openTab("friends")}
                  >
                    <span className="quick-icon">
                      <Users size={20} />
                    </span>
                    <span>
                      <strong>{friends.friends.length} friends</strong>
                      <small>
                        {friends.incoming.length > 0
                          ? `${friends.incoming.length} request${
                              friends.incoming.length === 1 ? "" : "s"
                            } waiting`
                          : "People you met on AnyCall"}
                      </small>
                    </span>
                    <CaretRight size={16} />
                  </button>
                  <button
                    type="button"
                    className="quick-card"
                    onClick={() => openTab("history")}
                  >
                    <span className="quick-icon">
                      <ClockCounterClockwise size={20} />
                    </span>
                    <span>
                      <strong>{historyList.length} calls</strong>
                      <small>Recent conversations and durations</small>
                    </span>
                    <CaretRight size={16} />
                  </button>
                </div>
              </div>

              <aside className="chat-panel" aria-label="1-to-1 chat">
                <header className="chat-head">
                  <div className="chat-head-title">
                    <ChatCircleDots size={18} />
                    <strong>Live chat</strong>
                  </div>
                  <span className={`chat-state ${chatReady ? "ready" : ""}`}>
                    {chatReady ? "Peer-to-peer" : "Waiting"}
                  </span>
                </header>

                <div className="chat-messages" ref={chatBoxRef} aria-live="polite">
                  {messages.length === 0 ? (
                    <div className="chat-empty">
                      <div className="chat-empty-icon">
                        <ChatCircleDots size={26} />
                      </div>
                      <p>
                        {callVisible
                          ? "Say hi. Messages stay between you two."
                          : "Your conversation will appear here once a call starts."}
                      </p>
                    </div>
                  ) : (
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
                  )}
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
                      chatReady ? "Type a message…" : "Connect to a person to chat"
                    }
                    disabled={!chatReady}
                    maxLength={2000}
                    autoComplete="off"
                    aria-label="Chat message"
                  />
                  <button
                    type="submit"
                    className="send-btn"
                    disabled={!chatReady || !text.trim()}
                    aria-label="Send message"
                  >
                    <ArrowRight size={18} />
                  </button>
                </form>
              </aside>
            </div>
          )}

          {tab === "friends" && (
            <section className="page">
              <header className="page-head">
                <div>
                  <span className="eyebrow">Your people</span>
                  <h1>Friends</h1>
                  <p>Call friends directly or accept new requests.</p>
                </div>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={refreshFriends}
                >
                  Refresh
                </button>
              </header>

              <div className="page-grid">
                <div className="list-card">
                  <div className="list-head">
                    <h2>Requests</h2>
                    <span className="count-pill">{friends.incoming.length}</span>
                  </div>
                  {friends.incoming.length === 0 ? (
                    <p className="empty-line">No incoming requests.</p>
                  ) : (
                    friends.incoming.map((person) => (
                      <div className="person-row" key={person.guestId}>
                        <Avatar
                          tone={person.avatar}
                          name={person.name}
                          size={44}
                          online={person.online}
                        />
                        <div className="person-copy">
                          <strong>{person.name}</strong>
                          <small>
                            {flagOf(person.country)}{" "}
                            {countryName(person.country)}
                          </small>
                        </div>
                        <button
                          type="button"
                          className="btn small primary"
                          onClick={() => acceptFriend(person.guestId)}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => declineFriend(person.guestId)}
                          aria-label="Decline request"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))
                  )}

                  <div className="list-head spaced">
                    <h2>Friends</h2>
                    <span className="count-pill">{friends.friends.length}</span>
                  </div>
                  {friends.friends.length === 0 ? (
                    <p className="empty-line">
                      Nobody yet. Add people you enjoyed talking to.
                    </p>
                  ) : (
                    friends.friends.map((person) => {
                      const socketId = partnerOnlineSocket(person.guestId);
                      return (
                        <div className="person-row" key={person.guestId}>
                          <Avatar
                            tone={person.avatar}
                            name={person.name}
                            size={44}
                            online={!!socketId}
                          />
                          <div className="person-copy">
                            <strong>{person.name}</strong>
                            <small>
                              {socketId ? "Online now" : "Offline"}
                              {person.country
                                ? ` · ${flagOf(person.country)} ${countryName(
                                    person.country
                                  )}`
                                : ""}
                            </small>
                          </div>
                          <button
                            type="button"
                            className="btn small"
                            disabled={!socketId || !!partnerId}
                            onClick={() => inviteCall(socketId)}
                          >
                            <Phone size={14} />
                            Call
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            aria-label="Remove friend"
                            onClick={() => removeFriend(person.guestId)}
                          >
                            <Trash size={15} />
                          </button>
                        </div>
                      );
                    })
                  )}

                  {friends.outgoing.length > 0 && (
                    <>
                      <div className="list-head spaced">
                        <h2>Sent requests</h2>
                        <span className="count-pill">
                          {friends.outgoing.length}
                        </span>
                      </div>
                      {friends.outgoing.map((person) => (
                        <div className="person-row" key={person.guestId}>
                          <Avatar
                            tone={person.avatar}
                            name={person.name}
                            size={40}
                            online={person.online}
                          />
                          <div className="person-copy">
                            <strong>{person.name}</strong>
                            <small>Waiting for them to accept</small>
                          </div>
                          <span className="pending-pill">Pending</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                <div className="side-notes">
                  <div className="note-card">
                    <UserPlus size={20} />
                    <h3>Meet more people</h3>
                    <p>
                      Turn on Auto Call and add the people you click with. Friends
                      stay in your guest account across page reloads.
                    </p>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => openTab("call")}
                    >
                      Go to call lounge
                    </button>
                  </div>
                  <div className="note-card">
                    <ShieldCheck size={20} />
                    <h3>Your safety tools</h3>
                    <p>
                      Report or block anyone from the call screen. Blocked people
                      can never be matched with you again.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {tab === "history" && (
            <section className="page">
              <header className="page-head">
                <div>
                  <span className="eyebrow">Recent conversations</span>
                  <h1>Call history</h1>
                  <p>Every accepted call is saved to your guest account.</p>
                </div>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={refreshHistory}
                >
                  Refresh
                </button>
              </header>

              <div className="list-card">
                {historyList.length === 0 ? (
                  <div className="empty-card">
                    <ClockCounterClockwise size={38} />
                    <h3>No calls yet</h3>
                    <p>Your accepted calls will show up here with duration.</p>
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => openTab("call")}
                    >
                      Start a call
                    </button>
                  </div>
                ) : (
                  historyList.map((item, index) => {
                    const socketId = partnerOnlineSocket(item.partnerGuestId);
                    return (
                      <div
                        className="history-row"
                        key={`${item.callId}-${index}`}
                      >
                        <span
                          className={`call-direction ${item.direction}`}
                          aria-hidden="true"
                        >
                          {item.direction === "incoming" ? (
                            <PhoneIncoming size={16} />
                          ) : item.direction === "auto" ? (
                            <Sparkle size={16} />
                          ) : (
                            <PhoneOutgoing size={16} />
                          )}
                        </span>
                        <Avatar
                          tone={item.partnerAvatar}
                          name={item.partnerName}
                          size={44}
                          online={!!socketId}
                        />
                        <div className="person-copy">
                          <strong>{item.partnerName || "Anonymous guest"}</strong>
                          <small>
                            {item.flag || flagOf(item.country)}{" "}
                            {countryName(item.country)} ·{" "}
                            {formatWhen(item.endedAt || item.startedAt)}
                          </small>
                        </div>
                        <div className="history-meta">
                          <span>{formatDuration(Math.round((item.durationMs || 0) / 1000))}</span>
                          <small>{item.direction}</small>
                        </div>
                        <button
                          type="button"
                          className="btn small"
                          disabled={!socketId || !!partnerId}
                          onClick={() => inviteCall(socketId)}
                        >
                          {socketId ? "Call back" : "Offline"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          )}

          {tab === "games" && (
            <section className="page">
              <header className="page-head">
                <div>
                  <span className="eyebrow">Phase 2</span>
                  <h1>Games</h1>
                  <p>
                    Quick games for the lobby and during calls are the next
                    milestone after core voice and social features.
                  </p>
                </div>
              </header>
              <div className="games-grid">
                {[
                  ["Would You Rather", "Ice-breaker prompts for new matches"],
                  ["Tic-Tac-Toe", "Fast 30-second rounds between calls"],
                  ["Trivia", "Shared-interest quiz in the call room"],
                ].map(([title, copy]) => (
                  <div className="game-card" key={title}>
                    <span className="game-icon">
                      <GameController size={24} />
                    </span>
                    <h3>{title}</h3>
                    <p>{copy}</p>
                    <span className="soon-pill">Coming in Phase 2</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === "profile" && (
            <section className="page">
              <header className="page-head">
                <div>
                  <span className="eyebrow">Guest account</span>
                  <h1>Profile & filters</h1>
                  <p>
                    Everything is stored against this device&apos;s guest
                    identity. No email or password.
                  </p>
                </div>
                <div className="profile-id-pill">
                  <Globe size={14} />
                  Guest {profile?.id ? profile.id.slice(0, 8) : "—"}
                </div>
              </header>

              <div className="page-grid">
                <ProfileEditor
                  profile={profile}
                  saving={savingProfile}
                  onSave={saveProfilePatch}
                  onOpenFilters={() => setFiltersOpen(true)}
                />

                <div className="side-notes">
                  <div className="note-card">
                    <Funnel size={20} />
                    <h3>Matching filters</h3>
                    <p>
                      Gender: {GENDERS.find(([value]) => value === (profile?.filters?.gender || "any"))?.[1] || "Any"}
                      <br />
                      Country:{" "}
                      {profile?.filters?.country && profile.filters.country !== "any"
                        ? `${flagOf(profile.filters.country)} ${countryName(
                            profile.filters.country
                          )}`
                        : "Any"}
                      <br />
                      Shared interests:{" "}
                      {profile?.filters?.interests?.length
                        ? profile.filters.interests.join(", ")
                        : "Any"}
                    </p>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setFiltersOpen(true)}
                    >
                      Edit filters
                    </button>
                  </div>

                  <div className="note-card">
                    <Prohibit size={20} />
                    <h3>Blocked guests</h3>
                    {blocks.length === 0 ? (
                      <p>Nobody is blocked.</p>
                    ) : (
                      <div className="blocked-list">
                        {blocks.map((guestId) => (
                          <div className="blocked-row" key={guestId}>
                            <code>{guestId.slice(0, 8)}</code>
                            <button
                              type="button"
                              className="btn small ghost"
                              onClick={() => unblockGuest(guestId)}
                            >
                              Unblock
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="note-card">
                    <ShieldCheck size={20} />
                    <h3>Moderator tools</h3>
                    <p>
                      Optional. Enter the server&apos;s admin token to review
                      reports and ban guests.
                    </p>
                    <div className="inline-form">
                      <input
                        className="input"
                        type="password"
                        placeholder="Admin token"
                        value={adminToken}
                        onChange={(event) => setAdminToken(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn small"
                        onClick={loadAdminReports}
                        disabled={adminBusy}
                      >
                        {adminBusy ? "Loading…" : "Load"}
                      </button>
                    </div>
                    {adminReports.length > 0 && (
                      <div className="admin-reports">
                        {adminReports.slice(0, 8).map((report, index) => (
                          <div className="admin-report" key={`${report.reporterId}-${index}`}>
                            <div>
                              <strong>{report.targetName || report.targetGuestId}</strong>
                              <small>
                                {report.reason} · reported by{" "}
                                {report.reporterId?.slice(0, 6)}
                              </small>
                            </div>
                            <button
                              type="button"
                              className="btn small danger"
                              onClick={() => banGuest(report.targetGuestId)}
                            >
                              Ban
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      <FilterModal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={profile?.filters || {}}
        onSave={saveFilters}
        saving={savingProfile}
      />

      <ReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        partner={partner}
        onSubmit={submitReport}
        sending={sendingReport}
      />

      <BlockModal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        partner={partner}
        onConfirm={confirmBlock}
        sending={sendingBlock}
      />

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
          >
            <Check size={16} weight="bold" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <audio ref={remoteAudioRef} autoPlay playsInline className="remote-audio" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Profile editor                                                              */
/* -------------------------------------------------------------------------- */
function ProfileEditor({ profile, saving, onSave, onOpenFilters }) {
  const [draft, setDraft] = useState({
    name: "",
    gender: "other",
    country: "any",
    interests: [],
  });
  const [allowIncoming, setAllowIncoming] = useState(true);

  useEffect(() => {
    setDraft({
      name: profile?.name || "",
      gender: profile?.gender || "other",
      country: profile?.country || "any",
      interests: Array.isArray(profile?.interests) ? profile.interests : [],
    });
    setAllowIncoming(!profile || profile.allowIncoming !== false);
  }, [profile]);

  function submit(event) {
    event.preventDefault();
    onSave({
      name: draft.name,
      gender: draft.gender,
      country: draft.country,
      interests: draft.interests,
      allowIncoming,
    });
  }

  return (
    <form className="list-card profile-form" onSubmit={submit}>
      <div className="profile-hero">
        <Avatar
          tone={profile?.avatar}
          name={draft.name || profile?.name}
          size={76}
          online
        />
        <div>
          <h2>{draft.name || "Guest"}</h2>
          <p>
            Guest identity ·{" "}
            {draft.country && draft.country !== "any"
              ? `${flagOf(draft.country)} ${countryName(draft.country)}`
              : "Country not set"}
          </p>
        </div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Display name</span>
          <input
            className="input"
            value={draft.name}
            maxLength={24}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, name: event.target.value }))
            }
            placeholder="How people see you"
          />
        </label>

        <label className="field">
          <span>Gender</span>
          <select
            className="input select"
            value={draft.gender}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, gender: event.target.value }))
            }
          >
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label className="field">
          <span>Your country</span>
          <CountrySelect
            value={draft.country}
            onChange={(country) =>
              setDraft((prev) => ({ ...prev, country }))
            }
            anyLabel="Prefer not to say"
          />
        </label>

        <div className="field">
          <span>Interests</span>
          <InterestPicker
            value={draft.interests}
            onChange={(interests) =>
              setDraft((prev) => ({ ...prev, interests }))
            }
          />
          <small className="field-hint">
            These are shown to your partner and can power mutual interest
            matching.
          </small>
        </div>

        <Toggle
          checked={allowIncoming}
          onChange={setAllowIncoming}
          label="Allow incoming calls"
          hint="Turn off to avoid manual call invites."
        />
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={onOpenFilters}
        >
          <Funnel size={16} />
          Match filters
        </button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}
