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
import { LayoutDashboard, Mic, CheckSquare, History, Monitor, Layers, ArrowUpRight, Users, CalendarDays, FileText, ChevronRight } from 'lucide-react';

export default function MeetingDashboard() {
  const [sessionActive,  setSessionActive]  = useState(false);
  const [sessionPaused,  setSessionPaused]  = useState(false);
  const [sessionId,      setSessionId]      = useState(null);
  const [transcript,     setTranscript]     = useState([]);
  const [actionItems,    setActionItems]    = useState([]);
  const [slides,         setSlides]         = useState([]);
  const [debtItems,      setDebtItems]      = useState([]);
  const [debrief,        setDebrief]        = useState(null);
  const [activeTab,      setActiveTab]      = useState('overview');
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
      setActiveTab('transcript');
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

  const navigation = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'transcript', label: 'Live transcript', icon: Mic },
    { id: 'actions', label: 'Action items', icon: CheckSquare },
    { id: 'history', label: 'Meeting history', icon: History },
    { id: 'slides', label: 'Slide context', icon: Monitor },
    { id: 'debt', label: 'Outstanding tasks', icon: Layers },
  ];
  const selected = navigation.find(item => item.id === activeTab) || navigation[0];
  const pending = actionItems.filter(item => !item.done).length;
  const participants = participantNames.split(',').map(name => name.trim()).filter(Boolean);
  const activeMeeting = history.find(meeting => meeting.id === sessionId);
  const actionsPanel = <ActionItemsPanel items={actionItems} setItems={setActionItems} onToggle={toggleAction} onRemove={removeAction} />;
  const setupForm = (
    <section className="card setup-card" aria-label="Meeting setup">
      <div className="card-heading"><div><h2>Start a meeting</h2><p>Set the context for your next conversation.</p></div><CalendarDays size={20} /></div>
      <div className="form-grid">
        <label className="field">Meeting title<input aria-label="Meeting title" value={meetingTitle} disabled={sessionActive} onChange={e => setMeetingTitle(e.target.value)} placeholder="e.g. Weekly product sync" /></label>
        <label className="field">Organizer<input aria-label="Organizer" value={adminName} disabled={sessionActive} onChange={e => setAdminName(e.target.value)} /></label>
        <label className="field field-wide">Participants<span className="field-hint">Separate names with commas</span><input aria-label="Participants" value={participantNames} disabled={sessionActive} onChange={e => setParticipantNames(e.target.value)} /></label>
      </div>
      <div className="setup-footer"><span>{mode === 'demo' ? 'Demo sessions use sample content. Your microphone stays off.' : 'Recording starts after you allow microphone access.'}</span>
        {!sessionActive && <button className="button button-primary" disabled={busy || !['demo', 'live'].includes(mode)} onClick={handleStart}>Start session <ArrowUpRight size={15} /></button>}
      </div>
    </section>
  );
  const historyPanel = (
    <section className="card" aria-label="Meeting history">
      <div className="card-heading"><div><h2>{activeTab === 'history' ? 'All meetings' : 'Recent meetings'}</h2><p>Review transcripts and follow up on decisions.</p></div>
        {activeTab !== 'history' && <button className="button button-text" onClick={() => setActiveTab('history')}>View all <ChevronRight size={15} /></button>}
      </div>
      {history.length ? <div className="table-scroll"><table className="meeting-table"><thead><tr><th>Meeting</th><th>Date</th><th>Participants</th><th>Status</th><th><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{(activeTab === 'history' ? history : history.slice(0, 5)).map(meeting => <tr key={meeting.id}>
          <td><div className="meeting-name"><span className="document-icon"><FileText size={17} /></span><div><strong>{meeting.title}</strong><small>{meeting.admin || 'Meeting organizer'}</small></div></div></td>
          <td>{new Date(meeting.started_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</td>
          <td>{meeting.participants?.length || 0} people</td><td><span className={`pill ${meeting.status === 'active' ? 'pill-green' : 'pill-neutral'}`}>{meeting.status === 'ended' ? 'Completed' : meeting.status}</span></td>
          <td><button className="icon-button" aria-label={`Open ${meeting.title}`} disabled={sessionActive || busy} onClick={() => restoreMeeting(meeting.id)}><ChevronRight size={18} /></button></td>
        </tr>)}</tbody></table></div> : <div className="empty-state"><History size={28} /><h3>Your meeting history starts here</h3><p>Completed meetings are saved for you to revisit.</p></div>}
    </section>
  );

  return (
    <div className="app-shell">
      {debrief && <DebriefModal debrief={debrief} onClose={() => setDebrief(null)} />}
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">m<span>.</span></span><div><strong>MeetIntel</strong><small>Meeting workspace</small></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{navigation.map(item => {
          const Icon = item.icon;
          return <button key={item.id} className={`nav-item ${activeTab === item.id ? 'active' : ''}`} onClick={() => setActiveTab(item.id)} aria-label={item.label} title={item.label} aria-current={activeTab === item.id ? 'page' : undefined}>
            <Icon size={18} /><span>{item.label}</span>{item.id === 'actions' && pending > 0 && <span className="nav-count">{pending}</span>}
          </button>;
        })}</nav>
        <div className="sidebar-bottom"><div className="workspace-note"><span className="status-dot" /><strong>One workspace. Clear outcomes.</strong><p>Keep conversations, decisions, and follow-ups together.</p></div><div className="workspace-profile"><span className="avatar">MI</span><div><strong>Personal workspace</strong><small>{mode === 'demo' ? 'Demo environment' : 'Meeting intelligence'}</small></div></div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={14} /><strong>{selected.label}</strong></div><StatusBar connected={connected} sessionActive={sessionActive} sessionPaused={sessionPaused} sessionId={sessionId} mode={mode} models={models} /></header>
        <main className="workspace-content">
          <div className="page-heading"><div><div className="eyebrow">MEETING INTELLIGENCE</div><h1>{selected.label}</h1><p>{activeTab === 'overview' ? 'A clearer view of your conversations and what comes next.' : activeTab === 'transcript' ? (activeMeeting?.title || 'Follow your conversation as it happens.') : activeTab === 'actions' ? 'Turn meeting commitments into clear next steps.' : activeTab === 'history' ? 'Every conversation, organized and available to revisit.' : activeTab === 'slides' ? 'Supporting context captured during your meetings.' : 'Follow up on commitments from previous meetings.'}</p></div>
            <MeetingControls sessionActive={sessionActive} sessionPaused={sessionPaused} disabled={busy || !['demo', 'live'].includes(mode)} onStart={handleStart} onPause={handlePause} onStop={handleStop} />
          </div>
          <div className="environment-notice"><span className={`pill ${mode === 'demo' ? 'pill-blue' : 'pill-green'}`}>{mode === 'demo' ? 'Demo mode' : mode === 'live' ? 'Live mode' : 'Connecting'}</span><span>{mode === 'demo' ? 'Explore with a sample meeting. No audio is recorded.' : mode === 'live' ? 'Your microphone is used only during an active session.' : 'Waiting for the meeting service.'}</span>{busy && <span className="processing" role="status">Processing…</span>}</div>
          {error && <div role="alert" className="error-notice">{error}<button className="button button-text" onClick={() => setError('')}>Dismiss</button></div>}
          {activeTab === 'overview' && <>
            <div className="stats-grid">{[
              { label: 'Saved meetings', value: history.length, detail: 'Your conversation archive', icon: CalendarDays },
              { label: 'Open action items', value: pending, detail: 'In the selected meeting', icon: CheckSquare },
              { label: 'Participants', value: activeMeeting?.participants?.length || participants.length, detail: 'Ready to collaborate', icon: Users },
              { label: 'Transcript segments', value: transcript.filter(item => !item.interim).length, detail: 'Captured in this session', icon: FileText },
            ].map(stat => { const Icon = stat.icon; return <article className="stat-card" key={stat.label}><div className="stat-top"><span>{stat.label}</span><Icon size={18} /></div><strong>{stat.value.toString().padStart(2, '0')}</strong><small>{stat.detail}</small></article>; })}</div>
            {setupForm}{historyPanel}
          </>}
          {activeTab === 'transcript' && <div className="live-grid"><section className="card transcript-card"><div className="card-heading"><div><h2>Live transcript</h2><p>{sessionPaused ? 'Recording paused' : sessionActive ? 'Connected to the current session' : 'Selected meeting transcript'}</p></div><span className={`pill ${sessionActive ? 'pill-green' : 'pill-neutral'}`}>{sessionPaused ? 'Paused' : sessionActive ? 'Active session' : 'Saved transcript'}</span></div><LiveTranscript transcript={transcript} sessionActive={sessionActive && !sessionPaused} /></section><section className="card">{actionsPanel}</section></div>}
          {activeTab === 'actions' && <section className="card">{actionsPanel}</section>}
          {activeTab === 'history' && historyPanel}
          {activeTab === 'slides' && <section className="card"><SlideGallery slides={slides} /></section>}
          {activeTab === 'debt' && <section className="card"><DebtLog items={debtItems} setItems={setDebtItems} sessionActive={sessionActive} /></section>}
          <footer className="page-footer"><span>MeetIntel workspace</span><span>Conversations with a clear next step</span></footer>
        </main>
      </div>
      <CaptureEngine sessionActive={sessionActive && !sessionPaused && mode === 'live' && connected} onError={setError} onAudioChunk={sendAudioChunk} sessionId={sessionId} />
    </div>
  );
}
