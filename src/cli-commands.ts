// CLI definition shared by the node entry (dist/cli.js) and the Electron executable.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Command, Option } from "commander";

import * as bootstrap from "./bootstrap";
import * as base from "./core/base";
import * as config from "./core/config";
import { C } from "./core/constants";
import * as modsShared from "./core/mods-shared";
import { shlexSplit } from "./core/proc";
import * as helper from "./helper";
import * as patch from "./patch";

export const SUBCOMMANDS = ["patch", "prelaunch", "config", "mods", "uninstall", "help"];

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(base.state.originalCwd, p);
}

function applyPaths(configPath?: string, modsPath?: string): void {
  if (configPath) base.paths.mainConfigFile = resolvePath(configPath);
  if (modsPath) base.paths.modsConfig = resolvePath(modsPath);
}

function ensureModsFile(): void {
  modsShared.scanMods();
  const states = config.readJsonFile<Record<string, boolean>>(base.paths.modsConfig);
  if (modsShared.modsWithOrder.some((m) => !(m in states))) {
    for (const m of modsShared.modsWithOrder) states[m] ??= false;
    config.writeJsonFile(base.paths.modsConfig, Object.fromEntries(Object.entries(states).sort(([a], [b]) => (a < b ? -1 : 1))));
  }
}

function openInEditor(file: string, editor?: string): Promise<number> {
  if (!fs.existsSync(file)) config.writeJsonFile(file, {});
  const cmd = shlexSplit(editor || process.env.EDITOR || (base.isWin ? "notepad" : "vi"));
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), file], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function headless(): Promise<void> {
  base.state.HEADLESS = true;
  await bootstrap.setupSystem();
}

async function runPatch(opts: { config?: string; mods?: string; number?: string; modsString?: string }): Promise<void> {
  applyPaths(opts.config, opts.mods);
  await headless();
  console.log("Starting patch process...");
  await patch.patcher(Number(opts.number ?? 66), opts.modsString ?? null);
}

export interface CliHandlers {
  /** Called when no subcommand is given. */
  launchGui(host: boolean): Promise<void> | void;
}

export function buildProgram(handlers: CliHandlers): Command {
  const program = new Command("dota2-minify")
    .description("Dota2-Minify CLI and GUI.")
    .helpOption("-h, --help", "Show help.")
    .option("-v, --version", "Print version and exit.")
    .option("--host", "Host the UI on a local port in an app window (uses the 'browser_exec' config key if set).")
    .enablePositionalOptions()
    .action(async (opts: { version?: boolean; host?: boolean }) => {
      if (opts.version) {
        console.log(base.VERSION);
        return;
      }
      await handlers.launchGui(Boolean(opts.host));
    });

  program
    .command("patch")
    .description("Run a patch.")
    .option("-c, --config <path>", "Path to config file.")
    .option("-m, --mods <path>", "Path to mods file.")
    .addOption(
      new Option("-n, --number <n>", "Pak number for the output VPK.").default("66").argParser((v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error("--number must be between 0 and 99");
        return String(n);
      }),
    )
    .option("--mods-string <mods>", 'Compile only these comma-separated mods, e.g. "foo,bar". Doesn\'t eval conditions.')
    .action(runPatch);

  program
    .command("prelaunch")
    .description("Run prelaunch checks and scripts, then launch the given game command.")
    .option("--config <path>", "Path to config file.")
    .option("--mods <path>", "Path to mods file.")
    .argument("[command...]", "Game command to run afterwards (%command%).")
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (gameArgs: string[], opts: { config?: string; mods?: string }) => {
      applyPaths(opts.config, opts.mods);
      await headless();
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
      const current = read(C.dotaSteamInfPath);
      const cached = read(base.dotaSteamInfCache);
      const patchRan = current !== cached || !cached;

      if (patchRan) {
        console.log("Dota 2 version changed or first run. Starting patch...");
        await patch.patcher();
        config.set("last_patch_time", Math.floor(Date.now() / 1000));
      } else {
        console.log("Dota 2 version has not changed. Skipping patch.");
        if (await helper.bulkExecScript("prelaunch")) config.set("last_patch_time", Math.floor(Date.now() / 1000));
      }

      if (gameArgs.length) {
        const cwd = fs.existsSync(base.state.originalCwd) ? base.state.originalCwd : path.dirname(gameArgs[0]) || undefined;
        const code = await new Promise<number>((resolve) => {
          const child = spawn(gameArgs[0], gameArgs.slice(1), { cwd, stdio: "inherit" });
          child.on("error", (err) => {
            console.log(`Failed to launch game: ${err.message}`);
            resolve(1);
          });
          child.on("close", (c) => resolve(c ?? 0));
        });
        process.exitCode = code;
      }
    });

  const fileCommand = (name: "config" | "mods", description: string) =>
    program
      .command(name)
      .description(description)
      .option(name === "config" ? "-c, --config <path>" : "-m, --mods <path>", `Path to ${name} file.`)
      .option("-e, --editor <bin>", "Editor binary to use (defaults to $EDITOR).")
      .option("-j, --json", "Print contents.")
      .option("-p, --path", "Print path.")
      .action(async (opts: { config?: string; mods?: string; editor?: string; json?: boolean; path?: boolean }) => {
        applyPaths(opts.config, opts.mods);
        if (name === "mods") ensureModsFile();
        const file = name === "config" ? base.paths.mainConfigFile : base.paths.modsConfig;
        if (opts.json) console.log(JSON.stringify(config.readJsonFile(file), null, 2));
        else if (opts.path) console.log(path.resolve(file));
        else process.exitCode = await openInEditor(file, opts.editor);
      });

  fileCommand("config", "Interact with the config file.");
  fileCommand("mods", "Interact with the mods file.");

  program
    .command("uninstall")
    .description("Uninstall all mods.")
    .option("-c, --config <path>", "Path to config file.")
    .option("-m, --mods <path>", "Path to mods file.")
    .option("-f, --force", "Wipe the contents of all language dirs.")
    .action(async (opts: { config?: string; mods?: string; force?: boolean }) => {
      applyPaths(opts.config, opts.mods);
      await headless();
      if (opts.force) await patch.unins.wipe();
      else await patch.unins.uninstall();
    });

  return program;
}
