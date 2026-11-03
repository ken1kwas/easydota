import fs from "node:fs";
import path from "node:path";

import * as base from "../../core/base";
import * as config from "../../core/config";
import { minifyOutputList } from "../../core/constants";
import { isPlainObject } from "../../core/jsonc";
import * as localization from "../../core/localization";
import * as modsShared from "../../core/mods-shared";
import * as steam from "../../core/steam";
import * as helper from "../../helper";
import * as scriptLoader from "../../core/script-loader";

export interface SettingSchema {
  key: string;
  value_key: string;
  text: string;
  type: string;
  default: unknown;
  advanced?: boolean;
  mod?: string;
  mod_display_name?: string;
  plugin?: string;
  force?: boolean;
  items?: unknown[];
  var_type?: "int" | "float";
  step?: number;
  min?: number;
  max?: number;
  [key: string]: unknown;
}

export class ConfigService {
  getAvailableLanguages(): string[] {
    const langs = localization.getAvailable();
    return langs.length ? langs : ["en"];
  }

  isDebugEnv(): boolean {
    return Boolean(config.get("debug_env"));
  }

  getLocalization(lang = "en"): Record<string, string> {
    let requested: unknown = lang || config.get("locale") || "en";
    if (typeof requested !== "string") requested = "en";
    const resolved = this.getAvailableLanguages().find((l) => l.toLowerCase() === (requested as string).toLowerCase()) ?? "en";
    const localized = localization.getForLocale(resolved);
    return Object.keys(localized).length ? localized : localization.getForLocale("en");
  }

  getCurrentLocale(): string {
    const val = String(config.get("locale") || "en");
    return this.getAvailableLanguages().find((a) => a.toLowerCase() === val.toLowerCase()) ?? "en";
  }

  setLocale(lang: string): boolean {
    config.set("locale", lang);
    localization.loadHeadless();
    return true;
  }

  getAvailableGameLanguages(): string[] {
    return minifyOutputList;
  }

  getCurrentGameLanguage(): string {
    return config.get("output_locale", "english");
  }

  setGameLanguage(lang: string): boolean {
    config.set("output_locale", lang);
    helper.syncOutputPath();
    modsShared.enforceLocaleModStates();
    return true;
  }

  getSteamAccounts(): steam.SteamAccount[] {
    return steam.getSteamAccounts();
  }

  getAvailableThemes(): Array<{ value: string; label: string }> {
    const themes: Array<{ value: string; label: string }> = [];
    if (fs.existsSync(base.themesDir)) {
      for (const item of fs.readdirSync(base.themesDir).sort()) {
        if (!item.toLowerCase().endsWith(".css") || !fs.statSync(path.join(base.themesDir, item)).isFile()) continue;
        const name = item.slice(0, -4);
        const label = name.replace(/[_-]/g, " ").replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
        themes.push({ value: name, label });
      }
    }
    if (!themes.some((t) => t.value === "light")) themes.unshift({ value: "light", label: "Light" });
    return themes;
  }

  getThemeCss(themeName?: string | null): string {
    const name = themeName || config.get("theme", "light") || "light";
    let clean = path.basename(String(name));
    if (!clean.toLowerCase().endsWith(".css")) clean += ".css";
    let themePath = path.join(base.themesDir, clean);
    if (!fs.existsSync(themePath)) themePath = path.join(base.themesDir, "light.css");
    return fs.existsSync(themePath) ? fs.readFileSync(themePath, "utf8") : "";
  }

  getBaseCss(): string {
    const p = path.join(base.webDir, "app.css");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }

