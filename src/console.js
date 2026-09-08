import readline from "readline";
import chalk from "chalk";
import { config, setPassword } from "./config.js";
import { allDevices, onlineDevices, timeAgo } from "./devices.js";
import { destroyAllSessions } from "./sessions.js";

export function startConsole(sockets) {
  if (!process.stdin.isTTY) {
    console.log(chalk.gray("No TTY attached, interactive console disabled."));
    return null;
  }

  const commands = {
    help() {
      console.log(chalk.bold("Available commands:"));
      const line = (cmd, text) => console.log(`  ${chalk.red.bold(cmd)} ${chalk.gray("→")} ${text}`);
      line("device-list", "List all known devices");
      line("sendPing [deviceId]", "Request a fresh location from one or all devices");
      line("disconnect <deviceId>", "Close the connection of a device");
      line("changePassword <current> <new>", "Change the shared password (active immediately)");
      line("sessions-clear", "Log out every dashboard session");
    },

    "device-list"() {
      const devices = allDevices();
      if (devices.length === 0) return console.log(chalk.yellow("No devices known."));
      devices.forEach((d, index) => {
        const prefix = devices.length === 1 ? "━" : index === 0 ? "┏" : index === devices.length - 1 ? "┗" : "┣";
        const position = d.position ? `${d.position.latitude} | ${d.position.longitude}` : "no position";
        const ping = d.lastPing ? `last ping ${timeAgo(d.lastPing)}` : "never reported";
        const status = d.status === "online" ? chalk.green("online") : chalk.gray("offline");
        console.log(`${prefix} ${chalk.whiteBright(d.id)} ${status} · ${position} · ${ping}`);
      });
    },

    async sendPing(deviceId) {
      if (onlineDevices().length === 0) return console.log(chalk.yellow("No devices connected."));
      const asked = await sockets.requestLocation(deviceId || null, null);
      if (asked === 0) return console.log(chalk.red(`Device ${chalk.whiteBright(deviceId)} is not connected.`));
      sockets.broadcastDevices();
      console.log(chalk.green(`Location request sent to ${deviceId ? deviceId : `${asked} devices`}.`));
    },

    disconnect(deviceId) {
      if (!deviceId) return console.log(chalk.red("Usage: disconnect <deviceId>"));
      sockets.disconnectDevice(deviceId);
    },

    changePassword(current, next) {
      if (!current || !next) return console.log(chalk.red("Usage: changePassword <current> <new>"));
      if (current !== config.password) return console.log(chalk.red("Current password is incorrect."));
      setPassword(next);
      destroyAllSessions();
      console.log(chalk.green("Password changed. Devices and dashboards must log in again."));
    },

    "sessions-clear"() {
      destroyAllSessions();
      console.log(chalk.green("All dashboard sessions cleared."));
    },
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => {
      const names = Object.keys(commands);
      const hits = names.filter((c) => c.startsWith(line));
      return [hits.length ? hits : names, line];
    },
  });

  rl.on("line", async (input) => {
    const [command, ...args] = input.trim().split(/\s+/);
    if (!command) return;
    const fn = commands[command];
    if (!fn) return console.log(chalk.red(`Unknown command: ${command}. Type 'help'.`));
    try {
      await fn(...args);
    } catch (error) {
      console.error(chalk.red("Command failed:"), error);
    }
  });

  return rl;
}
