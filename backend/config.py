# backend/config.py
"""
MeetIntel — Centralised Configuration & Startup Validation
===========================================================
Responsibilities
----------------
1. Load every env-var from .env via Pydantic BaseSettings (type-safe, validated).
2. Expose a single `cfg` singleton — all modules import from here, never from os.environ.
3. Print a clear "✅ / ❌" connection status for every service at FastAPI startup.

Import pattern (use everywhere in the backend):
    from config import cfg

    if cfg.has_deepgram:
        key = cfg.DEEPGRAM_API_KEY   # guaranteed non-empty str
"""

from __future__ import annotations

import sys
from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# ══════════════════════════════════════════════════════════════════════════════
# Settings model
# ══════════════════════════════════════════════════════════════════════════════
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file          = ".env",
        env_file_encoding = "utf-8",
        case_sensitive    = False,   # GOOGLE_API_KEY == google_api_key
        extra             = "ignore",
    )

    # ── Core API Keys ─────────────────────────────────────────────────────────
    # .env: GOOGLE_API_KEY
    # Used in: engine.py → _get_gemini(), VisionEngine, DebtEngine, DebriefEngine
    GOOGLE_API_KEY: Optional[str] = Field(
        None,
        description="Google AI Studio API key — drives ALL Gemini models (Flash, Pro, Embeddings)"
    )

    # .env: DEEPGRAM_API_KEY
    # Used in: engine.py → DeepgramEngine.__init__() and DeepgramEngine.connect()
    DEEPGRAM_API_KEY: Optional[str] = Field(
        None,
        description="Deepgram API key — authenticates the real-time Nova-2 STT WebSocket"
    )

    # .env: SUPABASE_URL
    # Used in: engine.py → DebtEngine._supabase() and services/persistence.py
    SUPABASE_URL: Optional[str] = Field(
        None,
        description="Supabase project REST URL (https://<id>.supabase.co)"
    )

    # .env: SUPABASE_SERVICE_KEY
    # Used in: engine.py → DebtEngine._supabase() — service_role bypasses RLS
    SUPABASE_SERVICE_KEY: Optional[str] = Field(
        None,
        description="Supabase service_role secret — grants full DB access for the backend"
    )

    # ── Webhooks ──────────────────────────────────────────────────────────────
    # .env: ZAPIER_WEBHOOK_URL
    # Used in: main.py → _post_meeting_cleanup() — fired after every session/stop
    ZAPIER_WEBHOOK_URL: Optional[str] = None

    # .env: N8N_WEBHOOK_URL / JIRA_WEBHOOK_URL / NOTION_WEBHOOK_URL
    # Used in: config.py → active_webhooks property (aggregates all webhook URLs)
    N8N_WEBHOOK_URL:    Optional[str] = None
    JIRA_WEBHOOK_URL:   Optional[str] = None
    NOTION_WEBHOOK_URL: Optional[str] = None

    # ── Server ────────────────────────────────────────────────────────────────
    # Used in: main.py → CORSMiddleware (cors_origins_list) + uvicorn binding
    BACKEND_HOST: str = "127.0.0.1"
    BACKEND_PORT: int = 8000
    APP_ENV:      str = "development"
    CORS_ORIGINS: str = "http://localhost:3000,app://.,file://"

    # ── Deepgram Model Config ─────────────────────────────────────────────────
    # Used in: engine.py → DeepgramEngine.connect() → LiveOptions
    DEEPGRAM_MODEL:       str = "nova-2"
    DEEPGRAM_LANGUAGE:    str = "en-US"
    DEEPGRAM_SAMPLE_RATE: int = 16000

    # ── Gemini Model Config ───────────────────────────────────────────────────
    # GEMINI_TEXT_MODEL    → engine.py ActionEngine.detect()      (Flash: low latency live tasks)
    # GEMINI_DEBRIEF_MODEL → engine.py DebriefEngine.generate()   (Pro:   quality post-meeting)
    # GEMINI_VISION_MODEL  → engine.py VisionEngine.analyze()     (Pro:   multimodal slide analysis)
    # GEMINI_EMBED_MODEL   → engine.py DebtEngine.embed/embed_query() (text-embedding-004 RAG)
    GEMINI_TEXT_MODEL:    str = "gemini-1.5-flash"
    GEMINI_DEBRIEF_MODEL: str = "gemini-1.5-pro"
    GEMINI_VISION_MODEL:  str = "gemini-1.5-pro"
    GEMINI_EMBED_MODEL:   str = "models/text-embedding-004"

    # ── Vision / AI Tuning ────────────────────────────────────────────────────
    # SLIDE_CHANGE_THRESHOLD   → engine.py VisionEngine._changed()  (pHash gate)
    # DEBT_SIMILARITY_THRESHOLD→ engine.py DebtEngine.query()       (pgvector cosine floor)
    # DEBT_MEETING_WINDOW      → engine.py DebtEngine.query()       (past-meeting scan limit)
    # ACTION_WINDOW_SIZE       → main.py   on_transcript callback   (sliding window cap)
    # ACTION_TRIGGER_INTERVAL  → main.py   on_transcript callback   (segment-count throttle)
    SLIDE_CHANGE_THRESHOLD:    float = 0.15
    DEBT_SIMILARITY_THRESHOLD: float = 0.78
    DEBT_MEETING_WINDOW:       int   = 3
    ACTION_WINDOW_SIZE:        int   = 20
    ACTION_TRIGGER_INTERVAL:   int   = 3

    # ── Computed helpers ──────────────────────────────────────────────────────
    @property
    def cors_origins_list(self) -> list[str]:
        """Parse the comma-separated CORS_ORIGINS string into a Python list."""
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def active_webhooks(self) -> list[str]:
        """Return a list of every non-empty webhook URL that is configured."""
        candidates = [
            self.ZAPIER_WEBHOOK_URL,
            self.N8N_WEBHOOK_URL,
            self.JIRA_WEBHOOK_URL,
            self.NOTION_WEBHOOK_URL,
        ]
        return [u for u in candidates if u]

    @property
    def is_dev(self) -> bool:
        return self.APP_ENV.lower() == "development"

    # ── Availability flags (use these as guards, never bare key checks) ────────
    @property
    def has_gemini(self) -> bool:
        """True when GOOGLE_API_KEY is present — gates /vision, /debt, /debrief endpoints."""
        return bool(self.GOOGLE_API_KEY and self.GOOGLE_API_KEY.strip())

    @property
    def has_deepgram(self) -> bool:
        """True when DEEPGRAM_API_KEY is present — gates live STT vs mock mode."""
        return bool(self.DEEPGRAM_API_KEY and self.DEEPGRAM_API_KEY.strip())

    @property
    def has_supabase(self) -> bool:
        """True when both SUPABASE_URL and SUPABASE_SERVICE_KEY are present."""
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_KEY)

    @property
    def has_zapier(self) -> bool:
        """True when ZAPIER_WEBHOOK_URL is set — gates post_meeting_cleanup payloads."""
        return bool(self.ZAPIER_WEBHOOK_URL and self.ZAPIER_WEBHOOK_URL.strip())

    @property
    def has_webhooks(self) -> bool:
        """True if ANY webhook (Zapier / n8n / Jira / Notion) is configured."""
        return bool(self.active_webhooks)

    # ── Startup validation ────────────────────────────────────────────────────
    def print_startup_status(self) -> None:
        """
        Print a ✅/❌ connection status for every service.
        Called from main.py lifespan() so it runs exactly once on server start.

        Output example:
            ════════════════════════════════════════
             MeetIntel — Service Connection Status
            ════════════════════════════════════════
            ✅ Gemini Connected      (gemini-1.5-flash / pro / text-embedding-004)
            ✅ Deepgram Connected    (nova-2 · en-US · 16000 Hz)
            ❌ Supabase NOT configured  →  debt RAG disabled, falling back to in-memory
            ✅ Zapier Connected      (1 webhook active)
            ════════════════════════════════════════
        """
        WIDTH = 52
        divider = "═" * WIDTH

        lines: list[str] = [
            "",
            divider,
            " MeetIntel — Service Connection Status",
            divider,
        ]

        # ── Gemini ──
        if self.has_gemini:
            lines.append(
                f"✅ Gemini Connected      "
                f"({self.GEMINI_TEXT_MODEL} / {self.GEMINI_DEBRIEF_MODEL} / {self.GEMINI_EMBED_MODEL})"
            )
        else:
            lines.append(
                "❌ Gemini NOT configured  "
                "→  vision, debrief & debt RAG disabled  (set GOOGLE_API_KEY)"
            )

        # ── Deepgram ──
        if self.has_deepgram:
            lines.append(
                f"✅ Deepgram Connected    "
                f"({self.DEEPGRAM_MODEL} · {self.DEEPGRAM_LANGUAGE} · {self.DEEPGRAM_SAMPLE_RATE} Hz)"
            )
        else:
            lines.append(
                "❌ Deepgram NOT configured  "
                "→  running in mock transcript mode  (set DEEPGRAM_API_KEY)"
            )

        # ── Supabase ──
        if self.has_supabase:
            lines.append(
                f"✅ Supabase Connected    "
                f"({self.SUPABASE_URL})"
            )
        else:
            lines.append(
                "❌ Supabase NOT configured  "
                "→  debt RAG disabled, falling back to in-memory  (set SUPABASE_URL + SUPABASE_SERVICE_KEY)"
            )

        # ── Zapier / Webhooks ──
        n = len(self.active_webhooks)
        if n > 0:
            lines.append(
                f"✅ Zapier Connected      ({n} webhook{'s' if n > 1 else ''} active)"
            )
        else:
            lines.append(
                "❌ Zapier NOT configured  "
                "→  post-meeting cleanup disabled  (set ZAPIER_WEBHOOK_URL)"
            )

        lines += [divider, ""]

        # Print to stdout (visible in the terminal immediately on startup).
        # Force UTF-8 on Windows so ✅/❌ render correctly in PowerShell / CMD.
        import io
        utf8_stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        utf8_stdout.write("\n".join(lines) + "\n")
        utf8_stdout.flush()

        # Also warn and exit early if critical keys are missing in production
        if self.APP_ENV.lower() == "production":
            missing = []
            if not self.has_gemini:
                missing.append("GOOGLE_API_KEY")
            if not self.has_deepgram:
                missing.append("DEEPGRAM_API_KEY")
            if missing:
                print(
                    f"[FATAL] Production mode requires: {', '.join(missing)}\n"
                    "        Set the missing keys in .env and restart.",
                    file=sys.stderr,
                    flush=True,
                )
                sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# Singleton accessor  (lru_cache ensures .env is parsed exactly once)
# ══════════════════════════════════════════════════════════════════════════════
@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# Module-level alias — `from config import cfg` is the canonical import everywhere
cfg = get_settings()