  static extractBgColor(themeCss: string): string {
    return themeCss?.match(/--bg-primary\s*:\s*(#[0-9a-fA-F]{3,6})\b/)?.[1] ?? "#FFFFFF";
  }

  static injectThemeIntoContent(html: string, themeCss: string, baseCss = ""): string {
    if (!html) return "";
    const styles = [baseCss && `<style id="minify-base">${baseCss}</style>`, themeCss && `<style id="minify-theme">${themeCss}</style>`]
      .filter(Boolean)
      .join("");
    if (!styles) return html;
    const headClose = html.lastIndexOf("</head>");
    return headClose !== -1 ? html.slice(0, headClose) + styles + html.slice(headClose) : styles + html;
  }

  static parseSettingItem(item: unknown, modFolder?: string, pluginFolder?: string): SettingSchema | null {
    if (!isPlainObject(item)) return null;
    const { key, type } = item;
    if (!key || !type) return null;

    const stype = String(type).toLowerCase();
    let def = item.default;
    if (def === undefined || def === null) {
      if (stype === "checkbox") def = false;
      else if (["inputbox", "text", "color"].includes(stype)) def = "";
      else if (stype === "number" || stype === "slider") def = item.min ?? 0;
      else if (stype === "list") def = [];
      else if (stype === "combo") def = Array.isArray(item.items) && item.items.length ? item.items[0] : "";
    }

    const entry: SettingSchema = {
      key,
      value_key: modFolder ? `mod:${modFolder}:${key}` : key,
      text: item.text ?? key,
      type: stype,
      default: def,
    };
    if (item.advanced === true) entry.advanced = true;
    if (modFolder) entry.mod = modFolder;
    if (pluginFolder) entry.plugin = pluginFolder;
    if ("force" in item) entry.force = Boolean(item.force);

    if (stype === "combo") {
      entry.items = item.items ?? [];
    } else if (stype === "number" || stype === "slider") {
      const vtype = item.var_type || (typeof def === "number" && !Number.isInteger(def) ? "float" : "int");
      entry.var_type = vtype;
      entry.step = item.step ?? (vtype === "float" ? 0.1 : 1);
      if ("min" in item) entry.min = item.min;
      else if (stype === "slider") entry.min = 0;
      if ("max" in item) entry.max = item.max;
      else if (stype === "slider") entry.max = 100;
    }
    // pass through UI-only fields (button function names, descriptions ...)
    for (const [k, v] of Object.entries(item)) if (!(k in entry) && !["default", "items"].includes(k)) entry[k] = v;
    return entry;
  }

  getSettings(): { schema: SettingSchema[]; values: Record<string, unknown> } {
    modsShared.scanMods();
    const nativeSchema = config.readJsonFile<unknown>(base.settingsFileDir);
    const schema: SettingSchema[] = [];
    const values: Record<string, unknown> = {};

    for (const item of Array.isArray(nativeSchema) ? nativeSchema : []) {
      const parsed = ConfigService.parseSettingItem(item);
      if (!parsed) continue;
      if (parsed.key === "steam_id") {
        parsed.items = steam.getSteamAccounts().map((acc) => ({
          value: acc.id,
          label: acc.name && acc.name !== "?" ? `${acc.name} (${acc.id})` : `User ${acc.id}`,
        }));
      } else if (parsed.key === "theme") parsed.items = this.getAvailableThemes();
      else if (parsed.key === "locale") parsed.items = this.getAvailableLanguages();
      else if (parsed.key === "output_locale") parsed.items = this.getAvailableGameLanguages();
      schema.push(parsed);
      values[parsed.key] = config.get(parsed.key, parsed.default);
    }

    // plugin manifest settings
    if (fs.existsSync(base.pluginsDir)) {
      for (const folder of fs.readdirSync(base.pluginsDir).sort()) {
        if (modsShared.isIgnoredFolder(folder)) continue;
        const manifestPath = path.join(base.pluginsDir, folder, "manifest.json");
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = config.readJsonFile(manifestPath);
        if (!Array.isArray(manifest.settings)) continue;
        for (const item of manifest.settings) {
          const parsed = ConfigService.parseSettingItem(item, undefined, folder);
          if (parsed) {
            schema.push(parsed);
            values[parsed.value_key] = config.get(parsed.key, parsed.default);
          }
        }
      }
    }

    // mod manifest settings
    if (fs.existsSync(base.modsDir)) {
      for (const folder of fs.readdirSync(base.modsDir).sort()) {
        if (modsShared.isIgnoredFolder(folder)) continue;
        const modPath = path.join(base.modsDir, folder);
        if (!fs.statSync(modPath).isDirectory()) continue;
        const cfg = modsShared.readManifest(modPath);
        if (!Array.isArray(cfg.settings)) continue;
        const enabled = Boolean(cfg.always) || modsShared.getState(folder);
        for (const item of cfg.settings) {
          const force = isPlainObject(item) && Boolean(item.force);
          if (!(force || enabled)) continue;
          const parsed = ConfigService.parseSettingItem(item, folder);
          if (!parsed) continue;
          if (cfg.name) parsed.mod_display_name = String(cfg.name);
          const store = config.getMod(folder, {});
          values[parsed.value_key] = parsed.key in store ? store[parsed.key] : parsed.default;
          schema.push(parsed);
        }
      }
    }
    return { schema, values };
  }

  setSetting(key: string, value: unknown, modName?: string | null): boolean {
    if (modName) {
      const modconf = config.getMod(modName, {});
      modconf[key] = value;
      config.setMod(modName, modconf);
    } else if (key === "locale") this.setLocale(String(value));
    else if (key === "output_locale") this.setGameLanguage(String(value));
    else config.set(key, value);
    return true;
  }

  async runModFunction(modName: string, functionName: string): Promise<boolean> {
    const script = scriptLoader.resolveScript(path.join(base.modsDir, modName), "script_utility");
    if (!script) return false;
    await helper.execScriptFunction(script, modName, functionName);
    return true;
  }

  resetNativeSettings(): boolean {
    const schema = config.readJsonFile<unknown>(base.settingsFileDir);
    if (Array.isArray(schema)) {
      for (const item of schema) if (isPlainObject(item) && "key" in item && "default" in item) this.setSetting(item.key, item.default);
    }
    return true;
  }

  resetModSettings(modName: string): boolean {
    const modconf = config.get<Record<string, unknown>>("modconf", {});
    if (isPlainObject(modconf) && modName in modconf) {
      delete modconf[modName];
      config.set("modconf", modconf);
    }
    return true;
  }
}
