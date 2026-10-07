'use client';

import { useState, useEffect } from 'react';
import { Wifi, WifiOff, Timer, PauseCircle, Cpu } from 'lucide-react';

function useElapsedTime(active) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

export default function StatusBar({ connected, sessionActive, sessionPaused, sessionId, mode, models = {} }) {
  // Timer pauses when session is paused
  const elapsed = useElapsedTime(sessionActive && !sessionPaused);

  return (
    <div className="flex items-center gap-4 text-xs text-white/40">

      {/* WS connection indicator */}
      <div className="flex items-center gap-1.5">
        {connected
          ? <Wifi    className="w-3.5 h-3.5 text-accent-green" />
          : <WifiOff className="w-3.5 h-3.5 text-accent-red"   />
        }
        <span className={connected ? 'text-accent-green' : 'text-accent-red'}>
          {connected ? 'Connected' : sessionActive ? 'Connecting' : ['demo', 'live'].includes(mode) ? 'Ready' : 'Offline'}
        </span>
      </div>

      <div className="w-px h-3 bg-white/10" />

      {/* Timer + paused badge */}
      <div className="flex items-center gap-1.5 font-mono">
        {sessionPaused
          ? <PauseCircle className="w-3.5 h-3.5 text-accent-amber" />
          : <Timer       className="w-3.5 h-3.5" />
        }
        <span className={sessionActive ? (sessionPaused ? 'text-accent-amber' : 'text-white/70') : ''}>
          {formatTime(elapsed)}
        </span>
        {sessionPaused && (
          <span className="text-[9px] font-medium text-accent-amber uppercase tracking-wider ml-0.5">
            paused
          </span>
        )}
      </div>

      <div className="w-px h-3 bg-white/10" />

      {/* Model indicator */}
      <div className="flex items-center gap-1.5" title={mode === 'demo' ? 'Synthetic demo; AI providers are not called' : `${models.live_tasks || 'Gemini'} · ${models.vision || 'Vision'}`}>
        <Cpu className="w-3.5 h-3.5 text-brand-400" />
        <span className="text-white/60">{mode === 'demo' ? 'Demo' : 'Gemini · Deepgram'}</span>
      </div>

      {sessionId && (
        <>
          <div className="w-px h-3 bg-white/10" />
          <span
            className="font-mono text-[10px] text-white/25"
            title={`Session ID: ${sessionId}`}
          >
            {sessionId.slice(-8)}
          </span>
        </>
      )}
    </div>
  );
}
