# backend/engine.py
"""
MeetIntel Engine — Deepgram STT + Google Gemini Brain
======================================================
All AI integrations in one file.  OpenAI has been completely removed.

| Engine        | Provider            | Model                         |
|---------------|---------------------|-------------------------------|
| DeepgramEngine| Deepgram SDK v3     | nova-2 (streaming STT)        |
| ActionEngine  | Google Gemini       | gemini-1.5-flash  (live/fast) |
| VisionEngine  | pHash + Gemini Pro  | gemini-1.5-pro  (multimodal)  |
| DebtEngine    | Gemini Embeddings   | text-embedding-004 (768-dim)  |
| DebriefEngine | Google Gemini       | gemini-1.5-pro  (final/qual.) |
"""

import os
import re
import json
import uuid
import base64
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

# ── Central config singleton ────────────────────────────────────────────────────
from config import cfg   # ALL env vars come from here — never call os.environ directly


log = logging.getLogger("meetintel.engine")


# ══════════════════════════════════════════════════════════════════════════════
# SHARED: Gemini client factory — lazy, cached per model name
# ══════════════════════════════════════════════════════════════════════════════
_gemini_models: dict = {}


def _get_gemini(model_name: str):
    """Return a cached genai.GenerativeModel for the given model name."""
    if model_name not in _gemini_models:
        from services import gemini_client as genai
        if not cfg.has_gemini:
            raise RuntimeError(
                "GOOGLE_API_KEY is not set. "
                "Get one at https://aistudio.google.com/app/apikey"
            )
        genai.configure(api_key=cfg.GOOGLE_API_KEY)
        _gemini_models[model_name] = genai.GenerativeModel(model_name)
    return _gemini_models[model_name]


def _parse_json_from_gemini(text: str) -> dict | list:
    """
    Gemini sometimes wraps JSON in markdown fences.
    Strip them and parse robustly.
    """
    # Strip ```json ... ``` or ``` ... ```
    text = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    return json.loads(text)


# ══════════════════════════════════════════════════════════════════════════════
# DEEPGRAM ENGINE  (unchanged — Deepgram is still our STT)
# ══════════════════════════════════════════════════════════════════════════════
class DeepgramEngine:
    """
    Async context manager wrapping Deepgram SDK v3 streaming (pinned to <4.0.0).
    Usage:
        async with engine.connect() as session:
            await session.send(pcm_bytes)
    """

    def __init__(self, on_transcript):
        self._on_transcript = on_transcript
        self._api_key = cfg.DEEPGRAM_API_KEY  # sourced from config.cfg, not os.environ

    @asynccontextmanager
    async def connect(self):
        from deepgram import (
            DeepgramClient,
            DeepgramClientOptions,
            LiveTranscriptionEvents,
            LiveOptions,
        )

        config = DeepgramClientOptions(options={"keepalive": "true"})
        client = DeepgramClient(self._api_key, config)
        conn   = client.listen.asyncwebsocket.v("1")

        async def _on_message(_self, result, **kwargs):
            try:
                alt = result.channel.alternatives[0]
                if not alt.transcript:
                    return
                speaker = None
                if hasattr(alt, "words") and alt.words:
                    spk_id  = getattr(alt.words[0], "speaker", None)
                    speaker = f"Speaker {spk_id + 1}" if spk_id is not None else None

                await self._on_transcript({
                    "transcript": alt.transcript,
                    "is_final":   result.is_final,
                    "speaker":    speaker,
                    "confidence": alt.confidence,
                    "timestamp":  result.start,
                })
            except Exception as exc:
                log.error("[Deepgram] Parse error: %s", exc)

        async def _on_error(_self, error, **kwargs):
            log.error("[Deepgram] Streaming error (non-fatal): %s", error)

        conn.on(LiveTranscriptionEvents.Transcript, _on_message)
        conn.on(LiveTranscriptionEvents.Error,      _on_error)

        options = LiveOptions(
            model            = cfg.DEEPGRAM_MODEL,
            language         = cfg.DEEPGRAM_LANGUAGE,
            encoding         = "linear16",
            channels         = 1,
            sample_rate      = cfg.DEEPGRAM_SAMPLE_RATE,
            punctuate        = True,
            interim_results  = True,
            diarize          = True,
            smart_format     = True,
            utterance_end_ms = "1000",
            vad_events       = True,
        )

        ok = await conn.start(options)
        if not ok:
            raise RuntimeError("Deepgram refused the connection — check your API key and network.")

        log.info("[Deepgram] Streaming session started — Nova-2 diarization active")

        class _Session:
            async def send(self, data: bytes):
                await conn.send(data)
            async def finish(self):
                await conn.finish()

        session = _Session()
        try:
            yield session
        finally:
            await conn.finish()


