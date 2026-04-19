# backend/services/vision_processor.py
"""
Vision Processor — Perceptual Hash (pHash) slide-change detection.

Algorithm:
  1. Decode the base64 JPEG into a PIL Image.
  2. Compute a perceptual hash (pHash) — 8×8 DCT-based hash.
  3. Compare Hamming distance against the stored previous hash.
  4. If distance > threshold → slide change → call Gemini 1.5 Pro Vision.
  5. Update stored hash.

Threshold (env SLIDE_CHANGE_THRESHOLD):
  - 0.0–1.0 normalised (fraction of 64-bit hash that differs).
  - Default 0.15 = ~10 bits different.
  - Lower → more sensitive (more frequent detections).

Why pHash over dHash?
  pHash uses DCT and is more robust to compression artifacts and
  minor lighting changes — better for screen captures of slides.
"""

import os
import base64
import logging
from io import BytesIO

import imagehash
from PIL import Image

log = logging.getLogger("meetintel.vision_processor")

THRESHOLD = float(os.getenv("SLIDE_CHANGE_THRESHOLD", "0.15"))
HASH_BITS = 64   # 8×8 pHash = 64-bit integer


class VisionProcessor:
    def __init__(self):
        self._last_hash: imagehash.ImageHash | None = None

    def detect_change(self, frame_b64: str) -> tuple[bool, int]:
        """
        Returns (changed: bool, hamming_distance: int).
        Always updates the stored hash when a change is detected.
        """
        try:
            img      = _decode_frame(frame_b64)
            cur_hash = imagehash.phash(img, hash_size=8)  # pHash (perceptual)

            if self._last_hash is None:
                # First frame — always treat as a slide capture
                self._last_hash = cur_hash
                return True, 0

            hamming    = cur_hash - self._last_hash
            normalised = hamming / HASH_BITS
            changed    = normalised > THRESHOLD

            if changed:
                self._last_hash = cur_hash
                log.debug("[Vision] Slide change detected: Hamming=%d (%.1f%%)", hamming, normalised * 100)

            return changed, hamming

        except Exception as exc:
            log.error("[VisionProcessor] Frame decode error: %s", exc)
            return False, 0

    def reset(self):
        """Call at session start to clear the stored hash."""
        self._last_hash = None


def _decode_frame(frame_b64: str) -> Image.Image:
    """Decode base64 JPEG → PIL Image, resize to 256×256 for hashing speed."""
    raw = base64.b64decode(frame_b64)
    img = Image.open(BytesIO(raw)).convert("RGB")
    img = img.resize((256, 256), Image.LANCZOS)
    return img
