// Process start-up shared by the CLI and the GUI.

import fs from "node:fs";

import * as conditions from "./conditions";
import * as base from "./core/base";
import * as constants from "./core/constants";
import * as localization from "./core/localization";
import * as log from "./core/log";
import { runMigrations } from "./core/migrations";
import * as modsShared from "./core/mods-shared";
import * as scriptLoader from "./core/script-loader";
import * as steam from "./core/steam";
import * as helper from "./helper";
import * as plugins from "./plugins";

/** chdir into the Minify folder and create the working directories. Must run first. */
export function enterRoot(): void {
  base.state.originalCwd = process.cwd();
  process.chdir(base.baseDir);
  for (const dir of [base.cacheDir, base.configDir, base.logsDir]) fs.mkdirSync(dir, { recursive: true });
  scriptLoader.install();
}

let pathsReady = false;

/** Locates Steam/Dota and computes every derived path. */
export async function initPaths(): Promise<void> {
  if (pathsReady) return;
  await steam.init();
  constants.init();
  modsShared.scanMods();
  helper.syncOutputPath();
  runMigrations();
  pathsReady = true;
}

/** Equivalent of python's `utils.setup_system()`. */
export async function setupSystem(): Promise<void> {
  log.installUnhandledHandlers();
  localization.loadHeadless();
  await initPaths();

  await conditions.isDotaRunning("&error_please_close_dota_terminal", "error");
  conditions.isCompilerFound();
  conditions.disableWorkshopMods();
  if (base.state.HEADLESS) await conditions.resolveDependencies();

  await plugins.initialize();
  await helper.bulkExecScript("initial", false);
}
