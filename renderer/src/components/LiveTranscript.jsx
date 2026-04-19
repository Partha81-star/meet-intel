'use client';

import { useEffect, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';

export default function LiveTranscript({ transcript, sessionActive }) {
  const bottomRef    = useRef(null);
  const containerRef = useRef(null);

  // Auto-scroll to bottom when new transcript arrives
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [transcript]);

  const finalItems  = transcript.filter((t) => t.is_final || !t.interim);
  const interimItem = transcript.find((t) => t.interim);

  // Dynamic speaker colors for better distinction
  const getSpeakerTheme = (speaker) => {
    if (!speaker) return { bg: 'bg-brand-500/30', border: 'border-brand-500/40', text: 'text-brand-400' };
    
    const themes = [
      { bg: 'bg-brand-500/20',     border: 'border-brand-500/30',    text: 'text-brand-400' },
      { bg: 'bg-accent-cyan/20',   border: 'border-accent-cyan/30',  text: 'text-accent-cyan' },
      { bg: 'bg-accent-amber/20',  border: 'border-accent-amber/30', text: 'text-accent-amber' },
      { bg: 'bg-accent-green/20',  border: 'border-accent-green/30', text: 'text-accent-green' },
      { bg: 'bg-accent-purple/20', border: 'border-accent-purple/30', text: 'text-accent-purple' },
    ];
    const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return themes[hash % themes.length];
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Transcript scroll area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 pb-4 space-y-3 pt-2"
        role="log"
        aria-live="polite"
        aria-label="Live meeting transcript"
      >
        {/* Empty state */}
        {transcript.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
              sessionActive
                ? 'bg-brand-500/20 border border-brand-500/30 animate-pulse'
                : 'bg-surface-200 border border-white/5'
            }`}>
              {sessionActive
                ? <Mic className="w-7 h-7 text-brand-400" />
                : <MicOff className="w-7 h-7 text-white/20" />
              }
            </div>
            <p className="text-sm text-white/40">
              {sessionActive
                ? 'Listening for voices…'
                : 'Start a session to begin transcription'}
            </p>
          </div>
        )}

        {/* Final transcript segments */}
        {finalItems.map((item) => {
          const theme = getSpeakerTheme(item.speaker);
          return (
            <div key={item.id} className="animate-slide-bottom">
              <div className="flex items-start gap-2.5">
                {/* Speaker indicator (mini avatar) */}
                <div className={`w-7 h-7 rounded-lg ${theme.bg} border ${theme.border} flex-shrink-0 mt-0.5 flex items-center justify-center shadow-sm`}>
                  <span className={`text-[9px] font-black ${theme.text}`}>
                    {item.speaker ? item.speaker.match(/\d+/) || item.speaker.slice(0, 2).toUpperCase() : '?'}
                  </span>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[11px] font-bold ${theme.text}`}>
                      {item.speaker || 'Unknown'}
                    </span>
                    {item.timestamp && (
                      <span className="text-[9px] text-white/20 font-mono">
                        {new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <div className="bg-surface-100/30 border border-white/5 rounded-xl rounded-tl-none px-3 py-2">
                    <p className="transcript-final text-sm text-white/90 leading-relaxed break-words">
                      {item.transcript}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Interim (streaming) text */}
        {interimItem && (
          <div className="flex items-start gap-2.5 opacity-60">
            <div className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 flex-shrink-0 mt-0.5 flex items-center justify-center">
               <span className="text-[9px] font-black text-white/20">...</span>
            </div>
            <div className="flex-1 min-w-0">
               <div className="bg-white/2 border border-white/5 rounded-xl rounded-tl-none px-3 py-2 italic font-light">
                <p className="transcript-interim text-sm text-white/40 leading-relaxed">
                  {interimItem.transcript}
                  <span className="inline-block w-1 h-3 bg-brand-400/40 ml-1 animate-pulse" />
                </p>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Bottom status bar */}
      <div className="px-4 py-2 bg-surface-50 border-t border-white/5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
           <span className="text-[10px] text-white/20 uppercase tracking-widest font-bold">
            {finalItems.length} segments
          </span>
          <span className="text-[10px] text-white/20 uppercase tracking-widest font-bold">
            {finalItems.reduce((acc, t) => acc + (t.transcript?.split(' ').length || 0), 0)} words
          </span>
        </div>
        {sessionActive && (
          <div className="flex items-center gap-1.5">
             <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
             <span className="text-[10px] font-bold text-accent-green/60 uppercase tracking-tighter">Diarization Active</span>
          </div>
        )}
      </div>
    </div>
  );
}
