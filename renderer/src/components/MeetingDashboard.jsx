'use client';

/**
 * MeetingDashboard.jsx — root UI orchestrator
 *
 * Data flow:
 *  Audio  : CaptureEngine → onAudioChunk → sendAudioChunk → WS → FastAPI
 *  Events : WS → useWebSocket → state (transcript, actionItems, debtItems)
 *  Vision : CaptureEngine.captureFrame → electronAPI.sendFrame → IPC → FastAPI
 *           → ipcHandlers pushes 'vision:slideContext' → preload → onSlideContext cb
 *  Debrief: electronAPI.generateDebrief → IPC → FastAPI → preload 'debrief:ready' → modal
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import CaptureEngine    from './CaptureEngine';
import LiveTranscript   from './LiveTranscript';
import ActionItemsPanel from './ActionItemsPanel';
import SlideGallery     from './SlideGallery';
import DebtLog          from './DebtLog';
import MeetingControls  from './MeetingControls';
import StatusBar        from './StatusBar';
import DebriefModal     from './DebriefModal';
import { useWebSocket } from '../hooks/useWebSocket';
import { WS_URL }       from '../lib/constants';
import { Brain, LayoutDashboard } from 'lucide-react';

export default function MeetingDashboard() {
  const [sessionActive,  setSessionActive]  = useState(false);
  const [sessionPaused,  setSessionPaused]  = useState(false);
  const [sessionId,      setSessionId]      = useState(null);
  const [transcript,     setTranscript]     = useState([]);
  const [actionItems,    setActionItems]    = useState([]);
  const [slides,         setSlides]         = useState([]);
  const [debtItems,      setDebtItems]      = useState([]);
  const [debrief,        setDebrief]        = useState(null);
  const [activeTab,      setActiveTab]      = useState('transcript');
  const ipcBound = useRef(false);

  // ── WebSocket connection to FastAPI ────────────────────────────────────────
  const { connected, sendAudioChunk } = useWebSocket(WS_URL, {
    enabled: sessionActive,
    onTranscript: useCallback((chunk) => {
      setTranscript((prev) => {
        if (chunk.is_final) {
          // Replace interim + append final
          return [...prev.filter((t) => !t.interim), { ...chunk, id: Date.now() }];
        }
        // Replace previous interim with new streaming text
        return [...prev.filter((t) => !t.interim), { ...chunk, interim: true, id: 'interim' }];
      });
    }, []),

    onActionItem: useCallback((item) => {
      setActionItems((prev) => {
        if (prev.some((a) => a.id === item.id)) return prev;
        return [{ ...item, isNew: true }, ...prev];
      });
      // Surface action items in Action Items tab badge
      setActiveTab((t) => t); // no-op that triggers re-render for badge
    }, []),

    onSlideContext: useCallback((slide) => {
      // This fires when the WS pushes a slide event (mock mode)
      setSlides((prev) => [slide, ...prev]);
    }, []),

    onDebtItem: useCallback((debt) => {
      setDebtItems((prev) =>
        prev.some((d) => d.id === debt.id) ? prev : [...prev, debt]
      );
    }, []),

    onIdentityUpdate: useCallback((map) => {
      setTranscript((prev) => prev.map(t => {
        if (!t.speaker) return t;
        const idMatch = t.speaker.match(/\d+/);
        const id = idMatch ? idMatch[0] : null;
        if (id && map[id]) {
          return { ...t, speaker: map[id] };
        }
        return t;
      }));
      console.debug('[Dashboard] Identities sync check ✓');
    }, []),
  });

  // ── IPC Listeners (Electron main → renderer) ───────────────────────────────
  // These fire from ipcHandlers when live vision/debrief results come in.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;
    if (ipcBound.current) return;
    ipcBound.current = true;

    // Vision: slide change detected by GPT-4o Vision (live mode)
    window.electronAPI.onSlideContext((slide) => {
      setSlides((prev) => [slide, ...prev]);
    });

    // Debt: cross-meeting debt item surfaced via IPC (if pushed from main)
    window.electronAPI.onDebtItem?.((debt) => {
      setDebtItems((prev) =>
        prev.some((d) => d.id === debt.id) ? prev : [...prev, debt]
      );
    });

    // Debrief: generated after session stop — also merge its action items
    window.electronAPI.onDebriefReady((data) => {
      setDebrief(data);
      // If the debrief contains action items (from full-transcript Gemini sweep), merge them
      if (data?.action_items?.length > 0) {
        setActionItems(prev => {
          const existingIds = new Set(prev.map(i => i.id));
          const fresh = data.action_items.filter(i => i.id && !existingIds.has(i.id));
          return [...prev, ...fresh.map(i => ({ ...i, isNew: true }))];
        });
      }
    });

    return () => {
      window.electronAPI.removeAllListeners('vision:slideContext');
      window.electronAPI.removeAllListeners('debt:item');
      window.electronAPI.removeAllListeners('debrief:ready');
    };
  }, []);

  // ── Session controls ───────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const metadata = {
      title:        `Meeting — ${new Date().toLocaleString()}`,
      admin:        'Aaditya Hingmire',
      participants: ['Parth Bhad', 'Aryan Karpe', 'Aaditya Hingmire'],
    };

    // Notify backend (via IPC in Electron, or direct HTTP fallback)
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.startSession(metadata).catch(console.warn);
    } else {
      fetch('http://127.0.0.1:8000/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      }).catch(console.warn);
    }

    setSessionId(`session_${Date.now()}`);
    setTranscript([]);
    setActionItems([]);
    setSlides([]);
    setDebtItems([]);
    setDebrief(null);
    setSessionPaused(false);
    setSessionActive(true);
    setActiveTab('transcript');
  }, []);

  const handlePause = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.pauseSession().catch(console.warn);
    }
    setSessionPaused((p) => !p);
  }, []);

  const handleStop = useCallback(async () => {
    setSessionActive(false);
    setSessionPaused(false);

    const BACKEND = 'http://127.0.0.1:8000';

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        // Electron path: stop + generate debrief via IPC
        await window.electronAPI.stopSession().catch(console.warn);
        await window.electronAPI.generateDebrief().catch(console.warn);
      } else {
        // Browser dev fallback
        await fetch(`${BACKEND}/session/stop`, { method: 'POST' }).catch(console.warn);
        const debriefRes = await fetch(`${BACKEND}/debrief/generate`, { method: 'POST' });
        if (debriefRes.ok) {
          const data = await debriefRes.json();
          setDebrief(data);
        }
      }
    } catch (e) {
      console.error('[Dashboard] Stop error:', e);
    }

    // After stopping, always fetch the complete action items from backend
    // This catches any tasks that were missed during the live session
    try {
      await new Promise(r => setTimeout(r, 2000)); // let backend pipeline finish
      const res = await fetch(`${BACKEND}/session/actions`);
      if (res.ok) {
        const data = await res.json();
        const backendItems = data.action_items || [];
        if (backendItems.length > 0) {
          setActionItems(prev => {
            const existingIds = new Set(prev.map(i => i.id));
            const newItems    = backendItems.filter(i => !existingIds.has(i.id));
            return [...prev, ...newItems.map(i => ({ ...i, isNew: true }))];
          });
        }
      }
    } catch (e) {
      console.warn('[Dashboard] Could not fetch final actions:', e);
    }
  }, []);

  const tabs = [
    { id: 'transcript', label: 'Actions',      badge: actionItems.filter((i) => !i.done).length },
    { id: 'slides',     label: 'Slides',        badge: slides.length },
    { id: 'debt',       label: 'Meeting Debt',  badge: debtItems.length, warn: debtItems.length > 0 },
  ];

  return (
    <div className="flex flex-col h-screen bg-surface text-white overflow-hidden">

      {/* ── Debrief Modal overlay ──────────────────────────────────────────── */}
      {debrief && (
        <DebriefModal debrief={debrief} onClose={() => setDebrief(null)} />
      )}

      {/* ── Top bar ──────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-surface-50/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Brain className="w-7 h-7 text-brand-400" />
            {sessionActive && !sessionPaused && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-accent-red animate-pulse" />
            )}
            {sessionPaused && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-accent-amber" />
            )}
          </div>
          <div>
            <h1 className="text-base font-semibold gradient-text tracking-tight leading-none">MeetIntel</h1>
            <p className="text-[10px] text-white/40 mt-0.5">AI Meeting Intelligence</p>
          </div>
        </div>

        <StatusBar
          connected={connected}
          sessionActive={sessionActive}
          sessionPaused={sessionPaused}
          sessionId={sessionId}
        />

        <MeetingControls
          sessionActive={sessionActive}
          sessionPaused={sessionPaused}
          onStart={handleStart}
          onPause={handlePause}
          onStop={handleStop}
        />
      </header>

      {/* ── Main layout ──────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Live Transcript (always visible) */}
        <div className="flex flex-col w-[420px] flex-shrink-0 border-r border-white/5">
          <div className="px-4 pt-4 pb-2 flex items-center gap-2">
            <LayoutDashboard className="w-4 h-4 text-brand-400" />
            <span className="text-sm font-medium text-white/80">Live Transcript</span>
            {sessionActive && !sessionPaused && <span className="recording-dot ml-auto" />}
            {sessionPaused && (
              <span className="ml-auto px-1.5 py-0.5 rounded text-[9px] font-semibold bg-accent-amber/20 text-accent-amber uppercase tracking-wider">
                Paused
              </span>
            )}
          </div>
          <LiveTranscript transcript={transcript} sessionActive={sessionActive && !sessionPaused} />
        </div>

        <div className="panel-divider" />

        {/* Right: Tabbed panels */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-white/5 flex-shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t-lg transition-all duration-200 ${
                  activeTab === tab.id
                    ? 'bg-surface-100 text-white border border-white/10 border-b-transparent -mb-px'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                {tab.label}
                {tab.badge > 0 && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    tab.warn ? 'bg-accent-amber/20 text-accent-amber' : 'bg-brand-500/20 text-brand-400'
                  }`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === 'transcript' && (
              <ActionItemsPanel items={actionItems} setItems={setActionItems} />
            )}
            {activeTab === 'slides' && (
              <SlideGallery slides={slides} />
            )}
            {activeTab === 'debt' && (
              <DebtLog
                items={debtItems}
                setItems={setDebtItems}
                sessionActive={sessionActive}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Hidden: CaptureEngine (pure logic, renders nothing visible) ─── */}
      <CaptureEngine
        sessionActive={sessionActive && !sessionPaused}
        onAudioChunk={sendAudioChunk}
        sessionId={sessionId}
      />
    </div>
  );
}
