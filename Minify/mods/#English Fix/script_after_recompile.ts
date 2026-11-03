import fs from "node:fs";
import path from "node:path";

import { base, config, constants, fs as mfs, output, VpkFile } from "@minify/sdk";

export function main(): void {
  const dotaPak = VpkFile.open(constants.dotaGamePakPath);
  const englishFiles = dotaPak.paths().filter((p) => p.endsWith("_english.txt") || p.endsWith("_english.vtt"));

  const gameRoot = path.dirname(path.dirname(constants.dotaGamePakPath));
  const locale = config.getLocale();

  const diskLocaleFiles: string[] = [];
  for (const sub of ["core", "dota_addons"]) {
    for (const abs of mfs.walk(path.join(gameRoot, sub))) {
      const name = path.basename(abs);
      if (name.endsWith(`_${locale}.txt`) || name.endsWith(`_${locale}.vtt`)) {
        diskLocaleFiles.push(path.relative(gameRoot, abs).split(path.sep).join("/"));
      }
    }
  }

  const compileDir = constants.minifyDotaCompileOutputPath;
  mfs.createDirs(compileDir);

  for (const filepath of englishFiles) {
    const renamed = filepath.replace("_english.txt", `_${locale}.txt`).replace("_english.vtt", `_${locale}.vtt`);
    const dest = path.join(compileDir, renamed);
    mfs.createDirs(path.dirname(dest));
    fs.writeFileSync(dest, dotaPak.read(filepath)!);
  }
  dotaPak.close();

  const backupDir = path.join(base.baseDir, "backup", "#English Fix");
  for (const rel of diskLocaleFiles) {
    const localeFile = path.join(gameRoot, rel);
    const englishFile = path.join(gameRoot, rel.replace(`_${locale}.txt`, "_english.txt").replace(`_${locale}.vtt`, "_english.vtt"));
    if (!fs.existsSync(englishFile)) continue;
    const backupDest = path.join(backupDir, rel);
    mfs.createDirs(path.dirname(backupDest));
    fs.copyFileSync(localeFile, backupDest);
    fs.copyFileSync(englishFile, localeFile);
  }

  const filesDir = path.join(__dirname, "files");
  if (fs.existsSync(filesDir)) mfs.copyTree(filesDir, compileDir);

  const total = englishFiles.length + diskLocaleFiles.length;
  output.addText(`Extracted and renamed ${total} localization files (${diskLocaleFiles.length} from game files).`, {
    msgType: "success",
    indent: true,
  });
}
