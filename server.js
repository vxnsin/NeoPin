import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import chalk from "chalk";
import readline from "readline";
import cookieParser from "cookie-parser";
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");

if (!fs.existsSync(envPath)) {
  const defaultEnvContent = `PASSWORD=neopin123\nPORT=3012`;
  fs.writeFileSync(envPath, defaultEnvContent, "utf8");
  console.log(".env file created with default values.");
}

dotenv.config();

const app = express();
const PORT = process.env.PORT;
const PASSWORD = process.env.PASSWORD;

const wss = new WebSocketServer({ noServer: true });

// Map to store connected devices.
// Instead of removing devices on disconnect, we'll mark them as offline.
const connectedDevices = new Map();

// Middleware
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.set("trust proxy", true);

// Request logging and authentication check
app.use((req, res, next) => {
  console.log(`Request URL: ${req.url}`);
  if (req.url === "/") return checkAuth(req, res, next);
  next();
});

// Authentication Check
function checkAuth(req, res, next) {
  const cookie = req.cookies.auth;
  if (cookie && cookie === PASSWORD) {
    return next();
  }
  res.redirect("/login.html");
}

// Login Route
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

// Login POST Request
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.cookie("auth", PASSWORD, {
      maxAge: 5 * 60 * 60 * 1000,
      httpOnly: true,
    });
    res.status(200).json({ message: "Login successful" });
  } else {
    res.status(401).send("Invalid password");
  }
});

