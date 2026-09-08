import { useCallback, useEffect, useState } from "react";
import { socket } from "@/lib/socket";
import type { ConnectOptions, Message, MessageListener } from "@/lib/SocketClient";

export type MsgHandler = MessageListener;

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(socket.connected);

  useEffect(() => socket.onStatus(setIsConnected), []);

  const connect = useCallback(
    (url: string, deviceId: string, password: string, options?: ConnectOptions) =>
      socket.connect(url, deviceId, password, options),
    []
  );
  const close = useCallback(() => socket.close(), []);
  const emit = useCallback((msg: Message | string) => socket.emit(msg), []);
  const addMessageListener = useCallback((listener: MessageListener) => socket.onMessage(listener), []);

  return { connect, close, emit, addMessageListener, isConnected };
}
