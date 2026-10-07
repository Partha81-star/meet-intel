/**
 * electron/main.js
 * MeetIntel — Electron Main Process  (Production-Ready Audit)
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow
 *  - Register system-level IPC handlers (session, vision, debrief, cleanup)
 *  - Set up the system tray icon
 *  - Request screen/audio capture permissions (macOS)
 *  - Configure Content Security Policy for the renderer
 *
 * WebSocket strategy (binary buffering):
 *  - binaryType = 'arraybuffer' is set on the renderer-side AudioStreamer.
 *  - The main process never touches the WS binary stream; it is a direct
 *    renderer ↔ FastAPI pipe.  The IPC bridge here only handles control
 *    signals (session start/stop, debrief trigger, vision frames).
 *
 * Graceful degradation:
 *  - All IPC handlers catch errors and return { error } objects instead of
 *    throwing, so the renderer never sees an unhandled rejection.
 *  - Backend connectivity failures are surfaced as 'backend:error' events.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  systemPreferences,
  session,
  shell,
} = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./ipcHandlers');

// ─── Constants ────────────────────────────────────────────────────────────────
const isDev        = !app.isPackaged && process.env.NODE_ENV !== 'production';
const BACKEND_BASE = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const RENDERER_URL = isDev
  ? 'http://localhost:3000'
  : `file://${path.join(__dirname, '../renderer/out/index.html')}`;

let mainWindow = null;
let tray       = null;

// ─── Window Factory ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1400,
    height:          900,
    minWidth:        1100,
    minHeight:       700,
    // 'hiddenInset' gives sleek macOS look; falls back gracefully on Windows
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    vibrancy:        'ultra-dark',         // macOS frosted glass (no-op on Windows)
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,              // Security: renderer talks to main ONLY via preload
      nodeIntegration:  false,             // Never expose Node.js APIs to untrusted renderer code
      sandbox:          false,             // Required for desktopCapturer in preload
      webSecurity:      true,
      // Content-Security-Policy is set in session handler below
    },
  });

  mainWindow.loadURL(RENDERER_URL);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ─── Tray Icon ────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../renderer/public/logo.png');
  try {
    tray = new Tray(iconPath);
  } catch (_iconErr) {
    // Graceful degradation: icon file missing in dev — skip tray
    console.warn('[MeetIntel] Tray icon not found — skipping tray setup');
    tray = null;
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open MeetIntel',  click: () => mainWindow?.show() },
    { type:  'separator' },
    { label: 'Quit',            click: () => app.quit() },
  ]);

  tray.setToolTip('MeetIntel — Meeting Intelligence');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

// ─── macOS Permission Helpers ─────────────────────────────────────────────────
async function requestMacPermissions() {
  if (process.platform !== 'darwin') return;

  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  if (screenStatus !== 'granted') {
    console.warn(
      '[MeetIntel] Screen recording not granted. ' +
      'Open System Settings → Privacy & Security → Screen Recording.'
    );
  }
}

// ─── Backend Health Probe ─────────────────────────────────────────────────────
/**
 * Polls the FastAPI backend until it is ready or times out.
 * Emits 'backend:ready' / 'backend:error' to the renderer.
 * @param {BrowserWindow} win
 * @param {number} retries
 * @param {number} intervalMs
 */
async function waitForBackend(win, retries = 30, intervalMs = 1000) {
  const { net } = require('electron');
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = net.request(`${BACKEND_BASE}/health`);
        req.on('response', (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
        req.on('error', reject);
        req.end();
      });
      console.log('[MeetIntel] Backend ready ✓');
      win.webContents.send('backend:ready', { url: BACKEND_BASE });
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const msg = `Backend not reachable at ${BACKEND_BASE} after ${retries}s`;
  console.error('[MeetIntel]', msg);
  // Graceful degradation: notify renderer — app continues in mock mode
  win?.webContents.send('backend:error', { message: msg });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // ── Content-Security-Policy ──────────────────────────────────────────────
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:3000 http://127.0.0.1:8000 ws://localhost:3000 ws://127.0.0.1:8000 data: blob:; " +
          "connect-src 'self' http://localhost:3000 http://127.0.0.1:8000 ws://localhost:3000 ws://127.0.0.1:8000;",
        ],
      },
    });
  });

  // ── Media / capture permissions ──────────────────────────────────────────
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const ALLOWED = ['media', 'display-capture', 'audioCapture', 'desktopCapture'];
    callback(ALLOWED.includes(permission));
  });

  await requestMacPermissions();

  const win = createWindow();
  registerIpcHandlers(ipcMain, win);
  createTray();

  // Probe backend in background — non-blocking
  waitForBackend(win).catch((err) => {
    console.error('[MeetIntel] waitForBackend fatal:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Security: Block all navigation to external origins ───────────────────────
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      return;
    }
    const SAFE_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    const SAFE_PROTOCOLS = ['file:', 'app:'];
    if (
      !SAFE_ORIGINS.includes(parsedUrl.origin) &&
      !SAFE_PROTOCOLS.includes(parsedUrl.protocol)
    ) {
      console.warn(`[MeetIntel] Blocked navigation to: ${navigationUrl}`);
      event.preventDefault();
    }
  });

  // Block new window creation from renderer EXCEPT for print/PDF
  contents.setWindowOpenHandler(({ url }) => {
    // Allow PDF print windows (blank url, opened by handleDownloadPdf)
    if (!url || url === 'about:blank' || url === '') {
      return { action: 'allow' };
    }
    // Allow known safe URLs to open in the system browser
    const ALLOWED_EXTERNAL = ['https://notion.so', 'https://jira.', 'https://github.com'];
    if (ALLOWED_EXTERNAL.some((prefix) => url.startsWith(prefix))) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});
