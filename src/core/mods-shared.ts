// Shared mod scanning logic

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import * as config from "./config";
import { isPlainObject } from "./jsonc";

// Arrays are updated in place so every reference sees the latest scan.
export const modsAlphabetical: string[] = [];
export const modsWithOrder: string[] = [];
export const visuallyUnavailableMods: string[] = [];
export const visuallyAvailableMods: string[] = [];
export const modDependenciesList: Array<Record<string, string[]>> = [];
export const modConflictsList: Array<Record<string, string[]>> = [];

export const CATEGORY_CONFLICTS = ["announcers", "backgrounds", "fonts", "huds", "mega-kill", "pings", "river", "terrains", "trees"];

/** Hidden or ignored directory (starts with . or _). */
export function isIgnoredFolder(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

/** Internal core system mod (starts with #). */
export function isSystemMod(name: string): boolean {
  return name.startsWith("#");
}

export function isUserMod(name: string): boolean {
  return !isIgnoredFolder(name) && !isSystemMod(name);
}

export function getState(mod: string): boolean {
  const states = config.readJsonFile<Record<string, boolean>>(base.paths.modsConfig);
  return Boolean(states[mod]);
}

export function setState(mod: string, value: boolean): void {
  config.updateJsonFile(base.paths.modsConfig, mod, value);
}

export function enforceLocaleModStates(): void {
  const { LOCALE_MOD_REQUIREMENTS } = require("./constants") as typeof import("./constants");
  const locale = config.get<string>("output_locale", "english");
  const all = new Set(Object.values(LOCALE_MOD_REQUIREMENTS).flat());
  const required = new Set(LOCALE_MOD_REQUIREMENTS[locale] ?? []);
  for (const mod of all) setState(mod, required.has(mod));
}

export function getConflictingCategories(): Set<string> {
  const categories = new Set(CATEGORY_CONFLICTS);
  try {
    if (fs.existsSync(base.pluginsDir)) {
      for (const entry of fs.readdirSync(base.pluginsDir)) {
        if (isIgnoredFolder(entry)) continue;
        const manifest = path.join(base.pluginsDir, entry, "manifest.json");
        if (!fs.existsSync(manifest)) continue;
        const cfg = config.readJsonFile(manifest);
        const ext = cfg.category_conflicts ?? cfg.conflicting_categories;
        if (Array.isArray(ext)) for (const c of ext) categories.add(String(c).toLowerCase());
      }
    }
  } catch {
    /* ignore */
  }
  return categories;
}

function replace<T>(target: T[], values: T[]): void {
  target.splice(0, target.length, ...values);
}

/** Reads a mod's manifest.json ({} if missing). */
export function readManifest(modPath: string): Record<string, any> {
  const file = path.join(modPath, "manifest.json");
  if (!fs.existsSync(file)) return {};
  const data = config.readJsonFile(file);
  return isPlainObject(data) ? data : {};
}

export function scanMods(): void {
  if (!fs.existsSync(base.modsDir)) {
    throw new Error(`Mods directory not found: ${path.resolve(base.modsDir)}`);
  }

  const alphabetical: string[] = [];
  const withOrder: Array<[string, number]> = [];
  const unavailable: string[] = [];
  const available: string[] = [];
  const dependencies: Array<Record<string, string[]>> = [];
  const conflicts: Array<Record<string, string[]>> = [];
  const categoryMods = new Map<string, string[]>();
  const activeCats = getConflictingCategories();

  const entries = fs.readdirSync(base.modsDir).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const mod of entries) {
    if (isIgnoredFolder(mod)) continue;
    const modPath = path.join(base.modsDir, mod);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(modPath).isDirectory();
    } catch {
      continue;
    }

    if (isDirectory) {
      alphabetical.push(mod);
      const blacklistExists = fs.existsSync(path.join(modPath, "blacklist.txt"));
      const cfg = readManifest(modPath);
      const order = typeof cfg.order === "number" ? cfg.order : 1;
      (cfg.visual ?? true ? available : unavailable).push(mod);
      if (cfg.dependencies != null) dependencies.push({ [mod]: [].concat(cfg.dependencies) });
      if (cfg.conflicts != null) conflicts.push({ [mod]: typeof cfg.conflicts === "string" ? [cfg.conflicts] : [...cfg.conflicts] });
      const category = cfg.category ? String(cfg.category).toLowerCase() : null;
      if (category && activeCats.has(category)) {
        if (!categoryMods.has(category)) categoryMods.set(category, []);
        categoryMods.get(category)!.push(mod);
      }
      // Default order: blacklist-only mods are indexed last
      withOrder.push([mod, blacklistExists && Object.keys(cfg).length === 0 ? 2 : order]);
    } else if (mod.endsWith(".vpk")) {
      alphabetical.push(mod);
      available.push(mod);
      withOrder.push([mod, 1]);
    }
  }

  for (const modsInCat of categoryMods.values()) {
    if (modsInCat.length <= 1) continue;
    for (const mod of modsInCat) {
      const others = modsInCat.filter((m) => m !== mod);
      const existing = conflicts.find((item) => mod in item);
      if (existing) {
        for (const c of others) if (!existing[mod].includes(c)) existing[mod].push(c);
      } else {
        conflicts.push({ [mod]: others });
      }
    }
  }

  // stable sort by order (python's sorted is stable too)
  const ordered = withOrder.map((e, i) => [...e, i] as [string, number, number]).sort((a, b) => a[1] - b[1] || a[2] - b[2]);

  replace(modsAlphabetical, alphabetical);
  replace(modsWithOrder, ordered.map((e) => e[0]));
  replace(visuallyUnavailableMods, unavailable);
  replace(visuallyAvailableMods, available);
  replace(modDependenciesList, dependencies);
  replace(modConflictsList, conflicts);
}
