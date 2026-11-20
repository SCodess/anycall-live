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
const jwt = require("jsonwebtoken");
const geoip = require("geoip-lite");
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

const GUEST_TOKEN_SECRET =
  process.env.GUEST_TOKEN_SECRET || "anycall-dev-guest-secret-change-me";
const GUEST_TOKEN_TTL = "30d";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "32kb" }));

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

const NAME_ADJECTIVES = [
  "Calm",
  "Bright",
  "Cosmic",
  "Gentle",
  "Lucky",
  "Mellow",
  "Neon",
  "Quiet",
  "Sunny",
  "Swift",
  "Velvet",
  "Witty",
];
const NAME_ANIMALS = [
  "Otter",
  "Panda",
  "Fox",
  "Koala",
  "Lynx",
  "Mango",
  "Nova",
  "Orca",
  "Robin",
  "Tiger",
  "Wolf",
  "Yuki",
];

function cleanText(value, max = 24) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeCountry(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function normalizeGender(value, fallback = "other") {
  return ["male", "female", "other"].includes(value) ? value : fallback;
}

function normalizeInterests(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const interests = [];
  for (const item of value) {
    const text = cleanText(item, 24);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    interests.push(text);
    if (interests.length >= 8) break;
  }
  return interests;
}

function normalizeFilters(value) {
  const input = value && typeof value === "object" ? value : {};
  const country =
    input.country && input.country !== "any"
      ? normalizeCountry(input.country) || "any"
      : "any";
  return {
    gender: ["any", "male", "female", "other"].includes(input.gender)
      ? input.gender
      : "any",
    country,
    interests: normalizeInterests(input.interests),
  };
}

function randomGuestName() {
  const adjective =
    NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const animal =
    NAME_ANIMALS[Math.floor(Math.random() * NAME_ANIMALS.length)];
  return `${adjective}${animal}${Math.floor(10 + Math.random() * 90)}`;
}

function lookupCountry(req) {
  try {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    const ip = (forwarded || req.ip || "").replace(/^::ffff:/, "");
    if (!ip || ip === "::1" || ip.startsWith("127.")) return null;
    const geo = geoip.lookup(ip);
    return geo && geo.country ? normalizeCountry(geo.country) : null;
  } catch (e) {
    return null;
  }
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    gender: profile.gender,
    country: profile.country || null,
    flag: countryToFlag(profile.country),
    interests: Array.isArray(profile.interests) ? profile.interests : [],
    filters: normalizeFilters(profile.filters),
    allowIncoming: profile.allowIncoming !== false,
    createdAt: profile.createdAt || null,
  };
}

async function createGuestProfile(body = {}, req = {}) {
  const profile = {
    id: crypto.randomUUID(),
    name: cleanText(body.name, 24) || randomGuestName(),
    avatar: Math.floor(Math.random() * 12),
    gender: normalizeGender(body.gender, "other"),
    country: normalizeCountry(body.country) || lookupCountry(req),
    interests: normalizeInterests(body.interests),
    filters: normalizeFilters(body.filters),
    allowIncoming: body.allowIncoming !== false,
    banned: false,
    createdAt: Date.now(),
  };
  return store.saveProfile(profile);
}

function signGuestToken(guestId) {
  return jwt.sign({ sub: guestId }, GUEST_TOKEN_SECRET, {
    expiresIn: GUEST_TOKEN_TTL,
  });
}

function verifyGuestToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, GUEST_TOKEN_SECRET);
    return payload && typeof payload.sub === "string" ? payload.sub : null;
  } catch (e) {
    return null;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function authGuest(req, res, next) {
  const guestId = verifyGuestToken(bearerToken(req));
  if (!guestId) return res.status(401).json({ error: "unauthorized" });
  req.guestId = guestId;
  next();
}

function adminOnly(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: "not-found" });
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

function profileSummary(user) {
  if (!user) return null;
  return {
    guestId: user.guestId || null,
    name: user.name || null,
    avatar: user.avatar != null ? user.avatar : null,
    gender: user.gender || null,
    country: user.country || null,
    flag: countryToFlag(user.country),
    interests: Array.isArray(user.interests) ? user.interests : [],
  };
}

// Blocks and bans are stored against the persistent guest identity. Anonymous
// sockets (old clients / raw tests) fall back to the socket id.
function identityOf(user) {
  if (!user) return null;
  return user.guestId || user.id || null;
}

