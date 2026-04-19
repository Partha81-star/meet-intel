# backend/services/action_detector.py
"""
Action Item Detector — thin wrapper around GeminiService.detect_actions().
Handles deduplication within a session to avoid re-surfacing the same items.
"""

import logging
from services.gemini_service import GeminiService

log = logging.getLogger("meetintel.action_detector")


class ActionDetector:
    def __init__(self):
        self._gemini    = GeminiService()
        self._seen_ids: set[str] = set()

    async def detect(self, transcript_window: list[str]) -> list[dict]:
        """
        Run action detection on the sliding window via Gemini 1.5 Flash.
        Filters out items whose titles have already been surfaced this session.
        """
        items = await self._gemini.detect_actions(transcript_window)
        new_items = []
        for item in items:
            # Dedup by title (fuzzy) — Gemini may return same item with different UUIDs
            title_key = item.get("title", "").lower().strip()[:60]
            if title_key not in self._seen_ids:
                self._seen_ids.add(title_key)
                new_items.append(item)

        log.debug("[ActionDetector] %d new items (of %d detected)", len(new_items), len(items))
        return new_items

    def reset(self):
        """Call at session start."""
        self._seen_ids.clear()
