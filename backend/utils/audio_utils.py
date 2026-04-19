# backend/utils/audio_utils.py
"""Audio format conversion helpers."""

import struct
import wave
import io


def pcm_to_wav(pcm_data: bytes, sample_rate: int = 16000, channels: int = 1) -> bytes:
    """
    Convert raw Int16 PCM bytes to an in-memory WAV file.
    Useful for re-processing or debugging captured audio.
    """
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)          # 16-bit = 2 bytes per sample
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def resample_pcm(pcm_data: bytes, from_rate: int, to_rate: int) -> bytes:
    """
    Naive integer resampling. For production use scipy.signal.resample.
    Sufficient for 48 kHz → 16 kHz (factor of 3).
    """
    if from_rate == to_rate:
        return pcm_data

    factor     = from_rate // to_rate
    samples    = len(pcm_data) // 2   # Int16 = 2 bytes
    shorts     = struct.unpack(f"{samples}h", pcm_data)
    resampled  = shorts[::factor]
    return struct.pack(f"{len(resampled)}h", *resampled)
