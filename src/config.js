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
  // The first account can always be created. More only while this is on.
  allowRegistration: process.env.ALLOW_REGISTRATION === "true",
  // Location history older than this is deleted at startup.
  historyDays: Number(process.env.HISTORY_DAYS) || 365,
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
};
