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
import { API_BASE, websocketUrl } from '../lib/constants';
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('loading');
  const [models, setModels] = useState({});
  const [history, setHistory] = useState([]);
  const [meetingTitle, setMeetingTitle] = useState('Team sync');
  const [participantNames, setParticipantNames] = useState('Parth Bhad, Aryan Karpe, Aaditya Hingmire');
  const [adminName, setAdminName] = useState('Aaditya Hingmire');

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || `Request failed (${response.status})`);
    return data;
  }, []);

  const refreshHistory = useCallback(async () => {
    const data = await request('/sessions');
    setHistory(data.sessions || []);
  }, [request]);

  useEffect(() => {
    request('/health').then(data => { setMode(data.mode); setModels(data.models || {}); }).catch(err => {
      setError(`Backend unavailable: ${err.message}`); setMode('offline');
    });
    refreshHistory().catch(err => setError(err.message));
  }, [request, refreshHistory]);

  const restoreMeeting = async id => {
    try {
      const data = await request(`/sessions/${id}`);
      setSessionId(id); setTranscript(data.transcripts); setActionItems(data.action_items);
      setSlides(data.slides); setDebrief(null);
      setSessionActive(['active', 'paused'].includes(data.session.status));
      setSessionPaused(data.session.status === 'paused');
    } catch (err) { setError(err.message); }
  };

  // ── WebSocket connection to FastAPI ────────────────────────────────────────
  const { connected, sendAudioChunk } = useWebSocket(websocketUrl(sessionId), {
    enabled: sessionActive,
    onError: setError,
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
    if (busy) return;
    setBusy(true); setError('');
    try {
      const participants = participantNames.split(',').map(name => name.trim()).filter(Boolean);
      if (!meetingTitle.trim() || !adminName.trim() || !participants.length) {
        throw new Error('Enter a meeting title, organizer, and at least one participant.');
      }
      const metadata = { title: meetingTitle.trim(), admin: adminName.trim(), participants };
      const data = window.electronAPI
        ? await window.electronAPI.startSession(metadata)
        : await request('/session/start', { method: 'POST', body: JSON.stringify(metadata) });
      if (!data.id) throw new Error(data.error || 'Could not start the session');
      setSessionId(data.id); setTranscript([]); setActionItems([]); setSlides([]);
      setDebtItems([]); setDebrief(null); setSessionPaused(false);
      setSessionActive(true); setActiveTab('transcript');
      await refreshHistory();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }, [busy, meetingTitle, adminName, participantNames, request, refreshHistory]);

  const handlePause = useCallback(async () => {
    try {
      const data = await request('/session/pause', { method: 'POST' });
      setSessionPaused(data.status === 'paused');
    } catch (err) { setError(err.message); }
  }, [request]);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await request('/session/stop', { method: 'POST' });
      setSessionActive(false); setSessionPaused(false);
      const data = await request(`/debrief/generate?session_id=${encodeURIComponent(sessionId)}`, { method: 'POST' });
      setDebrief(data);
      const detail = await request(`/sessions/${sessionId}`);
      setActionItems(detail.action_items);
      await refreshHistory();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }, [busy, sessionId, request, refreshHistory]);

  const toggleAction = async id => {
    const item = actionItems.find(action => action.id === id);
    try {
      const updated = await request(`/sessions/${sessionId}/actions/${id}`, {
        method: 'PATCH', body: JSON.stringify({ done: !item.done }),
      });
      setActionItems(items => items.map(action => action.id === id ? updated : action));
    } catch (err) { setError(err.message); }
  };

  const removeAction = async id => {
    try {
      await request(`/sessions/${sessionId}/actions/${id}`, { method: 'DELETE' });
      setActionItems(items => items.filter(item => item.id !== id));
    } catch (err) { setError(err.message); }
  };

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
          mode={mode}
          models={models}
          connected={connected}
          sessionActive={sessionActive}
          sessionPaused={sessionPaused}
          sessionId={sessionId}
        />

        <MeetingControls
          disabled={busy || mode === 'loading' || mode === 'offline'}
          sessionActive={sessionActive}
          sessionPaused={sessionPaused}
          onStart={handleStart}
          onPause={handlePause}
          onStop={handleStop}
        />
      </header>

      <div className="px-6 py-3 border-b border-white/10 space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={mode === 'demo' ? 'text-amber-300' : 'text-emerald-300'}>
            {mode === 'demo' ? 'Demo mode · synthetic meeting · microphone off' : mode === 'live' ? 'Live mode · microphone permission required' : 'Connecting to backend…'}
          </span>
          {busy && <span role="status">Processing…</span>}
          <label className="ml-auto">Meeting history
            <select aria-label="Meeting history" className="ml-2 bg-surface-100 rounded px-2 py-1 max-w-64"
              value={sessionId || ''} disabled={sessionActive || busy}
              onChange={event => event.target.value && restoreMeeting(event.target.value)}>
              <option value="">Select a meeting</option>
              {history.map(meeting => <option key={meeting.id} value={meeting.id}>{meeting.title} · {meeting.status}</option>)}
            </select>
          </label>
        </div>
        {!sessionActive && <div className="flex flex-wrap gap-3 text-xs">
          <label>Title <input aria-label="Meeting title" className="bg-surface-100 rounded px-2 py-1" value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)} /></label>
          <label>Organizer <input aria-label="Organizer" className="bg-surface-100 rounded px-2 py-1" value={adminName} onChange={e => setAdminName(e.target.value)} /></label>
          <label className="flex-1">Participants <input aria-label="Participants" className="bg-surface-100 rounded px-2 py-1 w-full sm:w-80" value={participantNames} onChange={e => setParticipantNames(e.target.value)} /></label>
        </div>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      </div>

      {/* ── Main layout ──────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Live Transcript (always visible) */}
        <div className="flex flex-col w-[38%] min-w-[240px] flex-shrink-0 border-r border-white/5">
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
              <ActionItemsPanel items={actionItems} setItems={setActionItems} onToggle={toggleAction} onRemove={removeAction} />
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
        sessionActive={sessionActive && !sessionPaused && mode === 'live' && connected}
        onError={setError}
        onAudioChunk={sendAudioChunk}
        sessionId={sessionId}
      />
    </div>
  );
}
