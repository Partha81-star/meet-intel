/**
 * electron/audioStreamer.js
 * MeetIntel — System Audio WebSocket Streamer  (Production-Ready Audit)
 *
 * HOW IT WORKS
 * ────────────
 * 1. The renderer calls desktopCapturer.getSources() via the preload bridge
 *    to enumerate screen sources (which carry loopback audio on Windows/macOS).
 * 2. navigator.mediaDevices.getUserMedia() is called with the sourceId to get
 *    a MediaStream containing the system audio track.
 * 3. An AudioWorkletProcessor (pcm-processor.js) converts the 32-bit float PCM
 *    from the Web Audio API into 16-bit Int16 chunks and posts them as
 *    ArrayBuffer transfers (zero-copy) via MessagePort.
 * 4. Each chunk is sent as a binary WebSocket frame — binaryType='arraybuffer'
 *    ensures low-latency, zero-JSON-overhead delivery to the FastAPI backend.
 * 5. The backend routes it to Deepgram (or mock mode) and emits JSON events
 *    back over the same socket.
 *
 * BINARY BUFFERING
 * ─────────────────
 * • The PCM worklet uses Transferable ArrayBuffers for zero-copy IPC.
 * • ws.binaryType = 'arraybuffer' is set before any frames arrive.
 * • We call ws.send(ev.data.buffer ?? ev.data) to handle both Int16Array
 *   and raw ArrayBuffer payloads from the worklet.
 * • CHUNK_MS is tunable — 50 ms gives ~800 bytes/chunk for very low latency.
 *
 * RECONNECT LOGIC
 * ────────────────
 * • If the WebSocket closes unexpectedly (e.g. backend restart), the streamer
 *   attempts up to MAX_RECONNECT_ATTEMPTS with exponential back-off.
 * • Audio capture continues during reconnect — no samples are captured until
 *   the socket is OPEN again, but no media resources are released.
 * • The renderer is notified via onStatus('reconnecting') / onStatus('live').
 *
 * GRACEFUL DEGRADATION
 * ─────────────────────
 * • All errors are caught and surfaced via onError/onStatus callbacks.
 * • stop() is idempotent — safe to call multiple times.
 *
 * PLATFORM NOTES
 * ──────────────
 * Windows 10+  : desktopCapturer screen source includes system audio (WASAPI).
 *                Enable "Stereo Mix" in Sound settings if your driver hides it.
 * macOS        : System audio requires BlackHole or Loopback virtual device.
 *                desktopCapturer alone does NOT capture system audio on macOS.
 * Linux        : Use a PulseAudio monitor source via { audio: true } constraint.
 *
 * USAGE (from a React component)
 * ──────────────────────────────
 *   import { AudioStreamer } from '../../../electron/audioStreamer';
 *   const streamer = new AudioStreamer({ onEvent, onError, onStatus });
 *   await streamer.start();   // begins capture + streaming
 *   await streamer.stop();    // gracefully stops
 */

const BACKEND_WS_URL          = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'ws://127.0.0.1:8000/ws/transcribe';
const SAMPLE_RATE              = 16_000;  // Deepgram expects 16 kHz linear PCM
const CHUNK_MS                 = 50;      // 50 ms → ~800 bytes/chunk (lower = less buffering)
const MAX_RECONNECT_ATTEMPTS   = 5;
const RECONNECT_BASE_DELAY_MS  = 500;     // doubles each attempt (exponential back-off)


/**
 * AudioStreamer
 * Manages: system audio capture → Int16 PCM → WebSocket binary streaming.
 */
export class AudioStreamer {
  /**
   * @param {object} opts
   * @param {function(object): void} opts.onEvent    - JSON event from the backend
   * @param {function(Error): void}  opts.onError    - Fatal or reconnect errors
   * @param {function(string): void} opts.onStatus   - 'connecting'|'live'|'reconnecting'|'stopped'|'error'
   */
  constructor({ onEvent, onError, onStatus } = {}) {
    this._onEvent  = onEvent  || (() => {});
    this._onError  = onError  || console.error;
    this._onStatus = onStatus || (() => {});

    this._ws              = null;
    this._stream          = null;
    this._audioCtx        = null;
    this._worklet         = null;
    this._sourceNode      = null;
    this._running         = false;
    this._reconnectCount  = 0;
    this._reconnectTimer  = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start system audio capture and WebSocket streaming. */
  async start() {
    if (this._running) return;

    try {
      this._onStatus('connecting');

      // ── Step 1: Resolve desktop capture source ─────────────────────────────
      const sourceId = await this._getDesktopSourceId();

      // ── Step 2: Acquire MediaStream (audio only) ───────────────────────────
      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: sourceId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth:  1,    // Video track is required by getUserMedia but unused
            maxHeight: 1,
          },
        },
      };

      this._stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Drop the video track — we only need audio
      this._stream.getVideoTracks().forEach((t) => t.stop());

      const audioTrack = this._stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('No audio track found in desktop capture stream.');

