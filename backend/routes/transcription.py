# backend/routes/transcription.py  — Phase 3
"""
WebSocket endpoint: /ws/transcribe

Protocol:
  Client → Server: binary frames (Int16 PCM @ 16 kHz, mono)
  Server → Client: JSON messages:
    { type: "transcript",   transcript, is_final, speaker, timestamp, confidence }
    { type: "action_item",  id, title, assignee, due, priority, context }
    { type: "debt_item",    ...DebtItem }
    { type: "ping" }
"""

import asyncio
import json
import logging
import time
import uuid
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.deepgram_service  import DeepgramStreamClient
from services.action_detector   import ActionDetector
from services.debt_log_service  import DebtLogService
from models.database            import db

log = logging.getLogger("meetintel.transcription")
router = APIRouter(tags=["transcription"])

# Sliding window of transcript segments kept in memory per session
WINDOW_SIZE   = 20   # number of final segments to keep for action detection
ACTION_TRIGGER = 5   # run action detection every N final segments


@router.websocket("/ws/transcribe")
async def transcribe_ws(websocket: WebSocket):
    """
    Full-duplex WebSocket.
    - Receives raw Int16 PCM audio bytes from the Electron renderer.
    - Pipes them into a Deepgram streaming session.
    - Broadcasts transcript chunks + AI-detected action items back to the client.
    """
    await websocket.accept()
    session_id = str(uuid.uuid4())
    log.info("[WS] New session: %s", session_id)

    # Transcript sliding window for action detection
    window: deque[str] = deque(maxlen=WINDOW_SIZE)
    segment_count = 0

    deepgram_client = DeepgramStreamClient()
    action_detector = ActionDetector()
    debt_service    = DebtLogService()

    # ── Create meeting record in Supabase ──────────────────────────────────
    meeting_id = await db.create_meeting(session_id)

    async def on_deepgram_result(result: dict):
        """
        Callback invoked for every Deepgram result event (interim + final).
        Pushes transcript to client; on finals → action detection.
        """
        nonlocal segment_count

        transcript_text = result.get("transcript", "")
        is_final        = result.get("is_final", False)
        speaker         = result.get("speaker")
        confidence      = result.get("confidence", 0.0)
        start_time      = result.get("start", time.time())

        if not transcript_text.strip():
            return

        # Push transcript chunk to renderer
        await websocket.send_json({
            "type":       "transcript",
            "transcript": transcript_text,
            "is_final":   is_final,
            "speaker":    speaker,
            "timestamp":  start_time,
            "confidence": confidence,
            "session_id": session_id,
        })

        if is_final:
            segment_count += 1
            window.append(transcript_text)

            # Persist to Supabase
            asyncio.create_task(
                db.insert_transcript_segment({
                    "meeting_id": meeting_id,
                    "text":       transcript_text,
                    "speaker":    speaker,
                    "timestamp":  start_time,
                    "confidence": confidence,
                })
            )

            # ── Action detection every N segments ──────────────────────────
            if segment_count % ACTION_TRIGGER == 0:
                asyncio.create_task(
                    run_action_detection(window, meeting_id, session_id, websocket)
                )

            # ── Meeting debt query: triggered on first segment & every 10th ─
            if segment_count == 1 or segment_count % 10 == 0:
                asyncio.create_task(
                    run_debt_query(transcript_text, meeting_id, session_id, websocket)
                )

    # ── Deepgram streaming loop ────────────────────────────────────────────
    try:
        async with deepgram_client.connect(on_result=on_deepgram_result) as dg_session:
            # Keep-alive ping task
            async def ping_loop():
                while True:
                    await asyncio.sleep(15)
                    try:
                        await websocket.send_json({"type": "ping"})
                    except Exception:
                        break

            ping_task = asyncio.create_task(ping_loop())

            try:
                while True:
                    data = await websocket.receive_bytes()
                    # Forward raw PCM to Deepgram
                    await dg_session.send(data)

            except WebSocketDisconnect:
                log.info("[WS] Client disconnected: %s", session_id)
            finally:
                ping_task.cancel()
                await dg_session.finish()

    except Exception as exc:
        log.exception("[WS] Fatal error in session %s: %s", session_id, exc)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        # Mark meeting as ended
        await db.end_meeting(meeting_id)
        log.info("[WS] Session ended: %s (%d segments)", session_id, segment_count)


async def run_action_detection(window: deque, meeting_id: str, session_id: str, websocket: WebSocket):
    """Runs GPT-4o action detection on the current transcript window."""
    try:
        detector = ActionDetector()
        items    = await detector.detect(list(window))
        for item in items:
            item["session_id"] = session_id
            await db.insert_action_item({"meeting_id": meeting_id, **item})
            await websocket.send_json({"type": "action_item", **item})
    except Exception as exc:
        log.error("[ActionDetector] %s", exc)


async def run_debt_query(context_text: str, meeting_id: str, session_id: str, websocket: WebSocket):
    """Queries vector DB for similar unresolved topics from past meetings."""
    try:
        debt_service = DebtLogService()
        debt_items   = await debt_service.query(context_text, exclude_meeting_id=meeting_id)
        for debt in debt_items:
            await websocket.send_json({"type": "debt_item", **debt})
    except Exception as exc:
        log.error("[DebtLog] %s", exc)
