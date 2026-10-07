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
      ...(debrief.risks || []).map(r => `⚠ ${r}`),
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
  <h1>📋 MeetIntel — Meeting Intelligence Report</h1>
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
            alert('✅ PDF saved!\n\n' + result.path);
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
    alert('📄 Report downloaded as HTML.\nOpen it in a browser and press Ctrl+P → Save as PDF.');
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Post-call debrief"
    >
      <div className="relative w-full max-w-3xl max-h-[88vh] glass-card overflow-hidden flex flex-col">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500/20 border border-brand-500/30 flex items-center justify-center">
              <FileText className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Post-Call Debrief</h2>
              <p className="text-[10px] text-white/40">
                {session.title || 'Meeting'} · {debrief.transcript_segments || 0} segments · {debrief.word_count || 0} words
                {isMock && <span className="ml-2 text-accent-amber">(demo mode)</span>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* PDF Button */}
            <button
              id="btn-debrief-pdf"
              onClick={handleDownloadPdf}
              disabled={pdfLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-brand-500/20 text-brand-400 hover:bg-brand-500/30 hover:text-brand-300 transition-all disabled:opacity-50"
              aria-label="Download meeting report as PDF"
            >
              <Download className="w-3 h-3" />
              {pdfLoading ? 'Generating…' : 'Download PDF'}
            </button>

            {/* Copy Button */}
            <button
              id="btn-debrief-copy"
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-200 text-white/60 hover:bg-surface-300 hover:text-white transition-all"
              aria-label="Copy debrief to clipboard"
            >
              {copied ? '✓ Copied!' : 'Copy'}
            </button>

            {/* Close */}
            <button
              id="btn-debrief-close"
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/5 transition-all"
              aria-label="Close debrief"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Summary */}
          {debrief.summary && (
            <section aria-label="Meeting summary">
              <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2">Summary</h3>
              <p className="text-sm text-white/80 leading-relaxed">{debrief.summary}</p>
            </section>
          )}

          {/* Two-col: Decisions + Risks */}
          <div className="grid grid-cols-2 gap-4">
            {(debrief.key_decisions || []).length > 0 && (
              <section aria-label="Key decisions">
                <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-accent-green" /> Key Decisions
                </h3>
                <ul className="space-y-1.5">
                  {debrief.key_decisions.map((d, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-accent-green flex-shrink-0 mt-0.5" />
                      <span className="text-xs text-white/70 leading-snug">{d}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(debrief.risks || []).length > 0 && (
              <section aria-label="Risks">
                <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-accent-amber" /> Risks
                </h3>
                <ul className="space-y-1.5">
                  {debrief.risks.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-accent-amber flex-shrink-0 mt-0.5" />
                      <span className="text-xs text-white/70 leading-snug">{r}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* Next Steps */}
          {(debrief.next_steps || []).length > 0 && (
            <section aria-label="Next steps">
              <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <ArrowRight className="w-3 h-3 text-accent-cyan" /> Next Steps
              </h3>
              <ol className="space-y-1.5">
                {debrief.next_steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-[10px] font-mono text-brand-400 flex-shrink-0 mt-0.5 w-4 text-right">{i + 1}.</span>
                    <span className="text-xs text-white/70 leading-snug">{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Action Items */}
          {(debrief.action_items || []).length > 0 && (
            <section aria-label="Action items">
              <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <ListTodo className="w-3 h-3 text-brand-400" /> Action Items ({debrief.action_items.length})
              </h3>
              <div className="space-y-1.5">
                {debrief.action_items.map((item, i) => {
                  const pColor = {
                    high:   'text-red-400   border-l-red-500   bg-red-500/5',
                    medium: 'text-amber-400 border-l-amber-500 bg-amber-500/5',
                    low:    'text-violet-400 border-l-violet-500 bg-violet-500/5',
                  }[item.priority || 'medium'] || 'text-amber-400 border-l-amber-500 bg-amber-500/5';

                  return (
                    <div key={item.id || i} className={`flex items-start gap-3 px-3 py-2 rounded-lg border-l-2 ${pColor}`}>
                      <Minus className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 opacity-50" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white/80 leading-snug">{item.title}</p>
                        {(item.assignee || item.due) && (
                          <p className="text-[10px] text-white/40 mt-0.5">
                            {item.assignee && <span>→ {item.assignee}</span>}
                            {item.assignee && item.due && <span className="mx-1">·</span>}
                            {item.due && <span>⏰ {item.due}</span>}
                          </p>
                        )}
                      </div>
                      <span className={`text-[9px] font-semibold uppercase tracking-wider flex-shrink-0 ${pColor.split(' ')[0]}`}>
                        {item.priority || 'med'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Notes */}
          {debrief.notes && (
            <section aria-label="Meeting notes">
              <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2">Detailed Notes</h3>
              <p className="text-xs text-white/60 leading-relaxed whitespace-pre-wrap">{debrief.notes}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
