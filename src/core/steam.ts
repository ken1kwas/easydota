/**
 * Finds the Steam root and the library Dota 2 is in (always accounts for the Windows executable path
 * in case it is used through an emulation layer). Also fixes the language argument for the user(s).
 */

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import * as config from "./config";
import * as log from "./log";
import * as output from "./output";
import { run } from "./proc";
import * as vdf from "./vdf";

export let ROOT = "";
export let LIBRARY = "";
export let steamExecutablePath = "";

/**
 * Hook used when Steam couldn't be located. The GUI installs one that shows a folder picker;
 * returning null aborts.
 */
export const hooks: { promptSteamRoot?: () => Promise<string | null> } = {};

const LAUNCH_OPTIONS_PATH = ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps", base.STEAM_DOTA_ID, "LaunchOptions"];

// --------------------------------------------------------- launch options --

/** Parse launch options, remove the language argument and return a clean string. */
export function removeLangArgs(argString: string): string {
  if (!argString) return "";
  const tokens = argString.split(/\s+/).filter(Boolean);
  const cleaned: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-language") {
      if (i + 1 < tokens.length && !/^[-+]/.test(tokens[i + 1])) i++;
      continue;
    }
    cleaned.push(tokens[i]);
  }
  return cleaned.join(" ");
}

/** Parse launch options, remove a specific language argument and return a clean string. */
export function removeSpecificLangArg(argString: string, langToRemove: string): string {
  if (!argString) return "";
  const tokens = argString.split(/\s+/).filter(Boolean);
  const cleaned: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-language" && i + 1 < tokens.length && !/^[-+]/.test(tokens[i + 1]) && tokens[i + 1] === langToRemove) {
      i++;
      continue;
    }
    cleaned.push(tokens[i]);
  }
  return cleaned.join(" ");
}

function targetSteamIds(): string[] {
  if (config.get("apply_for_all")) return getSteamAccounts().map((a) => a.id);
  return [String(config.get("steam_id") ?? "")];
}

function localConfigPath(steamId: string): string {
  return path.join(String(config.get("steam_root") ?? ""), "userdata", steamId, "config", "localconfig.vdf");
}

function setLaunchOptions(data: vdf.VdfObject, value: string): void {
  let cur = data;
  for (const key of LAUNCH_OPTIONS_PATH.slice(0, -1)) cur = cur[key] as vdf.VdfObject;
  cur[LAUNCH_OPTIONS_PATH[LAUNCH_OPTIONS_PATH.length - 1]] = value;
}

function readLaunchOptions(data: vdf.VdfObject): string | undefined {
  const v = vdf.getPath(data, LAUNCH_OPTIONS_PATH);
  return typeof v === "string" ? v : undefined;
}

/** If packaged and patch_on_launch is enabled, prepend the prelaunch command before %command%. */
export function addPrelaunchToLaunchOptions(checkOnly = false): boolean {
  if (!base.FROZEN || !config.get("patch_on_launch")) return false;

  let changed = false;
  for (const steamId of targetSteamIds()) {
    const vdfPath = localConfigPath(steamId);
    if (!fs.existsSync(vdfPath)) continue;
    const data = vdf.load(vdfPath);
    const launchOptions = readLaunchOptions(data);
    if (launchOptions === undefined) continue;

    const prefix = base.isWin ? `"${process.execPath}" prelaunch` : `bash -c "${process.execPath} prelaunch" &&`;
    if (launchOptions.startsWith(prefix)) continue;

    const other = launchOptions.split(/\s+/).filter((t) => t && t !== "%command%");
    const newOptions = [prefix, "%command%", ...other].join(" ");
    if (newOptions !== launchOptions) {
      if (checkOnly) return true;
      setLaunchOptions(data, newOptions);
      vdf.save(vdfPath, data);
      changed = true;
    }
  }
  return changed;
}

/**
 * Fixes user(s) launch options with the language argument for the current output path.
 * Does it for all accounts if "apply_for_all" is set.
 */
export function fixLaunchOptions(checkOnly = false): string[] | boolean {
  const accounts = getSteamAccounts();
  const successful: string[] = [];

  for (const steamId of targetSteamIds()) {
    const vdfPath = localConfigPath(steamId);
    if (!fs.existsSync(vdfPath)) continue;
    if (!checkOnly) output.addText("&checking_launch_options");
    const data = vdf.load(vdfPath);

    const locale = config.getLocale();
    const launchOptions = readLaunchOptions(data);
    if (launchOptions === undefined) continue;

    const count = launchOptions.split("-language").length - 1;
    if (!launchOptions.includes(`-language ${locale}`) || count >= 2) {
      if (checkOnly) return true;
      const userName = accounts.find((u) => u.id === steamId)?.name ?? "?";
      output.addText("&discrepancy_launch_options", [userName, locale], { indent: true });
      setLaunchOptions(data, `-language ${locale} ${removeLangArgs(launchOptions)}`);
      vdf.save(vdfPath, data);
      successful.push(steamId);
    }
  }
  return checkOnly ? false : successful;
}

