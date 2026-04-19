# backend/models/schemas.py
"""Pydantic v2 schemas for all domain objects."""

from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
import uuid


def new_id() -> str:
    return str(uuid.uuid4())


# ─── Transcript ────────────────────────────────────────────────────────────────
class TranscriptSegment(BaseModel):
    id:         str      = Field(default_factory=new_id)
    meeting_id: str
    text:       str
    speaker:    Optional[str] = None
    timestamp:  float
    confidence: float    = 0.0


# ─── Action Items ──────────────────────────────────────────────────────────────
class ActionItem(BaseModel):
    id:          str      = Field(default_factory=new_id)
    meeting_id:  str
    title:       str
    assignee:    Optional[str] = None
    due:         Optional[str] = None
    priority:    str      = "medium"   # high | medium | low
    context:     Optional[str] = None  # verbatim quote
    status:      str      = "unresolved"  # unresolved | partial | resolved
    # Stored separately in DB — not returned to renderer
    embedding:   Optional[list[float]] = Field(None, exclude=True)


# ─── Slides / Visual Context ───────────────────────────────────────────────────
class SlideContext(BaseModel):
    id:          str                = Field(default_factory=new_id)
    meeting_id:  Optional[str]      = None
    session_id:  Optional[str]      = None
    frame:       str                                    # base64 JPEG
    description: str                = ""
    key_points:  list[str]          = Field(default_factory=list)
    slide_type:  str                = "other"
    captured_at: Optional[datetime] = None
    hamming_dist: int               = 0


# ─── Meeting / Session ────────────────────────────────────────────────────────
class Meeting(BaseModel):
    id:           str               = Field(default_factory=new_id)
    session_id:   str
    title:        str               = "Untitled Meeting"
    participants: list[str]         = Field(default_factory=list)
    started_at:   Optional[str]     = None
    ended_at:     Optional[str]     = None
    status:       str               = "active"  # active | ended


# ─── Debrief ──────────────────────────────────────────────────────────────────
class Debrief(BaseModel):
    version:     str = "1.0"
    session:     dict
    summary:     str
    key_decisions: list[str]
    risks:       list[str]
    next_steps:  list[str]
    action_items: list[dict]
    slide_captures: int
    transcript_segments: int
    word_count:  int


# ─── Debt Log ──────────────────────────────────────────────────────────────────
class DebtItem(BaseModel):
    id:               str
    title:            str
    context:          Optional[str] = None
    assignee:         Optional[str] = None
    status:           str           = "unresolved"
    priority:         str           = "medium"
    similarity:       float         = 0.0
    meeting_id:       Optional[str] = None
    meeting_title:    Optional[str] = None
    days_ago:         Optional[int] = None
    responsible_party: Optional[str] = None
