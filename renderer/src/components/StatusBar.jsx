'use client';
import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
export default function StatusBar({ connected, sessionActive, sessionPaused, mode }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sessionActive) { setElapsed(0); return; }
    if (sessionPaused) return;
    const timer = setInterval(() => setElapsed(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [sessionActive, sessionPaused]);
  return <div className="status-bar"><span className={`status-dot ${!['demo', 'live'].includes(mode) ? 'status-offline' : ''}`} /><span>{sessionPaused ? 'Paused' : connected ? 'Session connected' : sessionActive ? 'Connecting' : ['demo', 'live'].includes(mode) ? 'Workspace ready' : 'Service offline'}</span>{sessionActive && <span className="elapsed"><Clock size={14} />{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span>}</div>;
}
