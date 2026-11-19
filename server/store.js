// server/store.js
//
// Matchmaking storage with two interchangeable implementations:
//
//   MemoryStore  - single process, synchronous reservations (default)
//   RedisStore   - multi-instance safe, atomic reservations via Lua
//
// Both implement the same async API so server/index.js does not care which
// one is active. The in-memory implementation relies on Node's single
// threaded event loop for atomicity: every reservation function runs without
// an await between its check and its write. RedisStore uses Lua scripts, so
// the same check-and-write is atomic across every backend instance.

const PREFIX = {
  user: "anycall:user:",
  online: "anycall:online",
  queue: "anycall:queue",
  queued: "anycall:queued",
  call: "anycall:call:",
  callByUser: "anycall:callByUser:",
  cooldown: "anycall:cooldown:",
};

const USER_TTL_SECONDS = 90;
const CALL_TTL_SECONDS = 120;

/* -------------------------------------------------------------------------- */
/* In-memory store                                                             */
/* -------------------------------------------------------------------------- */

class MemoryStore {
  constructor() {
    this.users = new Map();
    this.calls = new Map();
    this.callByUser = new Map();
    this.queue = [];
    this.queued = new Set();
    this.cooldowns = new Map();
  }

  async addUser(user) {
    this.users.set(user.id, { ...user });
  }

  async removeUser(id) {
    this.users.delete(id);
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    this.cooldowns.delete(id);
  }

  async updateUser(id, patch) {
    const user = this.users.get(id);
    if (!user) return null;
    Object.assign(user, patch);
    return { ...user };
  }

