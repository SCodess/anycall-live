# AnyCall - Permanent Deployment Guide

Production shape:

- **Frontend:** Vercel (`client/`, Vite build)
- **Backend:** Railway (`server/`, Node + Socket.IO)
- **Redis:** optional for one backend instance, **required for two or more**
- **TURN:** required for calls between restrictive networks (mobile data,
  symmetric NAT, corporate firewalls)

The app still works with a single in-memory backend, but that mode cannot
survive a restart and cannot be scaled to more than one instance.

## Prerequisites

- Git repository (already initialized)
- Node.js 18+ installed
- npm or yarn package manager
- Accounts on [Vercel](https://vercel.com) and [Railway](https://railway.app)
- A TURN service (see below)

## Deployment Steps

### Step 1: Deploy Backend to Railway

1. **Push to GitHub first** (required by Railway):
   ```bash
   git add .
   git commit -m "Harden calling and matchmaking"
   git push origin main
   ```

2. **Create Railway project**:
   - Go to https://railway.app/new
   - Select "GitHub"
   - Choose your repository
   - Railway will detect `railway.toml` and deploy `server/`

3. **Get your Railway URL**:
   - Open the project → Deployments → latest deployment
   - Click "View Public URL" (for example
     `https://anycall-live-production.up.railway.app`)

4. **Check the health endpoint**:
   ```bash
   curl https://your-railway-url.up.railway.app/health
   ```
   It returns `ok`, connected user count, whether Redis is active, and uptime.

### Step 2: Redis (required for more than one backend instance)

Without `REDIS_URL`, the server keeps matchmaking in process memory. That is
fine for a single Railway replica, but two replicas would each have their own
queue and could not reserve users atomically.

1. In the Railway project, click **New → Database → Redis**.
2. In the backend service, add a variable:
   ```
   REDIS_URL=${{Redis.REDIS_URL}}
   ```
3. Redeploy. `/health` should show `"redis": true`.

With Redis enabled, the server:

- runs every reservation / pairing decision as an atomic Lua script,
- uses the Socket.IO Redis adapter so signaling reaches users connected to
  another instance,
- refreshes presence and active-call TTLs with a heartbeat, so a crashed
  instance cannot leave a user busy forever.

If you use HTTP long-polling (the client tries WebSocket first), enable
sticky sessions on the load balancer. WebSocket connections do not need
stickiness.

### Step 3: TURN (required for real-world calls)

STUN alone only works when at least one peer can accept a direct connection.
Mobile networks and symmetric NAT usually cannot. The public Open Relay
credentials previously hard-coded here are no longer reliable — tests in this
repo found **zero relay candidates** from that service. Do not rely on it.

Use a real TURN service (Metered, Twilio Network Traversal, Cloudflare Calls,
or your own coturn). Then set these **build-time** variables in Vercel:

```
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=your-username
VITE_TURN_CREDENTIAL=your-credential
```

Multiple URLs can be comma-separated, for example:

```
VITE_TURN_URL=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
```

Vite bakes these values into the bundle at build time, so **redeploy the
frontend after changing them**.

`client/.env.production` is the local production env file. Keep the Railway
URL there and add the TURN values (or set them in the Vercel dashboard, which
takes precedence for that project).

### Step 4: Deploy Frontend to Vercel

1. **Configure environment variables** in Vercel (Project Settings →
   Environment Variables):
   ```
   VITE_SIGNALING_SERVER=https://your-railway-url.up.railway.app
   VITE_TURN_URL=turn:turn.example.com:3478
   VITE_TURN_USERNAME=your-username
   VITE_TURN_CREDENTIAL=your-credential
   ```

2. **Deploy**:
   ```bash
   cd client
   npx vercel --prod
   ```

   Vercel uses `client/vercel.json` (`framework: vite`, output `dist`). The
   tracked `dist/` files are stale build artifacts and are not the source of
   truth; always let Vercel run `npm run build`.

## Runtime settings (Railway)

All optional; defaults are safe.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / Socket.IO port |
| `CALL_TIMEOUT_MS` | `45000` | Max time from invite/accept to real WebRTC connection |
| `MATCH_INTERVAL_MS` | `1500` | How often the queue is scanned |
| `MATCH_COOLDOWN_MS` | `4000` | Do not immediately re-pair the same two users |
| `REDIS_URL` | unset | Enables Redis store + Socket.IO adapter |
| `NODE_ENV` | — | `production` disables `/debug/state` |

The server exposes `/health` at all times. `/debug/state` is local/test only.

## Tests

Run these from the repo.

```bash
# Signaling + matchmaking: 2/4/9/100 users, races, hangups, timeouts, requeue
cd server
node test/signaling.test.js

# Same suite against the Redis-backed store
REDIS_URL=redis://127.0.0.1:6379 node test/signaling.test.js   # bash
$env:REDIS_URL="redis://127.0.0.1:6379"; node test/signaling.test.js   # PowerShell

# Two live backend processes sharing one Redis
REDIS_URL=redis://127.0.0.1:6379 node test/multi-instance.test.js
```

The browser suite needs a Chrome/Chromium install and a test bundle built
against the local signaling server:

```bash
cd client
VITE_SIGNALING_SERVER=http://127.0.0.1:3214 VITE_TURN_URL=... VITE_TURN_USERNAME=... VITE_TURN_CREDENTIAL=... npm run build
node test/webrtc.e2e.js
```

It covers two real pages with fake microphones: actual audio tracks, chat in
both directions, hangup/rematch, simultaneous hangup, microphone denial, and a
relay-only TURN probe.

These tests do **not** replace real-device testing. Verify at least:

- two phones on different networks (one on mobile data) with TURN configured,
- a call while the backend is redeployed,
- a browser refresh during a call,
- simultaneous hangup from both devices,
- a second backend instance with `REDIS_URL` set.

## Troubleshooting

### Calls stay "connecting" or show a connect timeout

- Confirm `VITE_SIGNALING_SERVER` points at Railway and `/health` is reachable.
- Check that a TURN server is configured and that its credentials are valid.
- Chrome DevTools → `chrome://webrtc-internals` shows ICE candidate types.
  A call between restrictive networks needs `relay` candidates.

### No relay candidates

The TURN host/port is blocked, credentials are wrong, or the service is down.
Public Open Relay is **not** a working fallback. Use a paid or self-hosted
coturn instance.

### Socket.IO connection issues

- Railway logs should show `[redis] matchmaking + Socket.IO adapter enabled`
  when `REDIS_URL` is set, or `[store] in-memory (single instance)` otherwise.
- If you run multiple replicas without Redis, users on different instances can
  never match. This is a deployment error, not a UI bug.
- With polling across multiple replicas, enable sticky sessions.

### One user appears in two calls / duplicate calls

That should be impossible now: each user has one reservation key, and every
reservation is atomic (event loop for memory, Lua for Redis). If you see it,
check that all replicas share the same `REDIS_URL` and that no old backend
version without call IDs is still running.

## Alternative: Docker Compose (self-hosted)

`docker-compose.yml` describes the Redis + coturn + server + nginx layout.
It is an optional starting point, not the Vercel/Railway path. You must supply
images or Dockerfiles for the server/client and configure real TURN
credentials before exposing it publicly.

## Cost

- **Vercel:** free tier is sufficient for personal use
- **Railway:** $5/month for persistent containers (free trial available)
- **Redis:** included as a Railway add-on or a small managed instance
- **TURN:** metered plans vary; a small coturn VPS is usually the cheapest

Total cost depends mostly on TURN traffic, since calls relay only when a direct
path is impossible.
