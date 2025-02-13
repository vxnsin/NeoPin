import { useRef, useState } from "react";
import { registerHandlers } from "@/handlers/WebSocket";

export type MsgHandler = (data: any) => void;

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const listeners = useRef<MsgHandler[]>([]);
  const closedManually = useRef(false);
  const retryCount = useRef(0);
  const connectionParm = useRef<{
    url: string;
    deviceId: string;
    password: string;
  } | null>(null);
  const messageQueue = useRef<any[]>([]);

  const MAX_RETRIES = 3;

  const connect = (
    url: string,
    deviceId: string,
    password: string,
    options?: { reconnecting?: boolean; onMaxRetriesReached?: () => void }
  ): Promise<void> => {
    const autoReconnect = options?.reconnecting !== false;

    return new Promise((resolve, reject) => {
      if (
        !options?.reconnecting &&
        autoReconnect &&
        retryCount.current >= MAX_RETRIES
      ) {
        console.error("Max retry limit reached. Stopping reconnect attempts.");
        options?.onMaxRetriesReached?.();
        return reject(new Error("Max retry limit reached"));
      }

      closedManually.current = false;
      connectionParm.current = { url, deviceId, password };
      const ws = new WebSocket(url);
      socket.current = ws;

      console.log(
        `Connecting... (Attempt ${retryCount.current + 1}${
          options?.reconnecting ? "" : `/${MAX_RETRIES}`
        })`
      );

      ws.addEventListener("open", () => {
        retryCount.current = 0;
        setIsConnected(true);
        ws.send(JSON.stringify({ type: "authenticate", deviceId, password }));

        const authHandler = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if ("successful" in data) {
              ws.removeEventListener("message", authHandler);
              if (data.successful) {
                registerHandlers({ addMessageListener, emit });

                while (messageQueue.current.length) {
                  emit(messageQueue.current.shift());
                }

                resolve();
              } else {
                ws.close();
                reject(new Error("Authentication failed"));
              }
            }
          } catch {
            ws.removeEventListener("message", authHandler);
            ws.close();
            reject(new Error("Invalid authentication response"));
          }
        };

        ws.addEventListener("message", authHandler);
      });

      ws.addEventListener("error", () => {
        console.error(
          `WebSocket error (Attempt ${retryCount.current + 1}${
            options?.reconnecting ? "" : `/${MAX_RETRIES}`
          })`
        );
        setIsConnected(false);
        reject(new Error("WebSocket error"));
      });

      ws.addEventListener("close", () => {
        setIsConnected(false);
        if (!closedManually.current && connectionParm.current) {
          if (autoReconnect) {
            retryCount.current++;
            const delay = Math.min(
              1000 * Math.pow(2, retryCount.current),
              5000
            );
            console.log(
              `Retrying WebSocket connection in ${delay / 1000}s... (Retry ${
                retryCount.current
              })`
            );
            setTimeout(() => {
              connect(
                connectionParm.current!.url,
                connectionParm.current!.deviceId,
                connectionParm.current!.password,
                { ...options, reconnecting: true }
              ).catch(() => {});
            }, delay);
          }
        }
      });

      ws.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
          return;
        }
        if (data.hasOwnProperty("successful")) return;
        listeners.current.forEach((listener) => listener(data));
      });
    });
  };

  const close = () => {
    console.log("Closing WebSocket");
    closedManually.current = true;
    setIsConnected(false);
    if (socket.current) {
      socket.current.close();
      socket.current = null;
    }
  };

  const emit = (msg: any) => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket is not open. Queuing message:", msg);
      messageQueue.current.push(msg);
      return;
    }

    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    console.log("Sending message to WebSocket:", payload);
    socket.current.send(payload);
  };

  const addMessageListener = (listener: MsgHandler): (() => void) => {
    listeners.current.push(listener);
    return () => {
      listeners.current = listeners.current.filter((l) => l !== listener);
    };
  };

  return { connect, close, emit, addMessageListener, isConnected };
}
