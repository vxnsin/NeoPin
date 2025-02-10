import { useRef } from "react";
import { registerHandlers } from "@/handlers/WebSocket";

export type MessageHandler = (data: any) => void;

export function useWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const messageListenersRef = useRef<MessageHandler[]>([]);
  const manuallyClosedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0); // internal counter
  const connectionParamsRef = useRef<{ url: string; deviceId: string; password: string } | null>(null);

  const MAX_RETRIES = 3; // Maximum retries set to 3

  /**
   * Options:
   *   reconnecting: boolean (if false, auto-reconnection is disabled)
   *   onMaxRetriesReached: optional callback when max retries are reached
   */
  const connect = (
    url: string,
    deviceId: string,
    password: string,
    options?: { reconnecting?: boolean; onMaxRetriesReached?: () => void }
  ): Promise<void> => {
    // Default auto-reconnection to true if not provided.
    const autoReconnect = options?.reconnecting !== undefined ? options.reconnecting : true;

    return new Promise((resolve, reject) => {
      // If auto-reconnect is enabled and we've reached the retry limit, call the callback and reject.
      if (autoReconnect && reconnectAttemptsRef.current >= MAX_RETRIES) {
        console.error("Max retry limit reached. Stopping reconnect attempts.");
        if (options?.onMaxRetriesReached) {
          options.onMaxRetriesReached();
        }
        reject(new Error("Max retry limit reached"));
        return;
      }

      manuallyClosedRef.current = false;
      connectionParamsRef.current = { url, deviceId, password };
      const socket = new WebSocket(url);
      socketRef.current = socket;

      // Log differently if autoReconnect is disabled.
      if (autoReconnect) {
        console.log(
          `Connecting to WebSocket... (Attempt ${reconnectAttemptsRef.current + 1}/${MAX_RETRIES})`
        );
      } else {
        console.log("Connecting to WebSocket...");
      }

      socket.addEventListener("open", () => {
        // On a successful connection, reset the internal retry counter.
        reconnectAttemptsRef.current = 0;
        const authMsg = JSON.stringify({ type: "authenticate", deviceId, password });
        socket.send(authMsg);

        const authResponseHandler = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.hasOwnProperty("successful")) {
              socket.removeEventListener("message", authResponseHandler);
              if (data.successful) {
                // Register message handlers after a successful authentication.
                registerHandlers({ addMessageListener, emit });
                resolve();
              } else {
                socket.close();
                reject(new Error("Authentication failed"));
              }
            }
          } catch (error) {
            socket.removeEventListener("message", authResponseHandler);
            socket.close();
            reject(new Error("Invalid authentication response"));
          }
        };

        socket.addEventListener("message", authResponseHandler);
      });

      socket.addEventListener("error", () => {
        console.error(
          `WebSocket error (Attempt ${autoReconnect ? reconnectAttemptsRef.current + 1 : ""}/${autoReconnect ? MAX_RETRIES : ""})`
        );
        reject(new Error("WebSocket error"));
      });

      socket.addEventListener("close", () => {
        if (!manuallyClosedRef.current && connectionParamsRef.current) {
          if (autoReconnect) {
            reconnectAttemptsRef.current++;
            if (reconnectAttemptsRef.current >= MAX_RETRIES) {
              console.error("Max retry limit reached. Not retrying further.");
              if (options?.onMaxRetriesReached) {
                options.onMaxRetriesReached();
              }
              return;
            }
            const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 5000);
            console.log(
              `Retrying WebSocket connection in ${delay / 1000}s... (Retry ${reconnectAttemptsRef.current}/${MAX_RETRIES})`
            );
            setTimeout(() => {
              connect(
                connectionParamsRef.current!.url,
                connectionParamsRef.current!.deviceId,
                connectionParamsRef.current!.password,
                options
              ).catch(() => {});
            }, delay);
          }
        }
      });

      socket.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
          return;
        }
        // Ignore authentication responses (handled above)
        if (data.hasOwnProperty("successful")) return;
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
      messageListenersRef.current = messageListenersRef.current.filter((l) => l !== listener);
    };
  };

  return { connect, close, emit, addMessageListener };
}
