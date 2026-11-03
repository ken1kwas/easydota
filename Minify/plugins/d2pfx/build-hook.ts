import fs from "node:fs";
import path from "node:path";

import { base, constants, fs as mfs, helper, log, modsShared, output, VpkFile, vpkUtils, packVpkSingle } from "@minify/sdk";

import { RENAME_CATEGORIES } from "./meta";

interface D2pfxScan {
  normal: Map<string, string[]>;
  highPriority: Map<string, string[]>;
  mapVpkPaths: string[];
  cursorModPaths: string[];
}

function vpkFilesIn(dir: string): string[] {
  return [...mfs.walk(dir)].filter((f) => f.endsWith(".vpk"));
}

export function scanD2pfxMods(modList: string[]): D2pfxScan {
  const scan: D2pfxScan = { normal: new Map(), highPriority: new Map(), mapVpkPaths: [], cursorModPaths: [] };

  for (const modName of modList) {
    if (!modsShared.getState(modName)) continue;
    const modPath = path.join(base.modsDir, modName);
    if (!mfs.isDir(modPath)) continue;
    const cfg = modsShared.readManifest(modPath);
    if (cfg.browser !== "d2pfx") continue;

    const cat = cfg.category;
    if (cat === "cursors") {
      scan.cursorModPaths.push(modPath);
      continue;
    }
    const vpks = vpkFilesIn(modPath);
    if (!vpks.length) continue;

    if (cat === "terrains") {
      if (mfs.isDir(path.join(modPath, "maps"))) scan.mapVpkPaths.push(...vpks);
      else scan.normal.set(modName, vpks);
    } else if (RENAME_CATEGORIES.includes(cat)) {
      scan.highPriority.set(modName, vpks);
    } else {
      scan.normal.set(modName, vpks);
    }
  }
  return scan;
}

function mergeVpks(mods: Map<string, string[]>, checkExists: boolean): void {
  if (!mods.size) return;
  output.addText("&merging_vpks");
  for (const [modName, vpkPaths] of mods) {
    for (const p of vpkPaths) {
      try {
        const pak = VpkFile.open(p);
        vpkUtils.dump(pak, constants.minifyDotaCompileOutputPath, checkExists);
        pak.close();
        output.addText("&merged_mod", [modName], { indent: true });
      } catch {
        log.writeWarning("&failed_merge_mod", [modName]);
      }
    }
  }
}

export async function runPreBuild(modList: string[]): Promise<void> {
  const { normal, mapVpkPaths, cursorModPaths } = scanD2pfxMods(modList);
  const mapsOutputDir = path.join(helper.state.outputPath, "maps");

  // 1. Maps (dota.vpk)
  if (mapVpkPaths.length) {
    output.addText("&merging_vpks");
    mfs.createDirs(mapsOutputDir);
    if (fs.existsSync(base.mergeDir)) mfs.removePath(base.mergeDir);
    mfs.createDirs(base.mergeDir);
    const last = mapVpkPaths[mapVpkPaths.length - 1];
    try {
      const pak = VpkFile.open(last);
      vpkUtils.dump(pak, base.mergeDir);
      pak.close();
    } catch {
      log.writeWarning("&failed_merge_mod", [path.basename(last)]);
    }
    vpkUtils.dumpMetadata(base.mergeDir);
    await packVpkSingle(base.mergeDir, path.join(mapsOutputDir, "dota.vpk"));
    mfs.removePath(base.mergeDir);
  } else {
    const dotaVpk = path.join(mapsOutputDir, "dota.vpk");
    if (fs.existsSync(dotaVpk) && vpkUtils.isMinifyPak(dotaVpk)) {
      mfs.removePath(dotaVpk);
      if (mfs.isDir(mapsOutputDir) && !mfs.listDir(mapsOutputDir).length) mfs.removePath(mapsOutputDir);
    }
  }

  // 2. Cursors
  if (cursorModPaths.length) {
    const gameRoot = path.dirname(path.dirname(constants.dotaGamePakPath));
    const backupDir = path.join(base.baseDir, "backup", "d2pfx_cursors");
    const dotaCursorDir = path.join(gameRoot, "dota", "resource", "cursor");
    output.addText("&installing_terminal", ["D2PFX Cursors"]);

    for (const modPath of cursorModPaths) {
      const findCursorDir = (dir: string): string | null => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (e.name.toLowerCase() === "cursor") return path.join(dir, e.name);
          const nested = findCursorDir(path.join(dir, e.name));
          if (nested) return nested;
        }
        return null;
      };
      const sourceDir = findCursorDir(modPath) ?? modPath;

      for (const src of mfs.walk(sourceDir)) {
        const name = path.basename(src);
        if (![".ani", ".bmp", ".cur", ".res", ".png", ".jpg", ".jpeg"].includes(path.extname(name).toLowerCase())) continue;
        const dest = path.join(dotaCursorDir, name);
        const backup = path.join(backupDir, "dota", "resource", "cursor", name);
        if (mfs.isFile(dest) && !fs.existsSync(backup)) {
          mfs.createDirs(path.dirname(backup));
          fs.copyFileSync(dest, backup);
        }
        mfs.createDirs(path.dirname(dest));
        fs.copyFileSync(src, dest);
      }
    }
  } else {
    restoreD2pfxCursors();
  }

  // 3. Normal priority VPKs (base layer)
  mergeVpks(normal, true);
}

export function runPostBuild(modList: string[]): void {
  // High priority VPKs (override layer)
  mergeVpks(scanD2pfxMods(modList).highPriority, false);
}

export function restoreD2pfxCursors(): void {
  const backupDir = path.join(base.baseDir, "backup", "d2pfx_cursors");
  if (!mfs.isDir(backupDir)) return;
  const gameRoot = path.dirname(path.dirname(constants.dotaGamePakPath));
  let restored = 0;
  for (const file of mfs.walk(backupDir)) {
    const dest = path.join(gameRoot, path.relative(backupDir, file));
    mfs.createDirs(path.dirname(dest));
    fs.copyFileSync(file, dest);
    restored++;
  }
  mfs.removePath(backupDir);
  if (restored > 0) output.addText(`Restored ${restored} original cursor files.`, { msgType: "success", indent: true });
}
