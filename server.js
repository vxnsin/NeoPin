const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const basicAuth = require('express-basic-auth');
const os = require('os');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 3000;
const devicesFile = 'devices.json';

app.use(bodyParser.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: 'Too many requests, please try again later.'
});

app.use(limiter);

app.use(basicAuth({
    users: { "admin": "test" },
    challenge: true,
    realm: "Restricted Area",
    unauthorizedResponse: 'Password required to access this resource'
}));

let locations = [];
let devices = [];

const ensureDevicesFileExists = () => {
    if (!fs.existsSync(devicesFile)) {
        fs.writeFileSync(devicesFile, JSON.stringify([], null, 2)); 
    }
};

const getDevices = () => {
    try {
        ensureDevicesFileExists(); 
        const data = fs.readFileSync(devicesFile);
        devices = JSON.parse(data);
    } catch (error) {
        console.error("Error reading devices: " + error);
    }
};

const updateDevicesFile = () => {
    try {
        fs.writeFileSync(devicesFile, JSON.stringify(devices, null, 2));
    } catch (error) {
        console.error("Error writing devices to file: " + error);
    }
};

app.post('/checkLogin', (req, res) => {
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ error: "Password is required" });
    }
    
    if (password === process.env.AUTH_PASSWORD) {
        res.status(200).json({ message: "Login successful" });
    } else {
        res.status(401).json({ error: "Invalid password" });
    }
});

app.post('/register-device', (req, res) => {
    const { id, name } = req.body;

    if ( !id || !name) {
        return res.status(400).json({ error: "ID (Name), and Name are required" });
    }

    getDevices();

    const existingDevice = devices.find(dev => dev.id === id);
    if (existingDevice) {
        return res.status(400).json({ error: "Device with this ID already exists" });
    }

    const newDevice = { id: name }; 
    devices.push(newDevice);

    updateDevicesFile(); 

    res.status(201).json({ message: "Device registered successfully", device: newDevice });
});

app.post('/location', (req, res) => {
    const { id, latitude, longitude } = req.body;

    if (!id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: "ID, Latitude, and Longitude are required" });
    }

    const existingDevice = devices.find(dev => dev.id === id);
    if (!existingDevice) {
        return res.status(400).json({ error: "Device not found" });
    }

    const existingLocation = locations.findIndex(loc => loc.id === id);
    const timestamp = new Date().toISOString();
    const newLocation = { id, latitude, longitude, timestamp };

    if (existingLocation !== -1) {
        locations[existingLocation] = newLocation;
        res.status(202).json(newLocation);
    } else {
        locations.push(newLocation);
        res.status(202).json(newLocation);
    }
});

app.get('/locations', (req, res) => {
    if (locations.length === 0) {
        return res.status(400).json({ error: "There are no locations" });
    }

    res.status(200).json(locations);
});

app.get('/location/:id', (req, res) => {
    const { id } = req.params;
    const location = locations.find(loc => loc.id === id);

    if (!location) {
        return res.status(400).json({ error: "Location not found" });
    }

    res.status(200).json(location);
});

const getServerIp = () => {
    const networkInterfaces = os.networkInterfaces();
    for (let interfaceName in networkInterfaces) {
        for (let networkInterface of networkInterfaces[interfaceName]) {
            if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
                return networkInterface.address;
            }
        }
    }
    return 'localhost';
};

const serverIp = getServerIp();

app.listen(PORT, () => {
    console.log("NeoPin Backend - v0.5");
    console.log("Made by Vensin");
    console.log(`Server is running on http://${serverIp}:${PORT}`);
});
