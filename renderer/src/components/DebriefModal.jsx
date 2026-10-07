'use client';

import { useState } from 'react';
import {
  X, FileText, CheckCircle2, AlertTriangle,
  ArrowRight, ListTodo, Minus, Download
} from 'lucide-react';

/**
 * DebriefModal — post-session summary overlay.
 * PDF generation works in both Electron (IPC → printToPDF) and browser (Blob download).
 */
export default function DebriefModal({ debrief, onClose }) {
  const [copied,     setCopied]     = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  if (!debrief) return null;

  const session = debrief.session || {};
  const isMock  = ['mock', 'demo', 'unavailable'].includes(debrief.mode);

  // ── Copy to clipboard ──────────────────────────────────────────────────────
  const handleCopy = () => {
    const text = [
      'MEETING DEBRIEF',
      `Session: ${session.title || 'Untitled'}`,
      `Date: ${session.started_at ? new Date(session.started_at).toLocaleString() : 'N/A'}`,
      '',
      'SUMMARY',
      debrief.summary || '',
      '',
      'KEY DECISIONS',
      ...(debrief.key_decisions || []).map(d => `• ${d}`),
      '',
      'RISKS',
      ...(debrief.risks || []).map(r => `${r}`),
      '',
      'NEXT STEPS',
      ...(debrief.next_steps || []).map((s, i) => `${i + 1}. ${s}`),
      '',
      `ACTION ITEMS (${(debrief.action_items || []).length})`,
      ...(debrief.action_items || []).map(
        a => `• [${(a.priority || 'medium').toUpperCase()}] ${a.title} → ${a.assignee || 'Unassigned'}`
      ),
    ].join('\n');

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Build the PDF HTML string ──────────────────────────────────────────────
  function buildReportHtml() {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
    const items  = debrief.action_items || [];
    const groups = Object.create(null);
    for (const item of items) {
      const key = item.assignee || 'Unassigned';
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }

    const PRIORITY_HEX = { high: '#ef4444', medium: '#f59e0b', low: '#8b5cf6' };
    const PALETTE_HEX  = ['#8b5cf6', '#06b6d4', '#f43f5e', '#f59e0b', '#22c55e'];

    const swimlanesHtml = Object.keys(groups).map((name, idx) => {
      const color = PALETTE_HEX[idx % PALETTE_HEX.length];
      const initials = name.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
      const tasksHtml = groups[name].map(item => {
        const pc = PRIORITY_HEX[item.priority || 'medium'];
        return `<div style="border-left:3px solid ${pc};padding:8px 12px;margin:6px 0;background:#f9fafb;border-radius:0 6px 6px 0;">
          <div style="font-weight:600;font-size:13px;color:#111;">${escape(item.title || '')}</div>
          <div style="font-size:11px;color:#666;margin-top:3px;">
            <span style="background:${pc}22;color:${pc};padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;">${escape(item.priority || 'medium')}</span>
            ${item.context ? `<span style="margin-left:8px;font-style:italic;">"${escape(item.context)}"</span>` : ''}
          </div>
        </div>`;
      }).join('');

      return `<div style="border:1px solid ${color}44;border-radius:10px;margin:12px 0;overflow:hidden;">
        <div style="background:${color}18;padding:10px 14px;display:flex;align-items:center;gap:10px;">
          <div style="width:32px;height:32px;border-radius:50%;background:${color};color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;">${escape(initials)}</div>
          <div>
            <div style="font-weight:700;color:${color};font-size:14px;">${escape(name)}</div>
            <div style="font-size:11px;color:#666;">${groups[name].length} task${groups[name].length > 1 ? 's' : ''}</div>
          </div>
        </div>
        <div style="padding:10px 14px;">${tasksHtml}</div>
      </div>`;
    }).join('');

    const decisionsHtml = (debrief.key_decisions || []).length
      ? `<h2>Key Decisions</h2><ul>${debrief.key_decisions.map(d => `<li>${escape(d)}</li>`).join('')}</ul>` : '';
    const risksHtml = (debrief.risks || []).length
      ? `<h2>Risks &amp; Blockers</h2><ul>${debrief.risks.map(r => `<li>${escape(r)}</li>`).join('')}</ul>` : '';
    const stepsHtml = (debrief.next_steps || []).length
      ? `<h2>Next Steps</h2><ul>${debrief.next_steps.map(s => `<li>${escape(s)}</li>`).join('')}</ul>` : '';
    const notesHtml = debrief.notes
      ? `<h2>Detailed Notes</h2><p style="white-space:pre-wrap;">${escape(debrief.notes)}</p>` : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Meeting Report — ${escape(session.title || 'Untitled')}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 820px; margin: 0 auto; padding: 40px 30px; color: #111; }
    h1   { font-size: 24px; color: #1e1b4b; margin-bottom: 4px; }
    .meta{ font-size: 12px; color: #666; margin-bottom: 30px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
    h2   { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-top: 28px; }
    p    { font-size: 14px; line-height: 1.7; color: #374151; }
    ul   { font-size: 13px; line-height: 1.8; color: #374151; padding-left: 20px; }
    li   { margin-bottom: 4px; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <h1>MeetIntel — Meeting Intelligence Report</h1>
  <div class="meta">
    <strong>${escape(session.title || 'Untitled Meeting')}</strong> &nbsp;·&nbsp;
    ${session.started_at ? new Date(session.started_at).toLocaleString() : ''}
    &nbsp;·&nbsp; ${debrief.transcript_segments || 0} segments &nbsp;·&nbsp; ${debrief.word_count || 0} words
  </div>
  ${debrief.summary ? `<h2>Executive Summary</h2><p>${escape(debrief.summary)}</p>` : ''}
  ${decisionsHtml}
  ${risksHtml}
  ${stepsHtml}
  ${items.length ? `<h2>Task Assignment Dashboard</h2>${swimlanesHtml}` : ''}
  ${notesHtml}
</body>
</html>`;
  }

  // ── PDF download — three-layer approach ───────────────────────────────────
  const handleDownloadPdf = () => {
    setPdfLoading(true);
    const html = buildReportHtml();

    // Layer 1: Electron native IPC → printToPDF → saves real PDF to Downloads
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.printPdf) {
      window.electronAPI.printPdf(html)
        .then(result => {
          setPdfLoading(false);
          if (result && result.success) {
            alert('PDF saved!\n\n' + result.path);
          } else {
            // fallback to blob if IPC fails
            downloadAsBlob(html);
          }
        })
        .catch(() => {
          setPdfLoading(false);
          downloadAsBlob(html);
        });
      return;
    }

    // Layer 2+3: Browser — try popup-print, fallback to HTML blob download
    setPdfLoading(false);
    const win = window.open('', '_blank', 'width=900,height=700,left=100,top=100');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 600);
    } else {
      downloadAsBlob(html);
    }
  };

  // Blob fallback: downloads an .html file the user can File > Print as PDF
  function downloadAsBlob(html) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `MeetIntel_Report_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert('Report downloaded as HTML.\nOpen it in a browser and press Ctrl+P → Save as PDF.');
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Meeting debrief">
      <div className="report-modal">
        <div className="card-heading"><div><h2>Meeting debrief</h2><p>{session.title || 'Meeting'} · {debrief.transcript_segments || 0} segments · {debrief.word_count || 0} words {isMock && '· Demo report'}</p></div>
          <div className="report-actions"><button className="button button-secondary" onClick={handleDownloadPdf} disabled={pdfLoading} aria-label="Download meeting report as PDF"><Download size={14} />{pdfLoading ? 'Preparing…' : 'Export report'}</button><button className="button button-secondary" onClick={handleCopy} aria-label="Copy debrief to clipboard">{copied ? 'Copied' : 'Copy'}</button><button className="icon-button" onClick={onClose} aria-label="Close debrief"><X size={18} /></button></div>
        </div>
        <div className="report-content">
          {debrief.summary && <section aria-label="Meeting summary"><h3>Executive summary</h3><p>{debrief.summary}</p></section>}
          {[['Key decisions', debrief.key_decisions], ['Risks', debrief.risks], ['Next steps', debrief.next_steps]].map(([title, entries]) => entries?.length > 0 && <section key={title}><h3>{title}</h3><ul>{entries.map((entry, i) => <li key={i}>{entry}</li>)}</ul></section>)}
          {debrief.action_items?.length > 0 && <section aria-label="Action items"><h3>Action items</h3>{debrief.action_items.map((item, i) => <div className="report-item" key={item.id || i}><strong>{item.title}</strong><small>{item.assignee || 'Unassigned'} · {item.due || 'No due date'} · {item.done ? 'Completed' : 'Open'}</small></div>)}</section>}
          {debrief.notes && <section><h3>Meeting notes</h3><p>{debrief.notes}</p></section>}
        </div>
      </div>
    </div>
  );
}
