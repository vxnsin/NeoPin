import os from "os";
import chalk from "chalk";
import { config, isDefaultPassword } from "./src/config.js";
import { createSocketServer } from "./src/ws.js";
import { createApp } from "./src/http.js";
import { startConsole } from "./src/console.js";

function networkIp() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const details of interfaces) {
      if (details.family === "IPv4" && !details.internal) return details.address;
    }
  }
  return "127.0.0.1";
}

function banner() {
  console.clear();
  console.log(chalk.red("    _   __           ") + chalk.whiteBright("____  _ "));
  console.log(chalk.red("   / | / /__  ____  ") + chalk.whiteBright("/ __ \\(_)___"));
  console.log(chalk.red("  /  |/ / _ \\/ __ \\") + chalk.whiteBright("/ /_/ / / __ \\"));
  console.log(chalk.red(" / /|  /  __/ /_/ ") + chalk.whiteBright("/ ____/ / / / /"));
  console.log(chalk.red("/_/ |_/___/\\____/") + chalk.whiteBright(`_/    /_/_/ /_/ v${config.version}`));
  console.log(chalk.whiteBright(`Server running at ${chalk.red(`http://${networkIp()}:${config.port}`)}`));
  if (isDefaultPassword()) {
    console.log(chalk.yellow("The default password is active. Change it with 'changePassword neopin123 <new>'."));
  }
  console.log(chalk.whiteBright(`Type '${chalk.red.bold("help")}' to see available commands`));
}

// The socket server needs the HTTP server for upgrades, the routes need the
// socket server for pings, so wire them in this order.
const pending = {};
const app = createApp({
  requestLocation: (...args) => pending.sockets.requestLocation(...args),
  broadcastDevices: () => pending.sockets.broadcastDevices(),
});
const server = app.listen(config.port, banner);
pending.sockets = createSocketServer(server);

startConsole(pending.sockets);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(chalk.gray("\nShutting down."));
    pending.sockets.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
