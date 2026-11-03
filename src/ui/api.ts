/**
 * Backend API exposed to the web UI.
 *
 * Method names stay snake_case because the Svelte frontend calls them as
 * `window.pywebview.api.<name>(...)` (kept for compatibility with the python edition).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as conditions from "../conditions";
import * as base from "../core/base";
import { C, recalcRescompDirs } from "../core/constants";
import * as mfs from "../core/fs";
import * as log from "../core/log";
import * as output from "../core/output";
import { launchDetached } from "../core/proc";
import * as utils from "../core/utils";
import * as helper from "../helper";
import { ConfigService } from "./services/config-service";
import { ModService } from "./services/mod-service";
import { PatchService, type EventSink } from "./services/patch-service";
import { PluginService } from "./services/plugin-service";

export interface HostCallbacks {
  openUrl(url: string): void;
  shutdown?(): void;
  quit(): void;
}

export class Api {
  readonly patchService = new PatchService();
  readonly modService = new ModService();
  readonly configService = new ConfigService();
  readonly pluginService = new PluginService();
  private host: HostCallbacks;

  constructor(host: HostCallbacks) {
    this.host = host;
  }

  setSink(sink: EventSink | null): void {
    this.patchService.setSink(sink);
  }

  close(): void {
    this.patchService.close();
  }

  // ------------------------------------------------------------- app ---
  shutdown_host() {
    this.host.shutdown?.();
    return true;
  }
  open_url(url: string) {
    this.host.openUrl(url);
  }
  open_config_directory() {
    mfs.openThing(base.configDir);
  }
  create_debug_zip() {
    try {
      log.createDebugZip();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  get_readme_content() {
    try {
      const root = path.resolve(base.baseDir, "..");
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
      const readme = read(path.join(base.baseDir, "README.md")) || read(path.join(root, "README.md"));
      const license = read(path.join(base.baseDir, "LICENSE")) || read(path.join(root, "LICENSE"));
      return { success: true, readme, license };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  get_version() {
    return base.VERSION;
  }
  is_debug_env() {
    return this.configService.isDebugEnv();
  }

  static isPortable(): boolean {
    if (!base.FROZEN) return true;
    return !fs.existsSync(path.join(path.dirname(process.execPath), "unins000.exe"));
  }

  perform_update(url: string) {
    if (!base.isWin || Api.isPortable()) {
      this.host.openUrl(base.githubIo);
      return false;
    }
    void (async () => {
      const name = url.split("?")[0].split("/").pop() || "Minify-Setup.exe";
      const installer = path.join(os.tmpdir(), name);
      output.addText(`Downloading update: ${name}...`);
      const ok = await mfs.downloadFile(url, installer, { name, taskId: "app-update", emitProgress: true });
      if (!ok || !fs.existsSync(installer)) {
        output.addText("Update download failed.", { msgType: "error" });
        return;
      }
      await utils.sleep(2000);
      output.addText("Launching installer and closing Minify...");
      try {
        launchDetached(installer);
      } catch (err) {
        log.writeCrashlog(err, "Failed to launch installer");
        output.addText(`Failed to launch installer: ${err}`, { msgType: "error" });
      } finally {
        this.host.quit();
      }
    })();
    return true;
  }

  // ----------------------------------------------------------- patch ---
  start_patch() {
    return this.patchService.startPatch();
  }
  start_uninstall(removeEverything = false) {
    return this.patchService.startUninstall(removeEverything);
  }
  is_patching() {
    return this.patchService.isPatching();
  }
  get_logs() {
    return this.patchService.getLogs();
  }
  get_downloads() {
    return this.patchService.getDownloads();
  }
  clear_logs() {
    return this.patchService.clearLogs();
  }

  // ------------------------------------------------------------ mods ---
  get_mods() {
    return this.modService.getMods();
  }
  get_mod_details(modName: string, lang?: string | null) {
    return this.modService.getModDetails(modName, lang);
  }
  set_mods(data: Record<string, boolean>) {
    return this.modService.setMods(data);
  }

  // ---------------------------------------------------------- config ---
  get_available_languages() {
    return this.configService.getAvailableLanguages();
  }
  get_localization(lang = "en") {
    return this.configService.getLocalization(lang);
  }
  get_current_locale() {
    return this.configService.getCurrentLocale();
  }
  set_locale(lang: string) {
    return this.configService.setLocale(lang);
  }
  get_available_game_languages() {
    return this.configService.getAvailableGameLanguages();
  }
  get_current_game_language() {
    return this.configService.getCurrentGameLanguage();
  }
  set_game_language(lang: string) {
    return this.configService.setGameLanguage(lang);
  }
  get_steam_accounts() {
    return this.configService.getSteamAccounts();
  }
  get_settings() {
    return this.configService.getSettings();
  }
  set_setting(key: string, value: unknown, modName?: string | null) {
    return this.configService.setSetting(key, value, modName);
  }
  run_mod_function(modName: string, functionName: string) {
    return this.configService.runModFunction(modName, functionName);
  }
  reset_native_settings() {
    return this.configService.resetNativeSettings();
  }
  reset_mod_settings(modName: string) {
    return this.configService.resetModSettings(modName);
  }
  get_available_themes() {
    return this.configService.getAvailableThemes();
  }
  get_theme_css(themeName?: string | null) {
    return this.configService.getThemeCss(themeName);
  }
  get_state(key: string, def: unknown = null) {
    const states = utils.readStates();
    return key in states ? states[key] : def;
  }
  set_state(key: string, value: unknown) {
    utils.writeStates(key, value);
    return true;
  }

  // -------------------------------------------------- workshop tools ---
  check_workshop_tools_needed() {
    return base.isLinux && !C.rescompOverride && conditions.state.workshopInstalled;
  }
  extract_workshop_tools() {
    return helper.extractWorkshopTools();
  }
  is_workshop_installed() {
    return conditions.state.workshopInstalled;
  }

  async download_workshop_tools(): Promise<boolean> {
    const fallback = "https://github.com/Dota-Modding-Community/workshoptools/releases/latest/download/resourcecompiler.zip";
    let downloadUrl = fallback;
    try {
      const res = await fetch("https://api.github.com/repos/Dota-Modding-Community/workshoptools/releases/latest", {
        headers: { "User-Agent": "dota2-minify" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const asset = ((await res.json()) as { assets?: Array<{ name?: string; browser_download_url?: string }> }).assets?.find((a) =>
          a.name?.endsWith(".zip"),
        );
        if (asset?.browser_download_url) downloadUrl = asset.browser_download_url;
      }
    } catch (err) {
      log.writeWarning(`Could not query GitHub API for workshoptools release: ${err}`);
    }

    const zipPath = path.join(os.tmpdir(), "workshoptools.zip");
    output.addText(`Downloading Workshop Tools from ${downloadUrl}...`);
    if (!(await mfs.downloadFile(downloadUrl, zipPath, { name: "workshoptools.zip", taskId: "workshoptools" })) || !fs.existsSync(zipPath)) {
      output.addText("Failed to download Workshop Tools.", { msgType: "error" });
      return false;
    }

    output.addText("Expanding Workshop Tools to config/rescomproot...");
    const target = base.rescompOverrideDir;
    mfs.createDirs(target);
    if (!(await mfs.extractArchive(zipPath, target))) {
      output.addText("Failed to extract Workshop Tools archive.", { msgType: "error" });
      return false;
    }
    const inner = path.join(target, "resourcecompiler");
    if (mfs.isDir(inner)) {
      for (const item of fs.readdirSync(inner)) {
        const dst = path.join(target, item);
        if (fs.existsSync(dst)) mfs.removePath(dst);
        mfs.movePath(path.join(inner, item), dst);
      }
      mfs.removePath(inner);
    }
    mfs.removePath(zipPath);

    recalcRescompDirs();
    if (!base.isWin && fs.existsSync(C.dotaResourceCompilerPath)) {
      fs.chmodSync(C.dotaResourceCompilerPath, fs.statSync(C.dotaResourceCompilerPath).mode | 0o111);
    }
    conditions.state.workshopInstalled = fs.existsSync(C.dotaResourceCompilerPath);
    if (conditions.state.workshopInstalled) {
      output.addText("Workshop Tools installed successfully!", { msgType: "success" });
      return true;
    }
    output.addText(`resourcecompiler.exe was not found at ${C.dotaResourceCompilerPath}`, { msgType: "error" });
    return false;
  }

  // ---------------------------------------------------- legacy mods ---
  private legacyBackupDirs(): string[] {
    return fs
      .readdirSync(base.baseDir)
      .filter((n) => n.startsWith("mods_old_") && mfs.isDir(path.join(base.baseDir, n)))
      .sort()
      .map((n) => path.join(base.baseDir, n));
  }

  get_legacy_mods() {
    const dirs = this.legacyBackupDirs();
    if (!dirs.length) return [];
    const latest = dirs[dirs.length - 1];
    return fs
      .readdirSync(latest)
      .sort()
      .filter((e) => !fs.existsSync(path.join(base.modsDir, e)))
      .map((e) => `${path.basename(latest)}/${e}`);
  }

  import_legacy_mods(importMods = true) {
    const migrated: string[] = [];
    const discarded: string[] = [];
    mfs.createDirs(base.modsDir);
    const dirs = this.legacyBackupDirs();
    const latest = dirs[dirs.length - 1];
    if (latest) {
      for (const name of fs.readdirSync(latest).sort()) {
        const src = path.join(latest, name);
        const dst = path.join(base.modsDir, name);
        try {
          if (!importMods || fs.existsSync(dst)) {
            discarded.push(name);
            mfs.removePath(src);
          } else {
            mfs.movePath(src, dst);
            migrated.push(name);
          }
        } catch {
          discarded.push(name);
          mfs.removePath(src);
        }
      }
      utils.tryPass(() => fs.rmdirSync(latest));
      for (const stale of dirs.slice(0, -1)) mfs.removePath(stale);
    }
    return { migrated, discarded };
  }

  // --------------------------------------------------------- plugins ---
  get_plugin_tabs() {
    return this.pluginService.getTabs();
  }
  get_plugin_content(pluginId: string) {
    return this.pluginService.getContent(pluginId);
  }
  get_plugin_localization(pluginId: string, lang = "en") {
    return this.pluginService.getLocalization(pluginId, lang);
  }
  call_plugin_api(pluginId: string, action: string, params?: Record<string, any> | null) {
    return this.pluginService.callApi(pluginId, action, params);
  }
}

/** Public method names callable from the frontend. */
export function apiMethodNames(api: Api): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(api)).filter(
    (n) => n !== "constructor" && /^[a-z_]+$/.test(n) && typeof (api as any)[n] === "function" && n !== "close",
  );
}

/** Invokes an API method by name; rejects private/unknown names. */
export async function invokeApi(api: Api, method: string, args: unknown[]): Promise<unknown> {
  if (!apiMethodNames(api).includes(method)) throw new Error(`Invalid API method: ${method}`);
  return (api as any)[method](...args);
}
