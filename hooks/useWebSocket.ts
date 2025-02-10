import { useRef } from 'react';
import { registerHandlers } from '@/handlers/WebSocket';

export type MessageHandler = (data: any) => void;

export function useWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const messageListenersRef = useRef<MessageHandler[]>([]);
  const manuallyClosedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const connectionParamsRef = useRef<{ url: string; deviceId: string; password: string } | null>(null);

  const connect = (url: string, deviceId: string, password: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      manuallyClosedRef.current = false;
      connectionParamsRef.current = { url, deviceId, password };
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        const authMsg = JSON.stringify({ type: "authenticate", deviceId, password });
        socket.send(authMsg);

        const authResponseHandler = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.hasOwnProperty('successful')) {
              socket.removeEventListener('message', authResponseHandler);
              if (data.successful === true) {
                reconnectAttemptsRef.current = 0;
                // Auto-register default message handlers.
                registerHandlers({ addMessageListener, emit });
                resolve();
              } else {
                socket.close();
                reject(new Error("Authentication failed"));
              }
            }
          } catch (error) {
            socket.removeEventListener('message', authResponseHandler);
            socket.close();
            reject(new Error("Invalid authentication response"));
          }
        };

        socket.addEventListener('message', authResponseHandler);
      });

      socket.addEventListener('error', () => {
        reject(new Error("WebSocket error"));
      });

      socket.addEventListener('close', () => {
        if (!manuallyClosedRef.current && connectionParamsRef.current) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect(
              connectionParamsRef.current!.url,
              connectionParamsRef.current!.deviceId,
              connectionParamsRef.current!.password
            ).catch(() => {});
          }, delay);
        }
      });

      socket.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
          return;
        }
        if (data.hasOwnProperty('successful')) return;
        messageListenersRef.current.forEach((listener) => listener(data));
      });
    });
  };

  const close = () => {
    manuallyClosedRef.current = true;
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };

  const sendMessage = (msg: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket is not open"));
      }
      const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          socketRef.current?.removeEventListener('message', handler);
          resolve(data);
        } catch (error) {
          socketRef.current?.removeEventListener('message', handler);
          reject(error);
        }
      };
      socketRef.current.addEventListener('message', handler);
      socketRef.current.send(payload);
    });
  };

  const emit = (msg: any) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket is not open. Message not sent:", msg);
      return;
    }
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    socketRef.current.send(payload);
  };

  const addMessageListener = (listener: MessageHandler): (() => void) => {
    messageListenersRef.current.push(listener);
    return () => {
      messageListenersRef.current = messageListenersRef.current.filter(l => l !== listener);
    };
  };

  return { connect, close, sendMessage, emit, addMessageListener };
}
