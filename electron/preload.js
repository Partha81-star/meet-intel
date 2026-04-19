/**
 * electron/preload.js
 * MeetIntel — Secure Context Bridge
 *
 * Only the APIs listed here are accessible to the renderer.
 * This is the ONLY communication channel across the process boundary.
 */

const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── desktopCapturer ──────────────────────────────────────────────────────
  /**
   * Returns a list of available screen/window capture sources.
   * @param {Electron.SourcesOptions} opts
   */
  getSources: (opts) => ipcRenderer.invoke('capture:getSources', opts),

  /**
   * Get the best (primary) screen source — auto-selected by captureManager.
   */
  getBestSource: () => ipcRenderer.invoke('capture:getBestSource'),

  // ── IPC: Session lifecycle ────────────────────────────────────────────────
  startSession: (metadata) => ipcRenderer.invoke('session:start', metadata),
  stopSession:  ()          => ipcRenderer.invoke('session:stop'),
  pauseSession: ()          => ipcRenderer.invoke('session:pause'),

  // ── IPC: Screen capture frame push ───────────────────────────────────────
  /** Send a base64-encoded screen frame to the main process for forwarding to backend */
  sendFrame: (frameB64) => ipcRenderer.invoke('vision:frame', frameB64),

  // ── IPC: Post-call debrief ────────────────────────────────────────────────
  generateDebrief: () => ipcRenderer.invoke('debrief:generate'),

  // ── Event listeners (main → renderer) ────────────────────────────────────
  onSessionStatus: (cb) => ipcRenderer.on('session:status',     (_e, v) => cb(v)),
  onDebriefReady:  (cb) => ipcRenderer.on('debrief:ready',      (_e, v) => cb(v)),

  /**
   * Fired by ipcHandlers when Vision Engine detects a slide change.
   * Shape: { slide_changed, id, description, key_points, slide_type, captured_at, frame }
   */
  onSlideContext:  (cb) => ipcRenderer.on('vision:slideContext', (_e, v) => cb(v)),

  /**
   * Fired when the Debt Engine surfaces a cross-meeting debt item via IPC.
   * Shape: { id, title, context, assignee, status, priority, similarity, meeting_title, days_ago }
   */
  onDebtItem:      (cb) => ipcRenderer.on('debt:item',          (_e, v) => cb(v)),

  // ── Utility ───────────────────────────────────────────────────────────────
  platform: process.platform,
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // ── PDF generation (uses Electron printToPDF, saves to Downloads) ─────────
  printPdf: (htmlContent) => ipcRenderer.invoke('print:pdf', htmlContent),
});