// Match only when both sides' filters accept the other person. Missing
// profile fields default to "any", so old clients still match.
function isCompatible(a, b) {
  if (!a || !b) return false;
  const af = normalizeFilters(a.filters);
  const bf = normalizeFilters(b.filters);
  if (af.gender !== "any" && b.gender !== af.gender) return false;
  if (bf.gender !== "any" && a.gender !== bf.gender) return false;
  if (af.country !== "any" && b.country !== af.country) return false;
  if (bf.country !== "any" && a.country !== bf.country) return false;

  const ai = normalizeInterests(a.interests).map((i) => i.toLowerCase());
  const bi = normalizeInterests(b.interests).map((i) => i.toLowerCase());
  if (af.interests.length && !af.interests.some((i) => bi.includes(i.toLowerCase()))) {
    return false;
  }
  if (bf.interests.length && !bf.interests.some((i) => ai.includes(i.toLowerCase()))) {
    return false;
  }
  return true;
}

async function recordCallHistory(call, reason) {
  const [caller, callee] = await Promise.all([
    store.getUser(call.caller),
    store.getUser(call.callee),
  ]);
  const endedAt = Date.now();
  const startedAt =
    call.connectedAt || call.acceptedAt || call.createdAt || endedAt;
  const durationMs = Math.max(0, endedAt - startedAt);

  const add = async (me, other, direction) => {
    if (!me) return;
    const id = me.guestId || me.id;
    await store.addHistory(id, {
      callId: call.id,
      partnerGuestId: other ? other.guestId || null : null,
      partnerId: other ? other.id : null,
      partnerName: other ? other.name || null : null,
      partnerAvatar: other && other.avatar != null ? other.avatar : null,
      country: other ? other.country || null : null,
      flag: countryToFlag(other && other.country),
      startedAt,
      endedAt,
      durationMs,
      direction: call.kind === "auto" ? "auto" : direction,
      kind: call.kind || "invite",
      reason: reason || "ended",
    });
  };

  await Promise.all([
    add(caller, callee, "outgoing"),
    add(callee, caller, "incoming"),
  ]);
}

async function syncGuestToSockets(guestId, profile) {
  const sockets = await io.in(`guest:${guestId}`).fetchSockets();
  await Promise.all(
    sockets.map((socket) =>
      store.updateUser(socket.id, {
        guestId,
        name: profile.name,
        avatar: profile.avatar,
        gender: profile.gender,
        country: profile.country || null,
        interests: profile.interests || [],
        filters: normalizeFilters(profile.filters),
        allowIncoming: profile.allowIncoming !== false,
      })
    )
  );
}

