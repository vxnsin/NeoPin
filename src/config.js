import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(rootDir, ".env");
const DEFAULT_PASSWORD = "neopin123";
const DEFAULT_PORT = 3012;

if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, `PASSWORD=${DEFAULT_PASSWORD}\nPORT=${DEFAULT_PORT}\n`, "utf8");
  console.log(".env file created with default values.");
}

dotenv.config({ path: envPath, quiet: true });

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

export const config = {
  version: pkg.version,
  port: Number(process.env.PORT) || DEFAULT_PORT,
  password: process.env.PASSWORD || DEFAULT_PASSWORD,
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
  // Wrong passwords over the WebSocket, per IP, before further attempts are refused.
  deviceAuthLimit: { windowMs: 60 * 1000, max: 10 },
};

export function setPassword(newPassword) {
  config.password = newPassword;
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (/^PASSWORD=.*$/m.test(env)) {
    env = env.replace(/^PASSWORD=.*$/m, `PASSWORD=${newPassword}`);
  } else {
    env += `${env.endsWith("\n") || env === "" ? "" : "\n"}PASSWORD=${newPassword}\n`;
  }
  fs.writeFileSync(envPath, env, "utf8");
}

// Compares in constant time, so the answer time says nothing about the password.
export function passwordMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const hash = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(candidate), hash(config.password));
}

export function isDefaultPassword() {
  return config.password === DEFAULT_PASSWORD;
}