// Logout Route
app.get("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});

// WebSocket connection handling
wss.on("connection", (ws) => {
  let deviceId;
  let password;
  let authenticated = false;

  ws.on("message", async (message) => {
    try {
      const messageStr = message.toString();
      if (!messageStr.trim()) {
        ws.close(4000, "Invalid message format");
        return;
      }
      const parsedMessage = JSON.parse(messageStr);

      if (!authenticated) {
        deviceId = parsedMessage.deviceId;
        password = parsedMessage.password;

        console.log(
          chalk.blueBright(
            `[i] Device ${chalk.whiteBright(deviceId || "Unknown")} is attempting to connect...`
          )
        );

        // Check if a device with the same ID is already connected and online.
        if (deviceId && connectedDevices.has(deviceId)) {
          const existingWs = connectedDevices.get(deviceId);
          if (existingWs && existingWs.status === "online") {
            console.log(
              chalk.red(
                `[Failed] Device ${chalk.whiteBright(deviceId)} is already connected. Rejecting duplicate connection.`
              )
            );
            ws.close(4000, "Device already connected");
            return;
          }
        }

        if (!deviceId || password !== PASSWORD) {
          console.log(
            chalk.red(
              `[Failed] Unauthorized device ${chalk.whiteBright(deviceId || "Unknown")} connection attempt!`
            )
          );
          ws.close(4000, "Unauthorized");
          return;
        }

        authenticated = true;
        // Save this connection
        connectedDevices.set(deviceId, ws);
        ws.status = "online"; // Mark the device as online
        console.log(
          chalk.greenBright(
            `[+] Device ${chalk.whiteBright(deviceId)} successfully connected!`
          )
        );
        ws.send(JSON.stringify({ successful: true }));
        return;
      }

      handleMessage(parsedMessage, deviceId, ws);
    } catch (error) {
      console.error("Error parsing message:", error);
    }
  });

  ws.on("close", () => {
    if (authenticated) {
      console.log(
        chalk.redBright(
          `[-] Device ${chalk.whiteBright(deviceId)} has disconnected. Marking as offline.`
        )
      );
      ws.status = "offline";
    }
  });
});

async function handleMessage(parsedMessage, deviceId, ws) {
  switch (parsedMessage.type) {
    case 'ping':
        ws.send(JSON.stringify({ type: "pong" }));
      break;
    case "pingDevices":
      console.log(
        chalk.blue(
          `[Ping] Device ${chalk.whiteBright(deviceId)} triggered a location update.`
        )
      );
      
      const responsePromises = [];

      connectedDevices.forEach((deviceWs, otherDeviceId) => {
        if (otherDeviceId !== deviceId) {
          const responsePromise = new Promise((resolve) => {
            const onMessage = (message) => {
              try {
                const data = JSON.parse(message);
                if (data.type === "updatePosition") {
                  deviceWs.removeListener("message", onMessage);
                  resolve();
                }
              } catch (err) {
                // Ignore errors.
              }
            };
            deviceWs.on("message", onMessage);
            setTimeout(() => {
              deviceWs.removeListener("message", onMessage);
              resolve();
            }, 2000);
          });

          responsePromises.push(responsePromise);
          deviceWs.send(JSON.stringify({ type: "requestLocation", from: deviceId }));
        }
      });

      Promise.all(responsePromises).then(() => {
        const deviceData = Array.from(connectedDevices.entries()).map(
          ([devId, devWs]) => ({
            deviceId: devId,
            position: devWs.position
              ? {
                  latitude: devWs.position.latitude,
                  longitude: devWs.position.longitude,
                }
              : null,
            lastPing: devWs.lastPing || null,
            status: devWs.status ? devWs.status : "online",
          })
        );
        ws.send(JSON.stringify({ type: "dataResponse", devices: deviceData }));
      });
      break;

    case "updatePosition":
      if (parsedMessage.latitude && parsedMessage.longitude) {
        const timestamp = new Date().toISOString();
        ws.lastPing = timestamp;
        ws.position = {
          latitude: parsedMessage.latitude,
          longitude: parsedMessage.longitude,
        };
        console.log(
          `[Response] Device ${chalk.whiteBright(deviceId)} position updated:`,
          ws.position
        );
      }
      break;

    case "getData":
      const deviceData = Array.from(connectedDevices.entries()).map(
        ([devId, devWs]) => ({
          deviceId: devId,
          position: devWs.position
            ? {
                latitude: devWs.position.latitude,
                longitude: devWs.position.longitude,
              }
            : null,
          lastPing: devWs.lastPing || null,
          status: devWs.status ? devWs.status : "online",
        })
      );
      ws.send(JSON.stringify({ type: "dataResponse", devices: deviceData }));
      break;

    default:
      console.log(
        `Unknown message type from device ${deviceId}:`,
        parsedMessage
      );
      break;
  }
}

const server = app.listen(PORT, async () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
  );
  const version = packageJson.version;

  console.clear();
  console.log(
    chalk.red("    _   __           ") + chalk.whiteBright("____  _ ")
  );
  console.log(
    chalk.red("   / | / /__  ____  ") + chalk.whiteBright("/ __ \\(_)___")
  );
  console.log(
    chalk.red("  /  |/ / _ \\/ __ \\") + chalk.whiteBright("/ /_/ / / __ \\")
  );
  console.log(
    chalk.red(" / /|  /  __/ /_/ ") + chalk.whiteBright("/ ____/ / / / /")
  );
  console.log(
    chalk.red("/_/ |_/___/\\____/") +
      chalk.whiteBright(`_/    /_/_/ /_/ v${version}`)
  );
  console.log(
    chalk.whiteBright(
      `Server running at ${chalk.red(`http://${getNetworkIp()}:${PORT}`)}`
    )
  );
  console.log(
    chalk.whiteBright(
      `Type '${chalk.red.bold("help")}' to see available commands`
    )
  );
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

function getNetworkIp() {
  const networkInterfaces = os.networkInterfaces();
  for (let interfaceName in networkInterfaces) {
    const interfaces = networkInterfaces[interfaceName];
    for (let interfaceDetails of interfaces) {
      if (interfaceDetails.family === "IPv4" && !interfaceDetails.internal) {
        return interfaceDetails.address;
      }
    }
  }
  return "127.0.0.1";
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: (line) => {
    const completions = Object.keys(commands);
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  },
});

