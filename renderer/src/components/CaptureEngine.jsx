'use client';

/**
 * CaptureEngine.jsx — Phase 2 Core Component
 *
 * Responsibilities:
 *  1. Get a screen/audio MediaStream via desktopCapturer (Electron) or
 *     getUserMedia fallback (browser dev).
 *  2. Pipe raw PCM audio chunks to the parent via `onAudioChunk` callback
 *     (which forwards them to the FastAPI WebSocket).
 *  3. Capture screen frames every 30 s and send them to /vision/analyze
 *     via the Electron IPC bridge.
 *
 * Audio Pipeline:
 *   MediaStream → AudioContext → ScriptProcessor → Float32 PCM
 *   → Int16 conversion → ArrayBuffer → WebSocket
 *
 * This component renders nothing (null) — it is pure capture logic.
 */

import { useEffect, useRef, useCallback } from 'react';
import { API_BASE } from '../lib/constants';

const SAMPLE_RATE      = 16000;  // Deepgram expects 16 kHz
const FRAME_SIZE       = 4096;   // ScriptProcessor buffer size
const SCREEN_INTERVAL  = 30000;  // ms between screen captures

export default function CaptureEngine({ sessionActive, onAudioChunk, sessionId, onError }) {
  const streamRef          = useRef(null);
  const audioContextRef    = useRef(null);
  const processorRef       = useRef(null);
  const sourceRef          = useRef(null);
  const screenIntervalRef  = useRef(null);
  const canvasRef          = useRef(null);
  const videoRef           = useRef(null);
  const streamsRef = useRef([]);
  const firstFrameRef = useRef(null);

  // ─── Convert Float32 PCM → Int16 ArrayBuffer ──────────────────────────────
  const float32ToInt16 = useCallback((float32Array) => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array.buffer;
  }, []);

  // ─── Get mixed screen + audio stream ─────────────────────────────────────
  const getMediaStreams = useCallback(async () => {
    let desktopStream = null;
    let micStream     = null;

    try {
      // 1. Get Desktop Session (System Audio + Video)
      if (typeof window !== 'undefined' && window.electronAPI) {
        const source = await window.electronAPI.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
        });

        const screenSource = source.find(
          (s) => s.name.toLowerCase().includes('entire screen') || s.name.toLowerCase().includes('screen 1')
        ) || source[0];

        if (!screenSource) throw new Error('No screen source available');

        desktopStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 5,
            },
          },
        });
      }

      // 2. Get local Microphone (to hear the Admin)
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      return { desktopStream, micStream };
    } catch (err) {
      console.error('[CaptureEngine] Media capture failed:', err);
      // Fallback: minimal mic only
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { desktopStream: null, micStream: ms };
    }
  }, []);

  // ─── Start audio pipeline with Mixing ─────────────────────────────────────
  const startAudioPipeline = useCallback(async (streams) => {
    const { desktopStream, micStream } = streams;
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioContextRef.current = audioCtx;

    // Create a mixer node (merger)
    const mixer = audioCtx.createChannelMerger(1);

    if (desktopStream && desktopStream.getAudioTracks().length > 0) {
      const desktopSource = audioCtx.createMediaStreamSource(desktopStream);
      desktopSource.connect(mixer);
      console.log('[CaptureEngine] Attached System Audio Node');
    }

    if (micStream && micStream.getAudioTracks().length > 0) {
      const micSource = audioCtx.createMediaStreamSource(micStream);
      // Admin gain (slightly louder for authority/clearer extraction)
      const micGain = audioCtx.createGain();
      micGain.gain.value = 1.2;
      micSource.connect(micGain);
      micGain.connect(mixer);
      console.log('[CaptureEngine] Attached Microphone Node');
    }

    // ScriptProcessor for raw PCM access
    const processor = audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const pcmBuffer = float32ToInt16(inputData);
      onAudioChunk(pcmBuffer);
    };

    mixer.connect(processor);
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(audioCtx.destination);
    await audioCtx.resume();
    console.log('[CaptureEngine] Mixed Audio Pipeline Active');
  }, [float32ToInt16, onAudioChunk]);

  // ─── Screen frame capture ─────────────────────────────────────────────────
  const captureFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;

    if (video.readyState < 2) return; // Not enough data yet

    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // JPEG at 75% quality (reasonable for GPT-4o vision)
    const dataURL = canvas.toDataURL('image/jpeg', 0.75);
    const base64  = dataURL.split(',')[1];

    // Send via Electron IPC if available
    if (window.electronAPI) {
      await window.electronAPI.sendFrame(base64);
    } else {
      // Direct HTTP fallback for browser dev
      try {
        await fetch(`${API_BASE}/vision/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame: base64, session_id: sessionId }),
        });
      } catch (err) {
        console.error('[CaptureEngine] Frame POST failed:', err);
      }
    }
  }, [sessionId]);

  // ─── Main effect: start/stop on sessionActive toggle ─────────────────────
  useEffect(() => {
    const cleanup = () => {
      // Teardown
      processorRef.current?.disconnect();
      if (audioContextRef.current?.state !== 'closed') audioContextRef.current?.close().catch(() => {});
      streamsRef.current.forEach(stream => stream?.getTracks().forEach(track => track.stop()));
      streamsRef.current = [];
      clearInterval(screenIntervalRef.current);
      clearTimeout(firstFrameRef.current);
      if (videoRef.current) videoRef.current.srcObject = null;

      streamRef.current       = null;
      audioContextRef.current = null;
      processorRef.current    = null;
    };
    if (!sessionActive) {
      cleanup();
      return;
    }

    let active = true;

    (async () => {
      try {
        const streams = await getMediaStreams();
        if (!active) {
          streams.desktopStream?.getTracks().forEach(t => t.stop());
          streams.micStream?.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = streams.desktopStream || streams.micStream;
        streamsRef.current = [streams.desktopStream, streams.micStream];

        // Wire mixed audio pipeline
        await startAudioPipeline(streams);

        // Attach video track (from desktop stream) to hidden <video> element
        if (streams.desktopStream) {
          const videoTrack = streams.desktopStream.getVideoTracks()[0];
          if (videoTrack && videoRef.current) {
            const videoStream = new MediaStream([videoTrack]);
            videoRef.current.srcObject = videoStream;
            videoRef.current.play().catch(() => {});
          }
        }

        // Screen frame interval
        screenIntervalRef.current = setInterval(captureFrame, SCREEN_INTERVAL);
        // Capture first frame immediately
        firstFrameRef.current = setTimeout(captureFrame, 2000);
      } catch (err) {
        cleanup();
        onError?.(`Microphone capture failed: ${err.message}`);
        console.error('[CaptureEngine] Failed to start capture:', err);
      }
    })();

    return () => {
      active = false;
      cleanup();
    };
  }, [sessionActive, getMediaStreams, startAudioPipeline, captureFrame]);

  // ─── Hidden DOM elements for frame capture ────────────────────────────────
  return (
    <>
      <video
        ref={videoRef}
        style={{ display: 'none' }}
        muted
        playsInline
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
}
