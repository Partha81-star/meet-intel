# backend/models/database.py
"""
Supabase database client + helper methods.

All DB I/O is async (supabase-py uses httpx under the hood).
The vector search uses the pgvector cosine operator <=>
exposed via a Supabase RPC function `match_action_items`.
"""

import os
import json
import logging
from typing import Optional

from supabase import create_client, Client
from datetime import datetime, timezone

log = logging.getLogger("meetintel.database")


def _get_client() -> Client | None:
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        log.warning("[DB] Supabase not configured — running in MOCK mode")
        return None
    return create_client(url, key)


# Singleton client
_client: Client | None = _get_client()


class _Database:
    """
    All DB operations wrapped in try/except with graceful mock fallback.
    In a 24h hackathon, Supabase might not be configured — methods return
    mock values so the rest of the app still functions.
    """

    # ── Meetings ────────────────────────────────────────────────────────────
    async def create_meeting(self, session_id: str) -> str:
        if not _client:
            return f"mock_meeting_{session_id[:8]}"
        try:
            resp = _client.table("meetings").insert({
                "session_id": session_id,
                "started_at": _now(),
                "status":     "active",
            }).execute()
            return resp.data[0]["id"]
        except Exception as exc:
            log.error("[DB] create_meeting: %s", exc)
            return session_id

    async def end_meeting(self, meeting_id: str) -> None:
        if not _client: return
        try:
            _client.table("meetings").update({
                "ended_at": _now(),
                "status":   "ended",
            }).eq("id", meeting_id).execute()
        except Exception as exc:
            log.error("[DB] end_meeting: %s", exc)

    async def get_latest_session(self) -> dict | None:
        if not _client: return None
        try:
            resp = _client.table("meetings") \
                .select("*") \
                .order("started_at", desc=True) \
                .limit(1) \
                .execute()
            return resp.data[0] if resp.data else None
        except Exception as exc:
            log.error("[DB] get_latest_session: %s", exc)
            return None

    async def get_past_meeting_ids(
        self,
        limit:              int,
        exclude_meeting_id: Optional[str] = None,
    ) -> list[dict]:
        if not _client: return []
        try:
            q = _client.table("meetings") \
                .select("id, title, started_at") \
                .eq("status", "ended") \
                .order("started_at", desc=True) \
                .limit(limit)
            if exclude_meeting_id:
                q = q.neq("id", exclude_meeting_id)
            return q.execute().data or []
        except Exception as exc:
            log.error("[DB] get_past_meeting_ids: %s", exc)
            return []

    # ── Transcript ───────────────────────────────────────────────────────────
    async def insert_transcript_segment(self, segment: dict) -> None:
        if not _client: return
        try:
            _client.table("transcript_segments").insert(segment).execute()
        except Exception as exc:
            log.error("[DB] insert_transcript_segment: %s", exc)

    async def get_transcript_segments(self, meeting_id: str) -> list[dict]:
        if not _client: return []
        try:
            resp = _client.table("transcript_segments") \
                .select("*") \
                .eq("meeting_id", meeting_id) \
                .order("timestamp") \
                .execute()
            return resp.data or []
        except Exception as exc:
            log.error("[DB] get_transcript_segments: %s", exc)
            return []

    # ── Action Items ─────────────────────────────────────────────────────────
    async def insert_action_item(self, item: dict) -> str | None:
        if not _client: return item.get("id")
        try:
            resp = _client.table("action_items").insert({
                k: v for k, v in item.items() if k != "embedding"
            }).execute()
            return resp.data[0]["id"]
        except Exception as exc:
            log.error("[DB] insert_action_item: %s", exc)
            return None

    async def upsert_action_item_embedding(
        self,
        item_id:    str,
        meeting_id: str,
        embedding:  list[float],
        status:     str = "unresolved",
    ) -> None:
        if not _client: return
        try:
            _client.table("action_items").update({
                "embedding": embedding,
            }).eq("id", item_id).execute()
        except Exception as exc:
            log.error("[DB] upsert_action_item_embedding: %s", exc)

    async def update_action_item_status(self, item_id: str, status: str) -> None:
        if not _client: return
        try:
            _client.table("action_items").update({"status": status}).eq("id", item_id).execute()
        except Exception as exc:
            log.error("[DB] update_action_item_status: %s", exc)

    async def get_action_items(self, meeting_id: str) -> list[dict]:
        if not _client: return []
        try:
            resp = _client.table("action_items") \
                .select("id, title, assignee, due, priority, context, status") \
                .eq("meeting_id", meeting_id) \
                .execute()
            return resp.data or []
        except Exception as exc:
            log.error("[DB] get_action_items: %s", exc)
            return []

    # ── Vector search (Phase 4) ───────────────────────────────────────────────
    async def vector_search_action_items(
        self,
        query_embedding:     list[float],
        meeting_ids:         list[str],
        status:              str   = "unresolved",
        limit:               int   = 5,
        similarity_threshold: float = 0.78,
    ) -> list[dict]:
        """
        Calls the Supabase RPC function `match_action_items` which wraps:

        SELECT *, 1 - (embedding <=> query_embedding) AS similarity
        FROM action_items
        WHERE status = $status
          AND meeting_id = ANY($meeting_ids)
          AND 1 - (embedding <=> query_embedding) >= $threshold
        ORDER BY similarity DESC
        LIMIT $limit;

        See: docs/supabase_schema.sql for the RPC definition.
        """
        if not _client: return []
        try:
            resp = _client.rpc("match_action_items", {
                "query_embedding":     query_embedding,
                "meeting_ids":         meeting_ids,
                "match_status":        status,
                "match_threshold":     similarity_threshold,
                "match_count":         limit,
            }).execute()
            return resp.data or []
        except Exception as exc:
            log.error("[DB] vector_search_action_items: %s", exc)
            return []

    # ── Slides ───────────────────────────────────────────────────────────────
    async def insert_slide(self, slide: dict) -> str | None:
        if not _client: return None
        try:
            # Don't store full frame base64 in DB (too large) — use storage bucket instead
            db_slide = {k: v for k, v in slide.items() if k != "frame"}
            resp = _client.table("slides").insert(db_slide).execute()
            return resp.data[0]["id"]
        except Exception as exc:
            log.error("[DB] insert_slide: %s", exc)
            return None

    async def get_slides(self, meeting_id: str) -> list[dict]:
        if not _client: return []
        try:
            resp = _client.table("slides") \
                .select("id, description, key_points, captured_at, slide_type") \
                .eq("meeting_id", meeting_id) \
                .order("captured_at") \
                .execute()
            return resp.data or []
        except Exception as exc:
            log.error("[DB] get_slides: %s", exc)
            return []

    # ── Debrief ──────────────────────────────────────────────────────────────
    async def upsert_debrief(self, meeting_id: str, debrief: dict) -> None:
        if not _client: return
        try:
            _client.table("debriefs").upsert({
                "meeting_id": meeting_id,
                "content":    json.dumps(debrief),
                "created_at": _now(),
            }, on_conflict="meeting_id").execute()
        except Exception as exc:
            log.error("[DB] upsert_debrief: %s", exc)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Singleton instance used across routes
db = _Database()
