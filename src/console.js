import readline from "readline";
import chalk from "chalk";
import { createUser, getUserByName, listUsers, setPassword } from "./accounts.js";
import { allDevices, onlineDevices, statusOf, timeAgo } from "./devices.js";
import { destroyAllSessions } from "./sessions.js";

export function startConsole(sockets) {
  if (!process.stdin.isTTY) {
    console.log(chalk.gray("No TTY attached, interactive console disabled."));
    return null;
  }

  const userName = (id) => listUsers().find((u) => u.id === id)?.username ?? `#${id}`;

  const commands = {
    help() {
      console.log(chalk.bold("Available commands:"));
      const line = (cmd, text) => console.log(`  ${chalk.red.bold(cmd)} ${chalk.gray("→")} ${text}`);
      line("users", "List all accounts");
      line("createUser <name> <password>", "Create an account");
      line("passwd <name> <password>", "Set a new password, logs that account out everywhere");
      line("device-list", "List all known devices");
      line("sendPing <name> [deviceId]", "Request a fresh location from one or all devices of an account");
      line("disconnect <name> <deviceId>", "Close the connection of a device");
      line("sessions-clear", "Log out every dashboard session");
    },

    users() {
      const users = listUsers();
      if (users.length === 0) return console.log(chalk.yellow("No accounts yet. Create the first one in the dashboard."));
      users.forEach((u) => console.log(`${chalk.whiteBright(u.username)} · ${u.display_name} · since ${u.created_at.slice(0, 10)}`));
    },

    createUser(name, password) {
      if (!name || !password) return console.log(chalk.red("Usage: createUser <name> <password>"));
      try {
        const user = createUser({ username: name, password });
        console.log(chalk.green(`Account ${user.username} created.`));
      } catch (error) {
        console.log(chalk.red(error.message));
      }
    },

    passwd(name, password) {
      if (!name || !password) return console.log(chalk.red("Usage: passwd <name> <password>"));
      const user = getUserByName(name);
      if (!user) return console.log(chalk.red(`No account called ${name}.`));
      if (password.length < 8) return console.log(chalk.red("The password needs at least 8 characters."));
      setPassword(user.id, password);
      destroyAllSessions();
      sockets.disconnectUser(user.id, "Password changed");
      console.log(chalk.green(`Password of ${user.username} changed. Its devices and dashboards must log in again.`));
    },

    "device-list"() {
      const devices = allDevices();
      if (devices.length === 0) return console.log(chalk.yellow("No devices known."));
      devices.forEach((d, index) => {
        const prefix = devices.length === 1 ? "━" : index === 0 ? "┏" : index === devices.length - 1 ? "┗" : "┣";
        const position = d.position ? `${d.position.latitude} | ${d.position.longitude}` : "no position";
        const ping = d.lastPing ? `last ping ${timeAgo(d.lastPing)}` : "never reported";
        const status = statusOf(d) === "online" ? chalk.green("online") : chalk.gray("offline");
        console.log(`${prefix} ${chalk.whiteBright(userName(d.userId))}/${chalk.whiteBright(d.id)} ${status} · ${position} · ${ping}`);
      });
    },

    async sendPing(name, deviceId) {
      const user = name && getUserByName(name);
      if (!user) return console.log(chalk.red("Usage: sendPing <name> [deviceId]"));
      if (onlineDevices(user.id).length === 0) return console.log(chalk.yellow("No devices connected."));
      const asked = await sockets.requestLocation({ only: deviceId ? { deviceId, userId: user.id } : null });
      if (asked === 0) return console.log(chalk.red(`Device ${chalk.whiteBright(deviceId)} is not connected.`));
      sockets.broadcastDevices();
      console.log(chalk.green(`Location request sent to ${deviceId ? deviceId : `${asked} devices`}.`));
    },

    disconnect(name, deviceId) {
      const user = name && getUserByName(name);
      if (!user || !deviceId) return console.log(chalk.red("Usage: disconnect <name> <deviceId>"));
      sockets.disconnectDevice(user.id, deviceId);
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

  // readline swallows Ctrl+C, hand it on so inkan can shut down cleanly.
  rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));

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
