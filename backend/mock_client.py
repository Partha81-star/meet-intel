# backend/mock_client.py
"""
Mock WebSocket client — tests the backend WITHOUT Electron.
Run this while uvicorn is running to see live events in your terminal.

Usage:
    venv\Scripts\python  mock_client.py
"""

import asyncio
import json
import os
import struct
import random
import websockets


WS_URL = os.getenv("WS_URL", "ws://127.0.0.1:8000/ws/transcribe")


def _fake_pcm_chunk(samples: int = 4096) -> bytes:
    """Generate random Int16 PCM data (simulates microphone noise)."""
    return struct.pack(f"{samples}h", *[random.randint(-1000, 1000) for _ in range(samples)])


async def main():
    print(f"\n🔌  Connecting to {WS_URL} …\n")

    async with websockets.connect(WS_URL) as ws:
        print("✅  Connected! Sending mock audio @ 16 kHz…")
        print("    Events will appear below (Ctrl+C to stop)\n")
        print("─" * 60)

        # Send audio chunks in the background
        async def send_audio():
            while True:
                chunk = _fake_pcm_chunk()
                await ws.send(chunk)
                await asyncio.sleep(0.128)   # ~128ms chunks → 16 kHz

        send_task = asyncio.create_task(send_audio())

        # Receive and print events
        try:
            async for raw_msg in ws:
                if isinstance(raw_msg, bytes):
                    continue   # skip any binary echoes
                try:
                    msg = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue

                t = msg.get("type", "?")

                if t == "transcript":
                    status  = "FINAL  " if msg.get("is_final") else "interim"
                    speaker = msg.get("speaker") or "?"
                    print(f"[{status}] {speaker:10s} | {msg.get('transcript','')}")

                elif t == "action_item":
                    print(f"\n🎯  ACTION  [{msg.get('priority','?').upper()}] {msg.get('title','')}")
                    if msg.get("assignee"):
                        print(f"           → {msg['assignee']}")
                    if msg.get("due"):
                        print(f"           ⏰ {msg['due']}")
                    print()

                elif t == "debt_item":
                    print(f"\n⚠️   DEBT   {msg.get('title','')}")
                    print(f"           From: {msg.get('meeting_title','')}  ({msg.get('days_ago','?')}d ago)")
                    sim = msg.get("similarity", 0)
                    print(f"           Match: {sim:.0%}\n")

                elif t == "ping":
                    print("[ping]")

        except KeyboardInterrupt:
            print("\n\nStopped by user.")
        finally:
            send_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