let presenceTimer = null;
function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(async () => {
    presenceTimer = null;
    try {
      const users = await store.listUsers();
      const byKey = new Map();
      for (const user of users) {
        const key = user.guestId || user.id;
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, user);
          continue;
        }
        // Several tabs / sockets can belong to one guest. Show the richest
        // record so the online list still has a name and avatar.
        const score = (item) =>
          (item.guestId ? 2 : 0) + (item.name ? 1 : 0) + (item.country ? 1 : 0);
        if (score(user) > score(existing)) byKey.set(key, user);
      }
      const unique = Array.from(byKey.values());
      io.emit("presence", {
        count: unique.length,
        list: unique.map((user) => ({
          id: user.id,
          guestId: user.guestId || null,
          name: user.name || null,
          avatar: user.avatar != null ? user.avatar : null,
          gender: user.gender || null,
          country: user.country || null,
          flag: countryToFlag(user.country),
          interests: Array.isArray(user.interests) ? user.interests : [],
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
  // Redis endCall() only returns the participants, so history needs a
  // snapshot taken before the reservation is deleted.
  const snapshot = await store.getCall(callId);
  const call = await store.endCall(callId);
  if (!call) return null;

  clearCallTimeout(callId);

  // Only real conversations (accepted or connected) belong in call history.
  if (snapshot && (snapshot.acceptedAt || snapshot.connectedAt)) {
    try {
      await recordCallHistory(snapshot, reason);
    } catch (err) {
      console.error("[history]", err.message);
    }
  }

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
  const [caller, callee] = await Promise.all([
    store.getUser(call.caller),
    store.getUser(call.callee),
  ]);

  io.to(call.callee).emit("auto-ready", {
    from: call.caller,
    callId: call.id,
    partner: profileSummary(caller),
  });
  io.to(call.caller).emit("call-accept", {
    from: call.callee,
    callId: call.id,
    partner: profileSummary(callee),
  });
  scheduleCallTimeout(call.id);
  console.log(`[auto-match] ${call.caller} <-> ${call.callee} (${call.id})`);
}

let matchRunning = false;
let matchPending = false;

// Pairs as many waiting users as possible. Compatibility is mutual: both
// users' filters must accept the other person, and blocked pairs never match.
// store.pairUsers() is atomic, so simultaneous matcher runs (including runs on
// other backend instances) cannot reserve the same user twice.
async function tryMatch() {
  if (matchRunning) {
    matchPending = true;
    return;
  }
  matchRunning = true;
  try {
    if ((await store.queueSize()) < 2) return;
    const users = await store.listQueueUsers();
    const used = new Set();

    for (let i = 0; i < users.length; i += 1) {
      const a = users[i];
      if (used.has(a.id)) continue;
      for (let j = i + 1; j < users.length; j += 1) {
        const b = users[j];
        if (used.has(b.id)) continue;
        if (!isCompatible(a, b)) continue;
        if (await store.isBlocked(identityOf(a), identityOf(b))) continue;

        const call = await store.pairUsers(crypto.randomUUID(), a.id, b.id);
        if (!call) continue; // stale queue entry / cooldown / busy
        used.add(a.id);
        used.add(b.id);
        await announcePair(call);
        break;
      }
    }
  } finally {
    matchRunning = false;
  }

  if (matchPending) {
    matchPending = false;
    tryMatch().catch((err) => console.error("[match]", err.message));
  }
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
/* Guest + social REST API                                                     */
/* -------------------------------------------------------------------------- */

const route = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error("[api]", err.message);
    if (!res.headersSent) res.status(500).json({ error: "server-error" });
  });
};

const guestCreateBuckets = new Map();
function allowGuestCreate(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = 30;
  const bucket = guestCreateBuckets.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  guestCreateBuckets.set(ip, bucket);
  if (guestCreateBuckets.size > 5000) {
    for (const [key, value] of guestCreateBuckets) {
      if (now - value.start > windowMs) guestCreateBuckets.delete(key);
    }
  }
  return bucket.count <= max;
}

async function decorateFriendIds(ids) {
  const [profiles, users] = await Promise.all([
    store.getProfiles(ids),
    store.listUsers(),
  ]);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const onlineByGuest = new Map();
  for (const user of users) {
    if (user.guestId && !onlineByGuest.has(user.guestId)) {
      onlineByGuest.set(user.guestId, user);
    }
  }
  return ids.map((id) => {
    const profile = profileById.get(id);
    const live = onlineByGuest.get(id);
    return {
      guestId: id,
      name: profile ? profile.name : null,
      avatar: profile ? profile.avatar : null,
      gender: profile ? profile.gender : null,
      country: profile ? profile.country : null,
      flag: countryToFlag(profile && profile.country),
      interests: profile && Array.isArray(profile.interests)
        ? profile.interests
        : [],
      online: !!live,
      socketId: live ? live.id : null,
      autoActive: !!(live && live.autoActive),
    };
  });
}

app.post(
  "/api/guest",
  route(async (req, res) => {
    const ip = String(req.ip || "").replace(/^::ffff:/, "");
    if (!allowGuestCreate(ip)) {
      res.status(429).json({ error: "too-many-guests" });
      return;
    }
    const profile = await createGuestProfile(req.body || {}, req);
    res.json({
      token: signGuestToken(profile.id),
      profile: publicProfile(profile),
    });
  })
);

app.get(
  "/api/me",
  authGuest,
  route(async (req, res) => {
    const profile = await store.getProfile(req.guestId);
    if (!profile) {
      res.status(404).json({ error: "profile-not-found" });
      return;
    }
    res.json({ profile: publicProfile(profile) });
  })
);

app.patch(
  "/api/me",
  authGuest,
  route(async (req, res) => {
    const profile = await store.getProfile(req.guestId);
    if (!profile) {
      res.status(404).json({ error: "profile-not-found" });
      return;
    }
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      patch.name = cleanText(body.name, 24) || profile.name;
    }
    if (body.gender !== undefined) {
      patch.gender = normalizeGender(body.gender, profile.gender);
    }
    if (body.country !== undefined) {
      patch.country =
        body.country === "any" ? null : normalizeCountry(body.country);
    }
    if (body.interests !== undefined) {
      patch.interests = normalizeInterests(body.interests);
    }
    if (body.filters !== undefined) {
      patch.filters = normalizeFilters(body.filters);
    }
    if (body.allowIncoming !== undefined) {
      patch.allowIncoming = !!body.allowIncoming;
    }

    const updated = await store.saveProfile({ ...profile, ...patch });
    await syncGuestToSockets(req.guestId, updated);
    io.to(`guest:${req.guestId}`).emit("profile-updated", {
      profile: publicProfile(updated),
    });
    schedulePresence();
    res.json({ profile: publicProfile(updated) });
  })
);

app.get(
  "/api/friends",
  authGuest,
  route(async (req, res) => {
    const social = await store.getSocial(req.guestId);
    const ids = Array.from(
      new Set([...social.friends, ...social.incoming, ...social.outgoing])
    );
    const decorated = await decorateFriendIds(ids);
    const byId = new Map(decorated.map((item) => [item.guestId, item]));
    const pick = (id) => byId.get(id);
    res.json({
      friends: social.friends.map(pick).filter(Boolean),
      incoming: social.incoming.map(pick).filter(Boolean),
      outgoing: social.outgoing.map(pick).filter(Boolean),
    });
  })
);

app.post(
  "/api/friends/requests",
  authGuest,
  route(async (req, res) => {
    const to = cleanText(req.body && req.body.toGuestId, 64);
    if (!to || to === req.guestId) {
      res.status(400).json({ error: "invalid-target" });
      return;
    }
    const [me, target] = await Promise.all([
      store.getProfile(req.guestId),
      store.getProfile(to),
    ]);
    if (!me || !target) {
      res.status(404).json({ error: "target-not-found" });
      return;
    }
    if (target.banned || (await store.isBanned(to))) {
      res.status(403).json({ error: "target-banned" });
      return;
    }
    if (await store.isBlocked(req.guestId, to)) {
      res.status(403).json({ error: "blocked" });
      return;
    }
    const result = await store.sendFriendRequest(req.guestId, to);
    if (result.ok) {
      io.to(`guest:${to}`).emit("friend-request", {
        from: {
          guestId: me.id,
          name: me.name,
          avatar: me.avatar,
          country: me.country || null,
          flag: countryToFlag(me.country),
        },
      });
    }
    res.json(result);
  })
);

app.post(
  "/api/friends/requests/:id/accept",
  authGuest,
  route(async (req, res) => {
    const from = cleanText(req.params.id, 64);
    const ok = await store.acceptFriendRequest(req.guestId, from);
    if (!ok) {
      res.status(404).json({ error: "request-not-found" });
      return;
    }
    const [me, other] = await Promise.all([
      store.getProfile(req.guestId),
      store.getProfile(from),
    ]);
    for (const [room, profile] of [
      [req.guestId, me],
      [from, other],
    ]) {
      if (profile) {
        io.to(`guest:${room}`).emit("friend-accepted", {
          profile: publicProfile(profile),
        });
      }
    }
    res.json({ ok: true });
  })
);

app.post(
  "/api/friends/requests/:id/decline",
  authGuest,
  route(async (req, res) => {
    const from = cleanText(req.params.id, 64);
    const ok = await store.declineFriendRequest(req.guestId, from);
    if (!ok) {
      res.status(404).json({ error: "request-not-found" });
      return;
    }
    res.json({ ok: true });
  })
);

app.delete(
  "/api/friends/:id",
  authGuest,
  route(async (req, res) => {
    const other = cleanText(req.params.id, 64);
    await store.removeFriend(req.guestId, other);
    io.to(`guest:${other}`).emit("friend-removed", {
      guestId: req.guestId,
    });
    res.json({ ok: true });
  })
);

app.get(
  "/api/history",
  authGuest,
  route(async (req, res) => {
    const list = await store.getHistory(req.guestId);
    res.json({ list });
  })
);

app.post(
  "/api/reports",
  authGuest,
  route(async (req, res) => {
    const body = req.body || {};
    const targetGuestId = cleanText(body.targetGuestId, 64);
    if (!targetGuestId || targetGuestId === req.guestId) {
      res.status(400).json({ error: "invalid-target" });
      return;
    }
    const target = await store.getProfile(targetGuestId);
    if (!target) {
      res.status(404).json({ error: "target-not-found" });
      return;
    }
    await store.addReport({
      reporterId: req.guestId,
      targetGuestId,
      targetName: target.name || null,
      reason: cleanText(body.reason, 40) || "other",
      details: cleanText(body.details, 500),
      callId: cleanText(body.callId, 64) || null,
    });
    res.json({ ok: true });
  })
);

app.get(
  "/api/blocks",
  authGuest,
  route(async (req, res) => {
    res.json({ list: await store.getBlocks(req.guestId) });
  })
);

app.post(
  "/api/blocks/:id",
  authGuest,
  route(async (req, res) => {
    const target = cleanText(req.params.id, 64);
    if (!target || target === req.guestId) {
      res.status(400).json({ error: "invalid-target" });
      return;
    }
    await store.block(req.guestId, target);
    await store.removeFriend(req.guestId, target);
    res.json({ ok: true });
  })
);

app.delete(
  "/api/blocks/:id",
  authGuest,
  route(async (req, res) => {
    await store.unblock(req.guestId, cleanText(req.params.id, 64));
    res.json({ ok: true });
  })
);

app.get(
  "/api/admin/reports",
  adminOnly,
  route(async (req, res) => {
    res.json({ list: await store.listReports() });
  })
);

app.post(
  "/api/admin/ban",
  adminOnly,
  route(async (req, res) => {
    const guestId = cleanText(req.body && req.body.guestId, 64);
    if (!guestId) {
      res.status(400).json({ error: "invalid-target" });
      return;
    }
    await store.ban(guestId, cleanText(req.body.reason, 120) || "violation");
    io.in(`guest:${guestId}`).disconnectSockets(true);
    res.json({ ok: true });
  })
);

app.post(
  "/api/admin/unban",
  adminOnly,
  route(async (req, res) => {
    const guestId = cleanText(req.body && req.body.guestId, 64);
    if (!guestId) {
      res.status(400).json({ error: "invalid-target" });
      return;
    }
    await store.unban(guestId);
    res.json({ ok: true });
  })
);

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

  // A guest token binds this socket to a persistent profile. It is sent on
  // every connect (including reconnects), so a reload keeps friends/history.
  on("identify", async ({ token } = {}) => {
    const guestId = verifyGuestToken(token);
    if (!guestId) {
      socket.emit("identify-error", { error: "unauthorized" });
      return;
    }
    const profile = await store.getProfile(guestId);
    if (!profile) {
      socket.emit("identify-error", { error: "profile-not-found" });
      return;
    }
    if (profile.banned || (await store.isBanned(guestId))) {
      socket.emit("banned", {
        reason: profile.banReason || "violation",
      });
      socket.disconnect(true);
      return;
    }

    socket.join(`guest:${guestId}`);
    await store.updateUser(socket.id, {
      guestId,
      name: profile.name,
      avatar: profile.avatar,
      gender: profile.gender,
      country: profile.country || null,
      interests: profile.interests || [],
      filters: normalizeFilters(profile.filters),
      allowIncoming: profile.allowIncoming !== false,
    });
    socket.emit("identified", {
      socketId: socket.id,
      guestId,
      profile: publicProfile(profile),
    });
    schedulePresence();
  });

  on("get-history", async () => {
    const user = await store.getUser(socket.id);
    if (!user || !user.guestId) {
      socket.emit("history", { list: [] });
      return;
    }
    const list = await store.getHistory(user.guestId);
    socket.emit("history", { list });
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
    if (
      await store.isBlocked(identityOf(caller), identityOf(target))
    ) {
      socket.emit("call-reject", { from: to, reason: "blocked" });
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

    io.to(to).emit("call-invite", {
      from: socket.id,
      callId: call.id,
      partner: profileSummary(caller),
    });
    socket.emit("call-ringing", {
      to,
      callId: call.id,
      partner: profileSummary(target),
    });
    scheduleCallTimeout(call.id);
    schedulePresence();
  });

  on("call-accept", async ({ to, callId } = {}) => {
    const call = await getCallForSocket(socket.id, callId);
    if (!call) return;
    if (call.callee !== socket.id) return;
    if (to && to !== call.caller) return;

    const accepted = await store.acceptCall(call.id, socket.id);
    if (!accepted) return; // duplicate accept: ignore, never restart the call

    const calleeUser = await store.getUser(socket.id);
    io.to(accepted.caller).emit("call-accept", {
      from: socket.id,
      callId: accepted.id,
      partner: profileSummary(calleeUser),
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
