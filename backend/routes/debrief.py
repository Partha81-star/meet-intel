# backend/routes/debrief.py  — Post-call automation
"""
POST /debrief/generate

Aggregates all transcript segments, action items, and slides for the
current session into a structured JSON debrief, then fires webhooks.
"""

import logging
import json
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services.openai_service  import OpenAIService
from services.webhook_service import WebhookService
from models.database          import db

log        = logging.getLogger("meetintel.debrief")
router     = APIRouter(prefix="/debrief", tags=["debrief"])
openai_svc = OpenAIService()
webhook    = WebhookService()


@router.post("/generate")
async def generate_debrief():
    """
    1. Pull all segments + action items for the most recent ended session.
    2. GPT-4o → structured summary (decisions, risks, next steps).
    3. Build a fully typed JSON debrief document.
    4. Fire Jira/Notion webhooks asynchronously.
    5. Return the debrief JSON.
    """
    try:
        # ── Fetch session artifacts from Supabase ─────────────────────────
        session = await db.get_latest_session()
        if not session:
            return JSONResponse({"error": "No session found"}, status_code=404)

        segments     = await db.get_transcript_segments(session["id"])
        action_items = await db.get_action_items(session["id"])
        slides       = await db.get_slides(session["id"])

        full_transcript = " ".join(s["text"] for s in segments)

        # ── GPT-4o: structured debrief generation ─────────────────────────
        structured = await openai_svc.generate_debrief(
            transcript   = full_transcript,
            action_items = action_items,
            slide_count  = len(slides),
        )

        # ── Assemble debrief document ─────────────────────────────────────
        debrief = {
            "version":     "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "session": {
                "id":         session["id"],
                "title":      session.get("title"),
                "started_at": session.get("started_at"),
                "ended_at":   session.get("ended_at"),
                "duration_seconds": _calc_duration(session),
            },
            "summary":          structured.get("summary", ""),
            "key_decisions":    structured.get("key_decisions", []),
            "risks":            structured.get("risks", []),
            "action_items":     action_items,
            "slide_captures":   len(slides),
            "transcript_segments": len(segments),
            "word_count":       len(full_transcript.split()),
            "next_steps":       structured.get("next_steps", []),
        }

        # ── Persist debrief ────────────────────────────────────────────────
        await db.upsert_debrief(session["id"], debrief)

        # ── Fire webhooks (non-blocking) ───────────────────────────────────
        import asyncio
        asyncio.create_task(webhook.dispatch(debrief))

        log.info("[Debrief] Generated for session %s", session["id"])
        return debrief

    except Exception as exc:
        log.exception("[Debrief] Generation failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)


def _calc_duration(session: dict) -> int | None:
    try:
        start = datetime.fromisoformat(session["started_at"])
        end   = datetime.fromisoformat(session["ended_at"])
        return int((end - start).total_seconds())
    except Exception:
        return None
