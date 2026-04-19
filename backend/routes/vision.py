# backend/routes/vision.py  — Phase 3
"""
POST /vision/analyze

Receives a base64-encoded JPEG screen frame.
Runs dHash comparison against the last captured frame.
If a slide change is detected, sends the frame to GPT-4o Vision.
"""

import logging
from fastapi import APIRouter
from pydantic import BaseModel

from services.vision_processor import VisionProcessor
from services.openai_service   import OpenAIService
from models.database           import db

log    = logging.getLogger("meetintel.vision")
router = APIRouter(prefix="/vision", tags=["vision"])

processor   = VisionProcessor()
openai_svc  = OpenAIService()


class FrameRequest(BaseModel):
    frame:      str            # Base64 JPEG
    session_id: str | None = None


@router.post("/analyze")
async def analyze_frame(body: FrameRequest):
    """
    1. Decode + hash the incoming frame.
    2. Compare against last hash — if Hamming distance > threshold → slide change.
    3. On slide change: send to GPT-4o Vision for description + key points.
    4. Persist to Supabase slides table.
    5. Return result (slide_changed: bool, description, key_points, frame).
    """
    try:
        changed, hamming_dist = processor.detect_change(body.frame)

        if not changed:
            return {"slide_changed": False, "hamming_dist": hamming_dist}

        log.info("[Vision] Slide change detected (Hamming=%d) — sending to GPT-4o", hamming_dist)

        # ── GPT-4o Vision analysis ────────────────────────────────────────
        vision_result = await openai_svc.analyze_frame(body.frame)

        slide_record = {
            "session_id":  body.session_id,
            "frame":       body.frame,
            "description": vision_result.get("description", ""),
            "key_points":  vision_result.get("key_points", []),
            "hamming_dist": hamming_dist,
        }

        # Persist to Supabase
        slide_id = await db.insert_slide(slide_record)

        return {
            "slide_changed": True,
            "id":            slide_id,
            "description":   vision_result.get("description", ""),
            "key_points":    vision_result.get("key_points", []),
            "frame":         body.frame,
            "captured_at":   vision_result.get("captured_at"),
        }

    except Exception as exc:
        log.exception("[Vision] Error: %s", exc)
        return {"slide_changed": False, "error": str(exc)}