# ══════════════════════════════════════════════════════════════════════════════
# ACTION ENGINE  —  Gemini 1.5 Flash (60-second sliding window)
# ══════════════════════════════════════════════════════════════════════════════
_ACTION_PROMPT = """You are a senior Project Manager AI. Your job is to extract ONLY explicit task assignments from the meeting transcript.

Context:
- Admin/Manager: {admin}
- Meeting Participants: {participants}

Rules:
1. ONLY extract a task if someone is EXPLICITLY assigned to do something (e.g. "{admin}: Parth, please update the database schema").
2. The "assignee" MUST be one of the known participants above. Match by first name if needed.
3. If the admin says "I will do X", the assignee is "{admin}".
4. The "title" must be a clear, imperative action (e.g. "Update database schema").
5. Set "priority": "high" for words like urgent/critical/ASAP/today, "medium" for "soon/this week", "low" for everything else.
6. The "context" is the exact quote from the transcript that contains the assignment.
7. If no explicit assignment exists in this window, return an EMPTY array [].
8. Return ONLY a valid JSON array — no explanation, no markdown fences.

Format:
[
  {{
    "id": "<uuid>",
    "title": "Imperative task description",
    "assignee": "Full name of assigned person",
    "priority": "high|medium|low",
    "context": "Exact quote from transcript"
  }}
]

Transcript (Speaker-labeled):
{transcript}"""


class ActionEngine:
    """
    Sliding-window action-item extraction using Gemini 1.5 Flash.
    Participant-aware: uses known names to improve attribution accuracy.
    """

    def __init__(self):
        self._seen: set[str] = set()

    async def detect(
        self,
        window:       list[str],
        identities:   dict = {},
        participants: list[str] = [],
        admin:        str = "Admin",
    ) -> list[dict]:
        if not window:
            return []

        text = "\n".join(f"- {s}" for s in window)

        # Build participant context — prefer known identities, fall back to participants list
        known_names = list(identities.values()) if identities else participants
        participants_str = ", ".join(known_names) if known_names else "Unknown"

        model  = _get_gemini(cfg.GEMINI_TEXT_MODEL)
        prompt = _ACTION_PROMPT.format(
            transcript   = text,
            admin        = admin,
            participants = participants_str,
        )

        import asyncio
        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                prompt,
                generation_config={
                    "temperature":     0.1,
                    "max_output_tokens": 800,
                },
            ),
        )

        try:
            raw   = _parse_json_from_gemini(response.text)
            items = raw if isinstance(raw, list) else raw.get("action_items", raw.get("items", []))
        except Exception as exc:
            log.error("[ActionEngine] JSON parse error: %s | raw: %.200s", exc, response.text)
            return []

        new_items = []
        for item in items:
            if not item.get("id"):
                item["id"] = str(uuid.uuid4())
            key = item.get("title", "").lower()[:60]
            if key not in self._seen:
                self._seen.add(key)
                item["isNew"] = True
                new_items.append(item)

        log.info("[ActionEngine] Detected %d new action items from %d segments", len(new_items), len(window))
        return new_items


# ══════════════════════════════════════════════════════════════════════════════
# VISION ENGINE  —  pHash + Gemini 1.5 Pro Vision
# ══════════════════════════════════════════════════════════════════════════════
_VISION_PROMPT = """Analyze this meeting slide and link it to the current transcript context. What is the key takeaway?

Respond ONLY with valid JSON:
{
  "slide_changed": true,
  "description": "One concise sentence describing what is shown (max 25 words)",
  "key_points": ["point 1", "point 2", "point 3"],
  "slide_type": "presentation|whiteboard|code|dashboard|document|other",
  "takeaway": "The single most important insight from this slide in context"
}"""


