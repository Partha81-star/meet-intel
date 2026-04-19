"""
MeetIntel Smoke Test — Gemini Edition
======================================
Validates all backend endpoints are responding correctly.
Run from the backend/ directory with the server already started:

  cd backend
  python smoke_test.py

Expected output (mock mode, no API keys needed):
  HEALTH   : ok | gemini=False deepgram=False
  SESSION  : <uuid> | status=active
  DEBT     : mode=mock | items=2
  VISION   : slide_changed=True | takeaway=Q3 delivery is gated...
  STOP     : ended
  DEBRIEF  : mode=mock | summary=The team aligned...
  ALL ENDPOINTS OK ✓
"""

import json
import urllib.request as u

BASE = "http://127.0.0.1:8000"


def get(path):
    return json.loads(u.urlopen(BASE + path).read())


def post(path, body=b"{}"):
    req = u.Request(
        BASE + path, data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    return json.loads(u.urlopen(req).read())


# ── 1. Health ─────────────────────────────────────────────────────────────────
health = get("/health")
keys   = health.get("keys", {})
models = health.get("models", {})
print(f"HEALTH   : {health['status']} | gemini={keys.get('gemini')} deepgram={keys.get('deepgram')}")
print(f"  models : text={models.get('text')} | vision={models.get('vision')} | embed={models.get('embed')}")

# ── 2. Session start ──────────────────────────────────────────────────────────
session = post("/session/start", b'{"title":"Gemini Smoke Test"}')
print(f"SESSION  : {session['id'][:12]}… | status={session['status']}")

# ── 3. Debt query ─────────────────────────────────────────────────────────────
debt = post("/debt/query", b'{"trigger":"manual"}')
print(f"DEBT     : mode={debt['mode']} | items={len(debt['items'])}")

# ── 4. Vision analyze (tiny valid JPEG) ───────────────────────────────────────
import base64
tiny_jpg = base64.b64encode(
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
).decode()
vis = post("/vision/analyze", json.dumps({"frame": tiny_jpg}).encode())
print(f"VISION   : slide_changed={vis['slide_changed']} | takeaway={str(vis.get('takeaway',''))[:50]}")

# ── 5. Session stop ───────────────────────────────────────────────────────────
stop = post("/session/stop")
print(f"STOP     : {stop.get('status', stop)}")

# ── 6. Debrief generate ───────────────────────────────────────────────────────
deb = post("/debrief/generate")
mode    = deb.get("mode", "live")
summary = deb.get("summary", "")[:70] + ("…" if len(deb.get("summary", "")) > 70 else "")
print(f"DEBRIEF  : mode={mode} | summary={summary}")

print("\nALL ENDPOINTS OK [PASS]")
