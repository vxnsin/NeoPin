import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(rootDir, ".env");
const DEFAULT_PORT = 3012;

if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, `PORT=${DEFAULT_PORT}\n`, "utf8");
  console.log(".env file created with default values.");
}

dotenv.config({ path: envPath, quiet: true });

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

export const config = {
  version: pkg.version,
  port: Number(process.env.PORT) || DEFAULT_PORT,
  // Accounts, profile pictures and the location history live in this SQLite file.
  dbPath: path.resolve(rootDir, process.env.DATABASE_PATH || "data/neopin.db"),
  // The admin that is created on the first start. A missing password is generated.
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || null,
  // Location history older than this is deleted at startup.
  historyDays: Number(process.env.HISTORY_DAYS) || 365,
  // Where the names of visited places come from, an Overpass API. "off" turns it off.
  placeLookupUrl:
    process.env.PLACE_LOOKUP_URL === "off" ? null : process.env.PLACE_LOOKUP_URL || "https://overpass-api.de/api/interpreter",
  // Asked when Overpass fails, a Photon reverse endpoint. "off" turns it off.
  placeFallbackUrl:
    process.env.PLACE_FALLBACK_URL === "off" ? null : process.env.PLACE_FALLBACK_URL || "https://photon.komoot.io/reverse",
  // Only behind a reverse proxy: take the client IP and https from X-Forwarded-*.
  trustProxy: process.env.TRUST_PROXY === "true",
  // Send the dashboard cookie over HTTPS only. Turn on once the server sits behind TLS.
  secureCookies: process.env.SECURE_COOKIES === "true",
  // Sessions live in memory, so a fresh secret per start costs nothing.
  sessionSecret: crypto.randomBytes(32).toString("base64url"),
  sessionTtlMs: 5 * 60 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  locationWaitMs: 2 * 1000,
  loginRateLimit: { windowMs: 60 * 1000, max: 5 },
  // Wrong logins over the socket and HTTP routes with a device token, per IP.
  deviceAuthLimit: { windowMs: 60 * 1000, max: 10 },
  // Profile picture uploads and downloads per IP, a whole family fits easily.
  avatarRateLimit: { windowMs: 60 * 1000, max: 120 },
  // A device without an open socket still counts as online until two of its report
  // periods passed, plus some slack, and never shorter than minMs. Apps that do not
  // say how often they report are taken to report every defaultIntervalMs.
  onlineGrace: { minMs: 2 * 60 * 1000, slackMs: 60 * 1000, defaultIntervalMs: 2 * 60 * 1000 },
  // How often the server looks whether such a device has run out of time.
  statusSweepMs: 30 * 1000,
};
