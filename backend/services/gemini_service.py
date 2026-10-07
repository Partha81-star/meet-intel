# backend/services/gemini_service.py
"""
Google Gemini orchestration service — replaces openai_service.py

Methods:
  - analyze_frame(frame_b64)           → SlideContext  (Gemini 1.5 Pro Vision)
  - detect_actions(window)             → [ActionItem]  (Gemini 1.5 Flash)
  - generate_debrief(...)              → StructuredDebrief (Gemini 1.5 Flash)
  - embed_text(text)                   → list[float]   (text-embedding-004, 768-dim)
"""

import os
import re
import json
import uuid
import base64
import logging
import asyncio
from datetime import datetime, timezone
from typing import Optional

from services import gemini_client as genai

log = logging.getLogger("meetintel.gemini")

# ── Configure Gemini once at import ──────────────────────────────────────────
_api_key = os.environ.get("GOOGLE_API_KEY", "")
if _api_key:
    genai.configure(api_key=_api_key)

# Model names (overridable via env)
from config import cfg
TEXT_MODEL   = cfg.GEMINI_TEXT_MODEL
VISION_MODEL = cfg.GEMINI_VISION_MODEL
EMBED_MODEL  = cfg.GEMINI_EMBED_MODEL


# ─── Prompt templates ─────────────────────────────────────────────────────────

VISION_PROMPT = """You are an expert meeting intelligence assistant.
Analyze this meeting slide and link it to the current transcript context. What is the key takeaway?

Respond ONLY with a valid JSON object:
{
  "description": "One concise sentence describing what is shown (max 25 words)",
  "key_points": ["bullet 1", "bullet 2", "bullet 3"],
  "slide_type": "presentation|whiteboard|code|dashboard|document|other",
  "takeaway": "The single most important insight from this slide in context"
}"""

ACTION_PROMPT = """You are an AI meeting assistant. Read the recent meeting transcript and extract ALL clear verbal commitments, assignments, or action items.

Respond ONLY with a valid JSON array (can be empty []):
[
  {
    "id": "<uuid-like string>",
    "title": "Clear, imperative description of the task",
    "assignee": "Person's name if mentioned, else null",
    "due": "Due date or timeframe if mentioned, else null",
    "priority": "high|medium|low",
    "context": "Brief verbatim quote that revealed this commitment (max 15 words)"
  }
]

Rules:
- Only include genuine commitments ("I will...", "Can you...", "Let's make sure...", "We need to...")
- Do NOT fabricate items. If none found, return [].
- Priority: high = hard deadline/blocker, medium = recurring/implicit, low = nice-to-have

Recent transcript segments:
{transcript}"""

DEBRIEF_PROMPT = """You are an expert business analyst. Read the full meeting transcript and generate a structured debrief.

Respond ONLY with valid JSON:
{{
  "summary": "3-4 sentence executive summary of the meeting",
  "key_decisions": ["Decision 1", "Decision 2"],
  "risks": ["Risk or blocker identified 1", "Risk 2"],
  "next_steps": ["Recommended next step 1", "Next step 2"]
}}

Full transcript:
{transcript}

Action items detected ({item_count}):
{items_text}

Generate the debrief JSON."""


def _parse_gemini_json(text: str) -> dict | list:
    """Strip markdown fences and parse JSON from Gemini responses."""
    text = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    return json.loads(text)


class GeminiService:
    """Stateless façade — each method is independently callable."""

    # ── Vision: frame analysis ────────────────────────────────────────────────
    async def analyze_frame(self, frame_b64: str) -> dict:
        """Send a JPEG frame to Gemini 1.5 Pro Vision. Returns SlideContext dict."""
        log.debug("[Gemini] Sending frame to %s Vision", VISION_MODEL)

        image_bytes = base64.b64decode(frame_b64)
        image_part  = {"mime_type": "image/jpeg", "data": image_bytes}
        model       = genai.GenerativeModel(VISION_MODEL)

        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                [image_part, VISION_PROMPT],
                generation_config={"temperature": 0.2, "max_output_tokens": 400},
            ),
        )

        try:
            result = _parse_gemini_json(response.text)
        except json.JSONDecodeError:
            result = {"description": response.text, "key_points": [], "takeaway": ""}

        result["captured_at"] = datetime.now(timezone.utc).isoformat()
        return result

    # ── Action detection: sliding-window prompt ───────────────────────────────
    async def detect_actions(self, transcript_window: list[str]) -> list[dict]:
        """Sliding-window Gemini Flash call. Returns list of ActionItem dicts."""
        if not transcript_window:
            return []

        window_text = "\n".join(f"- {seg}" for seg in transcript_window)
        prompt      = ACTION_PROMPT.format(transcript=window_text)
        model       = genai.GenerativeModel(TEXT_MODEL)

        log.debug("[Gemini] Action detection on %d segments", len(transcript_window))

        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                prompt,
                generation_config={"temperature": 0.1, "max_output_tokens": 800},
            ),
        )

        try:
            raw   = _parse_gemini_json(response.text)
            items = raw if isinstance(raw, list) else raw.get("action_items", raw.get("items", []))
            for item in items:
                if "id" not in item or not item["id"]:
                    item["id"] = str(uuid.uuid4())
            return items
        except Exception as exc:
            log.error("[Gemini] Action parse error: %s", exc)
            return []

    # ── Debrief generation ───────────────────────────────────────────────────
    async def generate_debrief(
        self,
        transcript:   str,
        action_items: list[dict],
        slide_count:  int,
    ) -> dict:
        """Generates a structured debrief from the meeting transcript."""
        items_text = "\n".join(
            f"- [{i.get('priority','?').upper()}] {i.get('title','')}"
            + (f" (→ {i['assignee']})" if i.get("assignee") else "")
            for i in action_items
        ) or "None detected"

        prompt = DEBRIEF_PROMPT.format(
            transcript = transcript[:12000],
            item_count = len(action_items),
            items_text = items_text,
        )
        model = genai.GenerativeModel(TEXT_MODEL)

        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                prompt,
                generation_config={"temperature": 0.3, "max_output_tokens": 1200},
            ),
        )

        try:
            return _parse_gemini_json(response.text)
        except Exception as exc:
            log.error("[Gemini] Debrief parse error: %s", exc)
            return {"summary": response.text}

    # ── Embeddings (text-embedding-004) ───────────────────────────────────────
    async def embed_text(self, text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list[float]:
        """
        Generate a 768-dim embedding using Google text-embedding-004.
        task_type: "RETRIEVAL_DOCUMENT" for indexing, "RETRIEVAL_QUERY" for queries.
        """
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: genai.embed_content(
                model     = EMBED_MODEL,
                content   = text.strip()[:8000],
                task_type = task_type,
            ),
        )
        return result["embedding"]
