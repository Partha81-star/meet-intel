"""Small adapter over the supported Google Gen AI SDK for existing engines."""
from functools import lru_cache
from google import genai
from google.genai import types
from config import cfg


@lru_cache(maxsize=1)
def client():
    if not cfg.has_gemini:
        raise RuntimeError("GOOGLE_API_KEY is not configured")
    return genai.Client(api_key=cfg.GOOGLE_API_KEY,
                        http_options=types.HttpOptions(timeout=60000))


class GenerativeModel:
    def __init__(self, model):
        self.model = model

    def generate_content(self, contents, generation_config=None):
        if isinstance(contents, list):
            contents = [types.Part.from_bytes(data=p["data"], mime_type=p["mime_type"])
                        if isinstance(p, dict) and "data" in p else p for p in contents]
        return client().models.generate_content(
            model=self.model, contents=contents,
            config=types.GenerateContentConfig(**(generation_config or {})),
        )


def embed_content(model, content, task_type="RETRIEVAL_DOCUMENT"):
    result = client().models.embed_content(
        model=model, contents=content,
        config=types.EmbedContentConfig(task_type=task_type, output_dimensionality=768),
    )
    return {"embedding": result.embeddings[0].values}


def configure(**kwargs):
    # Configuration is read exclusively from cfg by client().
    pass
