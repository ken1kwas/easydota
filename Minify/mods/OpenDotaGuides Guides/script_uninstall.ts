import fs from "node:fs";
import path from "node:path";

import { fs as mfs, log } from "@minify/sdk";

import { backupPath, itembuildsPath } from "./script";

export function main(): void {
  if (!fs.existsSync(backupPath)) return;
  try {
    const lines = fs.readFileSync(path.join(itembuildsPath(), "default_antimage.txt"), "utf8").split(/\r?\n/);
    if (lines.length >= 3 && lines[2].includes("OpenDotaGuides")) mfs.restoreDirectory(itembuildsPath(), backupPath);
  } catch {
    log.writeWarning(
      "Unable to recover backed up default guides or the itembuilds directory is empty, verify files to get the default guides back",
    );
  }
}
