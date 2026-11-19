// server/index.js
//
// Signaling + matchmaking for AnyCall Live.
//
// Matchmaking invariants:
//   - A user has at most one active call (callByUser is the reservation).
//   - Both participants are validated and reserved atomically.
//   - Every call has an id; every signaling message is checked against it.
//   - Hangup / reject / disconnect / timeout are idempotent.
//   - Auto Call users are requeued after a call ends; non-auto users are not.
//
// With REDIS_URL set, reservations and pairing run as Lua scripts and
// Socket.IO uses the Redis adapter, so several backend instances are safe.
// Without REDIS_URL everything is process-local (single instance only).

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { MemoryStore, createRedisStore } = require("./store");

const PORT = process.env.PORT || 3000;
const CALL_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.CALL_TIMEOUT_MS || 45000)
);
const MATCH_INTERVAL_MS = Math.max(
  500,
  Number(process.env.MATCH_INTERVAL_MS || 1500)
);
const MATCH_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.MATCH_COOLDOWN_MS || 4000)
);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingInterval: 20000,
  pingTimeout: 25000,
});

let store = new MemoryStore();
let redisClient = null;
const history = [];
const callTimers = new Map();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function countryToFlag(cc) {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return "🏳️";
  return String.fromCodePoint(
    0x1f1e6 + cc.toUpperCase().charCodeAt(0) - 65,
    0x1f1e6 + cc.toUpperCase().charCodeAt(1) - 65
  );
}

function pushHistoryEntry(id, country) {
  if (!id) return;
  const entry = {
    id,
    country: country || null,
    flag: countryToFlag(country),
    last: Date.now(),
    online: true,
  };
  history.unshift(entry);
  if (history.length > 200) history.pop();
}

let presenceTimer = null;
function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(async () => {
    presenceTimer = null;
    try {
      const users = await store.listUsers();
      io.emit("presence", {
        count: users.length,
        list: users.map((user) => ({
          id: user.id,
          country: user.country || null,
          flag: countryToFlag(user.country),
          online: true,
          autoActive: !!user.autoActive,
        })),
      });
    } catch (err) {
      console.error("[presence] failed:", err.message);
    }
  }, 120);
  if (presenceTimer.unref) presenceTimer.unref();
}

function clearCallTimeout(callId) {
  const timer = callTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    callTimers.delete(callId);
  }
}

function scheduleCallTimeout(callId, delay = CALL_TIMEOUT_MS) {
  clearCallTimeout(callId);
  const timer = setTimeout(async () => {
    callTimers.delete(callId);
    try {
      const call = await store.getCall(callId);
      if (!call) return;
      // Another instance may have observed real connectivity already.
      if (call.state === "active") return;

      // An invite accepted late gets a full connecting window: the timer
      // re-arms instead of cutting a freshly accepted call short.
      const startedAt = call.acceptedAt || call.createdAt || Date.now();
      const elapsed = Date.now() - startedAt;
      if (elapsed < CALL_TIMEOUT_MS - 250) {
        scheduleCallTimeout(callId, CALL_TIMEOUT_MS - elapsed);
        return;
      }

      await finishCall(callId, "timeout", null);
    } catch (err) {
      console.error("[call-timeout]", err.message);
    }
  }, delay);
  if (timer.unref) timer.unref();
  callTimers.set(callId, timer);
}

async function requeueIfEligible(id) {
  const user = await store.getUser(id);
  if (!user || !user.autoActive) return;
  const existing = await store.getCallForUser(id);
  if (existing) return;
  await store.enqueue(id);
}

// Idempotent: endCall() returns null the second time, so duplicate hangups
// never emit twice and never requeue twice.
async function finishCall(callId, reason, actorId, options = {}) {
  const call = await store.endCall(callId);
  if (!call) return null;

  clearCallTimeout(callId);

  const payload = {
    callId,
    reason: reason || "ended",
    from: actorId || null,
  };
  io.to(call.caller).emit("call-hangup", payload);
  io.to(call.callee).emit("call-hangup", payload);

  await store.setCooldown(call.caller, call.callee, MATCH_COOLDOWN_MS);
  await store.setCooldown(call.callee, call.caller, MATCH_COOLDOWN_MS);

  const requeueIds = options.requeueIds || [call.caller, call.callee];
  for (const id of requeueIds) {
    await requeueIfEligible(id);
  }

  schedulePresence();
  tryMatch().catch((err) => console.error("[match]", err.message));
  return call;
}

