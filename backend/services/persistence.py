# backend/services/persistence.py
"""
MeetIntel — Supabase Persistence Service
=========================================
Called at session stop to:
  1. Upsert the meeting row
  2. Insert all action items + embed them for future debt queries
  3. Insert transcript segments (final only)
  4. Insert slide contexts

Import: from services.persistence import persist_session
"""

import logging
from datetime import datetime, timezone

log = logging.getLogger("meetintel.persistence")


async def persist_session(
    session: dict,
    segments: list[dict],
    action_items: list[dict],
    slides: list[dict],
    summary: str | None = None,
) -> None:
    """
    Persist a completed meeting session to Supabase.
    Silently skips if Supabase is not configured.
    """
    try:
        from config import cfg
        if not cfg.has_supabase:
            log.info("[Persist] Supabase not configured — skipping persistence")
            return

        from supabase import create_client
        import os

        db = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_KEY"],
        )

        sid  = session.get("id")
        now  = datetime.now(timezone.utc).isoformat()

        # ── 1. Upsert meeting row ──────────────────────────────────────────────
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
        log.info("[Persist] Meeting upserted: %s", sid)

        # ── 2. Embed + insert action items (Google text-embedding-004) ──────────
        if action_items and cfg.has_gemini:
            from services.gemini_service import GeminiService
            gemini = GeminiService()
            for item in action_items:
                iid = item.get("id")
                if not iid:
                    continue
                try:
                    text      = f"{item.get('title','')} {item.get('context','')}".strip()
                    embedding = await gemini.embed_text(text)
                    db.table("action_items").upsert({
                        "id":        iid,
                        "meeting_id": sid,
                        "title":     item.get("title", ""),
                        "assignee":  item.get("assignee"),
                        "due":       item.get("due"),
                        "priority":  item.get("priority", "medium"),
                        "status":    "unresolved",
                        "context":   item.get("context"),
                        "embedding": embedding,
                    }).execute()
                except Exception as exc:
                    log.error("[Persist] Action embed error (%s): %s", iid, exc)
            log.info("[Persist] %d action items indexed", len(action_items))

        # ── 3. Insert final transcript segments ───────────────────────────────
        finals = [s for s in segments if s.get("is_final")]
        if finals:
            rows = [
                {
                    "meeting_id": sid,
                    "speaker":    s.get("speaker"),
                    "text":       s.get("transcript", s.get("text", "")),
                    "is_final":   True,
                    "confidence": s.get("confidence"),
                    "ts":         s.get("timestamp"),
                }
                for s in finals
            ]
            db.table("transcript_segments").insert(rows).execute()
            log.info("[Persist] %d transcript segments saved", len(rows))

        # ── 4. Insert slide contexts ──────────────────────────────────────────
        if slides:
            slide_rows = [
                {
                    "meeting_id":  sid,
                    "description": s.get("description"),
                    "key_points":  s.get("key_points", []),
                    "slide_type":  s.get("slide_type", "other"),
                    "captured_at": s.get("captured_at", now),
                    # Omit frame_b64 to keep DB size manageable
                }
                for s in slides
            ]
            db.table("slide_contexts").insert(slide_rows).execute()
            log.info("[Persist] %d slides saved", len(slide_rows))

    except Exception as exc:
        log.exception("[Persist] Fatal error: %s", exc)
