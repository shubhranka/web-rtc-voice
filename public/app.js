'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // For peers behind restrictive/symmetric NATs, STUN alone is not enough.
  // Add a TURN server here (the relay still only sees E2EE ciphertext):
  // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' },
];

// PBKDF2 parameters — must match on both peers (they do, since it's the same code).
const KDF_SALT = 'voice-chat-e2ee-v1';
const KDF_ITERATIONS = 100000;

// App-layer E2EE requires the Insertable Streams transform API.
const E2EE_SUPPORTED = typeof window.RTCRtpScriptTransform === 'function';

// --- End-to-end encryption toggle -----------------------------------------
// Default ON. Override per session with ?e2ee=off in the URL (handy for
// isolating audio issues without a redeploy). BOTH peers must use the same
// setting — the creator's share link carries it to the joiner automatically.
const E2EE_DEFAULT = true;

function e2eeRequested() {
  const q = new URLSearchParams(location.search).get('e2ee');
  if (q === 'off' || q === 'false' || q === '0') return false;
  if (q === 'on' || q === 'true' || q === '1') return true;
  return E2EE_DEFAULT;
}

// Effective setting for this session.
const E2EE_ON = e2eeRequested() && E2EE_SUPPORTED;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const views = {
  home: $('view-home'),
  created: $('view-created'),
  join: $('view-join'),
  call: $('view-call'),
};
const banner = $('banner');
const remoteAudio = $('remote-audio');
const eeBadge = $('ee-badge');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let pc = null;
let localStream = null;
let e2eeWorker = null;
let keyBytes = null;
let role = null; // 'creator' | 'joiner'
let roomId = null;
let secret = null;
let muted = false;
const pendingCandidates = [];

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showView(name) {
  for (const key of Object.keys(views)) {
    views[key].hidden = key !== name;
  }
}

function showBanner(message, kind = 'error') {
  banner.textContent = message;
  banner.className = `banner banner--${kind}`;
  banner.hidden = false;
}

function clearBanner() {
  banner.hidden = true;
}

function setCallStatus(main, detail) {
  if (main !== undefined) $('call-status').textContent = main;
  if (detail !== undefined) $('conn-state').textContent = detail;
}

// ---------------------------------------------------------------------------
// Signaling (WebSocket)
// ---------------------------------------------------------------------------
function connectSignaling() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Could not reach the signaling server.'));
    ws.onclose = () => { /* handled elsewhere */ };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleSignal(msg);
    };
  });
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'created':
      roomId = msg.roomId;
      showCreatedView();
      break;

    case 'joined':
      roomId = msg.roomId;
      showView('call');
      setCallStatus('Connecting…', 'waiting for the other peer');
      break;

    case 'peer-joined':
      // We are the creator; the joiner arrived — kick off the WebRTC offer.
      setCallStatus('Connecting…', 'negotiating');
      await makeOffer();
      break;

    case 'peer-left':
      showBanner('The other person left the call.', 'info');
      hangUp(false);
      break;

    case 'signal':
      await handleWebrtcSignal(msg.payload);
      break;

    case 'error':
      handleServerError(msg.reason);
      break;
  }
}

function handleServerError(reason) {
  const messages = {
    'not-found': 'No connection found with that code. Check it and try again.',
    'full': 'That connection already has two people in it.',
  };
  showBanner(messages[reason] || 'Something went wrong.', 'error');
  cleanupMedia();
  showView('join');
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------
async function handleWebrtcSignal(payload) {
  if (!pc) return;

  if (payload.description) {
    const desc = payload.description;
    await pc.setRemoteDescription(desc);

    // Flush any ICE candidates that arrived before the remote description.
    while (pendingCandidates.length) {
      try { await pc.addIceCandidate(pendingCandidates.shift()); } catch { /* ignore */ }
    }

    if (desc.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: 'signal', payload: { description: pc.localDescription } });
    }
  } else if (payload.candidate) {
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try { await pc.addIceCandidate(payload.candidate); } catch { /* ignore */ }
    } else {
      pendingCandidates.push(payload.candidate);
    }
  }
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({ type: 'signal', payload: { description: pc.localDescription } });
}

// Build the peer connection, grab the mic, and (when enabled) wire up E2EE.
async function setupMediaAndPc() {
  if (E2EE_ON) {
    keyBytes = await deriveKeyBytes(secret);
    e2eeWorker = new Worker('e2ee-worker.js');
    e2eeWorker.onmessage = (e) => {
      const data = e.data || {};
      if (data.type === 'log') {
        console.log('[e2ee]', data.msg);
      } else if (data.type === 'decrypt-error') {
        console.warn('[e2ee] decryption failed — the passphrase does not match the other peer.');
        showBanner('Incoming audio could not be decrypted — the passphrase may not match.', 'error');
      }
    };
    e2eeWorker.onerror = (e) => {
      console.error('[e2ee] worker error:', e.message);
      showBanner('Encryption worker failed to start: ' + e.message, 'error');
    };
  } else {
    console.warn('[e2ee] DISABLED for this session (testing mode). Audio is NOT end-to-end encrypted.');
  }

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local audio; attach the encrypting transform to its sender when E2EE is on.
  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (E2EE_ON) {
      sender.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'encrypt', keyBytes });
    }
  }

  pc.ontrack = (evt) => {
    console.log('[webrtc] remote track received' + (E2EE_ON ? '; attaching decrypt transform' : ' (E2EE off)'));
    if (E2EE_ON) {
      evt.receiver.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', keyBytes });
    }
    remoteAudio.srcObject = evt.streams[0];
    // Force playback — some browsers won't autoplay a remote stream on their own.
    remoteAudio.play().catch((err) => {
      console.warn('[audio] autoplay blocked:', err && err.message);
      showBanner('Tap anywhere to start audio.', 'info');
      const resume = () => { remoteAudio.play().catch(() => {}); document.removeEventListener('click', resume); };
      document.addEventListener('click', resume);
    });
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      sendWs({ type: 'signal', payload: { candidate: evt.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    setCallStatus(undefined, state);
    if (state === 'connected') {
      setCallStatus('Connected', E2EE_ON ? 'end-to-end encrypted' : 'NOT encrypted (testing mode)');
      eeBadge.hidden = !E2EE_ON;
      clearBanner();
    } else if (state === 'failed') {
      setCallStatus('Connection failed', 'failed');
      showBanner('Could not establish a direct connection. A TURN server may be needed.', 'error');
    } else if (state === 'disconnected') {
      setCallStatus('Reconnecting…', 'disconnected');
    }
  };
}

// ---------------------------------------------------------------------------
// E2EE key derivation
// ---------------------------------------------------------------------------
async function deriveKeyBytes(sharedSecret) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(sharedSecret), 'PBKDF2', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(KDF_SALT), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256
  );
}

