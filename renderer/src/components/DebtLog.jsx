'use client';
import { useState } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { API_BASE } from '../lib/constants';
export default function DebtLog({ items, setItems }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`${API_BASE}/debt/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: 'manual' }) });
      const data = await response.json();
      if (!response.ok || data.mode === 'error') throw new Error(data.message || 'Could not load outstanding tasks');
      setItems(data.items || []);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  return <><div className="card-heading"><div><h2>Outstanding tasks</h2><p>Unresolved commitments from previous meetings.</p></div><button className="button button-secondary" onClick={refresh} disabled={loading}><RefreshCw size={15} />{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    {error && <p role="alert" className="error-notice">{error}</p>}
    {!items.length ? <div className="empty-state"><Layers size={28} /><h3>No outstanding tasks loaded</h3><p>Refresh to review unresolved items from your meeting history.</p></div> : <div className="task-list">{items.map((item, index) => <article className="task-row" key={item.id || index}><div className="task-content"><h3>{item.title}</h3><p className="task-context">{item.meeting_title || 'Previous meeting'}</p><div className="task-meta"><span>{item.assignee || 'Unassigned'}</span><span>{item.due || 'No due date'}</span></div></div><span className="pill pill-neutral">Open</span></article>)}</div>}
  </>;
}
