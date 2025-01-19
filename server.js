const express = require('express');
const WebSocket = require('ws');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const os = require('os');
const { default: chalk } = require("@stagas/chalk")
const readline = require("readline")
const app = express();
const PORT = 3012;

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
    users: { "admin": "test" },
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

                if (!deviceId || !password || password !== 'test') {
                    ws.close(4000, 'Unauthorized');
                    return;
                }

                authenticated = true;
                connectedDevices.set(deviceId, ws);
                console.log(chalk.bold.greenBright(`[+] Device ${chalk.whiteBright(deviceId)} connected`));
                return;
            }

            if (parsedMessage.ping) {
                ws.send(JSON.stringify({ successful: 'Connected' }));
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
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

rl.on('line', (input) => {
    if(input.trim() === "help") {
        console.log("sendPing > Sends a ping message to all connected devices")
        console.log("device-list > Shows a list of all connected devices")
    }

    if(input.trim() === "sendPing") {
        if(connectedDevices.size === 0) {
            console.log(chalk.yellow("No devices connected."))
        } else {
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
        }
    }
    if(input.trim() === "device-list") {
        if(connectedDevices.size === 0) {
            console.log(chalk.yellow("No devices connected."))
        } else {
            const devicesArray = Array.from(connectedDevices.keys());
            devicesArray.forEach((_, index) => {
                const content = `Device ID: ${_} - Position: ${connectedDevices.get(_).position ? `${connectedDevices.get(_).position.latitude} | ${connectedDevices.get(_).position.longitude}` : 'No position'}`;
                const prefix = index === 0 ? '┏' : index === devicesArray.length - 0 ? '┗' : '┣';
                console.log(chalk.greenBright(`${prefix} ${chalk.whiteBright(content)}`));
            })
        }
    }
})

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