class VisionEngine:
    """
    Perceptual hash gating (pHash) → Gemini 1.5 Pro Vision analysis.
    Only calls Gemini when a genuine slide change is detected.
    """

    def __init__(self):
        self._last_hash = None

    def _changed(self, frame_b64: str) -> tuple[bool, int]:
        """Returns (changed, hamming_distance)."""
        try:
            import imagehash
            from PIL import Image
            from io import BytesIO

            raw  = base64.b64decode(frame_b64)
            img  = Image.open(BytesIO(raw)).convert("RGB").resize((256, 256))
            h    = imagehash.phash(img)          # pHash (perceptual) per spec
            if self._last_hash is None:
                self._last_hash = h
                return True, 0
            dist = h - self._last_hash
            threshold = cfg.SLIDE_CHANGE_THRESHOLD  # sourced from config.cfg
            if dist / 64 > threshold:
                self._last_hash = h
                return True, int(dist)
            return False, int(dist)
        except Exception as exc:
            log.error("[Vision] pHash error: %s", exc)
            return True, 0

    async def analyze(self, frame_b64: str, session_id: str | None = None) -> dict:
        changed, dist = self._changed(frame_b64)
        if not changed:
            return {"slide_changed": False, "hamming_dist": dist}

        import asyncio
        from services import gemini_client as genai

        if not cfg.has_gemini:
            raise RuntimeError("GOOGLE_API_KEY is not set.")
        genai.configure(api_key=cfg.GOOGLE_API_KEY)

        vision_model_name = cfg.GEMINI_VISION_MODEL
        model = genai.GenerativeModel(vision_model_name)

        # Decode and package the image for the Gemini multimodal API
        image_bytes = base64.b64decode(frame_b64)
        image_part  = {"mime_type": "image/jpeg", "data": image_bytes}

        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                [image_part, _VISION_PROMPT],
                generation_config={
                    "temperature":     0.2,
                    "max_output_tokens": 400,
                },
            ),
        )

        try:
            result = _parse_json_from_gemini(response.text)
        except Exception as exc:
            log.error("[VisionEngine] JSON parse error: %s", exc)
            result = {"description": response.text, "key_points": [], "takeaway": ""}

        log.info("[VisionEngine] Slide change detected (hamming=%d) via %s", dist, vision_model_name)

        return {
            "slide_changed": True,
            "id":            str(uuid.uuid4()),
            "hamming_dist":  dist,
            "description":   result.get("description", ""),
            "key_points":    result.get("key_points", []),
            "slide_type":    result.get("slide_type", "other"),
            "takeaway":      result.get("takeaway", ""),
            "captured_at":   datetime.now(timezone.utc).isoformat(),
            "frame":         frame_b64,
        }


# ══════════════════════════════════════════════════════════════════════════════
# DEBT ENGINE  —  RAG with text-embedding-004 (Gemini) + Supabase pgvector
# ══════════════════════════════════════════════════════════════════════════════
SIMILARITY_THRESH = cfg.DEBT_SIMILARITY_THRESHOLD  # sourced from config.cfg


