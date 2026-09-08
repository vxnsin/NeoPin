import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { config, rootDir } from "./config.js";
import { getDevice, onlineDevices, serializeDevices } from "./devices.js";
import { createRateLimiter } from "./rateLimit.js";
import {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  destroySession,
  isValidSession,
} from "./sessions.js";

export function createApp(sockets) {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(cookieParser());

  const requireSession = (req, res, next) => {
    if (isValidSession(req.cookies[SESSION_COOKIE])) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ message: "Unauthorized" });
    res.redirect("/login.html");
  };

  app.get("/", requireSession, (req, res, next) => next());
  app.use(express.static(path.join(rootDir, "public")));

  const loginLimiter = createRateLimiter(config.loginRateLimit);
  app.locals.loginLimiter = loginLimiter;

  app.post("/login", loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== "string" || password !== config.password) {
      return res.status(401).json({ message: "Invalid password" });
    }
    res.cookie(SESSION_COOKIE, createSession(), cookieOptions(req));
    res.json({ message: "Login successful" });
  });

  app.get("/logout", (req, res) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    res.redirect("/login.html");
  });

  app.get("/api/getData", requireSession, (req, res) => {
    res.json(serializeDevices());
  });

  app.post("/api/sendPing", requireSession, async (req, res) => {
    const { deviceId } = req.body || {};
    if (onlineDevices().length === 0) {
      return res.status(202).json({ message: "No devices connected" });
    }
    if (deviceId && !getDevice(deviceId)?.socket) {
      return res.status(404).json({ message: `Device ${deviceId} is not connected` });
    }
    const asked = await sockets.requestLocation(deviceId || null, null);
    sockets.broadcastDevices();
    res.json({
      message: deviceId ? `Location request sent to ${deviceId}` : `Location request sent to ${asked} devices`,
      devices: serializeDevices(),
    });
  });

  return app;
}