  async getUser(id) {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async listUsers() {
    return Array.from(this.users.values()).map((user) => ({ ...user }));
  }

  async enqueue(id) {
    if (!this.users.has(id) || this.queued.has(id)) return false;
    this.queued.add(id);
    this.queue.push(id);
    return true;
  }

  async dequeue(id) {
    if (!this.queued.has(id)) return false;
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    return true;
  }

  async queueSize() {
    return this.queue.length;
  }

  async getCall(callId) {
    const call = this.calls.get(callId);
    return call ? { ...call } : null;
  }

  async getCallForUser(id) {
    const callId = this.callByUser.get(id);
    return callId ? this.getCall(callId) : null;
  }

  async listCalls() {
    return Array.from(this.calls.values()).map((call) => ({ ...call }));
  }

  _isCooling(a, b) {
    const now = Date.now();
    const ca = this.cooldowns.get(a);
    const cb = this.cooldowns.get(b);
    if (ca && ca.until > now && ca.partner === b) return true;
    if (cb && cb.until > now && cb.partner === a) return true;
    return false;
  }

  async createInvite(callId, caller, callee) {
    if (!callId || caller === callee) return null;
    if (!this.users.has(caller) || !this.users.has(callee)) return null;
    if (this.callByUser.has(caller) || this.callByUser.has(callee)) return null;

    const call = {
      id: callId,
      caller,
      callee,
      state: "invited",
      kind: "invite",
      createdAt: Date.now(),
    };
    this.calls.set(callId, call);
    this.callByUser.set(caller, callId);
    this.callByUser.set(callee, callId);
    return { ...call };
  }

  // Atomic with respect to Node's event loop (no await between check/write).
  async tryPair(callId) {
    const eligible = this.queue.filter(
      (id) => this.users.has(id) && !this.callByUser.has(id)
    );

    for (let i = 0; i < eligible.length; i += 1) {
      for (let j = i + 1; j < eligible.length; j += 1) {
        const a = eligible[i];
        const b = eligible[j];
        if (this._isCooling(a, b)) continue;

        this.queued.delete(a);
        this.queued.delete(b);
        const ia = this.queue.indexOf(a);
        if (ia >= 0) this.queue.splice(ia, 1);
        const ib = this.queue.indexOf(b);
        if (ib >= 0) this.queue.splice(ib, 1);

        const call = {
          id: callId,
          caller: a,
          callee: b,
          state: "connecting",
          kind: "auto",
          createdAt: Date.now(),
        };
        this.calls.set(callId, call);
        this.callByUser.set(a, callId);
        this.callByUser.set(b, callId);
        return { ...call };
      }
    }
    return null;
  }

  async acceptCall(callId, actor) {
    const call = this.calls.get(callId);
    if (!call || call.callee !== actor || call.state !== "invited") return null;
    call.state = "connecting";
    call.acceptedAt = Date.now();
    return { ...call };
  }

  async markConnected(callId) {
    const call = this.calls.get(callId);
    if (!call) return null;
    call.state = "active";
    call.connectedAt = Date.now();
    return { ...call };
  }

  async endCall(callId) {
    const call = this.calls.get(callId);
    if (!call) return null;
    this.calls.delete(callId);
    if (this.callByUser.get(call.caller) === callId) {
      this.callByUser.delete(call.caller);
    }
    if (this.callByUser.get(call.callee) === callId) {
      this.callByUser.delete(call.callee);
    }
    return { ...call, state: "ended" };
  }

  async setCooldown(id, partner, ms) {
    this.cooldowns.set(id, { partner, until: Date.now() + ms });
  }

  async heartbeat() {}

  async close() {}
}

/* -------------------------------------------------------------------------- */
/* Redis store                                                                 */
/* -------------------------------------------------------------------------- */

const ENQUEUE_SCRIPT = `
if redis.call('SADD', KEYS[2], ARGV[1]) == 1 then
  redis.call('RPUSH', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const DEQUEUE_SCRIPT = `
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('LREM', KEYS[1], 0, ARGV[1])
return 1
`;

const CREATE_INVITE_SCRIPT = `
local userPrefix = ARGV[1]
local callByUserPrefix = ARGV[2]
local callPrefix = ARGV[3]
local caller = ARGV[4]
local callee = ARGV[5]
local callId = ARGV[6]
local now = ARGV[7]
local ttl = tonumber(ARGV[8])

if caller == callee then return nil end
if redis.call('EXISTS', userPrefix .. caller) == 0 then return nil end
if redis.call('EXISTS', userPrefix .. callee) == 0 then return nil end
if redis.call('EXISTS', callByUserPrefix .. caller) == 1 then return nil end
if redis.call('EXISTS', callByUserPrefix .. callee) == 1 then return nil end

redis.call('HSET', callPrefix .. callId,
  'caller', caller,
  'callee', callee,
  'state', 'invited',
  'kind', 'invite',
  'createdAt', now)
redis.call('EXPIRE', callPrefix .. callId, ttl)
redis.call('SET', callByUserPrefix .. caller, callId, 'EX', ttl)
redis.call('SET', callByUserPrefix .. callee, callId, 'EX', ttl)
return callId
`;

const TRY_PAIR_SCRIPT = `
local queueKey = KEYS[1]
local queuedKey = KEYS[2]
local userPrefix = ARGV[1]
local callByUserPrefix = ARGV[2]
local callPrefix = ARGV[3]
local cooldownPrefix = ARGV[4]
local callId = ARGV[5]
local now = ARGV[6]
local ttl = tonumber(ARGV[7])

local picked = {}
local scanned = 0
local total = redis.call('LLEN', queueKey)

while #picked < 2 and scanned < total do
  scanned = scanned + 1
  local id = redis.call('LPOP', queueKey)
  if not id then break end
  redis.call('SREM', queuedKey, id)
  if redis.call('EXISTS', userPrefix .. id) == 1 and redis.call('EXISTS', callByUserPrefix .. id) == 0 then
    table.insert(picked, id)
  end
end

if #picked < 2 then
  for i = 1, #picked do
    redis.call('RPUSH', queueKey, picked[i])
    redis.call('SADD', queuedKey, picked[i])
  end
  return nil
end

local a = picked[1]
local b = picked[2]
local ca = redis.call('GET', cooldownPrefix .. a)
local cb = redis.call('GET', cooldownPrefix .. b)

if ca == b or cb == a then
  redis.call('RPUSH', queueKey, a)
  redis.call('RPUSH', queueKey, b)
  redis.call('SADD', queuedKey, a)
  redis.call('SADD', queuedKey, b)
  return nil
end

redis.call('HSET', callPrefix .. callId,
  'caller', a,
  'callee', b,
  'state', 'connecting',
  'kind', 'auto',
  'createdAt', now)
redis.call('EXPIRE', callPrefix .. callId, ttl)
redis.call('SET', callByUserPrefix .. a, callId, 'EX', ttl)
redis.call('SET', callByUserPrefix .. b, callId, 'EX', ttl)
return {a, b, callId}
`;

const ACCEPT_SCRIPT = `
local callPrefix = ARGV[1]
local callByUserPrefix = ARGV[2]
local callId = ARGV[3]
local actor = ARGV[4]
local ttl = tonumber(ARGV[5])
local now = ARGV[6]

local caller = redis.call('HGET', callPrefix .. callId, 'caller')
local callee = redis.call('HGET', callPrefix .. callId, 'callee')
local state = redis.call('HGET', callPrefix .. callId, 'state')

if not caller then return nil end
if actor ~= callee then return nil end
if state ~= 'invited' then return nil end

redis.call('HSET', callPrefix .. callId, 'state', 'connecting', 'acceptedAt', now)
redis.call('EXPIRE', callPrefix .. callId, ttl)
redis.call('EXPIRE', callByUserPrefix .. caller, ttl)
redis.call('EXPIRE', callByUserPrefix .. callee, ttl)
return {caller, callee, 'connecting'}
`;

const CONNECTED_SCRIPT = `
local callPrefix = ARGV[1]
local callByUserPrefix = ARGV[2]
local callId = ARGV[3]
local ttl = tonumber(ARGV[4])

local caller = redis.call('HGET', callPrefix .. callId, 'caller')
local callee = redis.call('HGET', callPrefix .. callId, 'callee')
if not caller then return nil end

redis.call('HSET', callPrefix .. callId, 'state', 'active', 'connectedAt', ARGV[5])
redis.call('EXPIRE', callPrefix .. callId, ttl)
redis.call('EXPIRE', callByUserPrefix .. caller, ttl)
redis.call('EXPIRE', callByUserPrefix .. callee, ttl)
return 'active'
`;

const END_CALL_SCRIPT = `
local callPrefix = ARGV[1]
local callByUserPrefix = ARGV[2]
local callId = ARGV[3]

local caller = redis.call('HGET', callPrefix .. callId, 'caller')
local callee = redis.call('HGET', callPrefix .. callId, 'callee')
local state = redis.call('HGET', callPrefix .. callId, 'state')
if not caller then return nil end

redis.call('DEL', callPrefix .. callId)
if redis.call('GET', callByUserPrefix .. caller) == callId then
  redis.call('DEL', callByUserPrefix .. caller)
end
if redis.call('GET', callByUserPrefix .. callee) == callId then
  redis.call('DEL', callByUserPrefix .. callee)
end
return {caller, callee, state}
`;

class RedisStore {
  constructor(client) {
    this.client = client;
    this.localUsers = new Map();
  }

  async addUser(user) {
    this.localUsers.set(user.id, { ...user });
    await this.client.set(`${PREFIX.user}${user.id}`, JSON.stringify(user), {
      EX: USER_TTL_SECONDS,
    });
    await this.client.sAdd(PREFIX.online, user.id);
  }

  async removeUser(id) {
    this.localUsers.delete(id);
    await this.client.del(`${PREFIX.user}${id}`);
    await this.client.sRem(PREFIX.online, id);
    await this.dequeue(id);
    await this.client.del(`${PREFIX.cooldown}${id}`);
  }

  async updateUser(id, patch) {
    const current = this.localUsers.get(id);
    const merged = current ? { ...current, ...patch } : { ...patch, id };
    this.localUsers.set(id, merged);
    await this.client.set(`${PREFIX.user}${id}`, JSON.stringify(merged), {
      EX: USER_TTL_SECONDS,
    });
    return { ...merged };
  }

  async getUser(id) {
    const raw = await this.client.get(`${PREFIX.user}${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async listUsers() {
    const ids = await this.client.sMembers(PREFIX.online);
    if (!ids.length) return [];
    const raws = await this.client.mGet(ids.map((id) => `${PREFIX.user}${id}`));
    const users = [];
    const stale = [];
    ids.forEach((id, index) => {
      const raw = raws[index];
      if (!raw) {
        stale.push(id);
        return;
      }
      try {
        users.push(JSON.parse(raw));
      } catch (e) {
        stale.push(id);
      }
    });
    if (stale.length) {
      await this.client.sRem(PREFIX.online, stale);
    }
    return users;
  }

  async enqueue(id) {
    const result = await this.client.eval(ENQUEUE_SCRIPT, {
      keys: [PREFIX.queue, PREFIX.queued],
      arguments: [id],
    });
    return Number(result) === 1;
  }

  async dequeue(id) {
    await this.client.eval(DEQUEUE_SCRIPT, {
      keys: [PREFIX.queue, PREFIX.queued],
      arguments: [id],
    });
    return true;
  }

  async queueSize() {
    return this.client.lLen(PREFIX.queue);
  }

  async _readCall(callId) {
    const raw = await this.client.hGetAll(`${PREFIX.call}${callId}`);
    if (!raw || !raw.caller) return null;
    return {
      id: callId,
      caller: raw.caller,
      callee: raw.callee,
      state: raw.state,
      kind: raw.kind,
      createdAt: Number(raw.createdAt || 0),
      acceptedAt: raw.acceptedAt ? Number(raw.acceptedAt) : undefined,
      connectedAt: raw.connectedAt ? Number(raw.connectedAt) : undefined,
    };
  }

  async getCall(callId) {
    if (!callId) return null;
    return this._readCall(callId);
  }

  async getCallForUser(id) {
    const callId = await this.client.get(`${PREFIX.callByUser}${id}`);
    if (!callId) return null;
    return this._readCall(callId);
  }

  async listCalls() {
    const calls = [];
    for await (const key of this.client.scanIterator({
      MATCH: `${PREFIX.call}*`,
      COUNT: 100,
    })) {
      const rawKey = Array.isArray(key) ? key[0] : key;
      const callId = String(rawKey).slice(PREFIX.call.length);
      const call = await this._readCall(callId);
      if (call) calls.push(call);
    }
    return calls;
  }

  async createInvite(callId, caller, callee) {
    const result = await this.client.eval(CREATE_INVITE_SCRIPT, {
      keys: [],
      arguments: [
        PREFIX.user,
        PREFIX.callByUser,
        PREFIX.call,
        caller,
        callee,
        callId,
        String(Date.now()),
        String(CALL_TTL_SECONDS),
      ],
    });
    if (!result) return null;
    return this.getCall(callId);
  }

  async tryPair(callId) {
    const result = await this.client.eval(TRY_PAIR_SCRIPT, {
      keys: [PREFIX.queue, PREFIX.queued],
      arguments: [
        PREFIX.user,
        PREFIX.callByUser,
        PREFIX.call,
        PREFIX.cooldown,
        callId,
        String(Date.now()),
        String(CALL_TTL_SECONDS),
      ],
    });
    if (!Array.isArray(result) || result.length < 3) return null;
    return this.getCall(callId);
  }

  async acceptCall(callId, actor) {
    const result = await this.client.eval(ACCEPT_SCRIPT, {
      keys: [],
      arguments: [
        PREFIX.call,
        PREFIX.callByUser,
        callId,
        actor,
        String(CALL_TTL_SECONDS),
        String(Date.now()),
      ],
    });
    if (!Array.isArray(result) || result.length < 2) return null;
    return this._readCall(callId);
  }

  async markConnected(callId) {
    const result = await this.client.eval(CONNECTED_SCRIPT, {
      keys: [],
      arguments: [
        PREFIX.call,
        PREFIX.callByUser,
        callId,
        String(CALL_TTL_SECONDS),
        String(Date.now()),
      ],
    });
    if (!result) return null;
    return this._readCall(callId);
  }

  async endCall(callId) {
    const result = await this.client.eval(END_CALL_SCRIPT, {
      keys: [],
      arguments: [PREFIX.call, PREFIX.callByUser, callId],
    });
    if (!Array.isArray(result) || result.length < 2) return null;
    return { id: callId, caller: result[0], callee: result[1], state: "ended" };
  }

  async setCooldown(id, partner, ms) {
    await this.client.set(`${PREFIX.cooldown}${id}`, partner, { PX: ms });
  }

  // Refresh presence + active-call TTLs. Called for users connected to this
  // instance, so a crashed instance cannot leave a user busy forever.
  async heartbeat() {
    const ids = Array.from(this.localUsers.keys());
    if (!ids.length) return;

    const presence = this.client.multi();
    for (const id of ids) {
      const user = this.localUsers.get(id);
      presence.set(`${PREFIX.user}${id}`, JSON.stringify(user), {
        EX: USER_TTL_SECONDS,
      });
    }
    await presence.exec();

    const lookup = this.client.multi();
    for (const id of ids) {
      lookup.get(`${PREFIX.callByUser}${id}`);
    }
    const results = await lookup.exec();
    const refresh = this.client.multi();
    results.forEach((entry, index) => {
      const callId = entry && entry[1];
      if (!callId) return;
      refresh.expire(`${PREFIX.call}${callId}`, CALL_TTL_SECONDS);
      refresh.expire(
        `${PREFIX.callByUser}${ids[index]}`,
        CALL_TTL_SECONDS
      );
    });
    await refresh.exec();
  }

  async close() {
    // The Redis client is owned by server/index.js.
  }
}

async function createRedisStore(redisUrl) {
  // Required only when REDIS_URL is set, so single-instance deployments do
  // not need Redis installed.
  const { createClient } = require("redis");
  const client = createClient({ url: redisUrl });
  client.on("error", (err) => {
    console.error("[redis] store error:", err.message);
  });
  await client.connect();
  return { store: new RedisStore(client), client };
}

module.exports = {
  MemoryStore,
  RedisStore,
  createRedisStore,
  PREFIX,
  USER_TTL_SECONDS,
  CALL_TTL_SECONDS,
};
