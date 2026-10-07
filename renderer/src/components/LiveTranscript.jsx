'use client';
import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';
function formatTime(value) {
  if (!value) return '';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export default function LiveTranscript({ transcript, sessionActive }) {
  const container = useRef(null);
  useEffect(() => { if (container.current) container.current.scrollTop = container.current.scrollHeight; }, [transcript]);
  const finals = transcript.filter(item => !item.interim);
  return <>
    <div className="transcript-body" role="log" aria-live="polite" aria-label="Live meeting transcript" ref={container}>
      {!transcript.length && <div className="empty-state"><Mic size={28} /><h3>{sessionActive ? 'Waiting for the conversation' : 'Your transcript will appear here'}</h3><p>{sessionActive ? 'Speech will appear as each segment is captured.' : 'Start a session or open a saved meeting to view its transcript.'}</p></div>}
      {transcript.map((item, index) => <article className={`transcript-entry ${item.interim ? 'interim' : ''}`} key={item.id || index}><span className="avatar">{(item.speaker || 'S').split(' ').map(word => word[0]).join('').slice(0, 2)}</span><div><div className="transcript-person"><strong>{item.speaker || 'Speaker'}</strong><time>{formatTime(item.timestamp)}</time></div><p>{item.transcript || item.text}</p></div></article>)}
    </div>
    <div className="transcript-footer"><span>{finals.length} segments</span><span>{finals.reduce((count, item) => count + (item.transcript || item.text || '').split(/\s+/).filter(Boolean).length, 0)} words</span>{sessionActive && <span className="recording-label"><span className="status-dot" />Session active</span>}</div>
  </>;
}
