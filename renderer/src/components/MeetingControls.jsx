'use client';

import { Play, Square, Pause, PlayCircle } from 'lucide-react';

/**
 * MeetingControls — Start / Pause / Stop buttons.
 * Now properly wires the Pause button to onPause.
 */
export default function MeetingControls({ sessionActive, sessionPaused, onStart, onPause, onStop }) {
  if (!sessionActive) {
    return (
      <button
        id="btn-start-session"
        onClick={onStart}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold transition-all duration-200 glow-brand hover:scale-105 active:scale-95"
        aria-label="Start meeting session"
      >
        <Play className="w-4 h-4 fill-current" />
        Start Session
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Pause / Resume toggle */}
      <button
        id="btn-pause-session"
        onClick={onPause}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-200 hover:bg-surface-300 text-white/70 text-sm font-medium transition-all border border-white/10 hover:border-accent-amber/40 hover:text-accent-amber active:scale-95"
        aria-label={sessionPaused ? 'Resume session' : 'Pause session'}
        title={sessionPaused ? 'Resume recording' : 'Pause recording'}
      >
        {sessionPaused
          ? <PlayCircle className="w-3.5 h-3.5 text-accent-amber" />
          : <Pause       className="w-3.5 h-3.5" />
        }
        {sessionPaused ? 'Resume' : 'Pause'}
      </button>

      {/* Stop + Debrief */}
      <button
        id="btn-stop-session"
        onClick={onStop}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 border border-accent-red/40 text-accent-red text-sm font-semibold transition-all duration-200 hover:scale-105 active:scale-95"
        aria-label="Stop meeting session and generate debrief"
        title="Stop recording and generate post-call debrief"
      >
        <Square className="w-3.5 h-3.5 fill-current" />
        Stop &amp; Debrief
      </button>
    </div>
  );
}
