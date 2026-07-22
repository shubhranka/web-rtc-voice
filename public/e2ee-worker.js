// End-to-end encryption worker.
//
// Runs off the main thread and is wired to a WebRTC sender/receiver via
// RTCRtpScriptTransform. It receives a stream of *encoded* audio frames and:
//   - encrypt: AES-GCM-encrypts each frame's payload before it goes on the wire
//   - decrypt: AES-GCM-decrypts each incoming frame's payload
//
// A random 96-bit IV is generated per frame and prepended to the ciphertext,
// so an encrypted payload is laid out as:  [ 12-byte IV | ciphertext+tag ].
//
// The key is derived on the main thread from the shared secret (which travels
// in the URL fragment / passphrase and never reaches the server) and passed in
// here as raw bytes.

const IV_BYTES = 12;

const log = (msg) => self.postMessage({ type: 'log', msg });

async function importKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function makeEncryptor(key) {
  let first = true;
  return async (frame, controller) => {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, frame.data);

      const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ciphertext), IV_BYTES);

      frame.data = out.buffer;
      controller.enqueue(frame);
      if (first) { first = false; log('first outgoing frame encrypted'); }
    } catch (e) {
      // If encryption fails, drop the frame rather than leaking plaintext.
      log('encrypt error: ' + (e && e.message));
    }
  };
}

function makeDecryptor(key) {
  let firstOk = true;
  let warned = false;
  return async (frame, controller) => {
    const buf = new Uint8Array(frame.data);
    if (buf.byteLength <= IV_BYTES) return; // too short to be one of our frames

    const iv = buf.subarray(0, IV_BYTES);
    const ciphertext = buf.subarray(IV_BYTES);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      frame.data = plaintext;
      controller.enqueue(frame);
      if (firstOk) { firstOk = false; log('first incoming frame decrypted OK'); }
    } catch (e) {
      // Wrong key or tampered frame -> cannot decrypt. Drop it (nothing plays).
      if (!warned) {
        warned = true;
        self.postMessage({ type: 'decrypt-error' });
      }
    }
  };
}

async function setUpTransform(transformer) {
  const { operation, keyBytes } = transformer.options;
  // Await key import BEFORE piping, so buffered frames aren't processed
  // until the key is ready (avoids a startup race).
  const key = await importKey(keyBytes);

  const handler = operation === 'encrypt' ? makeEncryptor(key) : makeDecryptor(key);
  const transform = new TransformStream({ transform: handler });

  transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformer.writable)
    .catch(() => { /* stream closed */ });

  log('transform ready: ' + operation);
}

// Modern browsers deliver the transformer via the "rtctransform" event.
// Assign the handler unconditionally — if the API isn't present the event
// simply never fires (and the main thread's feature check will have caught it).
self.onrtctransform = (event) => setUpTransform(event.transformer);
