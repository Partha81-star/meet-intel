/**
 * electron/ipcHandlers.js
 * MeetIntel — IPC Channel Registration
 *
 * All ipcMain.handle() calls live here to keep main.js clean.
 */

const { shell } = require('electron');
const { getBestScreenSource, getAllSources, serializeSource } = require('./captureManager');
const { net } = require('electron');

const BACKEND_BASE = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

/**
 * Helper: call the FastAPI backend from the main process.
 * Uses Electron's net module (bypasses CORS & renderer sandbox).
 */
function backendPost(path, body) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: `${BACKEND_BASE}${path}`,
      headers: { 'Content-Type': 'application/json' },
    });

    let data = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    request.on('error', reject);
    request.write(JSON.stringify(body));
    request.end();
  });
}

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.BrowserWindow} mainWindow
 */
function registerIpcHandlers(ipcMain, mainWindow) {
  // ── desktopCapturer: get all sources for picker UI ────────────────────────
  ipcMain.handle('capture:getSources', async () => {
    const sources = await getAllSources();
    return sources.map(serializeSource);
  });

  // ── desktopCapturer: get the best source for auto-start ───────────────────
  ipcMain.handle('capture:getBestSource', async () => {
    const source = await getBestScreenSource();
    return serializeSource(source);
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────
  ipcMain.handle('session:start', async (_event, metadata) => {
    console.log('[IPC] session:start', metadata);
    try {
      const result = await backendPost('/session/start', metadata || {});
      mainWindow.webContents.send('session:status', { active: true, ...result });
      return result;
    } catch (err) {
      console.error('[IPC] session:start failed:', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('session:stop', async () => {
    console.log('[IPC] session:stop');
    try {
      const result = await backendPost('/session/stop', {});
      mainWindow.webContents.send('session:status', { active: false, ...result });
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('session:pause', async () => {
    console.log('[IPC] session:pause');
    try {
      const result = await backendPost('/session/pause', {});
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Vision: forward a screen frame to the backend ────────────────────────
  ipcMain.handle('vision:frame', async (_event, frameB64) => {
    try {
      const result = await backendPost('/vision/analyze', { frame: frameB64 });
      // Push slide context to renderer if a slide change was detected
      if (result.slide_changed) {
        mainWindow.webContents.send('vision:slideContext', result);
      }
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Debrief ───────────────────────────────────────────────────────────────
  ipcMain.handle('debrief:generate', async () => {
    try {
      const result = await backendPost('/debrief/generate', {});
      mainWindow.webContents.send('debrief:ready', result);
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Open external links safely ────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    const allowed = ['https://notion.so', 'https://jira.', 'https://github.com'];
    if (allowed.some((prefix) => url.startsWith(prefix))) {
      await shell.openExternal(url);
    }
  });

  // ── PDF Generation — uses Electron's printToPDF (saves to Downloads) ──────
  ipcMain.handle('print:pdf', async (_event, htmlContent) => {
    const { BrowserWindow, app } = require('electron');
    const path = require('path');
    const fs   = require('fs');

    try {
      // Create a hidden window to render the PDF HTML
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      // Write HTML to a temp file and load it
      const tmpDir  = app.getPath('temp');
      const tmpFile = path.join(tmpDir, `meetintel_report_${Date.now()}.html`);
      fs.writeFileSync(tmpFile, htmlContent, 'utf8');
      await pdfWin.loadFile(tmpFile);

      // Generate PDF buffer
      const pdfData  = await pdfWin.webContents.printToPDF({
        pageSize:    'A4',
        margins:     { top: 20, bottom: 20, left: 15, right: 15 },
        printBackground: true,
      });
      pdfWin.close();

      // Save to Downloads
      const downloadsDir = app.getPath('downloads');
      const filename     = `MeetIntel_Report_${new Date().toISOString().slice(0,10)}.pdf`;
      const outPath      = path.join(downloadsDir, filename);
      fs.writeFileSync(outPath, pdfData);

      // Open the PDF in the default reader
      await shell.openPath(outPath);

      // Clean up temp file
      fs.unlink(tmpFile, () => {});

      return { success: true, path: outPath };
    } catch (err) {
      console.error('[IPC] print:pdf error:', err.message);
      return { error: err.message };
    }
  });
}

module.exports = { registerIpcHandlers };
