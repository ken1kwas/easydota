// One-shot migrations of old configs, file names and install layouts.

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import * as config from "./config";
import { C, recalcRescompDirs } from "./constants";
import * as mfs from "./fs";
import { isPlainObject } from "./jsonc";
import * as log from "./log";
import * as modsShared from "./mods-shared";
import * as output from "./output";
import * as utils from "./utils";

function migrateRemovedPostPatchSettings(): void {
  const data = config.readJsonFile(base.paths.mainConfigFile);
  if (!isPlainObject(data)) return;
  const removed = ["launch_dota_after_patch", "kill_self_after_patch"].filter((k) => k in data);
  if (!removed.length) return;
  for (const key of removed) delete data[key];
  config.writeJsonFile(base.paths.mainConfigFile, data);
  output.addText("Removed obsolete post-patch settings from configuration");
}

function migrateLocaleConfig(): void {
  const locale = config.get("output_locale");
  const outPath = config.get<string>("output_path");
  const uiLocale = config.get("locale", "en");

  if (typeof uiLocale === "string" && /[A-Z]/.test(uiLocale)) {
    config.set("locale", "en");
    log.writeWarning(`Migrated capitalized locale '${uiLocale}' to 'en'`);
  }
  let changed = false;
  if (locale === "minify") {
    config.set("output_locale", "english");
    changed = true;
  }
  if (outPath && outPath.includes("dota_minify")) {
    config.set("output_path", outPath.replace("dota_minify", "dota_dutch"));
    changed = true;
  }
  if (changed) log.writeWarning("Migrated legacy 'minify' locale to 'english' (dutch fallback)");
}

function renameFileInMods(src: string, dest: string): void {
  if (!fs.existsSync(base.modsDir)) return;
  for (const mod of fs.readdirSync(base.modsDir)) {
    const modPath = path.join(base.modsDir, mod);
    if (!mfs.isDir(modPath) || modsShared.isIgnoredFolder(mod)) continue;
    const s = path.join(modPath, src);
    const d = path.join(modPath, dest);
    if (!fs.existsSync(s)) continue;
    try {
      if (!fs.existsSync(d)) {
        mfs.movePath(s, d);
        output.addText(`Migrated ${src} to ${dest} in ${mod}`);
      } else {
        mfs.removePath(s);
        output.addText(`Removed redundant ${src} in ${mod} since ${dest} exists`);
      }
    } catch (err) {
      log.writeWarning(`Failed to migrate ${src} to ${dest} in ${mod}: ${err}`);
    }
  }
}

function migrateStaleRescomproot(): void {
  const smartprops = path.join(base.rescompOverrideDir, "game", "bin", "win64", "smartprops.dll");
  if (!fs.existsSync(base.rescompOverrideDir) || fs.existsSync(smartprops)) return;
  if (utils.readStates().stale_rescomproot_migrated) return;

  try {
    mfs.removePath(base.rescompOverrideDir);
    output.addText("Removed outdated Workshop Tools installation (missing smartprops.dll)");
  } catch (err) {
    log.writeWarning(`Failed to remove outdated Workshop Tools installation: ${err}`);
    return;
  }
  if (C.dotaToolsPaths.every((p) => fs.existsSync(p))) require("../helper").extractWorkshopTools();
  recalcRescompDirs();
  utils.writeStates("stale_rescomproot_migrated", true);
}

function migrateLegacyPaks(): void {
  if (utils.readStates().legacy_paks_migrated) return;
  const { isMinifyPak } = require("../patch/vpk-utils") as typeof import("../patch/vpk-utils");
  const targetDir = config.get<string>("output_path", C.minifyDefaultDotaPakOutputPath);
  if (mfs.isDir(targetDir)) {
    for (const item of ["pak65_dir.vpk", "pak67_dir.vpk"]) {
      const pak = path.join(targetDir, item);
      if (mfs.isFile(pak) && isMinifyPak(pak)) {
        try {
          mfs.removePath(pak);
          output.addText(`Migrated and removed legacy Minify pak: ${pak}`);
        } catch (err) {
          log.writeWarning(`Failed to remove legacy pak ${pak}: ${err}`);
        }
      }
    }
  }
  utils.writeStates("legacy_paks_migrated", true);
}

function migrateFlattenD2pfxManifests(): void {
  if (!fs.existsSync(base.modsDir)) return;
  for (const mod of fs.readdirSync(base.modsDir)) {
    const modPath = path.join(base.modsDir, mod);
    if (!mfs.isDir(modPath) || modsShared.isIgnoredFolder(mod)) continue;
    const manifestPath = path.join(modPath, "manifest.json");
    if (!mfs.isFile(manifestPath)) continue;
    try {
      const manifest = config.readJsonFile(manifestPath);
      const info = manifest.browser;
      if (!isPlainObject(info) || info.browser !== "d2pfx") continue;

      const rawTags = info.tags;
      const tags = isPlainObject(rawTags)
        ? Object.keys(rawTags).filter((k) => rawTags[k])
        : Array.isArray(rawTags)
          ? rawTags
          : rawTags == null
            ? []
            : [String(rawTags)];

      const next: Record<string, unknown> = {
        browser: "d2pfx",
        name: info.name,
        category: info.category,
        author: info.author,
        sender: info.sender,
        links: info.links ?? [],
        tags,
        version: info.version,
        label: info.label,
      };
      for (const [k, v] of Object.entries(info)) if (!(k in next)) next[k] = v;
      for (const [k, v] of Object.entries(manifest)) if (k !== "browser" && !(k in next)) next[k] = v;

      config.writeJsonFile(manifestPath, next);
      output.addText(`Flattened d2pfx manifest in ${mod}`);
    } catch (err) {
      log.writeWarning(`Failed to flatten d2pfx manifest in ${mod}: ${err}`);
    }
  }
}

/** Python mods (`script*.py`) don't run in this port — warn once so users know to port them. */
function warnAboutPythonScripts(): void {
  if (!fs.existsSync(base.modsDir)) return;
  const offenders: string[] = [];
  for (const mod of fs.readdirSync(base.modsDir)) {
    const modPath = path.join(base.modsDir, mod);
    if (!mfs.isDir(modPath)) continue;
    if (fs.readdirSync(modPath).some((f) => /^script.*\.py$/.test(f))) offenders.push(mod);
  }
  if (offenders.length) {
    log.writeWarning(`These mods contain Python scripts that are ignored by the TypeScript edition (port them to script*.ts): ${offenders.join(", ")}`);
  }
}

export function runMigrations(): void {
  migrateLocaleConfig();
  migrateRemovedPostPatchSettings();
  renameFileInMods("modcfg.json", "manifest.json");
  renameFileInMods("xml_mod.json", "xml.json");
  migrateStaleRescomproot();
  migrateLegacyPaks();
  migrateFlattenD2pfxManifests();
  warnAboutPythonScripts();
}