const commands = {
  help: () => {
    console.log(chalk.bold("Available commands:"));
    console.log(
      chalk.whiteBright(
        `${chalk.red.bold("sendPing [deviceId]")} 🡒 Sends a ping message to all connected devices or a specific device if deviceId is provided`
      )
    );
    console.log(
      chalk.whiteBright(
        `${chalk.red.bold("device-list")} 🡒 Lists all connected devices`
      )
    );
    console.log(
      chalk.whiteBright(
        `${chalk.red.bold("changePassword [currentPassword] [newPassword]")} 🡒 Change the password for authentication`
      )
    );
  },
  sendPing: (deviceId) => {
    if (connectedDevices.size === 0) {
      console.log(chalk.yellow("No devices connected."));
    } else if (deviceId) {
      const ws = connectedDevices.get(deviceId);
      if (ws) {
        ws.send(JSON.stringify({ type: "requestLocation" }), (err) => {
          if (err) {
            console.error(
              `Error sending requestLocation to device ${chalk.whiteBright(deviceId)}:`,
              err
            );
          } else {
            console.log(
              chalk.red.bold(
                `Location Request sent to device ${chalk.whiteBright(deviceId)}`
              )
            );
          }
        });
      } else {
        console.log(chalk.red(`Device ${chalk.whiteBright(deviceId)} not found.`));
      }
    } else {
      connectedDevices.forEach((ws, deviceId) => {
        ws.send(JSON.stringify({ type: "requestLocation" }), (err) => {
          if (err) {
            console.error(`Error sending requestLocation to device ${chalk.whiteBright(deviceId)}:`, err);
          } else {
            console.log(chalk.red.bold(`Location Request sent to all devices`));
          }
        });
      });
    }
  },
  "device-list": () => {
    if (connectedDevices.size === 0) {
      console.log(chalk.yellow("No devices connected."));
    } else {
      const devicesArray = Array.from(connectedDevices.entries());
      devicesArray.forEach(([deviceId, ws], index) => {
        const positionText = ws.position ? `${ws.position.latitude} | ${ws.position.longitude}` : "No position";
        const lastPingText = ws.lastPing ? `- Last Ping: ${timeAgo(ws.lastPing)}` : "";
        const statusText = ws.status ? ws.status : "online";
        const content = `ID: ${deviceId} - Position: ${positionText} ${lastPingText} - Status: ${statusText}`;
        const prefix = index === 0 ? "┏" : index === devicesArray.length - 1 ? "┗" : "┣";
        console.log(chalk.whiteBright(`${prefix} ${chalk.whiteBright(content)}`));
      });
    }
  },
  changePassword: (currentPassword, newPassword) => {
    if (!currentPassword || !newPassword) {
      console.log(chalk.red("Please provide both current and new password."));
      return;
    }
    if (currentPassword !== PASSWORD) {
      console.log(chalk.red("Current password is incorrect."));
      return;
    }
    process.env.PASSWORD = newPassword;
    console.log(chalk.green(`[+] ${chalk.whiteBright("Password changed successfully.")}`));
    const envFilePath = path.join(__dirname, ".env");
    const envFile = fs.readFileSync(envFilePath, "utf-8");
    const updatedEnvFile = envFile.replace(`PASSWORD=${PASSWORD}`, `PASSWORD=${newPassword}`);
    fs.writeFileSync(envFilePath, updatedEnvFile);
    console.log(
      chalk.green(
        `[+] ${chalk.whiteBright("The password has been successfully updated. Please restart the server to apply the change.")}`
      )
    );
  },
};

rl.on("line", (input) => {
  const [command, ...args] = input.trim().split(" ");
  if (commands[command]) {
    commands[command](...args);
  } else {
    console.log(chalk.red(`Unknown command: ${command}`));
  }
});

app.get("/api/getData", checkAuth, (req, res) => {
  if (connectedDevices.size === 0) {
    return res.status(202).json({ message: "No devices connected" });
  }
  const deviceData = Array.from(connectedDevices.entries()).map(([deviceId, ws]) => {
    const position = ws.position
      ? { latitude: ws.position.latitude, longitude: ws.position.longitude }
      : { latitude: null, longitude: null };
    return {
      deviceId,
      position,
      lastPing: ws.lastPing || null,
      status: ws.status ? ws.status : "online",
    };
  });
  console.log(deviceData);
  res.json(deviceData);
});

app.post("/api/sendPing", checkAuth, (req, res) => {
  const { deviceId } = req.body;
  if (connectedDevices.size === 0) {
    return res.status(202).json({ message: "No devices connected" });
  }
  if (deviceId) {
    const ws = connectedDevices.get(deviceId);
    if (ws) {
      ws.send(JSON.stringify({ type: "requestLocation" }), (err) => {
        if (err) {
          return res.status(500).json({ message: `Error sending requestLocation to device ${deviceId}: ${err}` });
        }
        return res.json({ message: `Location request sent to device ${deviceId}` });
      });
    } else {
      return res.status(202).json({ message: `Device ${deviceId} not found` });
    }
  } else {
    connectedDevices.forEach((ws, deviceId) => {
      ws.send(JSON.stringify({ type: "requestLocation" }), (err) => {
        if (err) {
          console.error(`Error sending requestLocation to device ${deviceId}:`, err);
        }
      });
    });
    return res.json({ message: `Location request sent to all devices` });
  }
});

function timeAgo(timestamp) {
  const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) {
    return Math.floor(interval) + " years ago";
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + " months ago";
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + " days ago";
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + " hours ago";
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + " minutes ago";
  }
  return Math.floor(seconds) + " seconds ago";
}