async function announcePair(call) {
  io.to(call.callee).emit("auto-ready", {
    from: call.caller,
    callId: call.id,
  });
  io.to(call.caller).emit("call-accept", {
    from: call.callee,
    callId: call.id,
  });
  scheduleCallTimeout(call.id);
  const [caller, callee] = await Promise.all([
    store.getUser(call.caller),
    store.getUser(call.callee),
  ]);
  pushHistoryEntry(call.caller, caller && caller.country);
  pushHistoryEntry(call.callee, callee && callee.country);
  console.log(`[auto-match] ${call.caller} <-> ${call.callee} (${call.id})`);
}

// Pairs as many waiting users as possible. store.tryPair() is atomic, so two
// simultaneous callers can never reserve the same user twice.
async function tryMatch() {
  if ((await store.queueSize()) < 2) return;
  for (let i = 0; i < 500; i += 1) {
    const callId = crypto.randomUUID();
    const call = await store.tryPair(callId);
    if (!call) break;
    await announcePair(call);
  }
  schedulePresence();
}

async function getCallForSocket(socketId, callId) {
  const call = callId
    ? await store.getCall(callId)
    : await store.getCallForUser(socketId);
  if (!call) return null;
  if (call.caller !== socketId && call.callee !== socketId) return null;
  return call;
}

function counterpartOf(call, socketId) {
  return call.caller === socketId ? call.callee : call.caller;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({ ok: true, service: "anycall-signaling" });
});