class DebtEngine:
    """
    Meeting Debt RAG pipeline.
    Embeds text with Google text-embedding-004 (768-dim),
    stores / queries via Supabase pgvector.
    """

    def __init__(self):
        self._supa = None

    def _supabase(self):
        if self._supa is None:
            from supabase import create_client
            self._supa = create_client(
                cfg.SUPABASE_URL,
                cfg.SUPABASE_SERVICE_KEY,
            )
        return self._supa

    async def embed(self, text: str) -> list[float]:
        """
        Generate a 768-dim embedding using Google text-embedding-004.
        Uses the low-level genai.embed_content call (not GenerativeModel).
        """
        import asyncio
        from services import gemini_client as genai

        api_key = cfg.GOOGLE_API_KEY or ""
        genai.configure(api_key=api_key)

        model_name = cfg.GEMINI_EMBED_MODEL  # models/text-embedding-004 (768-dim)
        truncated  = text.strip()[:8000]

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: genai.embed_content(
                model   = model_name,
                content = truncated,
                task_type = "RETRIEVAL_DOCUMENT",
            ),
        )
        return result["embedding"]

    async def embed_query(self, text: str) -> list[float]:
        """Embed a query (uses RETRIEVAL_QUERY task type for better retrieval accuracy)."""
        import asyncio
        from services import gemini_client as genai

        api_key = cfg.GOOGLE_API_KEY or ""
        genai.configure(api_key=api_key)

        model_name = cfg.GEMINI_EMBED_MODEL
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: genai.embed_content(
                model     = model_name,
                content   = text.strip()[:8000],
                task_type = "RETRIEVAL_QUERY",
            ),
        )
        return result["embedding"]

    async def index_action_item(self, item: dict, meeting_id: str) -> None:
        try:
            text      = f"{item.get('title','')} {item.get('context','')}".strip()
            embedding = await self.embed(text)
            self._supabase().table("action_items").update(
                {"embedding": embedding}
            ).eq("id", item["id"]).execute()
        except Exception as exc:
            log.error("[Debt] Index error: %s", exc)

    async def query(self, context: str, exclude_meeting_id: str | None = None) -> list[dict]:
        try:
            qe = await self.embed_query(context)
            db = self._supabase()

            q = db.table("meetings").select("id, title, started_at") \
                  .eq("status", "ended").order("started_at", desc=True) \
                  .limit(cfg.DEBT_MEETING_WINDOW)  # sourced from config.cfg
            if exclude_meeting_id:
                q = q.neq("id", exclude_meeting_id)
            meetings = q.execute().data or []
            if not meetings:
                return []

            ids  = [m["id"] for m in meetings]
            mmap = {m["id"]: m for m in meetings}

            rows = db.rpc("match_action_items", {
                "query_embedding":  qe,
                "meeting_ids":      ids,
                "match_status":     "unresolved",
                "match_threshold":  SIMILARITY_THRESH,
                "match_count":      5,
            }).execute().data or []

            result = []
            for r in rows:
                m    = mmap.get(r.get("meeting_id"), {})
                days = None
                if m.get("started_at"):
                    dt   = datetime.fromisoformat(m["started_at"])
                    days = (datetime.now(timezone.utc) - dt).days
                result.append({
                    **r,
                    "meeting_title": m.get("title", "Previous Meeting"),
                    "days_ago":      days,
                })
            log.info("[Debt] Query returned %d items", len(result))
            return result
        except Exception as exc:
            log.exception("[Debt] Query error: %s", exc)
            return []


# ══════════════════════════════════════════════════════════════════════════════
# DEBRIEF ENGINE  —  Gemini 1.5 Flash
# ══════════════════════════════════════════════════════════════════════════════
_DEBRIEF_PROMPT = """You are a world-class Executive Assistant. Based on the transcript and action items below, generate a professional Meeting Summary Report.

Your report MUST be structured with the following keys:
{{
  "summary": "A 3-4 sentence high-level executive summary of the meeting's purpose and outcome.",
  "key_decisions": ["List of formal decisions made"],
  "risks": ["Identification of any blockers or missed deadlines mentioned"],
  "next_steps": ["Concise, prioritized list of what happens next"],
  "notes": "A detailed, bulleted breakdown of the meeting discussion in chronological order."
}}

Respond ONLY with valid JSON.

Full transcript:
{transcript}

Action items detected ({item_count}):
{items_text}
"""


class DebriefEngine:
    async def generate(self, session: dict, segments: list, items: list) -> dict:
        transcript = " ".join(
            s.get("transcript", s.get("text", "")) for s in segments
        )
        items_text = "\n".join(
            f"- [{i.get('priority','?').upper()}] {i.get('title','')} → {i.get('assignee','?')}"
            for i in items
        ) or "None"

        prompt = _DEBRIEF_PROMPT.format(
            transcript = transcript[:12000],
            item_count = len(items),
            items_text = items_text,
        )

        import asyncio
        # Debrief uses Gemini 1.5 PRO — quality over latency for the final synthesis
        model    = _get_gemini(cfg.GEMINI_DEBRIEF_MODEL)  # sourced from config.cfg
        loop     = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                prompt,
                generation_config={
                    "temperature":     0.3,
                    "max_output_tokens": 1200,
                },
            ),
        )

        try:
            structured = _parse_json_from_gemini(response.text)
        except Exception as exc:
            log.error("[DebriefEngine] JSON parse error: %s", exc)
            structured = {"summary": response.text}

        return {
            "version":             "1.0",
            "session":             session,
            "transcript_segments": len(segments),
            "word_count":          len(transcript.split()),
            "action_items":        items,
            **structured,
        }
