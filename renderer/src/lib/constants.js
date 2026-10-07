// renderer/src/lib/constants.js
// Centralised configuration — override with environment variables

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';
export function websocketUrl(sessionId) {
  const base = process.env.NEXT_PUBLIC_WS_URL || (
    typeof window !== 'undefined'
      ? (['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port === '3000'
        ? 'ws://127.0.0.1:8000/ws/transcribe'
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws/transcribe`)
      : ''
  );
  return `${base}?session_id=${encodeURIComponent(sessionId || '')}`;
}
