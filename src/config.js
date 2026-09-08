import fs from "fs";
import path from "path";
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

dotenv.config({ path: envPath });

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

export const config = {
  version: pkg.version,
  port: Number(process.env.PORT) || DEFAULT_PORT,
  password: process.env.PASSWORD || DEFAULT_PASSWORD,
  sessionTtlMs: 5 * 60 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  locationWaitMs: 2 * 1000,
  loginRateLimit: { windowMs: 60 * 1000, max: 5 },
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

export function isDefaultPassword() {
  return config.password === DEFAULT_PASSWORD;
}
