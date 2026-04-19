# backend/utils/image_utils.py
"""Image encoding/decoding utilities for the Vision pipeline."""

import base64
from io import BytesIO
from PIL import Image


def encode_image(image: Image.Image, quality: int = 75) -> str:
    """PIL Image → base64 JPEG string."""
    buf = BytesIO()
    image.save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def decode_image(b64_str: str) -> Image.Image:
    """base64 JPEG string → PIL Image."""
    raw = base64.b64decode(b64_str)
    return Image.open(BytesIO(raw)).convert("RGB")


def resize_for_vision(image: Image.Image, max_dim: int = 1024) -> Image.Image:
    """
    Resize image so the longest edge is at most max_dim.
    GPT-4o Vision 'low' detail mode only needs 512px; 'high' benefits from 1024px.
    """
    w, h = image.size
    if max(w, h) <= max_dim:
        return image
    scale = max_dim / max(w, h)
    return image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
