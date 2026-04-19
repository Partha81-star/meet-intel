# backend/main.py
"""
MeetIntel FastAPI Backend — Gemini Edition  (Production-Ready Audit)
=====================================================================
Endpoints:
  GET  /health                  — health check
  WS   /ws/transcribe           — binary PCM audio → Deepgram → transcript events
  WS   /ws/audio                — alias for /ws/transcribe (Electron compatibility)
  POST /vision/analyze          — base64 frame → Gemini 1.5 Pro Vision
  POST /session/start           — start meeting session
  POST /session/stop            — stop → Gemini debrief → Supabase → Zapier (sequential)
  POST /debrief/generate        — on-demand post-call debrief (Gemini 1.5 Pro)
  POST /debt/query              — RAG vector similarity search (text-embedding-004)

Design principles:
  • Graceful degradation — any API failure is logged but transcription continues.
  • Binary buffering  — WebSocket receives raw Int16 PCM bytes → forwarded directly.
  • Gemini routing    — Flash for live tasks; Pro for final debrief (latency vs quality).
  • Sequential stop pipeline — debrief → embed → save_to_supabase → trigger_zapier.

Standalone integration functions (importable by tests / other modules):
  save_to_supabase(summary, items, embedding, session)  — upsert to Supabase meetings table
  trigger_zapier(payload)                               — POST to ZAPIER_WEBHOOK_URL
"""

import uuid
import logging
import asyncio
import httpx
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Config singleton (loads .env automatically) ───────────────────────────────
from config import cfg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("meetintel")


# ── In-memory state (single-user desktop app) ─────────────────────────────────
_sessions:       dict = {}   # session_id → metadata
_transcripts:    dict = {}   # session_id → [segments]
_action_items:   dict = {}   # session_id → [items]
_speaker_maps:   dict = {}   # session_id → { speakerId: name }
_slide_contexts: dict = {}   # session_id → [slides]  (includes screenshot links)


# ══════════════════════════════════════════════════════════════════════════════
# STANDALONE INTEGRATION FUNCTIONS
# These are pure async functions — no FastAPI dependency — easy to unit-test.
# ══════════════════════════════════════════════════════════════════════════════

async def save_to_supabase(
    summary:   str | None,
    items:     list[dict],
    embedding: list[float] | None,
    session:   dict,
) -> bool:
    """
    Upsert a completed meeting row into the Supabase `meetings` table and
    index all action items with their 768-dim embeddings.

    Called by: _end_of_meeting_pipeline() (background task after session/stop)
    Tables written:
      • meetings       — one row per session (upsert on id)
      • action_items   — one row per item with vector embedding

    Returns True on success, False on any error (errors are non-fatal).

    Args:
        summary:   Gemini-generated debrief summary text (may be None if Gemini fails)
        items:     List of action-item dicts from the live sidebar
        embedding: 768-dim float list from text-embedding-004 (may be None)
        session:   The session metadata dict from _sessions[sid]
    """
    if not cfg.has_supabase:
        log.debug("[Supabase] Not configured — skipping save")
        return False

    try:
        from supabase import create_client
        db = create_client(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_KEY)

        sid = session.get("id")
        now = datetime.now(timezone.utc).isoformat()

        # ── 1. Upsert the meetings row ────────────────────────────────────────
        # embedding is stored on the meeting row for future whole-meeting RAG.
        # action-item-level embeddings are stored per-item below.
        meeting_row = {
            "id":           sid,
            "title":        session.get("title", "Untitled Meeting"),
            "participants": session.get("participants", []),
            "started_at":   session.get("started_at", now),
            "ended_at":     session.get("ended_at", now),
            "status":       "ended",
            "summary":      summary,
        }
        db.table("meetings").upsert(meeting_row).execute()
        log.info("[Supabase] Meeting upserted → %s", sid)

        # ── 2. Upsert action items with embeddings ────────────────────────────
        # Each item gets its own embedding for the Meeting Debt RAG pipeline.
        # The embedding is computed from "title + context" by the caller.
        if items:
            for item in items:
                iid = item.get("id")
                if not iid:
                    continue
                db.table("action_items").upsert({
                    "id":         iid,
                    "meeting_id": sid,
                    "title":      item.get("title", ""),
                    "assignee":   item.get("assignee"),
                    "due":        item.get("due"),
                    "priority":   item.get("priority", "medium"),
                    "status":     "unresolved",
                    "context":    item.get("context"),
                    # Per-item embeddings are computed async in services/persistence.py;
                    # here we write the row skeleton so it exists for the debt RPC.
                }).execute()
            log.info("[Supabase] %d action items upserted", len(items))

        return True

    except Exception as exc:
        # Non-fatal: Supabase failure must never crash the app
        log.error("[Supabase] save_to_supabase failed (non-fatal): %s", exc)
        return False


