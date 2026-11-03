#!/usr/bin/env node
// Node entry point: `node dist/cli.js [patch|prelaunch|config|mods|uninstall] ...`
// Without a subcommand it starts the Electron GUI (or the browser-hosted UI with --host).

import { spawn } from "node:child_process";
import path from "node:path";

import * as bootstrap from "./bootstrap";
import { buildProgram } from "./cli-commands";
import * as base from "./core/base";

async function launchGui(host: boolean): Promise<void> {
  if (host) {
    base.state.HEADLESS = false;
    await bootstrap.setupSystem();
    const { runHosted } = await import("./ui/host-server");
    await runHosted();
    return;
  }
  let electronBinary: string;
  try {
    // In plain node the `electron` package exports the path of its binary.
    electronBinary = require("electron") as unknown as string;
  } catch {
    console.error("Electron is not installed. Run `npm install`, or use `--host` to open the UI in a browser.");
    process.exitCode = 1;
    return;
  }
  const appRoot = path.resolve(__dirname, "..");
  const child = spawn(electronBinary, [appRoot], { detached: true, stdio: "ignore", cwd: base.state.originalCwd });
  child.unref();
}

async function main(): Promise<void> {
  bootstrap.enterRoot();
  await buildProgram({ launchGui }).parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
