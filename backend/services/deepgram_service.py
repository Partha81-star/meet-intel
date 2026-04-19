# backend/services/deepgram_service.py  — Phase 3
"""
Deepgram Streaming STT Client

Uses the Deepgram SDK v3 async streaming API.
Config: Nova-2, 16 kHz, mono, diarization enabled.
"""

import os
import logging
from contextlib import asynccontextmanager

from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions,
)

log = logging.getLogger("meetintel.deepgram")


class DeepgramStreamClient:
    """Context-manager wrapper around Deepgram's async live-transcription."""

    def __init__(self):
        api_key = os.environ["DEEPGRAM_API_KEY"]
        config  = DeepgramClientOptions(options={"keepalive": "true"})
        self._client = DeepgramClient(api_key, config)

    @asynccontextmanager
    async def connect(self, on_result):
        """
        Yields a DeepgramSession with a `.send(bytes)` coroutine.

        on_result(dict) is called for every Deepgram transcript event with:
          { transcript, is_final, speaker, confidence, start, duration }
        """
        dg_connection = self._client.listen.asyncwebsocket.v("1")
        session = _DeepgramSession(dg_connection)

        # ── Register event handlers ────────────────────────────────────────
        async def _on_message(_self, result, **kwargs):
            try:
                alt = result.channel.alternatives[0]
                if not alt.transcript:
                    return

                speaker = None
                if hasattr(alt, "words") and alt.words:
                    # Use speaker label from first word
                    speaker_id = getattr(alt.words[0], "speaker", None)
                    speaker    = f"Speaker {speaker_id + 1}" if speaker_id is not None else None

                await on_result({
                    "transcript": alt.transcript,
                    "is_final":   result.is_final,
                    "speaker":    speaker,
                    "confidence": alt.confidence,
                    "start":      result.start,
                    "duration":   result.duration,
                })
            except Exception as exc:
                log.error("[Deepgram] Result parse error: %s", exc)

        async def _on_error(_self, error, **kwargs):
            log.error("[Deepgram] Stream error: %s", error)

        async def _on_close(_self, close, **kwargs):
            log.info("[Deepgram] Connection closed")

        dg_connection.on(LiveTranscriptionEvents.Transcript, _on_message)
        dg_connection.on(LiveTranscriptionEvents.Error,      _on_error)
        dg_connection.on(LiveTranscriptionEvents.Close,      _on_close)

        # ── Connect with optimised options ─────────────────────────────────
        options = LiveOptions(
            model           = "nova-2",
            language        = "en-US",
            encoding        = "linear16",
            channels        = 1,
            sample_rate     = 16000,
            punctuate       = True,
            interim_results = True,
            diarize         = True,         # Speaker identification
            smart_format    = True,
            utterance_end_ms = "1000",
            vad_events      = True,
        )

        connected = await dg_connection.start(options)
        if not connected:
            raise RuntimeError("Failed to connect to Deepgram")

        log.info("[Deepgram] Streaming session started (Nova-2, 16 kHz)")

        try:
            yield session
        finally:
            await dg_connection.finish()


class _DeepgramSession:
    """Thin wrapper providing a consistent `.send()` coroutine."""

    def __init__(self, connection):
        self._conn = connection

    async def send(self, audio_bytes: bytes):
        await self._conn.send(audio_bytes)

    async def finish(self):
        await self._conn.finish()
