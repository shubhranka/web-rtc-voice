# 🎙️ Voice Chat

A minimal web app that connects **two people** for a real-time voice call. One person
creates a connection and shares a link (or a room code); the other joins. Audio flows
**peer-to-peer over WebRTC** — the server only relays the signaling needed to introduce the
two browsers.

## How it works

```
Browser A (creator) ──┐                          ┌── Browser B (joiner)
   WebRTC audio  <─────┼──── peer-to-peer ────────┼─────>  WebRTC audio
   signaling  ───► WebSocket ─► Node server ◄── WebSocket ◄─── signaling
```

- **Signaling server** (`server.js`) — an Express + `ws` server that serves the frontend and
  relays WebRTC offer/answer/ICE messages between the two peers in a room. It never touches
  the audio.
- **WebRTC** — carries the audio directly between the two browsers. WebRTC media is encrypted
  in transit by default (DTLS-SRTP).

## Requirements

- **Node.js ≥ 18**
- A modern browser (Chrome, Edge, Safari, or Firefox).

## Run locally

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

- Click **Create connection** → copy the **link** or the **room code**.
- On a second device (or a second browser window), open the link, or click **Join
  connection** and enter the code.
- Grant microphone permission on both sides.

> **Testing on one machine:** two tabs on the same computer will echo/howl because both use the
> same speakers and mic. Use **headphones**, or test with **two separate devices**.

`localhost` is treated as a secure context, so the microphone works without HTTPS during local
development.

## Deploy (public internet)

Deploy `server.js` to any Node host that provides **HTTPS** (e.g. Render, Railway, Fly.io,
a VPS behind a TLS reverse proxy). HTTPS is **required** in production because browsers block
microphone access (`getUserMedia`) and secure WebSockets (`wss:`) on non-secure origins. The
client automatically uses `wss:` when the page is served over HTTPS.

Set the port via the `PORT` environment variable if your host requires it (defaults to `3000`).

### Restrictive networks (TURN)

STUN (already configured) is enough for most connections, but ~10–20% of networks
(symmetric NATs, mobile data, locked-down corporate networks) need a **TURN** relay. Without
it, such peers connect signaling but get no audio. Add one to `ICE_SERVERS` in
`public/app.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' },
];
```

Get free TURN credentials (e.g. metered.ca, Twilio) or self-host coturn. TURN cannot run on
Render — it must be an external service, just like STUN.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express static server + WebSocket signaling relay |
| `public/index.html` | UI (home / created / join / in-call views) |
| `public/style.css` | Styling (light + dark) |
| `public/app.js` | Signaling client and WebRTC |

## Limitations

- **Two participants per room.** Extra joiners get a "room full" error.
- **No persistence.** Rooms live in server memory and disappear when both peers leave.
