// Dynamic localization handling

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import * as config from "./config";
import { isPlainObject, readJsonc } from "./jsonc";

export let locale = "";
/** Mutated in place so every importer sees the active dictionary. */
export const localizationDict: Record<string, string> = {};
export let localizations: string[] = [];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function loadDict(localesDir: string, lang = "en"): Record<string, string> {
  if (!localesDir || !isDir(localesDir)) return {};
  const result: Record<string, string> = {};
  const overlay = (file: string) => {
    if (!fs.existsSync(file)) return;
    try {
      const data = readJsonc(file);
      if (isPlainObject(data)) Object.assign(result, data);
    } catch {
      /* ignore */
    }
  };
  // 1. Base English fallback, 2. target language
  overlay(path.join(localesDir, "en.json"));
  lang = (lang || "en").toLowerCase();
  if (lang !== "en") overlay(path.join(localesDir, `${lang}.json`));
  return result;
}

function pluginFolders(): string[] {
  if (!isDir(base.pluginsDir)) return [];
  return fs.readdirSync(base.pluginsDir).sort();
}

function mergePluginLocalizations(target: Record<string, string>, lang = "en"): void {
  for (const folder of pluginFolders()) {
    const pLocales = path.join(base.pluginsDir, folder, "locales");
    if (isDir(pLocales)) Object.assign(target, loadDict(pLocales, lang));
  }
}

export function loadHeadless(): void {
  const raw = config.get<unknown>("locale", "en");
  locale = (typeof raw === "string" ? raw : "en").toLowerCase();
  for (const key of Object.keys(localizationDict)) delete localizationDict[key];
  Object.assign(localizationDict, loadDict(base.localesDir, locale));
  mergePluginLocalizations(localizationDict, locale);
}

export function getAvailable(): string[] {
  const langs = new Set<string>();
  const scan = (dir: string) => {
    if (!isDir(dir)) return;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) langs.add(f.slice(0, -5).toLowerCase());
  };
  scan(base.localesDir);
  for (const folder of pluginFolders()) scan(path.join(base.pluginsDir, folder, "locales"));

  const sorted = [...langs].filter((l) => l !== "en").sort();
  localizations = langs.has("en") ? ["en", ...sorted] : sorted;
  return localizations;
}

export function getForLocale(lang = "en"): Record<string, string> {
  lang = (lang || "en").toLowerCase();
  const result = loadDict(base.localesDir, lang);
  mergePluginLocalizations(result, lang);
  return result;
}

export function getForPlugin(pluginId: string, lang = "en"): Record<string, string> {
  return loadDict(path.join(base.pluginsDir, pluginId, "locales"), (lang || "en").toLowerCase());
}

/** Return only the requested language section from `<!-- lang:xx -->` marked notes. */
export function parseNotesForLocale(notesText: string, lang = "en"): string {
  if (!notesText || !notesText.toLowerCase().includes("<!-- lang:")) return (notesText ?? "").trim();

  const sections = new Map<string, string>();
  let currentLang: string | null = null;
  let lines: string[] = [];
  const marker = "<!-- lang:";

  for (const line of notesText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(marker) && trimmed.endsWith("-->")) {
      if (currentLang) sections.set(currentLang, lines.join("\n").trim());
      currentLang = trimmed.slice(marker.length, -3).trim().toLowerCase();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (currentLang) sections.set(currentLang, lines.join("\n").trim());

  const target = (lang || "en").toLowerCase();
  if (sections.has(target)) return sections.get(target)!;
  if (sections.has("en")) return sections.get("en")!;
  const first = sections.values().next();
  if (!first.done) return first.value;
  return notesText.trim();
}
