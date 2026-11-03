import fs from "node:fs";
import path from "node:path";

import { C } from "../core/constants";
import * as mfs from "../core/fs";
import * as log from "../core/log";
import * as output from "../core/output";
import { getPlugins } from "../core/registry";
import * as steam from "../core/steam";
import { bulkExecScript } from "../helper";
import { isMinifyPak } from "./vpk-utils";

export async function uninstall(): Promise<void> {
  output.clean();
  const pakPattern = /^pak\d{2}_dir\.vpk$/;

  for (const dir of C.minifyDotaPossibleLanguageOutputPaths) {
    if (!mfs.isDir(dir)) continue;

    const mapsVpk = path.join(dir, "maps", "dota.vpk");
    if (fs.existsSync(mapsVpk) && isMinifyPak(mapsVpk)) mfs.removePath(path.join(dir, "maps"));

    for (const item of mfs.listDir(dir)) {
      const pakPath = path.join(dir, item);
      if (!pakPattern.test(item) || !mfs.isFile(pakPath) || !isMinifyPak(pakPath)) continue;
      const prefix = item.split("_")[0];
      for (const sibling of mfs.listDir(dir)) {
        if (sibling.startsWith(`${prefix}_`) && sibling.endsWith(".vpk")) mfs.removePath(path.join(dir, sibling));
      }
    }
  }

  steam.removeMinifyLang();
  steam.restoreBootLanguage();

  for (const plugin of getPlugins()) {
    if (!plugin.onUninstall) continue;
    try {
      await plugin.onUninstall();
    } catch (err) {
      log.writeWarning("Plugin uninstall hook failed", [], err);
    }
  }

  await bulkExecScript("uninstall");
  output.addText("&mods_removed_terminal");
}

export async function wipe(): Promise<void> {
  output.clean();
  await uninstall();
  for (const dir of C.minifyDotaPossibleLanguageOutputPaths) {
    if (mfs.isDir(dir)) {
      mfs.removePath(dir);
      output.addText("&clean_lang_dirs", [dir]);
    }
  }
}
