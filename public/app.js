'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ICE_SERVERS = [
  // STUN lets peers discover their public address for a DIRECT connection.
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },

  // TURN relays media when a direct path is impossible (symmetric/strict NAT,
  // mobile data, locked-down networks). Without it, such peers will connect
  // signaling but get no audio. Get free TURN credentials (e.g. metered.ca or
  // Twilio) or self-host coturn, then uncomment and fill in:
  // {
  //   urls: [
  //     'turn:YOUR_TURN_HOST:3478?transport=udp',
  //     'turn:YOUR_TURN_HOST:3478?transport=tcp',
  //     'turns:YOUR_TURN_HOST:5349?transport=tcp',
  //   ],
  //   username: 'YOUR_USERNAME',
  //   credential: 'YOUR_CREDENTIAL',
  // },
];

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let pc = null;
let localStream = null;
let role = null; // 'creator' | 'joiner'
let roomId = null;
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

// Build the peer connection and grab the mic.
async function setupMediaAndPc() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = (evt) => {
    console.log('[webrtc] remote track received');
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
      const c = evt.candidate;
      // type is host | srflx (via STUN) | relay (via TURN).
      console.log(`[ice] local candidate: ${c.type || '?'} ${c.protocol || ''} ${c.address || ''}`);
      sendWs({ type: 'signal', payload: { candidate: evt.candidate } });
    } else {
      console.log('[ice] local candidate gathering complete');
    }
  };

  pc.oniceconnectionstatechange = () => console.log('[ice] iceConnectionState:', pc.iceConnectionState);
  pc.onicegatheringstatechange = () => console.log('[ice] iceGatheringState:', pc.iceGatheringState);

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    setCallStatus(undefined, state);
    if (state === 'connected') {
      setCallStatus('Connected', 'call in progress');
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
// Flows
// ---------------------------------------------------------------------------
async function handleCreate() {
  clearBanner();
  role = 'creator';
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
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) { showBanner('Enter the room code.', 'error'); return; }

  role = 'joiner';
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
  $('share-link').value = `${location.origin}/?room=${roomId}`;
  $('room-code').value = roomId;
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
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    try { pc.close(); } catch { /* ignore */ }
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteAudio.srcObject = null;
  pendingCandidates.length = 0;
  muted = false;
  $('btn-mute').textContent = 'Mute';
  $('btn-mute').classList.remove('btn--muted');
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

  // If opened via a share link (/?room=CODE), prefill the join form.
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    $('join-code').value = roomParam.toUpperCase();
    showView('join');
  } else {
    showView('home');
  }
}

init();
