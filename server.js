const express = require('express');
const WebSocket = require('ws');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const readline = require("readline");
const chalk = require("@stagas/chalk").default;
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3012;
const PASSWORD = process.env.PASSWORD || 'neopin123';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';
const GITHUB_REPO = process.env.GITHUB_REPO || 'https://api.github.com/repos/vxnsin/NeoPin';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'server';
const LAST_COMMIT_FILE = './last_commit.txt';

const CHECK_INTERVAL = 5 * 1000; 

const wss = new WebSocket.Server({ noServer: true });
const connectedDevices = new Map();

app.use(bodyParser.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later.',
});
app.use(limiter);

// Basic Auth
app.use(basicAuth({
    users: { "admin": PASSWORD },
    challenge: true,
    realm: "Restricted Area",
    unauthorizedResponse: 'Password required to access this resource'
}));

// WebSocket-Handling
wss.on('connection', (ws) => {
    let deviceId;
    let authenticated = false;

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);

            if (!authenticated) {
                deviceId = parsedMessage.deviceId;
                const password = parsedMessage.password;

                if (!deviceId || !password || password !== PASSWORD) {
                    ws.close(4000, 'Unauthorized');
                    return;
                }

                authenticated = true;
                connectedDevices.set(deviceId, ws);
                console.log(chalk.bold.greenBright(`[+] Device ${deviceId} connected`));
                ws.send(JSON.stringify({ successful: true }));
                return;
            }

            if (parsedMessage.latitude && parsedMessage.longitude) {
                const deviceData = connectedDevices.get(deviceId);
                if (deviceData) {
                    deviceData.position = {
                        latitude: parsedMessage.latitude,
                        longitude: parsedMessage.longitude,
                    };
                    console.log(`Device ${deviceId} position updated:`, deviceData.position);
                }
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        connectedDevices.delete(deviceId);
        console.log(chalk.bold.redBright(`[-] Device ${deviceId} disconnected`));
    });
});

// Commands über CLI
const commands = {
    help: () => {
        console.log(chalk.bold("Available commands:"));
        console.log(chalk.blue("sendPing [deviceId] 🡒 Sends a ping message to devices."));
        console.log(chalk.blue("device-list 🡒 Lists all connected devices."));
    },
    sendPing: (deviceId) => {
        connectedDevices.forEach((ws, id) => {
            if (!deviceId || deviceId === id) {
                ws.send(JSON.stringify({ ping: true }));
                console.log(`Ping sent to device ${id}`);
            }
        });
    },
    'device-list': () => {
        connectedDevices.forEach((_, id) => {
            console.log(chalk.greenBright(`Device ID: ${id}`));
        });
    }
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
    const [command, ...args] = line.trim().split(' ');
    commands[command]?.(...args) || console.log(chalk.red(`Unknown command: ${command}`));
});

// Auto-Updater
function fetchLatestCommit(callback) {
    const options = {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'GitHub Auto-Updater' }
    };
    https.get(`${GITHUB_REPO}/commits?sha=${GITHUB_BRANCH}`, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            const commits = JSON.parse(data);
            callback(null, commits[0]?.sha);
        });
    }).on('error', callback);
}

function updateServerJS(callback) {
    const options = {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'GitHub Auto-Updater' }
    };
    https.get(`${GITHUB_REPO}/contents/server.js?ref=${GITHUB_BRANCH}`, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            const content = Buffer.from(JSON.parse(data).content, 'base64').toString('utf8');
            fs.writeFile('./server.js', content, callback);
        });
    }).on('error', callback);
}

function autoUpdate() {
    fs.readFile(LAST_COMMIT_FILE, 'utf8', (err, lastCommit) => {
        fetchLatestCommit((err, latestCommit) => {
            if (err) return console.error('Error fetching commit:', err);
            if (latestCommit !== lastCommit) {
                console.log(chalk.yellow(`New commit detected: ${latestCommit}. Updating...`));
                updateServerJS((err) => {
                    if (err) return console.error('Error updating server.js:', err);
                    fs.writeFile(LAST_COMMIT_FILE, latestCommit, (err) => {
                        if (err) return console.error('Error writing last commit:', err);
                        console.log(chalk.greenBright('Update complete. Restarting server...'));
                        exec('npm restart', (err) => {
                            if (err) console.error('Error restarting server:', err);
                        });
                    });
                });
            } else {
                console.log(chalk.blue('No new updates.'));
            }
        });
    });
}

setInterval(autoUpdate, CHECK_INTERVAL);

const server = app.listen(PORT, () => {
    console.log(chalk.blue(`Server running at http://localhost:${PORT}`));
});

server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});
