const express = require('express');
const WebSocket = require('ws');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const { default: chalk } = require("@stagas/chalk")
const readline = require("readline")
const app = express();

const PORT = process.env.PORT || 3012;
const PASSWORD = process.env.PASSWORD || 'neopin123';


const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'https://api.github.com/repos/vxnsin/NeoPin';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const LAST_COMMIT_FILE = './last_commit.txt';

const CHECK_INTERVAL = 5 * 60 * 1000;

const wss = new WebSocket.Server({ noServer: true });

const connectedDevices = new Map();

app.use(bodyParser.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: 'Too many requests, please try again later.',
});

app.use(limiter);

app.use(basicAuth({
    users: { "admin": PASSWORD },
    challenge: true,
    realm: "Restricted Area",
    unauthorizedResponse: 'Password required to access this resource'
}));

wss.on('connection', (ws) => {
    let deviceId;
    let password;
    let authenticated = false; 

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);

            console.log(parsedMessage)

            if (!authenticated) {
                deviceId = parsedMessage.deviceId;
                password = parsedMessage.password;

                if (!deviceId || !password || password !== PASSWORD) {
                    ws.close(4000, 'Unauthorized');
                    return;
                }

                authenticated = true;
                connectedDevices.set(deviceId, ws);
                console.log(chalk.bold.greenBright(`[+] Device ${chalk.whiteBright(deviceId)} connected`));
                ws.send(JSON.stringify({ successful: true }));
                return;
            }

            if(parsedMessage.latitude && parsedMessage.longitude) {
                const deviceData = connectedDevices.get(deviceId);
                if(deviceData) {
                    deviceData.position = {
                    latitude: parsedMessage.latitude,
                    longitude: parsedMessage.longitude,
                }
                console.log(`Device ${deviceId} position updated:`, deviceData.position);
                }
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        connectedDevices.delete(deviceId);
        console.log(chalk.bold.redBright(`[-] Device ${chalk.whiteBright(deviceId)} disconnected`));
    });
});

const server = app.listen(PORT, () => {
    console.log(chalk.blue(`Server running at http://localhost:${PORT}`));
    console.log(chalk.blue(`Type '${chalk.bold("help")}' to see available commands`));
});


const commands = {
    help: () => {
        console.log(chalk.bold("Available commands:"));
        console.log(chalk.blue(`${chalk.bold("sendPing [deviceId]")} 🡒 Sends a ping message to all connected devices or a specific device if deviceId is provided`));
        console.log(chalk.blue(`${chalk.bold("device-list")} 🡒 Lists all connected devices`));
    },
    sendPing: (deviceId) => {
        if (connectedDevices.size === 0) {
            console.log(chalk.yellow("No devices connected."));
        } else if (deviceId) {
            const ws = connectedDevices.get(deviceId);
            if (ws) {
                const pingMessage = { ping: true };
                ws.send(JSON.stringify(pingMessage), (err) => {
                    if (err) {
                        console.error(`Error sending ping to device ${deviceId}:`, err);
                    } else {v
                        console.log(`Ping sent to device ${deviceId}`);
                    }
                });
            } else {
                console.log(chalk.red(`Device ${deviceId} not found.`));
            }
        } else {
            connectedDevices.forEach((ws, deviceId) => {
                const pingMessage = { ping: true };
                ws.send(JSON.stringify(pingMessage), (err) => {
                    if (err) {
                        console.error(`Error sending ping to device ${deviceId}:`, err);
                    } else {
                        console.log(`Ping sent to device ${deviceId}`);
                    }
                });
            });
        }
    },
    'device-list': () => {
        if (connectedDevices.size === 0) {
            console.log(chalk.yellow("No devices connected."));
        } else {
            const devicesArray = Array.from(connectedDevices.keys());
            devicesArray.forEach((deviceId, index) => {
                const content = `Device ID: ${deviceId} - Position: ${connectedDevices.get(deviceId).position ? `${connectedDevices.get(deviceId).position.latitude} | ${connectedDevices.get(deviceId).position.longitude}` : 'No position'}`;
                const prefix = index === 0 ? '┏' : index === devicesArray.length - 1 ? '┗' : '┣';
                console.log(chalk.greenBright(`${prefix} ${chalk.whiteBright(content)}`));
            });
        }
    }
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => {
        const completions = Object.keys(commands);
        const hits = completions.filter((c) => c.startsWith(line));
        return [hits.length ? hits : completions, line];
    }
});

rl.on('line', (input) => {
    const [command, ...args] = input.trim().split(' ');
    if (commands[command]) {
        commands[command](...args);
    } else {
        console.log(chalk.red(`Unknown command: ${command}`));
    }
});

app.post("/sendPing", (req, res) => {
    if(connectedDevices.size === 0) {
        return res.status(400).json({message: "No devices connected"});
    }

    connectedDevices.forEach((ws, deviceId) => {
        const pingMessage = { ping: true };
        ws.send(JSON.stringify(pingMessage), (err) => {
            if(err) { 
                console.error(`Error sending ping to device ${deviceId}:`, err)
            } else {
                console.log(`Ping sent to device ${deviceId}`)
            }
        })
    })

    res.status(200).json({message: "Ping sent to all devices"});
})

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});