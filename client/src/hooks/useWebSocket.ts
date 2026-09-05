import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

let sharedSocket: Socket | null = null;

// Ready promise: resolves once the shared socket has been created.
// Lets mount-time `subscribe()`/`emit()` calls queue instead of dropping on null.
let readyResolve: ((s: Socket) => void) | null = null;
let socketReadyPromise: Promise<Socket> = new Promise<Socket>((res) => {
  readyResolve = res;
});

const resolveReady = (s: Socket) => {
  if (readyResolve) {
    readyResolve(s);
    readyResolve = null;
  }
};

export const getSharedSocket = () => sharedSocket;
export const getSocketReadyPromise = () => socketReadyPromise;
// Alias for convenience.
export const waitForSocket = () => socketReadyPromise;

export const disconnectSocket = () => {
  if (sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
  }
  // Reset for the next connection cycle (only if previous promise already settled).
  if (!readyResolve) {
    socketReadyPromise = new Promise<Socket>((res) => {
      readyResolve = res;
    });
  }
};

export const useWebSocket = () => {
  const socketRef = useRef<Socket | null>(null);
  const [readySocket, setReadySocket] = useState<Socket | null>(() => sharedSocket);

  useEffect(() => {
    let mounted = true;
    const setupSocket = async () => {
      if (!sharedSocket) {
        let token: string | undefined = undefined;
        try {
          const auth = (await import('../services/firebase/config')).auth;
          token = await auth.currentUser?.getIdToken();
        } catch (e) {
          console.error('Failed to get auth token for WebSocket:', e);
        }

        const serverUrl = import.meta.env.VITE_API_URL || window.location.origin;
        sharedSocket = io(serverUrl, {
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
        });
        // Firebase ID tokens expire after 1h. The auth above is captured once,
        // so reconnects after expiry reuse a stale token and get rejected by
        // server verifyIdToken(). Refresh with a forced renewal so the next
        // handshake uses a fresh token.
        const refreshAuthToken = async () => {
          try {
            const { auth } = await import('../services/firebase/config');
            const freshToken = await auth.currentUser?.getIdToken(true);
            if (freshToken && sharedSocket) {
              (sharedSocket.auth as Record<string, unknown>) = { token: freshToken };
            }
          } catch (e) {
            console.error('Failed to refresh auth token for WebSocket:', e);
          }
        };
        sharedSocket.on('connect_error', () => {
          void refreshAuthToken();
        });
        sharedSocket.on('reconnect_attempt', () => {
          void refreshAuthToken();
        });
        sharedSocket.io.on('reconnect_attempt', () => {
          void refreshAuthToken();
        });
        resolveReady(sharedSocket);
      } else {
        resolveReady(sharedSocket);
      }
      socketRef.current = sharedSocket;
      if (mounted) setReadySocket(sharedSocket);
    };
    setupSocket();

    // If another instance already created the socket, sync this instance.
    socketReadyPromise.then((s) => {
      if (mounted) {
        socketRef.current = s;
        setReadySocket(s);
      }
    });

    return () => {
      mounted = false;
      // Don't disconnect the shared socket on component unmount
    };
  }, []);

  const emit = useCallback((event: string, data?: any) => {
    const s = socketRef.current ?? sharedSocket;
    if (s) {
      s.emit(event, data);
    } else {
      // Queue until socket ready instead of dropping on mount race.
      socketReadyPromise.then((sock) => {
        sock.emit(event, data);
      });
    }
  }, []);

  const subscribe = useCallback((event: string, callback: (...args: any[]) => void) => {
    const socket = socketRef.current ?? sharedSocket;
    if (socket) {
      socket.on(event, callback);
      return () => {
        socket.off(event, callback);
      };
    }
    // Socket not ready yet (async setup on mount): queue subscription.
    let cancelled = false;
    let boundSocket: Socket | null = null;
    socketReadyPromise.then((sock) => {
      if (cancelled) return;
      boundSocket = sock;
      sock.on(event, callback);
    });
    return () => {
      cancelled = true;
      if (boundSocket) {
        boundSocket.off(event, callback);
      } else {
        // Covers attach-then-immediate-cleanup ordering: fall back to current shared socket.
        sharedSocket?.off(event, callback);
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    disconnectSocket();
    socketRef.current = null;
    setReadySocket(null);
  }, []);

  return {
    emit,
    subscribe,
    disconnect,
    socket: readySocket ?? socketRef.current,
    ready: socketReadyPromise,
    socketReady: socketReadyPromise,
    waitForSocket: getSocketReadyPromise,
  };
};
