import { SocketClient } from "../lib/SocketClient";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1005, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "" });
  }

  static latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function connectAndAuthenticate(client: SocketClient) {
  const promise = client.connect("ws://server", "phone", "secret");
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ successful: true });
  await promise;
  return ws;
}

beforeEach(() => {
  // flush() waits for setImmediate, so that one has to stay real.
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  FakeWebSocket.instances = [];
  (global as any).WebSocket = FakeWebSocket;
});

afterEach(() => {
  jest.useRealTimers();
});

test("authenticates after the socket opens and resolves on success", async () => {
  const client = new SocketClient();
  const ws = await connectAndAuthenticate(client);

  expect(ws.url).toBe("ws://server");
  expect(ws.sent[0]).toEqual({ type: "authenticate", deviceId: "phone", token: "secret", deviceType: "phone" });
  expect(client.connected).toBe(true);
});

test("remembers the features of the server it is connected to, per connection", async () => {
  const client = new SocketClient();
  const promise = client.connect("ws://server", "phone", "secret");
  const first = FakeWebSocket.latest();
  first.open();
  first.receive({ successful: true, features: ["positionBatch", 7] });
  await promise;
  expect(client.features).toEqual(["positionBatch"]);

  first.drop();
  expect(client.features).toEqual(["positionBatch"]);
  jest.advanceTimersByTime(2_000);
  const second = FakeWebSocket.latest();
  expect(client.features).toEqual([]);
  second.open();
  second.receive({ successful: true });
  await flush();
  expect(client.features).toEqual([]);
});

test("waits for beforeConnect, so the login carries what it loaded", async () => {
  let ready!: () => void;
  const client = new SocketClient(() => new Promise<void>((resolve) => (ready = resolve)));
  const promise = client.connect("ws://server", "phone", "secret");
  expect(FakeWebSocket.instances).toHaveLength(0);
  ready();
  await flush();
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ successful: true });
  await promise;
  expect(client.connected).toBe(true);
});

test("a close while beforeConnect runs opens no socket", async () => {
  let ready!: () => void;
  const client = new SocketClient(() => new Promise<void>((resolve) => (ready = resolve)));
  const promise = client.connect("ws://server", "phone", "secret");
  client.close();
  ready();
  await expect(promise).rejects.toThrow();
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test("relogin logs in again on a fresh socket and stays connected", async () => {
  const client = new SocketClient();
  const states: boolean[] = [];
  client.onStatus((connected) => states.push(connected));
  const first = await connectAndAuthenticate(client);
  client.relogin();
  expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  const second = FakeWebSocket.latest();
  second.open();
  expect(second.sent[0].type).toBe("authenticate");
  second.receive({ successful: true });
  await flush();
  expect(client.connected).toBe(true);
  expect(states).toEqual([true]);
});

test("relogin does nothing while disconnected", () => {
  const client = new SocketClient();
  client.relogin();
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test("rejects on a failed authentication and does not reconnect", async () => {
  const client = new SocketClient();
  const promise = client.connect("ws://server", "phone", "wrong");
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ successful: false });

  await expect(promise).rejects.toThrow("Authentication failed");
  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("reconnects with back-off after the connection drops", async () => {
  const client = new SocketClient();
  const states: boolean[] = [];
  client.onStatus((connected) => states.push(connected));
  const first = await connectAndAuthenticate(client);

  first.drop();
  expect(client.connected).toBe(false);
  expect(FakeWebSocket.instances).toHaveLength(1);

  jest.advanceTimersByTime(2_000);
  expect(FakeWebSocket.instances).toHaveLength(2);
  const second = FakeWebSocket.latest();
  second.open();
  second.receive({ successful: true });
  await flush();

  expect(client.connected).toBe(true);
  expect(states).toEqual([true, false, true]);
});

test("stops reconnecting once the server closes with the policy code", async () => {
  const client = new SocketClient();
  const ws = await connectAndAuthenticate(client);

  ws.close(4000, "Unauthorized");

  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(client.rejected).toBe(true);
});

test("queues messages while offline and flushes them after authentication", async () => {
  const client = new SocketClient();
  client.emit({ type: "updatePosition", latitude: 1, longitude: 2 });

  const ws = await connectAndAuthenticate(client);

  expect(ws.sent).toEqual([
    { type: "authenticate", deviceId: "phone", token: "secret", deviceType: "phone" },
    { type: "updatePosition", latitude: 1, longitude: 2 },
  ]);
});

test("sends a heartbeat ping every 25 seconds", async () => {
  const client = new SocketClient();
  const ws = await connectAndAuthenticate(client);

  jest.advanceTimersByTime(25_000);
  jest.advanceTimersByTime(25_000);

  expect(ws.sent.filter((m) => m.type === "ping")).toHaveLength(2);
});

test("close() stops the reconnect loop", async () => {
  const client = new SocketClient();
  const ws = await connectAndAuthenticate(client);

  client.close();
  expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(client.connected).toBe(false);
});

test("delivers server messages to listeners but swallows pong", async () => {
  const client = new SocketClient();
  const received: any[] = [];
  client.onMessage((data) => received.push(data));
  const ws = await connectAndAuthenticate(client);

  ws.receive({ type: "pong" });
  ws.receive({ type: "requestLocation", from: "dashboard" });

  expect(received).toEqual([{ type: "requestLocation", from: "dashboard" }]);
});

test("authenticates with the token and tells listeners when it is refused", async () => {
  const client = new SocketClient();
  const refused = jest.fn();
  client.onRejected(refused);
  const ws = await connectAndAuthenticate(client);
  expect(ws.sent[0]).toEqual({ type: "authenticate", deviceId: "phone", token: "secret", deviceType: "phone" });

  ws.close(4000, "Unauthorized");
  expect(refused).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("a refused login at connect time notifies as well", async () => {
  const client = new SocketClient();
  const refused = jest.fn();
  client.onRejected(refused);
  const promise = client.connect("ws://server", "phone", "bad");
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ successful: false });
  await expect(promise).rejects.toThrow();
  expect(refused).toHaveBeenCalledTimes(1);
});

test("groupsChanged reaches the listeners", async () => {
  const client = new SocketClient();
  const received: any[] = [];
  client.onMessage((data) => received.push(data));
  const ws = await connectAndAuthenticate(client);
  ws.receive({ type: "groupsChanged" });
  expect(received).toEqual([{ type: "groupsChanged" }]);
});
