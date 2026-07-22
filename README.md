# 🔒 Encrypted Voice Chat

A minimal web app that connects **two people** for a real-time voice call. One person
creates a connection and shares a link (or a room code); the other joins. Audio flows
**peer-to-peer over WebRTC** and is **end-to-end encrypted** — the server relays only the
signaling needed to introduce the two browsers and never sees the audio or the key.

## How it works

```
Browser A (creator) ──┐                          ┌── Browser B (joiner)
   WebRTC audio  <─────┼──── peer-to-peer ────────┼─────>  WebRTC audio
   signaling  ───► WebSocket ─► Node server ◄── WebSocket ◄─── signaling
```

- **Signaling server** (`server.js`) — an Express + `ws` server that serves the frontend and
  relays WebRTC offer/answer/ICE messages between the two peers in a room. It never touches
  the audio and never learns the encryption key.
- **WebRTC** — carries the audio directly between the two browsers. Already encrypted in
  transit by DTLS-SRTP.
- **Application-layer end-to-end encryption** — on top of WebRTC's transport encryption, each
  encoded audio frame is encrypted with **AES-256-GCM** using [Insertable Streams]
  (`RTCRtpScriptTransform` + a Web Worker, `public/e2ee-worker.js`). Only the two endpoints
  hold the key, so a compromised signaling server or TURN relay only ever sees ciphertext.

### Where the key comes from

The creator's browser generates a random secret and puts it in the **URL fragment** of the
share link (`https://host/?room=CODE#k=SECRET`). Browsers never send the fragment to the
server or in the WebSocket handshake, so **the key never reaches the server**. The joiner's
browser reads it from the link. For code-only joins, the creator also sees the secret as a
**passphrase** to share over a channel they trust, and the join screen has a passphrase field.

> **Trust note:** end-to-end encryption is only as strong as the channel you use to share the
> link/passphrase. This is inherent to every E2EE system — the key exchange must happen over a
> channel you trust.

## Requirements

- **Node.js ≥ 18**
- A modern browser that supports `RTCRtpScriptTransform` (current Chrome, Edge, Safari, or
  Firefox). The app detects support and shows a clear message otherwise.

## Run locally

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

- Click **Create connection** → copy the **link** or the **room code + passphrase**.
- On a second device (or a second browser window), open the link, or click **Join
  connection** and enter the code + passphrase.
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
(symmetric NATs) need a **TURN** relay. Add one to `ICE_SERVERS` in `public/app.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' },
];
```

The TURN relay still only sees end-to-end-encrypted ciphertext.

## Verifying the encryption

- During a call both peers show **"Connected — end-to-end encrypted 🔒"**.
- **Negative test:** join with a **wrong passphrase** (open the link without the `#k=`
  fragment and type a mismatched passphrase). The connection still establishes, but the audio
  cannot be decrypted — you'll hear nothing and see a passphrase-mismatch warning. That proves
  frames are genuinely encrypted with the shared key.
- Open DevTools → Network → the WebSocket connection: the relayed frames contain only SDP/ICE
  signaling — no key and no audio.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express static server + WebSocket signaling relay |
| `public/index.html` | UI (home / created / join / in-call views) |
| `public/style.css` | Styling (light + dark) |
| `public/app.js` | Signaling client, WebRTC, and E2EE wiring |
| `public/e2ee-worker.js` | AES-GCM encrypt/decrypt of audio frames (off-thread) |

## Limitations

- **Two participants per room.** Extra joiners get a "room full" error.
- **No persistence.** Rooms live in server memory and disappear when both peers leave.