/** Removes `-language <locale>` only if the configured output locale is english. */
export function removeMinifyLang(): string[] {
  const successful: string[] = [];
  for (const steamId of targetSteamIds()) {
    const vdfPath = localConfigPath(steamId);
    if (!fs.existsSync(vdfPath)) continue;
    const data = vdf.load(vdfPath);
    if (config.get("output_locale") !== "english") continue;

    const launchOptions = readLaunchOptions(data);
    if (launchOptions === undefined) continue;
    if (launchOptions.includes("-language")) {
      setLaunchOptions(data, removeSpecificLangArg(launchOptions, config.getLocale()));
      vdf.save(vdfPath, data);
      successful.push(steamId);
    }
  }
  return successful;
}

function bootVcfgPath(): string {
  return path.join(LIBRARY, "steamapps", "common", "dota 2 beta", "game", "dota", "cfg", "boot.vcfg");
}

/** Restores UILanguage in boot.vcfg to english if symbolic english (dutch) was used. */
export function restoreBootLanguage(): boolean {
  if (config.get("output_locale") !== "english") return false;
  const file = bootVcfgPath();
  if (!fs.existsSync(file)) return false;
  let data: vdf.VdfObject;
  try {
    data = vdf.load(file);
  } catch {
    log.writeWarning("Error reading boot.vcfg");
    return false;
  }
  const boot = data.boot;
  if (typeof boot !== "object" || boot.UILanguage !== "dutch") return false;
  boot.UILanguage = "english";
  vdf.save(file, data);
  return true;
}

/** Ensures UILanguage in boot.vcfg matches the resolved locale (e.g. dutch for english). */
export function fixBootLanguage(checkOnly = false): boolean {
  const locale = config.getLocale();
  const file = bootVcfgPath();
  if (!fs.existsSync(file)) return false;
  let data: vdf.VdfObject;
  try {
    data = vdf.load(file);
  } catch {
    log.writeWarning("Error reading boot.vcfg");
    return false;
  }
  const boot = (typeof data.boot === "object" ? data.boot : (data.boot = {})) as vdf.VdfObject;
  if (boot.UILanguage === locale) return false;
  if (checkOnly) return true;
  boot.UILanguage = locale;
  vdf.save(file, data);
  return true;
}

// ------------------------------------------------------- library discovery --

function hasDota(library: string): boolean {
  return (
    fs.existsSync(path.join(library, base.DOTA_EXECUTABLE_PATH)) ||
    fs.existsSync(path.join(library, base.DOTA_EXECUTABLE_PATH_FALLBACK))
  );
}

/** Find the Dota 2 library from libraryfolders.vdf */
export function findLibraryFromVdf(steamRoot: string): boolean {
  try {
    const regPath = path.join(steamRoot, "config", "libraryfolders.vdf");
    if (!steamRoot || steamRoot === "." || !fs.existsSync(regPath)) return false;
    const data = vdf.load(regPath);
    const folders = data.libraryfolders;
    if (typeof folders !== "object") return false;
    for (const folder of Object.values(folders)) {
      if (typeof folder === "object" && typeof folder.path === "string" && hasDota(folder.path)) {
        config.set("steam_library", folder.path);
        return true;
      }
    }
    return false;
  } catch (err) {
    log.writeWarning("Error reading libraryfolders.vdf", [], err);
    config.set("steam_library", "");
    return false;
  }
}

