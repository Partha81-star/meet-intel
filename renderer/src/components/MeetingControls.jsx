'use client';
import { Play, Square, Pause } from 'lucide-react';
export default function MeetingControls({ sessionActive, sessionPaused, onStart, onPause, onStop, disabled }) {
  if (!sessionActive) return <button id="btn-start-session" className="button button-primary" onClick={onStart} disabled={disabled} aria-label="Start meeting session"><Play size={15} />New session</button>;
  return <div className="control-group"><button id="btn-pause-session" className="button button-secondary" onClick={onPause} disabled={disabled} aria-label={sessionPaused ? 'Resume session' : 'Pause session'}>{sessionPaused ? <Play size={15} /> : <Pause size={15} />}{sessionPaused ? 'Resume' : 'Pause'}</button><button id="btn-stop-session" className="button button-stop" onClick={onStop} disabled={disabled} aria-label="Stop meeting session and generate debrief"><Square size={14} />End session</button></div>;
}