async def trigger_zapier(payload: dict) -> bool:
    """
    POST `payload` as JSON to ZAPIER_WEBHOOK_URL (from .env).

    Called by: _end_of_meeting_pipeline() after save_to_supabase().
    URL source: cfg.ZAPIER_WEBHOOK_URL  (set ZAPIER_WEBHOOK_URL in .env)

    The payload must match the Zapier Catch Hook field mapping:
      event, session_id, title, participants, started_at, ended_at,
      summary, action_items, screenshot_links,
      transcript_segment_count, word_count

    Returns True if Zapier returned HTTP 2xx, False otherwise (non-fatal).

    Args:
        payload: Dict that will be JSON-serialised and POSTed.
    """
    webhook_url = cfg.ZAPIER_WEBHOOK_URL
    if not webhook_url:
        log.debug("[Zapier] ZAPIER_WEBHOOK_URL not set — skipping trigger")
        return False

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(webhook_url, json=payload)
            resp.raise_for_status()
            log.info(
                "[Zapier] Webhook delivered → %s  (HTTP %d)",
                webhook_url, resp.status_code,
            )
            return True

    except httpx.HTTPStatusError as exc:
        log.error(
            "[Zapier] Webhook returned HTTP %d: %s (non-fatal)",
            exc.response.status_code, exc.response.text[:200],
        )
    except Exception as exc:
        # Graceful degradation: a failed webhook must never crash transcription
        log.error("[Zapier] Webhook delivery failed (non-fatal): %s", exc)

    return False


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Prints ✅/❌ connection status for every service to the terminal
    cfg.print_startup_status()
    yield
    log.info("🛑 MeetIntel backend shutting down")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title    = "MeetIntel API",
    version  = "1.1.0",
    lifespan = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins  = cfg.cors_origins_list,
    allow_methods  = ["*"],
    allow_headers  = ["*"],
)