      // ── Step 3: Web Audio pipeline → PCM worklet ──────────────────────────
      this._audioCtx   = new AudioContext({ sampleRate: SAMPLE_RATE });
      this._sourceNode = this._audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));

      // Load the Int16 PCM conversion worklet
      await this._audioCtx.audioWorklet.addModule(
        new URL('./pcm-processor.js', import.meta.url)
      );
      this._worklet = new AudioWorkletNode(this._audioCtx, 'pcm-processor', {
        processorOptions: { chunkMs: CHUNK_MS, sampleRate: SAMPLE_RATE },
      });

      // ── Step 4: Open WebSocket with binary buffering ──────────────────────
      this._ws = await this._openWebSocket();

      // ── Step 5: Wire PCM chunks → WebSocket (zero-copy binary frames) ─────
      this._worklet.port.onmessage = (ev) => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        // ev.data may be an Int16Array (from the worklet) or an ArrayBuffer.
        // Always send the underlying ArrayBuffer for true binary framing.
        const buffer = ev.data instanceof ArrayBuffer
          ? ev.data
          : ev.data.buffer;

        this._ws.send(buffer);
      };

      this._sourceNode.connect(this._worklet);
      // Connect worklet to destination to keep the AudioContext alive
      // (some browsers suspend the context if a node has no audio output)
      this._worklet.connect(this._audioCtx.destination);

      this._running        = true;
      this._reconnectCount = 0;
      this._onStatus('live');

    } catch (err) {
      this._onStatus('error');
      this._onError(err);
      await this.stop();
    }
  }

  /** Gracefully stop all resources. Idempotent. */
  async stop() {
    this._running = false;

    // Cancel any pending reconnect timer
    if (this._reconnectTimer != null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Silence the worklet message handler before teardown
    if (this._worklet) {
      this._worklet.port.onmessage = null;
    }

    // Disconnect Web Audio graph
    try { this._worklet?.disconnect(); }     catch (_) {}
    try { this._sourceNode?.disconnect(); }  catch (_) {}

    // Stop all media tracks
    this._stream?.getTracks().forEach((t) => t.stop());

    // Close AudioContext
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      await this._audioCtx.close().catch(() => {});
    }

    // Close WebSocket cleanly
    if (this._ws) {
      this._ws.onmessage = null;
      this._ws.onclose   = null;   // Prevent reconnect loop on intentional stop
      this._ws.onerror   = null;
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, 'Session stopped by user');
      }
      this._ws = null;
    }

    this._stream     = null;
    this._audioCtx   = null;
    this._worklet    = null;
    this._sourceNode = null;

    this._onStatus('stopped');
  }

  get isRunning() {
    return this._running;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve the best screen source ID via the Electron preload bridge.
   * Falls back through progressively simpler strategies.
   */
  async _getDesktopSourceId() {
    if (window.electronAPI?.getBestSource) {
      const source = await window.electronAPI.getBestSource();
      return source.id;
    }
    if (window.electronAPI?.getSources) {
      const sources = await window.electronAPI.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
      if (!sources?.length) throw new Error('No screen sources found.');
      return sources[0].id;
    }
    throw new Error('electronAPI not available — are you running inside Electron?');
  }

  /**
   * Open and configure a WebSocket connection to the FastAPI backend.
   * Sets binaryType = 'arraybuffer' for zero-copy binary frame handling.
   * The resolved WebSocket will fire onclose → _scheduleReconnect if the
   * connection drops unexpectedly while the streamer is still running.
   *
   * @returns {Promise<WebSocket>}
   */
  _openWebSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BACKEND_WS_URL);

      // ── CRITICAL: must be set before any frames arrive ───────────────────
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log(`[AudioStreamer] WebSocket connected → ${BACKEND_WS_URL}`);
        resolve(ws);
      };

      ws.onerror = () => {
        // onerror always fires before onclose — reject only if not yet resolved
        reject(new Error(`WebSocket connection failed: ${BACKEND_WS_URL}`));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const event = JSON.parse(ev.data);
            this._onEvent(event);
          } catch (parseErr) {
            console.warn('[AudioStreamer] Non-JSON text message:', ev.data);
          }
        }
        // Binary messages from the backend are unexpected but harmless — ignore
      };

      ws.onclose = (ev) => {
        if (this._running) {
          const reason = `code=${ev.code} reason=${ev.reason || 'none'}`;
          console.warn(`[AudioStreamer] WebSocket closed unexpectedly (${reason})`);
          this._scheduleReconnect();
        }
      };
    });
  }

  /**
   * Exponential back-off reconnect.
   * Audio worklet continues running during reconnect — samples are simply
   * dropped (the buffer check guards against sending to a closed socket).
   */
  _scheduleReconnect() {
    if (!this._running) return;
    if (this._reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
      const err = new Error(
        `WebSocket reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts.`
      );
      console.error('[AudioStreamer]', err.message);
      this._onStatus('error');
      this._onError(err);
      this.stop();
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this._reconnectCount);
    this._reconnectCount++;
    console.log(
      `[AudioStreamer] Reconnecting in ${delay}ms (attempt ${this._reconnectCount}/${MAX_RECONNECT_ATTEMPTS})`
    );
    this._onStatus('reconnecting');

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        this._ws = await this._openWebSocket();
        this._reconnectCount = 0;
        this._onStatus('live');
        console.log('[AudioStreamer] Reconnected successfully ✓');
      } catch (err) {
        console.error('[AudioStreamer] Reconnect attempt failed:', err.message);
        // onerror/onclose will not fire on a failed open — retry manually
        this._scheduleReconnect();
      }
    }, delay);
  }
}
