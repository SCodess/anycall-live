# webrtc-app (Starter)

Minimal starter for **Audio call + Chat + File-share** using **WebRTC + Socket.IO**.

Structure:
- client/  — React + Vite frontend
- server/  — Node + Express + Socket.IO signaling server
- turn/    — coturn docker-compose (example)

## Quick start (local)

1. Start signaling server:
   ```bash
   cd server
   npm install
   npm start
   ```
2. Start frontend (dev):
   ```bash
   cd client
   npm install
   npm run dev
   ```
3. Open two browser windows/tabs at the frontend dev URL (usually http://localhost:5173).
   Click **Start Call** in one tab to initiate an offer.

## Notes
- For production you should deploy signaling server and optionally a TURN server (coturn).
- Update ICE servers in client/src/App.jsx to add your TURN server credentials.
- This starter uses DataChannel for chat and small/medium file transfer (chunked).
