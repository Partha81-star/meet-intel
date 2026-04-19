# backend/services/debt_log_service.py  — Gemini Edition
"""
Meeting Debt Log — RAG-powered Vector Similarity Search

Architecture:
  1. Every final action item is embedded with Google text-embedding-004 (768-dim)
     and upserted into Supabase's pgvector table `action_items`.

  2. On each debt query trigger, we embed the current transcript context
     and run a cosine similarity search against all UNRESOLVED items
     from the last 3 meetings (excluding the current session).

  3. Items with similarity >= SIMILARITY_THRESHOLD are returned as
     "Meeting Debt" and surfaced in the sidebar DebtLog component.

Supabase pgvector query used:
  SELECT *, 1 - (embedding <=> query_embedding) AS similarity
  FROM action_items
  WHERE status = 'unresolved' AND meeting_id != current_meeting_id
    AND meeting_id IN (last 3 meeting IDs)
  ORDER BY similarity DESC
  LIMIT 5;
"""

import os
import logging
from typing import Optional

from models.database import db

log = logging.getLogger("meetintel.debt")

SIMILARITY_THRESHOLD = float(os.getenv("DEBT_SIMILARITY_THRESHOLD", "0.78"))
MAX_DEBT_ITEMS       = 5
PAST_MEETING_WINDOW  = 3    # Search within last N meetings


class DebtLogService:
    """
    Wraps the RAG pipeline for surfacing unresolved meeting debt.
    Uses Google text-embedding-004 (768-dim) via GeminiService.
    """

    def __init__(self):
        from services.gemini_service import GeminiService
        self._gemini = GeminiService()

    async def embed_text(self, text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list[float]:
        """
        Embed text using Google text-embedding-004 (768-dim).
        task_type: RETRIEVAL_DOCUMENT (indexing) | RETRIEVAL_QUERY (search)
        """
        return await self._gemini.embed_text(text, task_type=task_type)

    async def index_action_item(self, item: dict, meeting_id: str) -> None:
        """
        Generate an embedding for a new action item and upsert into Supabase.
        Called automatically from the transcription route after action detection.
        """
        try:
            embed_text = f"{item.get('title', '')} {item.get('context', '')}".strip()
            if not embed_text:
                return

            embedding = await self.embed_text(embed_text)

            await db.upsert_action_item_embedding(
                item_id    = item["id"],
                meeting_id = meeting_id,
                embedding  = embedding,
                status     = "unresolved",
            )
            log.debug("[Debt] Indexed action item: %s", item.get("title", "")[:40])
        except Exception as exc:
            log.error("[Debt] Indexing error: %s", exc)

    async def query(
        self,
        context_text:       str,
        exclude_meeting_id: Optional[str] = None,
    ) -> list[dict]:
        """
        Core RAG query.

        1. Embed the current transcript context with RETRIEVAL_QUERY task type.
        2. Fetch last PAST_MEETING_WINDOW meeting IDs (excl. current).
        3. Run pgvector cosine similarity search.
        4. Filter to items >= SIMILARITY_THRESHOLD.
        5. Enrich with meeting metadata and return.

        Returns a list of DebtItem dicts ready for the frontend.
        """
        try:
            if not context_text.strip():
                return []

            # ── Step 1: Embed current context (as a query) ────────────────────
            query_embedding = await self.embed_text(context_text, task_type="RETRIEVAL_QUERY")

            # ── Step 2: Get past meeting IDs ──────────────────────────────────
            past_meetings = await db.get_past_meeting_ids(
                limit              = PAST_MEETING_WINDOW,
                exclude_meeting_id = exclude_meeting_id,
            )

            if not past_meetings:
                log.debug("[Debt] No past meetings to query")
                return []

            past_ids = [m["id"] for m in past_meetings]

            # ── Step 3: Vector similarity search ──────────────────────────────
            results = await db.vector_search_action_items(
                query_embedding      = query_embedding,
                meeting_ids          = past_ids,
                status               = "unresolved",
                limit                = MAX_DEBT_ITEMS,
                similarity_threshold = SIMILARITY_THRESHOLD,
            )

            # ── Step 4 & 5: Enrich with meeting context ───────────────────────
            meeting_map = {m["id"]: m for m in past_meetings}
            debt_items  = []

            for row in results:
                meeting  = meeting_map.get(row.get("meeting_id"), {})
                days_ago = _calc_days_ago(meeting.get("started_at"))

                debt_items.append({
                    "id":                row["id"],
                    "title":             row["title"],
                    "context":           row.get("context"),
                    "assignee":          row.get("assignee"),
                    "status":            row.get("status", "unresolved"),
                    "priority":          row.get("priority", "medium"),
                    "similarity":        round(row.get("similarity", 0.0), 3),
                    "meeting_id":        row.get("meeting_id"),
                    "meeting_title":     meeting.get("title", "Previous Meeting"),
                    "days_ago":          days_ago,
                    "responsible_party": row.get("assignee"),
                })

            log.info("[Debt] Query returned %d items (threshold=%.2f)", len(debt_items), SIMILARITY_THRESHOLD)
            return debt_items

        except Exception as exc:
            log.exception("[Debt] Query failed: %s", exc)
            return []

    async def mark_resolved(self, item_id: str) -> bool:
        """Mark a debt item as resolved in the database."""
        try:
            await db.update_action_item_status(item_id, "resolved")
            return True
        except Exception as exc:
            log.error("[Debt] mark_resolved failed: %s", exc)
            return False


# ─── Utility ──────────────────────────────────────────────────────────────────

def _calc_days_ago(iso_ts: Optional[str]) -> Optional[int]:
    if not iso_ts:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(iso_ts)
        return (datetime.now(timezone.utc) - dt).days
    except Exception:
        return None
