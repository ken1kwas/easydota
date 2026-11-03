// Checks for various things

import fs from "node:fs";
import path from "node:path";

import * as base from "./core/base";
import { C } from "./core/constants";
import * as mfs from "./core/fs";
import * as log from "./core/log";
import * as modsShared from "./core/mods-shared";
import * as output from "./core/output";
import { isProcessRunning, which } from "./core/proc";

export const state = { workshopInstalled: false };
export const workshopRequiredMethods = ["styling.css", "xml.json", "files_uncompiled", "remap.json"];

/** Hook to open URLs (set by the GUI; CLI prints them). */
export const hooks: { openUrl?: (url: string) => void } = {};

export async function isDotaRunning(textTag: string, textType: output.MsgType): Promise<boolean> {
  const running = await isProcessRunning(base.isWin ? "dota2.exe" : "dota2");
  if (running) output.addText(textTag, { msgType: textType });
  return running;
}

/** resourcecompiler existence check */
export function isCompilerFound(): boolean {
  state.workshopInstalled = fs.existsSync(C.dotaResourceCompilerPath);
  if (!state.workshopInstalled && !base.state.HEADLESS) {
    output.addText("&error_no_workshop_tools_found_terminal", { msgType: "warning" });
  }
  return state.workshopInstalled;
}

function setS2vExecutable(exe: string): void {
  C.s2vExecutable = exe;
  C.s2vExecPath = path.isAbsolute(exe) ? exe : path.join(".", exe);
}

/**
 * Downloads Source2Viewer-CLI (only needed with Workshop Tools) up to 3 times and opens the download
 * URL if it keeps failing. PATH is checked first, then the Minify root.
 *
 * The python version also downloaded ripgrep for blacklist directory matching; this port matches
 * with JavaScript regular expressions instead, so ripgrep is no longer required.
 */
export async function resolveDependencies(retries = 0): Promise<void> {
  if (state.workshopInstalled && !base.isWin && which("wine") === null) {
    output.addText("&error_wine_not_found_terminal", { msgType: "error" });
    return;
  }

  try {
    const exeName = path.basename(C.s2vExecutable);
    if (state.workshopInstalled) {
      const onPath = which(exeName);
      setS2vExecutable(onPath ?? exeName);

      if (!fs.existsSync(C.s2vExecutable)) {
        output.addText("&downloading_cli_terminal");
        const zipPath = C.s2vLatest.split("/").pop()!;
        if (await mfs.downloadFile(C.s2vLatest, zipPath, { progressTag: true })) {
          output.addText("&downloaded_cli_terminal", [zipPath]);
          if (await mfs.extractArchive(zipPath, ".")) {
            mfs.removePath(zipPath);
            output.addText("&extracted_cli_terminal", [zipPath]);
            setS2vExecutable(exeName);
            if (!base.isWin) fs.chmodSync(exeName, fs.statSync(exeName).mode | 0o111);
          }
        }
      }
    } else if (fs.existsSync(exeName)) {
      mfs.removePath(exeName);
    }
  } catch (err) {
    log.writeCrashlog(err);
    output.addText("&failed_download_retrying_terminal", { msgType: "error" });
    if (retries < 3) return resolveDependencies(retries + 1);
    output.addText("&failed_download", [3], { msgType: "error" });
    output.addText("&connection_error", { msgType: "error" });
    if (state.workshopInstalled) {
      if (hooks.openUrl) hooks.openUrl(C.s2vLatest);
      else output.addText(C.s2vLatest);
    }
  }
}

/** Checks if required binaries exist. */
export function checkBinaries(): boolean {
  if (state.workshopInstalled) {
    const onPath = which(path.basename(C.s2vExecutable));
    if (!fs.existsSync(C.s2vExecutable) && !onPath) return false;
    if (onPath && !path.isAbsolute(C.s2vExecutable)) setS2vExecutable(onPath);
  }
  return true;
}

export function isWorkshopRequiredMod(modPath: string, manifest?: Record<string, any>): boolean {
  manifest ??= modsShared.readManifest(modPath);
  if (manifest.skip_workshop_check) return false;
  return workshopRequiredMethods.some((m) => fs.existsSync(path.join(modPath, m)));
}

export function disableWorkshopMods(): void {
  if (state.workshopInstalled) return;
  for (const folder of modsShared.modsWithOrder) {
    const modPath = path.join(base.modsDir, folder);
    if (isWorkshopRequiredMod(modPath)) modsShared.setState(folder, false);
  }
}
