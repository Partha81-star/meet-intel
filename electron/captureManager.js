/**
 * electron/captureManager.js
 * MeetIntel — System Audio + Screen Capture Manager
 *
 * This module runs in the MAIN process context.
 * It uses Electron's desktopCapturer to enumerate sources,
 * then sends the chosen sourceId back to the renderer so it can
 * call getUserMedia() with the loopback audio constraint.
 *
 * Why desktopCapturer in main + getUserMedia in renderer?
 *   Electron's desktopCapturer.getSources() must run in the main process
 *   (or via preload), but getUserMedia() with chromeMediaSource must be
 *   called in the renderer's window context to get an actual MediaStream.
 *
 * Audio loopback strategy:
 *   - macOS: system audio available via desktopCapturer (loopback built-in)
 *   - Windows: requires a virtual audio device (e.g. VB-Cable / WASAPI loopback)
 *             — we instruct the user and attempt desktopCapturer screen source
 *               which on Windows 10+ captures system audio automatically.
 *   - Linux: PulseAudio monitor source via getUserMedia({ audio: true })
 */

const { desktopCapturer } = require('electron');

/**
 * Returns the best screen source for system audio capture.
 * On most platforms the "Entire Screen" source carries audio.
 *
 * @returns {Promise<Electron.DesktopCapturerSource>}
 */
async function getBestScreenSource() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });

  if (!sources || sources.length === 0) {
    throw new Error('No screen sources available. Check Screen Recording permission.');
  }

  // Prefer "Entire Screen" / "Screen 1" — the primary display
  const primary = sources.find((s) =>
    s.name.toLowerCase().includes('entire screen') ||
    s.name.toLowerCase().includes('screen 1') ||
    s.name.toLowerCase().includes('display 1')
  ) || sources[0];

  return primary;
}

/**
 * Returns all available window sources (for picker UI).
 * @returns {Promise<Electron.DesktopCapturerSource[]>}
 */
async function getAllSources() {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 240, height: 135 },
    fetchWindowIcons: true,
  });
}

/**
 * Serialises a DesktopCapturerSource to a plain object
 * safe to pass over the IPC bridge (thumbnail is a NativeImage).
 */
function serializeSource(source) {
  return {
    id: source.id,
    name: source.name,
    thumbnailDataURL: source.thumbnail?.toDataURL() || null,
    displayId: source.display_id,
  };
}

module.exports = { getBestScreenSource, getAllSources, serializeSource };
