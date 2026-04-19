'use client';

import { useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp, ExternalLink, Clock } from 'lucide-react';
import { API_BASE } from '../lib/constants';

const STATUS_COLOR = {
  unresolved: 'text-accent-red   bg-accent-red/10   border-accent-red/30',
  partial:    'text-accent-amber bg-accent-amber/10 border-accent-amber/30',
  resolved:   'text-accent-green bg-accent-green/10 border-accent-green/30',
};

/**
 * DebtLog — displays cross-meeting unresolved commitments (RAG results).
 *
 * Props:
 *   items         — array of debt items (pushed via WS or injected via IPC)
 *   setItems      — state setter so we can add items from the manual refresh
 *   sessionActive — true while a session is live
 */
export default function DebtLog({ items, setItems, sessionActive }) {
  const [loading,  setLoading]  = useState(false);
  const [expanded, setExpanded] = useState({});
  const [error,    setError]    = useState(null);

  const toggleExpand = useCallback(
    (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })),
    []
  );

  /**
   * Manual refresh — calls /debt/query and merges new items (deduped by id).
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`${API_BASE}/debt/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'manual' }),
      });
      const data = await res.json();
      const incoming = data.items || [];

      if (incoming.length > 0) {
        setItems((prev) => {
          const existingIds = new Set(prev.map((d) => d.id));
          const newOnes     = incoming.filter((d) => !existingIds.has(d.id));
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
        });
      }
    } catch (err) {
      console.error('[DebtLog] Refresh failed:', err);
      setError('Failed to fetch debt items — is the backend running?');
    } finally {
      setLoading(false);
    }
  }, [setItems]);

  const markResolved = useCallback((id) => {
    setItems((prev) =>
      prev.map((d) => d.id === id ? { ...d, status: 'resolved' } : d)
    );
  }, [setItems]);

  return (
    <div className="flex flex-col h-full p-4 gap-3">

      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-accent-amber" />
          <h2 className="text-sm font-semibold text-white/80">Meeting Debt Log</h2>
          {items.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-accent-amber/20 text-accent-amber">
              {items.filter((i) => i.status !== 'resolved').length} unresolved
            </span>
          )}
        </div>

        <button
          id="btn-debt-refresh"
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-200 text-white/60 hover:bg-surface-300 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Refresh meeting debt from vector database"
          title="Query past meetings for similar unresolved topics"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Querying…' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-accent-red/10 border border-accent-red/30 text-xs text-accent-red">
          {error}
        </div>
      )}

      {/* Context banner */}
      <div className="debt-badge rounded-lg px-3 py-2 flex-shrink-0">
        <p className="text-[11px] text-white/60 leading-relaxed">
          <span className="text-accent-amber font-semibold">RAG-powered</span> — searches your last{' '}
          <span className="font-semibold text-white/80">3 meetings</span> for similar unresolved
          commitments. Surface what you forgot.
        </p>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-amber/10 border border-accent-amber/20 flex items-center justify-center mb-3">
              <AlertTriangle className="w-5 h-5 text-accent-amber/40" />
            </div>
            <p className="text-xs text-white/30">No meeting debt found</p>
            <p className="text-[11px] text-white/20 mt-1">
              {sessionActive
                ? 'Querying past meetings as topics arise…'
                : 'Start a session or click Refresh to surface debt'}
            </p>
          </div>
        )}

        {items.map((debt) => (
          <div key={debt.id} className="glass-card overflow-hidden animate-slide-bottom">
            {/* Debt item header */}
            <button
              className="w-full flex items-start gap-3 p-3 text-left hover:bg-white/[0.02] transition-colors"
              onClick={() => toggleExpand(debt.id)}
              aria-expanded={!!expanded[debt.id]}
              aria-label={`Toggle details for: ${debt.title}`}
            >
              {/* Status badge */}
              <span className={`flex-shrink-0 px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${
                STATUS_COLOR[debt.status || 'unresolved']
              }`}>
                {debt.status || 'unresolved'}
              </span>

              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/90 font-medium leading-snug">{debt.title}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Clock className="w-3 h-3 text-white/30" />
                  <span className="text-[10px] text-white/40">{debt.meeting_title || 'Previous meeting'}</span>
                  {debt.days_ago != null && (
                    <span className="text-[10px] text-white/30">{debt.days_ago}d ago</span>
                  )}
                </div>
              </div>

              {/* Similarity score */}
              <div className="flex-shrink-0 text-right mr-1">
                <div className="text-[10px] font-mono text-brand-400">
                  {Math.round((debt.similarity || 0) * 100)}%
                </div>
                <div className="text-[9px] text-white/30">match</div>
              </div>

              {expanded[debt.id]
                ? <ChevronUp   className="w-3.5 h-3.5 text-white/30 flex-shrink-0 mt-0.5" />
                : <ChevronDown className="w-3.5 h-3.5 text-white/30 flex-shrink-0 mt-0.5" />
              }
            </button>

            {/* Expanded detail */}
            {expanded[debt.id] && (
              <div className="px-3 pb-3 pt-0 border-t border-white/5 animate-fade-in">
                {debt.context && (
                  <blockquote className="text-xs text-white/50 italic border-l-2 border-brand-500/40 pl-2 mt-2 mb-2">
                    "{debt.context}"
                  </blockquote>
                )}
                {debt.responsible_party && (
                  <p className="text-[11px] text-white/50 mb-2">
                    <span className="text-white/30">Assigned to: </span>
                    <span className="text-brand-400">{debt.responsible_party}</span>
                  </p>
                )}
                <div className="flex gap-3 mt-2">
                  <button
                    className="flex items-center gap-1 text-[10px] text-brand-400 hover:text-brand-300 transition-colors"
                    disabled
                    title="Coming soon: link to original meeting"
                  >
                    <ExternalLink className="w-3 h-3" />
                    View meeting
                  </button>
                  <span className="text-white/20">·</span>
                  {debt.status !== 'resolved' && (
                    <button
                      onClick={() => markResolved(debt.id)}
                      className="text-[10px] text-accent-green hover:text-accent-green/80 transition-colors"
                      aria-label="Mark this debt item as resolved"
                    >
                      ✓ Mark resolved
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
