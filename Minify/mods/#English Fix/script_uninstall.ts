import fs from "node:fs";
import path from "node:path";

import { base, constants, fs as mfs, output } from "@minify/sdk";

export function main(): void {
  const backupDir = path.join(base.baseDir, "backup", "#English Fix");
  if (!mfs.isDir(backupDir)) {
    output.addText("No backup found for #English Fix disk files.", { msgType: "warning", indent: true });
    return;
  }

  const gameRoot = path.dirname(path.dirname(constants.dotaGamePakPath));
  let restored = 0;
  for (const file of mfs.walk(backupDir)) {
    const dest = path.join(gameRoot, path.relative(backupDir, file));
    mfs.createDirs(path.dirname(dest));
    fs.copyFileSync(file, dest);
    restored++;
  }

  mfs.removePath(backupDir);
  output.addText(`Restored ${restored} disk files from backup.`, { msgType: "success", indent: true });
}
