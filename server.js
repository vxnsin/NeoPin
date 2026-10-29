import os from "os";
import chalk from "chalk";
import { config } from "./src/config.js";
import { initDb } from "./src/db.js";
import { ensureAdmin } from "./src/accounts.js";
import { pruneHistory } from "./src/history.js";
import { createApp } from "./src/app.js";
import { startConsole } from "./src/console.js";
import { startTransit } from "./src/transit.js";
import { applyStagedRestore, beforeRestoreFile, startBackups } from "./src/backups.js";

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
  console.log(chalk.red("/_/ |_/___/\\____/") + chalk.whiteBright(`_/    /_/_/ /_/ v${config.version}`) + (config.commit ? chalk.gray(` ${config.commit.slice(0, 7)}`) : ""));
  console.log(chalk.whiteBright(`Server running at ${chalk.red(`http://${networkIp()}:${config.port}`)}`));
  if (adminCreated) {
    console.log(chalk.yellow(`Admin account created: ${chalk.whiteBright(adminCreated.username)}`));
    if (adminCreated.password) {
      console.log(chalk.yellow(`Generated password: ${chalk.whiteBright(adminCreated.password)}  (shown once, change it after logging in)`));
    }
  }
  if (restored) {
    console.log(chalk.yellow(`Backup restored. The previous database is kept as ${chalk.whiteBright(beforeRestoreFile())}`));
  }
  console.log(chalk.whiteBright(`Type '${chalk.red.bold("help")}' to see available commands`));
}

// inkan closes every socket and the server itself on SIGINT and SIGTERM.
// A backup uploaded in the dashboard takes the place of the database before it is opened.
const restored = applyStagedRestore();
initDb();
const adminCreated = ensureAdmin();
pruneHistory();
const server = createApp();
await server.app.listen(config.port);
banner();
startTransit();
startBackups();
startConsole(server);