async function queryRegistryInstallPath(): Promise<string | null> {
  for (const key of ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "HKLM\\SOFTWARE\\Valve\\Steam", "HKCU\\SOFTWARE\\Valve\\Steam"]) {
    try {
      const res = await run("reg", ["query", key, "/v", key.startsWith("HKCU") ? "SteamPath" : "InstallPath"]);
      const m = res.stdout.match(/REG_SZ\s+(.+)\s*$/m);
      if (m) {
        const p = path.normalize(m[1].trim());
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Get the Steam root path via the registry (Windows) or the default install location. */
export async function getSteamRootPath(): Promise<string> {
  const configured = String(config.get("steam_root", "") ?? "");
  if (configured && fs.existsSync(configured)) return configured;

  let found = "";
  if (base.isWin) found = (await queryRegistryInstallPath()) ?? "";
  if (!found && fs.existsSync(base.STEAM_DEFAULT_INSTALLATION_PATH)) found = base.STEAM_DEFAULT_INSTALLATION_PATH;

  if (found) {
    config.set("steam_root", found);
    config.set("steam_library", found); // assume, will be checked anyway
    return found;
  }
  return "";
}

/**
 * root = library: found; root != library: find from library VDF; unknown root: ask the user.
 */
export async function handleNonDefaultPath(steamRoot: string): Promise<string> {
  let library = String(config.get("steam_library", "") ?? "");
  if (!fs.existsSync(path.join(library, base.DOTA_EXECUTABLE_PATH))) {
    findLibraryFromVdf(steamRoot);
    library = String(config.get("steam_library", "") ?? "");
  }

  while (!library || !hasDota(library)) {
    const picked = hooks.promptSteamRoot ? await hooks.promptSteamRoot() : null;
    if (!picked) {
      output.addText(
        `We couldn't find your Steam/Dota 2 installation. Set "steam_root" and "steam_library" in '${base.paths.mainConfigFile}' and restart Minify.`,
        { msgType: "error" },
      );
      break;
    }
    steamRoot = path.normalize(picked);
    config.set("steam_root", steamRoot);
    if (!findLibraryFromVdf(steamRoot) && hasDota(steamRoot)) config.set("steam_library", steamRoot);
    library = String(config.get("steam_library", "") ?? "");
  }
  return steamRoot;
}

const BASE_STEAM_64 = (1n << 56n) | (1n << 52n) | (1n << 32n);

/** Converts a 64-bit SteamID to a 32-bit AccountID string. */
export function steam64ToAccountId(steam64: string | number | bigint): string {
  try {
    return String(BigInt(steam64) & 0xffffffffn);
  } catch {
    return String(steam64);
  }
}

/** Converts a 32-bit AccountID to a 64-bit SteamID. */
export function accountIdToSteam64(accountId: string | number): bigint {
  try {
    return BigInt(accountId) | BASE_STEAM_64;
  } catch {
    return 0n;
  }
}

interface LoginInfo {
  steam64: string;
  persona_name: string;
  account_name: string;
  timestamp: number;
  autologin: boolean;
}

/** Parse loginusers.vdf to map 32-bit account_id -> login info. */
export function getLoginusersData(): Record<string, LoginInfo> {
  const map: Record<string, LoginInfo> = {};
  if (!ROOT) return map;
  const file = path.join(ROOT, "config", "loginusers.vdf");
  if (!fs.existsSync(file)) return map;
  try {
    const users = vdf.load(file).users;
    if (typeof users === "object") {
      for (const [s64, udata] of Object.entries(users)) {
        if (typeof udata !== "object") continue;
        const ts = Number(udata.Timestamp ?? 0);
        map[steam64ToAccountId(s64)] = {
          steam64: s64,
          persona_name: String(udata.PersonaName ?? ""),
          account_name: String(udata.AccountName ?? ""),
          timestamp: Number.isFinite(ts) ? ts : 0,
          autologin: udata.AutoLogin === "1",
        };
      }
    }
  } catch (err) {
    log.writeWarning(`Error reading loginusers.vdf: ${err}`);
  }
  return map;
}

export interface SteamAccount {
  id: string;
  name: string;
  account_name: string;
  timestamp: number;
}

/** All users that have Dota 2 data, sorted by last login timestamp (desc). */
export function getSteamAccounts(): SteamAccount[] {
  const userdata = path.join(ROOT, "userdata");
  if (!ROOT || !fs.existsSync(userdata)) return [];

  const logins = getLoginusersData();
  const accounts: SteamAccount[] = [];
  for (const userId of fs.readdirSync(userdata)) {
    if (!/^\d+$/.test(userId) || !fs.statSync(path.join(userdata, userId)).isDirectory()) continue;
    if (!fs.existsSync(path.join(userdata, userId, base.STEAM_DOTA_ID))) continue;

    const info = logins[userId];
    let name = info?.persona_name ?? "";
    if (!name) {
      const lc = path.join(userdata, userId, "config", "localconfig.vdf");
      name = "?";
      if (fs.existsSync(lc)) {
        try {
          const persona = vdf.getPath(vdf.load(lc), ["UserLocalConfigStore", "friends", "PersonaName"]);
          if (typeof persona === "string") name = persona;
        } catch {
          /* ignore */
        }
      }
    }
    accounts.push({ id: userId, name, account_name: info?.account_name ?? "", timestamp: info?.timestamp ?? 0 });
  }
  return accounts.sort((a, b) => b.timestamp - a.timestamp);
}

/** Locates Steam + the Dota 2 library. Must run before `constants.init()`. */
export async function init(): Promise<void> {
  ROOT = await getSteamRootPath();
  ROOT = await handleNonDefaultPath(ROOT);
  LIBRARY = String(config.get("steam_library") ?? "");

  if (!config.get("steam_id") && ROOT) {
    const first = getSteamAccounts()[0];
    if (first) config.set("steam_id", first.id);
  }

  steamExecutablePath = path.join(ROOT, base.isWin ? "steam.exe" : "steam");
}
