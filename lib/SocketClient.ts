export type Message = Record<string, any>;
export type MessageListener = (data: Message) => void;
export type StatusListener = (connected: boolean) => void;
export type ConnectOptions = { autoReconnect?: boolean };

const HEARTBEAT_MS = 25_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUE = 50;

type Credentials = { url: string; deviceId: string; password: string };

export class SocketClient {
  connected = false;

  private socket: WebSocket | null = null;
  private credentials: Credentials | null = null;
  private autoReconnect = true;
  private closedManually = false;
  private everConnected = false;
  private retries = 0;
  private queue: Message[] = [];
  private listeners: MessageListener[] = [];
  private statusListeners: StatusListener[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get reconnectPending() {
    return this.reconnectTimer !== null;
  }

  connect(url: string, deviceId: string, password: string, options?: ConnectOptions): Promise<void> {
    this.credentials = { url, deviceId, password };
    this.autoReconnect = options?.autoReconnect ?? true;
    this.closedManually = false;
    this.everConnected = false;
    this.retries = 0;
    this.clearReconnectTimer();
    return this.open();
  }

  close() {
    this.closedManually = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    const ws = this.socket;
    this.socket = null;
    ws?.close();
    this.setConnected(false);
  }

  emit(msg: Message | string) {
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(typeof msg === "string" ? JSON.parse(msg) : msg);
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener);
    };
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.credentials) return reject(new Error("No credentials"));
      const { url, deviceId, password } = this.credentials;

      this.stopHeartbeat();
      const previous = this.socket;
      this.socket = null;
      previous?.close();

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (error: any) {
        return reject(new Error(error?.message || "Invalid server address"));
      }
      this.socket = ws;

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        fn();
      };
      const authTimer = setTimeout(() => {
        settle(() => reject(new Error("Authentication timed out")));
        ws.close();
      }, AUTH_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "authenticate", deviceId, password }));
      };

      ws.onmessage = (event) => {
        let data: Message;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if ("successful" in data) {
          if (data.successful) {
            this.retries = 0;
            this.everConnected = true;
            this.setConnected(true);
            this.startHeartbeat();
            this.flushQueue();
            settle(resolve);
          } else {
            this.closedManually = true;
            settle(() => reject(new Error("Authentication failed")));
            ws.close();
          }
          return;
        }

        if (data.type === "pong") return;
        this.listeners.forEach((listener) => listener(data));
      };

      ws.onerror = () => {
        settle(() => reject(new Error("Could not reach the server")));
      };

      ws.onclose = (event) => {
        if (this.socket !== ws) return;
        this.socket = null;
        this.stopHeartbeat();
        this.setConnected(false);
        settle(() => reject(new Error(event.reason || `Connection closed (${event.code})`)));

        if (!this.closedManually && this.autoReconnect && this.everConnected) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    this.retries += 1;
    const delay = Math.min(1000 * 2 ** this.retries, MAX_BACKOFF_MS);
    console.log(`WebSocket lost, reconnecting in ${delay / 1000}s (attempt ${this.retries})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open().catch(() => {});
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private flushQueue() {
    while (this.queue.length && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(this.queue.shift()));
    }
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.statusListeners.forEach((listener) => listener(value));
  }
}
