'use client';

/**
 * useWebSocket.js
 * Manages the WebSocket connection to the FastAPI /ws/transcribe endpoint.
 *
 * Key design decisions:
 *  - All message handlers are stored in refs, not deps. This means changing
 *    a handler NEVER triggers a reconnect — only `url` and `enabled` do.
 *  - Connection only opens when `enabled` is true (i.e., session is active).
 *  - Retries on abnormal close codes only while still enabled.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const RECONNECT_DELAY = 3000;
const MAX_RETRIES     = 5;    // Reduced from 10 to prevent infinite retry storms

export function useWebSocket(url, {
  onTranscript,
  onActionItem,
  onSlideContext,
  onDebtItem,
  onIdentityUpdate,
  onError,
  enabled = false,
} = {}) {
  const wsRef         = useRef(null);
  const retryRef      = useRef(0);
  const retryTimerRef = useRef(null);
  const enabledRef    = useRef(enabled);
  const [connected, setConnected]   = useState(false);

  // Store all handlers in refs so they never trigger reconnects
  const handlersRef = useRef({});
  handlersRef.current = { onTranscript, onActionItem, onSlideContext, onDebtItem, onIdentityUpdate, onError };

  // Keep enabledRef in sync
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const disconnect = useCallback(() => {
    clearTimeout(retryTimerRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent retry on intentional close
      wsRef.current.close(1000, 'Session ended');
      wsRef.current = null;
    }
    setConnected(false);
    retryRef.current = 0;
  }, []);

  const connect = useCallback(() => {
    if (!url || !enabledRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)) {
      return; // Already connecting or connected
    }

    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected to', url);
        setConnected(true);
        retryRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) return; // Skip binary echo
        try {
          const msg = JSON.parse(event.data);
          const h   = handlersRef.current;
          switch (msg.type) {
            case 'transcript':      h.onTranscript?.(msg);      break;
            case 'action_item':     h.onActionItem?.(msg);      break;
            case 'slide_context':   h.onSlideContext?.(msg);    break;
            case 'debt_item':       h.onDebtItem?.(msg);        break;
            case 'identity_update': h.onIdentityUpdate?.(msg.map); break;
            case 'ping':            ws.send(JSON.stringify({ type: 'pong' })); break;
            case 'error':
              h.onError?.(msg.message);
              console.error('[WS] Backend error:', msg.message);
              break;
            default:
              console.debug('[WS] Unknown message type:', msg.type);
          }
        } catch (err) {
          console.error('[WS] JSON parse error:', err);
        }
      };

      ws.onclose = (event) => {
        console.warn('[WS] Closed', event.code, event.reason || '');
        wsRef.current = null;
        setConnected(false);

        // Only retry on abnormal closure, while session is still active
        if (enabledRef.current && event.code !== 1000 && event.code !== 1001 && retryRef.current < MAX_RETRIES) {
          retryRef.current += 1;
          console.log(`[WS] Retrying (${retryRef.current}/${MAX_RETRIES}) in ${RECONNECT_DELAY}ms...`);
          retryTimerRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };

      ws.onerror = (err) => {
        console.error('[WS] Connection error:', err);
        // onclose will handle retry
      };

    } catch (err) {
      console.error('[WS] Setup failed:', err);
    }
  }, [url]); // Only url — handlers are in refs, enabled is in a ref

  // Main effect: connect when enabled, disconnect when not
  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      disconnect();
    }
    return () => {
      // Cleanup on unmount
      clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
    };
  }, [enabled, connect, disconnect]);

  const sendAudioChunk = useCallback((buffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer);
    }
  }, []);

  return { connected, sendAudioChunk };
}
