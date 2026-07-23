// Voice Chat signaling server.
//
// Responsibilities (and ONLY these):
//   1. Serve the static frontend from ./public
//   2. Act as a WebSocket signaling relay so two browsers can find each other
//      and exchange WebRTC offer/answer/ICE by room code.
//
// The server never sees the audio (that flows peer-to-peer). It only relays
// opaque signaling messages between the two peers in a room.

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Single-page style: any unknown GET falls back to index.html so that a
// shared link like /?room=ABC123 still loads the app.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Array<WebSocket>>  (max 2 peers per room)
const rooms = new Map();

// Unambiguous room codes: no 0/O/1/I to avoid confusion when typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(id));
  return id;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Relay a message to every peer in the room EXCEPT the sender.
function relayToPeer(roomId, sender, msg) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender) send(peer, msg);
  }
}

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const peers = rooms.get(roomId);
  if (!peers) return;

  const idx = peers.indexOf(ws);
  if (idx !== -1) peers.splice(idx, 1);

  // Tell whoever is left that their partner dropped.
  relayToPeer(roomId, ws, { type: 'peer-left' });

  if (peers.length === 0) rooms.delete(roomId);
  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'create': {
        // A peer can only be in one room at a time.
        if (ws.roomId) leaveRoom(ws);
        const roomId = generateRoomId();
        rooms.set(roomId, [ws]);
        ws.roomId = roomId;
        ws.role = 'creator';
        send(ws, { type: 'created', roomId });
        break;
      }

      case 'join': {
        const roomId = (msg.roomId || '').toString().trim().toUpperCase();
        const peers = rooms.get(roomId);
        if (!peers) {
          send(ws, { type: 'error', reason: 'not-found' });
          return;
        }
        if (peers.length >= 2) {
          send(ws, { type: 'error', reason: 'full' });
          return;
        }
        peers.push(ws);
        ws.roomId = roomId;
        ws.role = 'joiner';
        send(ws, { type: 'joined', roomId });
        // Let the creator know a peer arrived — that triggers the WebRTC offer.
        relayToPeer(roomId, ws, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        // Opaque to the server: SDP offer/answer or ICE candidate. Just relay.
        if (!ws.roomId) return;
        relayToPeer(ws.roomId, ws, { type: 'signal', payload: msg.payload });
        break;
      }

      case 'leave': {
        leaveRoom(ws);
        break;
      }

      default:
        // ignore unknown message types
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Drop dead connections so rooms don't leak if a browser vanishes.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Voice chat server listening on http://localhost:${PORT}`);
});
