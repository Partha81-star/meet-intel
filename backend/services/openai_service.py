# backend/services/openai_service.py  — Phase 3
"""
OpenAI GPT-4o orchestration service.

Methods:
  - analyze_frame(frame_b64)       → SlideContext (Phase 3 Vision)
  - detect_actions(window)         → [ActionItem]  (Phase 3 Sliding window)
  - generate_debrief(...)          → StructuredDebrief (Phase 4)
"""

import os
import json
import logging
import base64
from datetime import datetime, timezone

from openai import AsyncOpenAI

log    = logging.getLogger("meetintel.openai")
client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

# ─── Prompts ──────────────────────────────────────────────────────────────────

VISION_SYSTEM = """You are an expert meeting intelligence assistant.
You are given a screenshot from an ongoing business meeting (slide, whiteboard, shared screen, etc.).

Respond ONLY with a valid JSON object in this exact schema:
{
  "description": "One concise sentence describing what is shown on screen (max 25 words)",
  "key_points": ["bullet 1", "bullet 2", "bullet 3"],
  "slide_type": "presentation|whiteboard|code|dashboard|document|other",
  "captured_at": "<ISO 8601 timestamp>"
}"""

ACTION_SYSTEM = """You are an AI meeting assistant. Read the recent meeting transcript and extract ALL clear verbal commitments, assignments, or action items.

For EACH item found, return JSON. Respond ONLY with a valid JSON array (can be empty []):
[
  {
    "id": "<uuid-like string>",
    "title": "Clear, imperative description of the task",
    "assignee": "Person's name if mentioned, else null",
    "due": "Due date or timeframe if mentioned (e.g. 'by Friday', 'next week'), else null",
    "priority": "high|medium|low",
    "context": "Brief verbatim quote that revealed this commitment (max 15 words)"
  }
]

Rules:
- Only include genuine commitments ("I will...", "Can you...", "Let's make sure...", "We need to...")
- Do NOT fabricate items. If none found, return [].
- Priority: high = hard deadline/blocker, medium = recurring/implicit, low = nice-to-have"""

DEBRIEF_SYSTEM = """You are an expert business analyst. Read the full meeting transcript and generate a structured debrief.

Respond ONLY with valid JSON:
{
  "summary": "3-4 sentence executive summary of the meeting",
  "key_decisions": ["Decision 1", "Decision 2"],
  "risks": ["Risk or blocker identified 1", "Risk 2"],
  "next_steps": ["Recommended next step 1", "Next step 2"]
}"""


class OpenAIService:
    # ── Vision: frame analysis ─────────────────────────────────────────────
    async def analyze_frame(self, frame_b64: str) -> dict:
        """
        Sends a JPEG frame to GPT-4o Vision.
        Returns SlideContext dict.
        """
        log.debug("[OpenAI] Sending frame to GPT-4o Vision")

        response = await client.chat.completions.create(
            model    = "gpt-4o",
            messages = [
                {"role": "system", "content": VISION_SYSTEM},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url":    f"data:image/jpeg;base64,{frame_b64}",
                                "detail": "low",   # 'low' for speed, 'high' for detail
                            },
                        },
                        {
                            "type": "text",
                            "text": "Analyse this meeting screen capture and return the JSON.",
                        },
                    ],
                },
            ],
            max_tokens      = 400,
            response_format = {"type": "json_object"},
            temperature     = 0.2,
        )

        try:
            result = json.loads(response.choices[0].message.content)
        except json.JSONDecodeError:
            result = {"description": response.choices[0].message.content, "key_points": []}

        result["captured_at"] = datetime.now(timezone.utc).isoformat()
        return result

    # ── Action detection: sliding-window prompt ───────────────────────────
    async def detect_actions(self, transcript_window: list[str]) -> list[dict]:
        """
        Sliding-window GPT-4o call on the last N transcript segments.
        Returns a list of ActionItem dicts.
        """
        if not transcript_window:
            return []

        window_text = "\n".join(f"- {seg}" for seg in transcript_window)
        log.debug("[OpenAI] Action detection on %d segments", len(transcript_window))

        response = await client.chat.completions.create(
            model    = "gpt-4o",
            messages = [
                {"role": "system", "content": ACTION_SYSTEM},
                {
                    "role": "user",
                    "content": f"Recent transcript segments:\n{window_text}\n\nExtract action items:",
                },
            ],
            max_tokens      = 800,
            response_format = {"type": "json_object"},
            temperature     = 0.1,
        )

        try:
            raw = json.loads(response.choices[0].message.content)
            # GPT sometimes wraps in {"action_items": [...]}
            items = raw if isinstance(raw, list) else raw.get("action_items", raw.get("items", []))
            # Ensure each item has an id
            import uuid
            for item in items:
                if "id" not in item or not item["id"]:
                    item["id"] = str(uuid.uuid4())
            return items
        except Exception as exc:
            log.error("[OpenAI] Action parse error: %s", exc)
            return []

    # ── Debrief generation ────────────────────────────────────────────────
    async def generate_debrief(
        self,
        transcript: str,
        action_items: list[dict],
        slide_count: int,
    ) -> dict:
        """Generates a full structured debrief from the meeting transcript."""
        items_text = "\n".join(
            f"- [{i.get('priority','?').upper()}] {i.get('title','')}"
            + (f" (→ {i['assignee']})" if i.get("assignee") else "")
            for i in action_items
        ) or "None detected"

        user_msg = (
            f"Full transcript:\n{transcript[:12000]}\n\n"   # truncate to ~12k chars
            f"Action items detected ({len(action_items)}):\n{items_text}\n\n"
            f"Screen captures: {slide_count}\n\n"
            "Generate the debrief JSON."
        )

        response = await client.chat.completions.create(
            model    = "gpt-4o",
            messages = [
                {"role": "system", "content": DEBRIEF_SYSTEM},
                {"role": "user",   "content": user_msg},
            ],
            max_tokens      = 1200,
            response_format = {"type": "json_object"},
            temperature     = 0.3,
        )

        try:
            return json.loads(response.choices[0].message.content)
        except Exception as exc:
            log.error("[OpenAI] Debrief parse error: %s", exc)
            return {"summary": response.choices[0].message.content}