function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // URL-safe base64 without padding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------
function ensureE2eeOk() {
  if (e2eeRequested() && !E2EE_SUPPORTED) {
    showBanner(
      'This browser does not support end-to-end encrypted calls. Use a current version of ' +
      'Chrome, Edge, Safari, or Firefox — or append ?e2ee=off to the URL to test without it.',
      'error'
    );
    return false;
  }
  return true;
}

async function handleCreate() {
  clearBanner();
  if (!ensureE2eeOk()) return;
  role = 'creator';
  secret = generateSecret();
  try {
    await setupMediaAndPc();
    await connectSignaling();
    sendWs({ type: 'create' });
  } catch (err) {
    reportSetupError(err);
  }
}

async function handleJoin() {
  clearBanner();
  if (!ensureE2eeOk()) return;

  const code = $('join-code').value.trim().toUpperCase();
  const pass = $('join-pass').value.trim();
  if (!code) { showBanner('Enter the room code.', 'error'); return; }
  if (E2EE_ON && !pass) { showBanner('Enter the passphrase from the person who invited you.', 'error'); return; }

  role = 'joiner';
  secret = pass;
  try {
    await setupMediaAndPc();
    await connectSignaling();
    sendWs({ type: 'join', roomId: code });
  } catch (err) {
    reportSetupError(err);
  }
}

function reportSetupError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    showBanner('Microphone access was denied. Allow the mic and try again.', 'error');
  } else if (err && err.name === 'NotFoundError') {
    showBanner('No microphone was found on this device.', 'error');
  } else {
    showBanner((err && err.message) || 'Could not start the call.', 'error');
  }
  cleanupMedia();
  showView('home');
}

function showCreatedView() {
  const base = `${location.origin}/?room=${roomId}`;
  // With E2EE on, the key rides in the URL fragment (never sent to the server).
  // With E2EE off, propagate the flag so the joiner uses the same setting.
  $('share-link').value = E2EE_ON ? `${base}#k=${secret}` : `${base}&e2ee=off`;
  $('room-code').value = roomId;
  $('passphrase-out').value = E2EE_ON ? secret : '(encryption disabled — testing)';
  showView('created');
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !muted;
  }
  const btn = $('btn-mute');
  btn.textContent = muted ? 'Unmute' : 'Mute';
  btn.classList.toggle('btn--muted', muted);
}

function cleanupMedia() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* ignore */ }
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (e2eeWorker) {
    e2eeWorker.terminate();
    e2eeWorker = null;
  }
  remoteAudio.srcObject = null;
  keyBytes = null;
  pendingCandidates.length = 0;
  muted = false;
  $('btn-mute').textContent = 'Mute';
  $('btn-mute').classList.remove('btn--muted');
  eeBadge.hidden = true;
}

function hangUp(notify = true) {
  if (notify) sendWs({ type: 'leave' });
  cleanupMedia();
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  roomId = null;
  secret = null;
  role = null;
  setCallStatus('Connecting…', 'setting up…');
  showView('home');
}

// ---------------------------------------------------------------------------
// Wire up UI + entry point
// ---------------------------------------------------------------------------
function copyFrom(inputId) {
  const input = $(inputId);
  input.select();
  navigator.clipboard.writeText(input.value).then(
    () => showBanner('Copied to clipboard.', 'info'),
    () => showBanner('Could not copy — select and copy manually.', 'error')
  );
}

function init() {
  $('btn-create').onclick = handleCreate;
  $('btn-show-join').onclick = () => { clearBanner(); showView('join'); };
  $('btn-join').onclick = handleJoin;
  $('btn-cancel-join').onclick = () => { clearBanner(); showView('home'); };
  $('btn-cancel-created').onclick = () => hangUp(true);
  $('btn-mute').onclick = toggleMute;
  $('btn-hangup').onclick = () => hangUp(true);

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = () => copyFrom(btn.getAttribute('data-copy'));
  });

  // If opened via a share link (/?room=CODE[#k=SECRET]), prefill the join form.
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const keyFromHash = new URLSearchParams(location.hash.slice(1)).get('k');

  if (roomParam) {
    $('join-code').value = roomParam.toUpperCase();
    if (E2EE_ON && keyFromHash) $('join-pass').value = keyFromHash;
    showView('join');
  } else {
    showView('home');
  }
  ensureE2eeOk(); // warn early if E2EE is requested but the browser can't do it

  // Make it obvious when running unencrypted.
  if (!e2eeRequested()) {
    const sub = document.querySelector('.app__subtitle');
    if (sub) sub.textContent = 'Peer-to-peer voice — ENCRYPTION OFF (testing mode).';
  }

  // The key lives only in this tab; strip it from the visible URL / history.
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

init();
