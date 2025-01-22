const express = require('express');
const WebSocket = require('ws');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const { default: chalk } = require("@stagas/chalk")
const readline = require("readline")
const app = express();
const moment = require('moment');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3012;
const PASSWORD  = 'neopin123';

const wss = new WebSocket.Server({ noServer: true });

const connectedDevices = new Map();

app.use(bodyParser.json());
app.use(cookieParser());

app.set("trust proxy", true)

app.use((req, res, next) => {
    res.set('X-Powered-By', 'NeoPin');
    res.set('X-Made-By', 'Vensin');
    res.set("X-Content-Type-Options", "nosniff")
    next(); 
});

app.use((req, res, next) => {
    console.log(`Request URL: ${req.url}`); 

    if(req.url === "/") {
        return checkAuth(req, res, next);  
    }
    next();
});


app.use(express.static(__dirname + '/public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.js')) {
            res.set('Content-Type', 'application/javascript');
        }
    }
}));



const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: 'Too many requests, please try again later.',
});

app.use(limiter);


function checkAuth(req, res, next) {
    const cookie = req.cookies.auth;
    if (cookie && cookie === PASSWORD) {
        return next();
    } else {
        res.redirect('/login.html');
    }
}


app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

app.post('/login', (req, res) => {
    const { password } = req.body; 
    if (password === PASSWORD) {
        res.cookie('auth', PASSWORD, { maxAge: 5 * 60 * 60 * 1000, httpOnly: true });
        res.status(200).json({ message: 'Login successful' }); 
    } else {
        console.log(password)
        res.status(401).send('Invalid password');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth');
    res.redirect('/login.html');
});

app.get('/', checkAuth, (req, res) => {
    res.send("test")
});



wss.on('connection', (ws) => {
    let deviceId;
    let password;
    let authenticated = false; 

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);

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
                const timestamp = new Date().toISOString(); 
                const deviceData = connectedDevices.get(deviceId);
                if(deviceData) {
                    deviceData.lastPing = timestamp;
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
                    } else {
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
            const devicesArray = Array.from(connectedDevices.entries());
            devicesArray.forEach(([deviceId, ws], index) => {
                const positionText = ws.position
                    ? `${ws.position.latitude} | ${ws.position.longitude}`
                    : 'No position';

                const lastPingText = ws.lastPing
                    ? `- Last Ping: ${timeAgo(ws.lastPing)}`
                    : '';

                const content = `Device ID: ${deviceId} - Position: ${positionText} ${lastPingText}`;
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
    if (connectedDevices.size === 0) {
        return res.status(400).json({ message: "No devices connected" });
    }

    const timestamp = new Date().toISOString();

    connectedDevices.forEach((ws, deviceId) => {
        const pingMessage = { ping: true, timestamp };
        ws.send(JSON.stringify(pingMessage), (err) => {
            if (err) {
                console.error(chalk.red(`[-] Error sending ping to device ${deviceId}:`, err));
            } else {
                console.log(chalk.green(`[+] Ping sent to device ${deviceId} at ${timestamp}`));
            }
        });
    });

    res.status(200).json({ message: "Ping sent to all devices", timestamp });
});

app.get("/getData", (req, res) => {
    if (connectedDevices.size === 0) {
        return res.status(200).json({ message: "No devices connected" });
    }

    const deviceData = Array.from(connectedDevices.entries()).map(([deviceId, ws]) => {
        const position = ws.position
            ? { latitude: ws.position.latitude, longitude: ws.position.longitude }
            : { latitude: null, longitude: null };

        return {
            deviceId,
            position,
            lastPing: ws.lastPing || null,
        };
    });

    res.status(200).json({ devices: deviceData });
});



app.get("/getData/count", (req, res) => {
    if (connectedDevices.size === 0) {
        return res.status(200).json({ message: "No devices connected" });
    }

    res.status(200).json({ count: connectedDevices.size });
});


server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

function timeAgo(timestamp) {
    const now = moment();
    const then = moment(timestamp);
    const diffInMinutes = now.diff(then, 'minutes');
    const diffInHours = now.diff(then, 'hours');
    const diffInDays = now.diff(then, 'days');

    if (diffInMinutes < 1) {
        return 'Just now';
    } else if (diffInMinutes === 1) {
        return '1 minute ago';
    } else if (diffInMinutes < 60) {
        return `${diffInMinutes} minutes ago`;
    } else if (diffInHours === 1) {
        return '1 hour ago';
    } else if (diffInHours < 24) {
        return `${diffInHours} hours ago`;
    } else if (diffInDays === 1) {
        return '1 day ago';
    } else {
        return `${diffInDays} days ago`;
    }
}