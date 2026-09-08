<div align="center">

<img src=".readme/Logo.png" alt="NeoPin" width="120">

# NeoPin Server

**The self-hosted backend for [NeoPin](https://github.com/vxnsin/NeoPin).**
Accepts WebSocket connections from your phones, remembers where everyone is, and serves a live web dashboard.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com)
[![ws](https://img.shields.io/badge/WebSocket-ws%208-010101?style=flat-square)](https://github.com/websockets/ws)
[![License](https://img.shields.io/badge/License-MIT-d3171e?style=flat-square)](LICENSE)
[![App](https://img.shields.io/badge/App-main%20branch-d3171e?style=flat-square&logo=react&logoColor=white)](https://github.com/vxnsin/NeoPin)

<br>

<img src=".readme/dashboard-map.jpg" alt="Web dashboard with device map" width="820">

</div>

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Configuration](#configuration)
- [Console commands](#console-commands)
- [HTTP endpoints](#http-endpoints)
- [WebSocket protocol](#websocket-protocol)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Good to know](#good-to-know)

## What it does

- **Single process, no database.** Express for HTTP and `ws` for WebSockets on the same port. State lives in memory.
- **Shared-password auth.** Devices authenticate with the server password. A device that reconnects under the same name replaces its old connection and keeps its last position.
- **Live updates.** Every position change is broadcast to all devices and dashboards, throttled to twice a second. No polling.
- **Location relay.** Any client can ask the server to poll all devices; the server fans out `requestLocation`, waits up to 2 seconds for answers and returns the combined list.
- **Web dashboard.** Log in at `/login.html`, get a Leaflet map with colour-coded markers (online, stale, offline), a device list with jump-to and a live connection indicator.
- **Session cookies.** The dashboard login issues a random session token, not the password. Login attempts are rate limited.
- **Interactive console.** Type `help` in the running server to list devices, ping them, kick one or change the password.

## Quick start

Node.js 20 or newer.

```bash
git clone -b Server https://github.com/vxnsin/NeoPin.git neopin-server
cd neopin-server
npm install
npm start
```

On first start a `.env` is written with `PORT=3012` and the default password `neopin123`. **Change it before you expose the server**, either in `.env` or with `changePassword neopin123 <new>` in the console. Then open `http://<your-ip>:3012` in a browser or point the app at `ws://<your-ip>:3012`.

<div align="center">
<img src=".readme/setup.gif" alt="Terminal recording of the setup" width="600">
</div>

## Docker

The repository ships a `Dockerfile` and a `docker-compose.yml`.

```bash
git clone -b Server https://github.com/vxnsin/NeoPin.git neopin-server
cd neopin-server
# edit PASSWORD in docker-compose.yml
docker compose up -d --build
```

For the interactive console attach to the container (`docker attach <container>`, detach with `Ctrl+P Ctrl+Q`). Without a TTY the console is disabled and everything else works normally.

## Configuration

Values come from `.env` in the project root. Environment variables override the file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3012` | HTTP and WebSocket port |
| `PASSWORD` | `neopin123`, written on first start | Shared password for apps and the dashboard |

Timing constants (heartbeat 30 s, location wait 2 s, session lifetime 5 h, login limit 5 per minute) live in `src/config.js`.

## Console commands

| Command | Effect |
|---|---|
| `help` | List commands |
| `device-list` | Every known device with status, position and last ping |
| `sendPing [deviceId]` | Ask one device (or all) for a fresh location |
| `disconnect <deviceId>` | Close the connection of a device |
| `changePassword <current> <new>` | Change the password, effective immediately, and log out all dashboards |
| `sessions-clear` | Log out every dashboard session |

## HTTP endpoints

The dashboard and the API share a session cookie (`neopin_session`, HttpOnly, SameSite=Strict, Secure behind TLS) issued by `POST /login`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | session | Dashboard, redirects to `/login.html` when not logged in |
| `GET` | `/login.html` | – | Login page |
| `POST` | `/login` | – | Body `{ "password" }`, sets the session cookie. Rate limited, `429` when exceeded |
| `GET` | `/logout` | – | Destroys the session |
| `GET` | `/api/getData` | session | All devices as `[{ deviceId, position, lastPing, status }]` |
| `POST` | `/api/sendPing` | session | Body `{ "deviceId"? }`, asks one or all devices and returns the updated list |

## WebSocket protocol

Connect to the same host and port. Messages are JSON. The first message must authenticate.

**Client → Server**

| Message | Response |
|---|---|
| `{ "type": "authenticate", "deviceId", "password" }` | `{ "successful": true }` and a `dataResponse`, or close code `4000` `Unauthorized` |
| `{ "type": "authenticate", "viewer": true }` | Same, but for dashboards. Requires a valid session cookie on the upgrade request. Viewers are not listed as devices. |
| `{ "type": "ping" }` | `{ "type": "pong" }` |
| `{ "type": "pingDevices" }` | Fans out `requestLocation` to all other devices, then `dataResponse` |
| `{ "type": "getData" }` | `dataResponse` from cache |
| `{ "type": "updatePosition", "latitude", "longitude" }` | none, stores the position and broadcasts `dataResponse` to everyone |
| `{ "type": "locationError", "message" }` | none, logged |

**Server → Client**

| Message | Meaning |
|---|---|
| `{ "type": "requestLocation", "from"? }` | Reply with `updatePosition` |
| `{ "type": "dataResponse", "devices": [...] }` | Current device list, sent on every change |

The server also sends WebSocket-level pings every 30 seconds and terminates connections that do not answer.

## Project structure

```
server.js            # wiring, banner, shutdown
src/
├─ config.js         # .env handling, timing constants, password change
├─ devices.js        # in-memory device registry
├─ sessions.js       # dashboard session tokens and cookie helpers
├─ rateLimit.js      # fixed-window limiter for /login
├─ ws.js             # WebSocket protocol, heartbeat, broadcast
├─ http.js           # Express routes and static files
└─ console.js        # interactive commands
public/              # dashboard (index.html, login.html, styles)
test/                # node:test suites
```

## Tests

```bash
npm test
```

Runs unit tests for the device registry and sessions plus an integration suite that starts the server on a random port and exercises authentication, broadcast, reconnect, rate limiting and the dashboard viewer over real sockets.

## Good to know

- **State is in memory.** A restart forgets all devices and positions. Disconnected devices are kept and marked `offline` until the next restart.
- **Use TLS in the wild.** Put the server behind a reverse proxy (Caddy, nginx, Traefik) that terminates HTTPS and forwards WebSocket upgrades, then use `wss://` in the app. The password travels in plain text otherwise.
- **Behind a proxy** the server trusts `X-Forwarded-For` for rate limiting and `X-Forwarded-Proto` for the Secure cookie flag.

## License

[MIT](LICENSE)

---

<div align="center">
<sub>Part of <a href="https://github.com/vxnsin/NeoPin">NeoPin</a> · made by <a href="https://github.com/vxnsin">Vensin</a></sub>
</div>
