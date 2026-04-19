# backend/services/webhook_service.py
"""
Webhook dispatcher — sends the structured debrief to Jira/Notion/custom endpoints.
Supports retry with exponential back-off (max 3 attempts).
"""

import asyncio
import json
import logging
import os

import httpx

log = logging.getLogger("meetintel.webhook")


class WebhookService:
    def __init__(self):
        self._targets = {
            "jira":   os.getenv("JIRA_WEBHOOK_URL",   ""),
            "notion": os.getenv("NOTION_WEBHOOK_URL", ""),
        }

    async def dispatch(self, debrief: dict) -> None:
        """Fire all configured webhooks concurrently."""
        tasks = []
        for name, url in self._targets.items():
            if url:
                tasks.append(self._send(name, url, debrief))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _send(self, name: str, url: str, payload: dict, retries: int = 3) -> None:
        """POST the debrief JSON with exponential back-off."""
        delay = 1.0
        async with httpx.AsyncClient(timeout=15) as client:
            for attempt in range(1, retries + 1):
                try:
                    resp = await client.post(
                        url,
                        json    = payload,
                        headers = {"Content-Type": "application/json"},
                    )
                    resp.raise_for_status()
                    log.info("[Webhook] %s → %d OK", name.upper(), resp.status_code)
                    return
                except httpx.HTTPStatusError as exc:
                    log.warning("[Webhook] %s attempt %d — HTTP %d", name, attempt, exc.response.status_code)
                except Exception as exc:
                    log.warning("[Webhook] %s attempt %d — %s", name, attempt, exc)

                if attempt < retries:
                    await asyncio.sleep(delay)
                    delay *= 2

            log.error("[Webhook] %s failed after %d attempts", name, retries)
