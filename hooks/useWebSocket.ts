import { useEffect, useRef, useState } from "react";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";

interface AuthMessage {
  type: "authenticate";
  deviceId: string;
  password: string;
}

export interface WebSocketConfig {
  url: string;
  deviceId: string;
  password: string;
  onRequestLocation?: () => void | Promise<void>;
}

export function useAuthWebSocket(config?: WebSocketConfig) {
  const [messages, setMessages] = useState<any[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const { getValue } = useAsyncStorage('userData');
  const retryCountRef = useRef(0); 

  useEffect(() => {
    if (!config) return;

    const loadSavedData = async () => {
      try {
        const savedData = await getValue();
        if (!savedData) {
          console.error("No saved data found in AsyncStorage");
          return;
        }

        const parsedData = JSON.parse(savedData);
        const { username, serverIp, password } = parsedData || {};

        const deviceIdToUse = config.deviceId || username;
        const passwordToUse = config.password || password;
        const serverIpToUse = serverIp || config.url; 

        if (!deviceIdToUse || !passwordToUse) {
          console.error("Missing device ID or password");
          return;
        }

        if (!serverIpToUse) {
          console.error("No WebSocket server URL available");
          return;
        }

        setupWebSocket(serverIpToUse, deviceIdToUse, passwordToUse);
      } catch (error) {
        console.error("Error initializing WebSocket:", error);
      }
    };

    const setupWebSocket = (url: string, deviceId: string, password: string) => {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        retryCountRef.current = 0; 
        const authMsg: AuthMessage = { 
          type: "authenticate", 
          deviceId, 
          password 
        };
        ws.send(JSON.stringify(authMsg));
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          setMessages(prev => [...prev, data]);
          
          if (data.type === "requestLocation" && config.onRequestLocation) {
            await config.onRequestLocation();
          }
        } catch (error) {
          console.error("Error handling message:", error);
        }
      };

      ws.onerror = (e) => {
        console.error("WebSocket error:", e);
      };

      ws.onclose = (e) => {
        console.log(`WebSocket closed (code: ${e.code}, reason: ${e.reason})`);
        
        if (retryCountRef.current < 3) {
          const retryTime = Math.min(1000 * 2 ** retryCountRef.current, 30000);
          retryCountRef.current++;
          setTimeout(loadSavedData, retryTime);
        }
      };

      socketRef.current = ws;
    };

    loadSavedData();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [config, getValue]);

  const sendMessage = (msg: string | object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
      socketRef.current.send(payload);
    } else {
      console.warn("WebSocket is not open. Message not sent:", msg);
    }
  };

  return { messages, sendMessage };
}