app.get("/health", async (req, res) => {
  try {
    const users = await store.listUsers();
    res.json({
      ok: true,
      service: "anycall-signaling",
      users: users.length,
      redis: !!redisClient,
      uptime: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Local/debug only. NODE_ENV=production on Railway disables it.
app.get("/debug/state", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  try {
    const [users, calls, queueSize] = await Promise.all([
      store.listUsers(),
      store.listCalls(),
      store.queueSize(),
    ]);
    res.json({ users, calls, queueSize, callTimers: callTimers.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Socket.IO                                                                   */
/* -------------------------------------------------------------------------- */

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  const ready = store
    .addUser({
      id: socket.id,
      country: null,
      autoActive: false,
      allowIncoming: true,
      lastSeen: Date.now(),
    })
    .then(schedulePresence)
    .catch((err) => console.error("[user-add]", err.message));

  // Await registration before handling events, so a fast client cannot race
  // the user record into existence.
  const on = (event, handler) => {
    socket.on(event, (payload) => {
      ready
        .then(() => handler(payload))
        .catch((err) => console.error(`[${event}]`, err.message));
    });
  };

  on("announce-location", async ({ country } = {}) => {
    const normalized =
      country && typeof country === "string" ? country.toUpperCase() : null;
    await store.updateUser(socket.id, { country: normalized });
    schedulePresence();
  });

  socket.on("get-history", () => {
    socket.emit("history", { list: history.slice(0, 100) });
  });

  // Every SDP/ICE packet must belong to a live call and may only travel to
  // the other participant of that call.
  on("signal", async ({ to, data, callId } = {}) => {
    if (!to || !data) return;
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return;
    if (to !== counterpartOf(call, socket.id)) return;
    io.to(to).emit("signal", {
      id: socket.id,
      callId: call.id,
      data,
    });
  });

  on("call-invite", async ({ to } = {}) => {
    if (!to || to === socket.id) return;

    const [caller, target] = await Promise.all([
      store.getUser(socket.id),
      store.getUser(to),
    ]);
    if (!caller || !target) {
      socket.emit("call-reject", { from: to, reason: "offline" });
      return;
    }
    if (!target.allowIncoming) {
      socket.emit("call-reject", { from: to, reason: "incoming-disabled" });
      return;
    }

    const [mine, theirs] = await Promise.all([
      store.getCallForUser(socket.id),
      store.getCallForUser(to),
    ]);
    if (mine || theirs) {
      socket.emit("call-reject", { from: to, reason: "busy" });
      return;
    }

    const callId = crypto.randomUUID();
    const call = await store.createInvite(callId, socket.id, to);
    if (!call) {
      socket.emit("call-reject", { from: to, reason: "busy" });
      return;
    }

    io.to(to).emit("call-invite", { from: socket.id, callId: call.id });
    socket.emit("call-ringing", { to, callId: call.id });
    scheduleCallTimeout(call.id);
    pushHistoryEntry(socket.id, caller.country);
    pushHistoryEntry(to, target.country);
    schedulePresence();
  });

  on("call-accept", async ({ to, callId } = {}) => {
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return;
    if (call.callee !== socket.id) return;
    if (to && to !== call.caller) return;

    const accepted = await store.acceptCall(call.id, socket.id);
    if (!accepted) return; // duplicate accept: ignore, never restart the call

    io.to(accepted.caller).emit("call-accept", {
      from: socket.id,
      callId: accepted.id,
    });
    scheduleCallTimeout(accepted.id);
  });

  on("call-reject", async ({ to, callId, reason } = {}) => {
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return;
    const other = counterpartOf(call, socket.id);
    if (to && to !== other) return;

    io.to(other).emit("call-reject", {
      from: socket.id,
      callId: call.id,
      reason: reason || "rejected",
    });
    await finishCall(call.id, reason || "rejected", socket.id);
  });

  on("call-hangup", async ({ to, callId, reason } = {}) => {
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return; // already ended by the other side: idempotent no-op
    const other = counterpartOf(call, socket.id);
    if (to && to !== other) return;
    await finishCall(call.id, reason || "hangup", socket.id);
  });

  // The client only sends this after RTCPeerConnection.connectionState is
  // really "connected"; it is never inferred from signaling alone.
  on("call-connected", async ({ callId } = {}) => {
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return;
    const connected = await store.markConnected(call.id);
    if (!connected) return;
    clearCallTimeout(call.id);
    console.log(`[call-connected] ${call.caller} <-> ${call.callee}`);
  });

  on("chat", async ({ to, message, text } = {}) => {
    const body = typeof message === "string" ? message : text;
    if (!to || typeof body !== "string" || !body.trim()) return;

    const call = await store.getCallForUser(socket.id);
    if (!call) return;
    if (to !== counterpartOf(call, socket.id)) return;

    io.to(to).emit("chat", {
      from: socket.id,
      sender: socket.id,
      text: body.slice(0, 2000),
      callId: call.id,
    });
  });

  on("auto-call-start", async () => {
    if (!(await store.getUser(socket.id))) return;
    await store.updateUser(socket.id, { autoActive: true });

    // Already in a call: mark Auto ON, stay reserved, and let finishCall()
    // requeue this user when the current call ends.
    const existing = await store.getCallForUser(socket.id);
    if (!existing) {
      await store.enqueue(socket.id);
    }
    await tryMatch();
    schedulePresence();
  });

  on("auto-call-stop", async () => {
    await store.updateUser(socket.id, { autoActive: false });
    await store.dequeue(socket.id);
    io.to(socket.id).emit("auto-stopped", {});
    schedulePresence();
  });

  socket.on("log", (data) => console.log("CLIENT LOG", socket.id, data));

  on("disconnect", async (reason) => {
    console.log("disconnected:", socket.id, reason || "");

    const user = await store.getUser(socket.id);
    await store.dequeue(socket.id);

    const call = await store.getCallForUser(socket.id);
    if (call) {
      const partner = counterpartOf(call, socket.id);
      // Only the partner is eligible for immediate requeue; the disconnected
      // socket is about to be removed.
      await finishCall(call.id, "peer-disconnected", socket.id, {
        requeueIds: [partner],
      });
    }

    if (user) pushHistoryEntry(socket.id, user.country);
    await store.removeUser(socket.id);
    schedulePresence();
  });
});

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  if (process.env.REDIS_URL) {
    const { createAdapter } = require("@socket.io/redis-adapter");
    const { client, store: redisStore } = await createRedisStore(
      process.env.REDIS_URL
    );
    redisClient = client;
    store = redisStore;

    const pub = client.duplicate();
    const sub = client.duplicate();
    pub.on("error", (err) => console.error("[redis] pub:", err.message));
    sub.on("error", (err) => console.error("[redis] sub:", err.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    console.log("[redis] matchmaking + Socket.IO adapter enabled");
  } else {
    store = new MemoryStore();
    console.log("[store] in-memory (single instance)");
  }

  const heartbeat = setInterval(() => {
    store.heartbeat().catch((err) => {
      console.error("[heartbeat]", err.message);
    });
  }, 25000);
  if (heartbeat.unref) heartbeat.unref();

  const matcher = setInterval(() => {
    tryMatch().catch((err) => console.error("[match]", err.message));
  }, MATCH_INTERVAL_MS);
  if (matcher.unref) matcher.unref();

  server.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    console.log("Socket.IO server ready.");
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