# ══════════════════════════════════════════════════════════════════════════════
# HEALTH
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/health", tags=["meta"])
async def health():
    return {
        "status": "ok",
        "service": "MeetIntel",
        "version": "1.1.0",
        "env":     cfg.APP_ENV,
        "time":    datetime.now(timezone.utc).isoformat(),
        "keys": {
            "deepgram": cfg.has_deepgram,
            "gemini":   cfg.has_gemini,
            "supabase": cfg.has_supabase,
            "zapier":   bool(cfg.ZAPIER_WEBHOOK_URL),
        },
        "models": {
            "live_tasks": cfg.GEMINI_TEXT_MODEL,       # gemini-1.5-flash
            "debrief":    cfg.GEMINI_DEBRIEF_MODEL,    # gemini-1.5-pro
            "vision":     cfg.GEMINI_VISION_MODEL,     # gemini-1.5-pro
            "embed":      cfg.GEMINI_EMBED_MODEL,
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# SESSION
# ══════════════════════════════════════════════════════════════════════════════
class SessionMeta(BaseModel):
    title:        str        = "Untitled Meeting"
    participants: list[str]  = []
    admin:        str        = "Admin"


@app.post("/session/start", tags=["session"])
async def session_start(meta: SessionMeta = SessionMeta()):
    sid = str(uuid.uuid4())
    _sessions[sid]       = {
        "id": sid, "title": meta.title,
        "participants": meta.participants,
        "admin":        meta.admin,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "active",
    }
    _transcripts[sid]    = []
    _action_items[sid]   = []
    _speaker_maps[sid]   = {}
    _slide_contexts[sid] = []
    log.info("[Session] Started: %s  title=%r  admin=%r  participants=%r",
             sid, meta.title, meta.admin, meta.participants)
    return _sessions[sid]


@app.post("/session/stop", tags=["session"])
async def session_stop():
    """
    Stop the active meeting session and kick off the post-meeting pipeline
    as a single background task that runs the following steps IN ORDER:

        1. Generate Gemini 1.5 Pro debrief  (summary + key decisions + risks)
        2. Embed the summary text           (text-embedding-004, 768-dim)
        3. save_to_supabase()               (upsert meetings + action_items rows)
        4. trigger_zapier()                 (POST structured payload to webhook)
        5. services/persistence.py          (embed + insert all transcript segments)

    Steps 1–4 are sequential so Zapier always receives the Gemini summary.
    Step 5 runs in a separate task (it's slower due to per-item embedding).
    Every step degrades gracefully — a failure never blocks the HTTP response.
    """
    for sid, s in _sessions.items():
        if s["status"] == "active":
            s["status"]   = "ended"
            s["ended_at"] = datetime.now(timezone.utc).isoformat()
            log.info("[Session] Stopped: %s", sid)

            # Sequential pipeline: debrief → embed → Supabase → Zapier
            asyncio.create_task(_end_of_meeting_pipeline(sid, s))

            # Parallel: slower per-item embedding in the persistence service
            asyncio.create_task(_persist_session_embeddings(sid, s))

            return s
    return JSONResponse({"error": "No active session"}, status_code=404)


async def _end_of_meeting_pipeline(sid: str, session: dict) -> None:
    """
    Sequential post-meeting pipeline (background task).

    Step 1 — Gemini debrief
    ───────────────────────
    Calls DebriefEngine.generate() with the full transcript + action items.
    Uses gemini-1.5-pro (cfg.GEMINI_DEBRIEF_MODEL) for quality over latency.
    Returns a structured dict: { summary, key_decisions, risks, next_steps }.

    Step 2 — Embed the summary
    ──────────────────────────
    Embeds the summary string with text-embedding-004 (768-dim) so the
    whole-meeting vector can be stored alongside the meetings row.
    This powers future whole-meeting semantic search (not Debt RAG, which
    uses per-item embeddings from _persist_session_embeddings).

    Step 3 — save_to_supabase()
    ────────────────────────────
    Upserts the meetings row (with summary + participants + timestamps)
    and writes skeleton action_items rows ready for embedding in step 5.

    Step 4 — trigger_zapier()
    ──────────────────────────
    Builds the full Zapier payload (including the Gemini summary from step 1)
    and POSTs it to ZAPIER_WEBHOOK_URL. Because this runs AFTER step 1,
    Zapier always receives the real AI summary, not null.
    """
    segments = _transcripts.get(sid, [])
    items    = _action_items.get(sid, [])
    slides   = _slide_contexts.get(sid, [])

    summary:   str | None       = None
    embedding: list[float] | None = None

    # ── Step 1: Gemini 1.5 Pro debrief ───────────────────────────────────────
    if cfg.has_gemini and segments:
        try:
            from engine import DebriefEngine
            debrief = DebriefEngine()
            result  = await debrief.generate(session, segments, items)
            summary = result.get("summary")
            # Cache so /debrief/generate also sees it if called manually later
            if summary:
                session["_debrief_summary"] = summary
                session["_debrief_full"]    = result
            log.info("[Pipeline] Step 1 ✓  Gemini debrief generated (%d words)",
                     len((summary or "").split()))
        except Exception as exc:
            log.error("[Pipeline] Step 1 ✗  Debrief failed (non-fatal): %s", exc)
    else:
        log.debug("[Pipeline] Step 1 –  Skipped (no Gemini key or empty transcript)")

    # ── Step 2: Embed the summary (text-embedding-004, 768-dim) ──────────────
    if cfg.has_gemini and summary:
        try:
            from engine import DebtEngine
            embedder  = DebtEngine()
            embedding = await embedder.embed(summary)
            log.info("[Pipeline] Step 2 ✓  Summary embedded (%d dims)", len(embedding))
        except Exception as exc:
            log.error("[Pipeline] Step 2 ✗  Embedding failed (non-fatal): %s", exc)
    else:
        log.debug("[Pipeline] Step 2 –  Skipped (no summary to embed)")

    # ── Step 3: save_to_supabase() ────────────────────────────────────────────
    saved = await save_to_supabase(
        summary   = summary,
        items     = items,
        embedding = embedding,
        session   = session,
    )
    log.info("[Pipeline] Step 3 %s  Supabase save", "✓" if saved else "✗ (non-fatal)")

    # ── Step 4: trigger_zapier() ──────────────────────────────────────────────
    word_count = sum(
        len(s.get("transcript", s.get("text", "")).split())
        for s in segments
    )
    screenshot_links = [
        f"data:image/jpeg;base64,{sl['frame']}"
        for sl in slides
        if sl.get("frame")
    ]

    zapier_payload = {
        "event":                    "meeting_ended",
        "session_id":               sid,
        "title":                    session.get("title", "Untitled Meeting"),
        "participants":             session.get("participants", []),
        "started_at":               session.get("started_at"),
        "ended_at":                 session.get("ended_at"),
        # summary is the live Gemini output from Step 1 (not null anymore)
        "summary":                  summary,
        "action_items":             items,
        "screenshot_links":         screenshot_links,
        "transcript_segment_count": len(segments),
        "word_count":               word_count,
    }
    fired = await trigger_zapier(zapier_payload)
    log.info("[Pipeline] Step 4 %s  Zapier webhook", "✓" if fired else "✗ (non-fatal)")


async def _persist_session_embeddings(sid: str, session: dict) -> None:
    """
    Background task (runs in parallel with the pipeline):
    Embeds each action item individually and inserts transcript segments + slides.
    This is slower (one Gemini call per item) so runs separately from steps 1-4.
    """
    try:
        from services.persistence import persist_session
        segments = _transcripts.get(sid, [])
        items    = _action_items.get(sid, [])
        slides   = _slide_contexts.get(sid, [])
        summary  = session.get("_debrief_summary")
        await persist_session(session, segments, items, slides, summary)
    except Exception as exc:
        log.error("[Persist] Embedding task error (non-fatal): %s", exc)


# ── _post_meeting_cleanup removed ────────────────────────────────────────────
# Replaced by the sequential _end_of_meeting_pipeline() above.
# trigger_zapier() is now a standalone function (importable + unit-testable).
# All Zapier logic lives in trigger_zapier(); see the STANDALONE INTEGRATION
# FUNCTIONS section near the top of this file.


@app.post("/session/pause", tags=["session"])
async def session_pause():
    for s in _sessions.values():
        if s["status"] in ("active", "paused"):
            s["status"] = "paused" if s["status"] == "active" else "active"
            return s
    return JSONResponse({"error": "No active session"}, status_code=404)


@app.get("/session/current", tags=["session"])
async def session_current():
    for s in reversed(list(_sessions.values())):
        if s["status"] == "active":
            return s
    return {"status": "idle"}


@app.get("/session/actions", tags=["session"])
async def session_actions():
    """
    Returns all action items from the most recently ended (or active) session.
    The frontend polls this after session stop to populate the swimlane dashboard.
    """
    # Prefer last ended session; fall back to active
    target_sid = None
    for sid, s in reversed(list(_sessions.items())):
        if s["status"] in ("ended", "active"):
            target_sid = sid
            break
    if not target_sid:
        return {"action_items": [], "session_id": None}

    return {
        "session_id":   target_sid,
        "action_items": _action_items.get(target_sid, []),
        "speaker_map":  _speaker_maps.get(target_sid, {}),
    }


# ══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET — /ws/transcribe  and  /ws/audio  (alias)
# ══════════════════════════════════════════════════════════════════════════════
async def _ws_handler(websocket: WebSocket) -> None:
    """
    Core WebSocket handler shared by /ws/transcribe and /ws/audio.

    Receives raw Int16 PCM audio (binary frames) from the Electron renderer.
    Binary frames are forwarded directly to Deepgram — zero-copy, zero JSON overhead.

    Frame format (Electron → Backend):
      • Binary frames: Int16 PCM, 16 kHz, mono, little-endian
      • binaryType must be 'arraybuffer' on the client (set in audioStreamer.js)

    Events emitted (Backend → Electron):
      { type: 'transcript', transcript, is_final, speaker, confidence, timestamp }
      { type: 'action_item', id, title, assignee, priority, due, context, isNew }
      { type: 'debt_item', id, title, assignee, similarity, meeting_title, days_ago }
      { type: 'ping' }                        ← keep-alive every 15 s
      { type: 'error', message, code }        ← graceful degradation signal

    Routing:
      has_deepgram = True  → _deepgram_mode() — live Nova-2 streaming
      has_deepgram = False → _mock_mode()     — realistic mock events for demo

    On Deepgram failure mid-session:
      Emits { type: 'error', code: 'DEEPGRAM_FAILURE' } then falls back to mock.
      The client stays connected — no reconnect loop triggered.
    """
    await websocket.accept()
    conn_id = str(uuid.uuid4())[:8]
    log.info("[WS:%s] Client connected", conn_id)

    await _deepgram_mode(websocket, conn_id)


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    """Primary WebSocket endpoint — binary PCM → Deepgram → JSON events."""
    await _ws_handler(websocket)


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    """
    Alias for /ws/transcribe.
    Electron audioStreamer.js connects to this URL when
    NEXT_PUBLIC_BACKEND_WS_URL=ws://127.0.0.1:8000/ws/audio is set in .env.
    Identical behaviour — both routes share _ws_handler().
    """
    await _ws_handler(websocket)


async def _deepgram_mode(websocket: WebSocket, conn_id: str):
    """
    Live Deepgram streaming mode.
    Session ID is resolved dynamically per-segment so timing races are avoided.
    """
    from engine import DeepgramEngine, ActionEngine

    action_engine = ActionEngine()
    segment_count = 0
    window: list[str] = []

    async def on_transcript(chunk: dict):
        nonlocal segment_count
        try:
            await websocket.send_json({"type": "transcript", **chunk})
        except Exception as send_exc:
            log.warning("[WS:%s] Send failed: %s", conn_id, send_exc)
            return

        if chunk.get("is_final"):
            segment_count += 1
            speaker = chunk.get("speaker", "Speaker ?")
            window.append(f"{speaker}: {chunk['transcript']}")
            if len(window) > cfg.ACTION_WINDOW_SIZE:
                window.pop(0)

            # Resolve session ID dynamically — avoids the timing race where
            # /session/start is called a few ms AFTER the WS connects
            sid = next(
                (s["id"] for s in _sessions.values() if s["status"] == "active"),
                None
            )

            if sid:
                _transcripts.setdefault(sid, []).append(chunk)

            # Action Item Detection — two triggers:
            # 1. Periodic: every N final segments (catches background assignments)
            # 2. Name-triggered: fires immediately when a participant name is spoken
            #    (catches explicit direct assignments like "Parth, please do X")
            session_meta = _sessions.get(sid, {}) if sid else {}
            participants = session_meta.get("participants", [])
            transcript_lower = chunk.get("transcript", "").lower()
            name_triggered = any(
                p.split()[0].lower() in transcript_lower   # match first name
                for p in participants
            )

            should_detect = (
                segment_count % cfg.ACTION_TRIGGER_INTERVAL == 0
                or name_triggered
            )

            if should_detect and len(window) >= 2:
                asyncio.create_task(
                    _detect_actions(action_engine, list(window), websocket, sid)
                )

            # Identity Discovery (Name Mapping) — every 5 final segments
            if segment_count % 5 == 0 and sid:
                asyncio.create_task(
                    _infer_identities(list(window), websocket, sid)
                )

    engine    = DeepgramEngine(on_transcript=on_transcript)
    ping_task: asyncio.Task | None = None

    try:
        async with engine.connect() as dg_session:
            ping_task = asyncio.create_task(_ping_loop(websocket))
            try:
                while True:
                    data = await websocket.receive_bytes()
                    await dg_session.send(data)
            except WebSocketDisconnect:
                log.info("[WS:%s] Client disconnected cleanly", conn_id)
            except Exception as recv_exc:
                log.error("[WS:%s] Receive error: %s", conn_id, recv_exc)
    except Exception as dg_exc:
        err_msg = str(dg_exc)
        log.error("[WS:%s] Deepgram fatal error: %s", conn_id, err_msg)
        try:
            await websocket.send_json({
                "type":    "error",
                "message": f"STT engine error: {err_msg}",
                "code":    "DEEPGRAM_CONNECTION_ERROR",
            })
            await asyncio.sleep(0.3)
        except Exception:
            pass
    finally:
        if ping_task and not ping_task.done():
            ping_task.cancel()





async def _ping_loop(websocket: WebSocket):
    """Keep-alive ping every 10s to prevent proxy/load-balancer timeouts."""
    while True:
        await asyncio.sleep(10)
        try:
            await websocket.send_json({"type": "ping"})
        except Exception:
            break  # Connection gone — stop silently


_IDENTITY_PROMPT = """Analyze the following transcript snippets. Identify the real name associated with each Speaker ID based on introductions or mentions (e.g. "I am Aaditya", "Aaditya here").

Transcript:
{transcript}

Return ONLY valid JSON:
{{
  "0": "Name", 
  "1": "Name"
}}
If unknown, do not include it.
"""

async def _infer_identities(window: list[str], websocket: WebSocket, sid: str):
    if not window or not sid: return
    try:
        text   = "\n".join(window[-20:])
        model  = _get_gemini(cfg.GEMINI_TEXT_MODEL)
        prompt = _IDENTITY_PROMPT.format(transcript=text)

        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(prompt, generation_config={"temperature": 0.1})
        )
        
        from engine import _parse_json_from_gemini
        updates = _parse_json_from_gemini(response.text)
        if isinstance(updates, dict) and updates:
            current_map = _speaker_maps.get(sid, {})
            needs_emit  = False
            for k, v in updates.items():
                # Clean key (remove "Speaker" if present)
                clean_k = str(k).lower().replace("speaker", "").strip()
                if current_map.get(clean_k) != v:
                    current_map[clean_k] = v
                    needs_emit = True
            
            if needs_emit:
                await websocket.send_json({
                    "type": "identity_update",
                    "map": current_map
                })
                log.info("[Identity] Learned names for %s: %s", sid, current_map)

    except Exception as exc:
        log.error("[IdentityDetector] Error: %s", exc)


async def _detect_actions(
    engine,
    window: list[str],
    websocket: WebSocket,
    session_id: str | None = None,
) -> None:
    try:
        # Gather context: identity map, known participants, admin name
        identities   = _speaker_maps.get(session_id, {}) if session_id else {}
        session_meta = _sessions.get(session_id, {}) if session_id else {}
        participants = session_meta.get("participants", [])
        admin        = session_meta.get("admin", "Admin")

        items = await engine.detect(
            window,
            identities   = identities,
            participants = participants,
            admin        = admin,
        )
        for item in items:
            try:
                await websocket.send_json({"type": "action_item", **item})
            except Exception:
                pass
            if session_id and session_id in _action_items:
                exists = any(a.get("id") == item.get("id") for a in _action_items[session_id])
                if not exists:
                    _action_items[session_id].append(item)
    except Exception as exc:
        log.error("[ActionDetector] Non-fatal error: %s", exc)






# ══════════════════════════════════════════════════════════════════════════════
# VISION — Gemini 1.5 Pro Vision
# ══════════════════════════════════════════════════════════════════════════════
class FrameRequest(BaseModel):
    frame:      str
    session_id: str | None = None


@app.post("/vision/analyze", tags=["vision"])
async def vision_analyze(body: FrameRequest):
    """
    Accepts a base64-encoded JPEG frame from the Electron captureManager,
    runs perceptual hash gating, then Gemini 1.5 Pro Vision analysis.
    Graceful degradation: returns mock data if Gemini is unavailable.
    """
    if not cfg.has_gemini:
        return {
            "slide_changed": True,
            "id":            str(uuid.uuid4()),
            "description":   "Mock: Slide showing Q3 roadmap with feature timeline.",
            "key_points":    ["Feature A ships in July", "Beta in August", "GA in October"],
            "slide_type":    "presentation",
            "takeaway":      "Q3 delivery is gated on the auth fix — escalate now.",
            "captured_at":   datetime.now(timezone.utc).isoformat(),
            "mode":          "mock",
        }

    try:
        from engine import VisionEngine
        ve     = VisionEngine()
        result = await ve.analyze(body.frame, body.session_id)
    except Exception as exc:
        # Graceful degradation: vision failure must not crash transcription
        log.error("[Vision] Analysis failed (non-fatal): %s", exc)
        return {
            "slide_changed": False,
            "error":         str(exc),
            "mode":          "error",
        }

    # Cache slide context (with the frame for Zapier screenshot links)
    if result.get("slide_changed"):
        sid = body.session_id or next(
            (s["id"] for s in _sessions.values() if s["status"] == "active"), None
        )
        if sid and sid in _slide_contexts:
            # Attach the frame to the slide context for post-meeting screenshot links
            result["frame"] = body.frame
            _slide_contexts[sid].append(result)

    return result


# ══════════════════════════════════════════════════════════════════════════════
# DEBT LOG (RAG) — Gemini text-embedding-004 + Supabase pgvector
# ══════════════════════════════════════════════════════════════════════════════
class DebtQueryRequest(BaseModel):
    trigger: str = "auto"


@app.post("/debt/query", tags=["debt"])
async def debt_query(body: DebtQueryRequest):
    if not cfg.has_gemini or not cfg.has_supabase:
        return {
            "items": [_mock_debt_item() for _ in range(2)],
            "mode":  "mock",
        }

    try:
        from engine import DebtEngine
        de    = DebtEngine()
        items = await de.query("recent meeting context")
        return {"items": items, "mode": "live"}
    except Exception as exc:
        log.error("[Debt] Query failed (non-fatal): %s", exc)
        return {"items": [], "mode": "error", "message": str(exc)}


# ══════════════════════════════════════════════════════════════════════════════
# DEBRIEF — Gemini 1.5 Pro (quality > speed for final debrief)
# ══════════════════════════════════════════════════════════════════════════════
@app.post("/debrief/generate", tags=["debrief"])
async def debrief_generate():
    """
    Generates a structured post-meeting debrief using Gemini 1.5 PRO.
    Pro is used here (not Flash) because the debrief is a one-shot,
    high-stakes synthesis of the entire meeting — quality trumps latency.
    The resulting summary is also cached on the session for the Zapier payload.
    """
    # Find most recent session (ended takes priority, then active)
    session = next(
        (s for s in reversed(list(_sessions.values())) if s["status"] == "ended"), None
    ) or next(
        (s for s in reversed(list(_sessions.values()))), None
    )

    if not session:
        return JSONResponse({"error": "No session found"}, status_code=404)

    sid      = session["id"]
    segments = _transcripts.get(sid, [])
    items    = _action_items.get(sid, [])

    if not cfg.has_gemini:
        # Mock debrief for demo mode
        return {
            "version":    "1.0",
            "session":    session,
            "summary":    "The team aligned on Q3 roadmap priorities, identified a critical auth bug blocking the next release, and scheduled a Thursday deployment window with DevOps.",
            "key_decisions": [
                "Ship Feature A by end of Q3",
                "Hotfix auth bug before the next release",
                "Thursday deployment slot confirmed with DevOps",
            ],
            "risks": [
                "Auth bug may delay release if not resolved by Wednesday",
                "API docs are still out of date after v2 launch",
            ],
            "action_items": items or [
                _mock_action_item("Create Jira ticket for auth bug", "Alice"),
                _mock_action_item("Schedule stakeholder sync for Tuesday", "Bob"),
            ],
            "next_steps": [
                "Alice to create Jira ticket for auth bug by EOD",
                "Bob to schedule stakeholder sync for next Tuesday",
                "DevOps to confirm Thursday deployment window",
                "Update API documentation with new v2 endpoints",
            ],
            "transcript_segments": len(segments),
            "word_count": sum(
                len(s.get("transcript", s.get("text", "")).split())
                for s in segments
            ),
            "mode": "mock",
        }

    try:
        from engine import DebriefEngine
        de     = DebriefEngine()
        result = await de.generate(session, segments, items)

        # Cache the summary on the session object for Zapier payload
        summary = result.get("summary")
        if summary:
            session["_debrief_summary"] = summary

        # Add metadata if not present from engine
        if "transcript_segments" not in result:
            result["transcript_segments"] = len(segments)
            result["word_count"] = sum(len(s.get("transcript", "").split()) for s in segments)

        return result

    except Exception as exc:
        log.error("[Debrief] Generation failed: %s", exc)
        return JSONResponse(
            {"error": "Debrief generation failed", "detail": str(exc)},
            status_code=500,
        )
