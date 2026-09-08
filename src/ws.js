import { WebSocketServer } from "ws";
import chalk from "chalk";
import { config } from "./config.js";
import {
  attachSocket,
  detachSocket,
  getDevice,
  onlineDevices,
  serializeDevices,
  updatePosition,
} from "./devices.js";
import { isValidSession, sessionFromCookieHeader } from "./sessions.js";

const CLOSE_POLICY = 4000;
const BROADCAST_THROTTLE_MS = 500;

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

export function createSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const viewers = new Set();
  let broadcastTimer = null;

  httpServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  // Sends the current device list to every device and dashboard, at most twice a second.
  function broadcastDevices() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const payload = { type: "dataResponse", devices: serializeDevices() };
      for (const device of onlineDevices()) send(device.socket, payload);
      for (const viewer of viewers) send(viewer, payload);
    }, BROADCAST_THROTTLE_MS);
  }

  // Asks devices for a fresh fix and resolves once they answered or the wait is over.
  function requestLocation(targetId, excludeId) {
    const targets = onlineDevices().filter(
      (d) => d.id !== excludeId && (!targetId || d.id === targetId)
    );
    const waits = targets.map(
      (device) =>
        new Promise((resolve) => {
          const onMessage = (raw) => {
            try {
              if (JSON.parse(raw.toString()).type === "updatePosition") done();
            } catch {
              // ignore unparsable messages here, the main handler logs them
            }
          };
          const done = () => {
            clearTimeout(timer);
            device.socket?.removeListener("message", onMessage);
            resolve();
          };
          const timer = setTimeout(done, config.locationWaitMs);
          device.socket.on("message", onMessage);
          send(device.socket, { type: "requestLocation", from: excludeId });
        })
    );
    return Promise.all(waits).then(() => targets.length);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log(
          chalk.yellow(`[Heartbeat] ${chalk.whiteBright(ws.label || "client")} stopped responding. Closing.`)
        );
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);

  wss.on("connection", (ws, request) => {
    let deviceId = null;
    let role = null;
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    const authenticate = (msg) => {
      if (msg.viewer) {
        const token = sessionFromCookieHeader(request.headers.cookie);
        if (!isValidSession(token)) {
          ws.close(CLOSE_POLICY, "Unauthorized");
          return false;
        }
        role = "viewer";
        ws.label = "dashboard";
        viewers.add(ws);
        send(ws, { successful: true });
        send(ws, { type: "dataResponse", devices: serializeDevices() });
        return true;
      }

      if (!msg.deviceId || msg.password !== config.password) {
        console.log(
          chalk.red(`[Failed] Unauthorized connection attempt from ${chalk.whiteBright(msg.deviceId || "Unknown")}`)
        );
        ws.close(CLOSE_POLICY, "Unauthorized");
        return false;
      }

      deviceId = String(msg.deviceId);
      role = "device";
      ws.label = deviceId;
      const replaced = attachSocket(deviceId, ws);
      if (replaced) {
        console.log(chalk.yellow(`[i] Device ${chalk.whiteBright(deviceId)} reconnected. Replacing the previous connection.`));
        replaced.replaced = true;
        replaced.terminate();
      } else {
        console.log(chalk.greenBright(`[+] Device ${chalk.whiteBright(deviceId)} connected.`));
      }
      send(ws, { successful: true });
      broadcastDevices();
      return true;
    };

    const handle = async (msg) => {
      switch (msg.type) {
        case "ping":
          send(ws, { type: "pong" });
          break;
        case "getData":
          send(ws, { type: "dataResponse", devices: serializeDevices() });
          break;
        case "pingDevices":
          await requestLocation(null, deviceId);
          send(ws, { type: "dataResponse", devices: serializeDevices() });
          break;
        case "updatePosition": {
          if (role !== "device") return;
          const { latitude, longitude } = msg;
          if (typeof latitude !== "number" || typeof longitude !== "number") return;
          updatePosition(deviceId, latitude, longitude);
          broadcastDevices();
          break;
        }
        case "locationError":
          console.log(chalk.yellow(`[!] ${chalk.whiteBright(deviceId)} could not read its location: ${msg.message}`));
          break;
        case "pong":
          break;
        default:
          console.log(`Unknown message type from ${ws.label || "client"}:`, msg.type);
      }
    };

    ws.on("message", (raw) => {
      ws.isAlive = true;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(CLOSE_POLICY, "Invalid message format");
        return;
      }
      if (!role) {
        authenticate(msg);
        return;
      }
      handle(msg).catch((error) => console.error("Error handling message:", error));
    });

    ws.on("close", () => {
      if (role === "viewer") {
        viewers.delete(ws);
        return;
      }
      if (role === "device" && !ws.replaced && detachSocket(deviceId, ws)) {
        console.log(chalk.redBright(`[-] Device ${chalk.whiteBright(deviceId)} disconnected. Marked offline.`));
        broadcastDevices();
      }
    });
  });

  return {
    wss,
    viewers,
    broadcastDevices,
    requestLocation,
    disconnectDevice(deviceId) {
      const device = getDevice(deviceId);
      device?.socket?.close(CLOSE_POLICY, "Disconnected by server");
    },
    close() {
      clearInterval(heartbeat);
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
