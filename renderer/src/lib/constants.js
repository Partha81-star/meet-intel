// renderer/src/lib/constants.js
// Centralised configuration — override with environment variables

export const WS_URL   = process.env.NEXT_PUBLIC_WS_URL   || 'ws://127.0.0.1:8000/ws/transcribe';
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE  || 'http://127.0.0.1:8000';
export const MODELS   = {
  stt:    'nova-2',
  text:   'gemini-1.5-flash',
  vision: 'gemini-1.5-pro',
};
