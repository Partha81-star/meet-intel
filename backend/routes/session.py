# backend/routes/session.py
"""Session lifecycle routes — start, stop, pause."""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from models.database import db

log    = logging.getLogger("meetintel.session")
router = APIRouter(prefix="/session", tags=["session"])

# In-memory active session store (single-user desktop app)
_active_session: dict | None = None


class SessionMeta(BaseModel):
    title:       str | None = None
    participants: list[str] = []


@router.post("/start")
async def start_session(meta: SessionMeta = SessionMeta()):
    global _active_session

    session_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()

    _active_session = {
        "session_id":   session_id,
        "started_at":   started_at,
        "title":        meta.title or f"Meeting {started_at[:10]}",
        "participants": meta.participants,
        "status":       "active",
    }

    log.info("[Session] Started: %s", session_id)
    return _active_session


@router.post("/stop")
async def stop_session():
    global _active_session

    if not _active_session:
        return {"error": "No active session"}

    _active_session["status"]   = "ended"
    _active_session["ended_at"] = datetime.now(timezone.utc).isoformat()

    log.info("[Session] Stopped: %s", _active_session["session_id"])
    result = _active_session
    _active_session = None
    return result


@router.post("/pause")
async def pause_session():
    global _active_session

    if not _active_session:
        return {"error": "No active session"}

    toggled        = "paused" if _active_session["status"] == "active" else "active"
    _active_session["status"] = toggled

    log.info("[Session] Status toggled to: %s", toggled)
    return _active_session


@router.get("/current")
async def current_session():
    return _active_session or {"status": "idle"}
