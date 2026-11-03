// Variables that almost never change

import os from "node:os";
import path from "node:path";

export const VERSION = "2rc9";
export const TITLE = `Minify ${VERSION}`;

export const OS = process.platform;
export const MACHINE = os.arch().toLowerCase(); // x64, arm64, arm, ia32 ...
export const ARCHITECTURE = ["x64", "arm64", "ppc64", "s390x"].includes(MACHINE) ? "64bit" : "32bit";

export const isWin = OS === "win32";
export const isLinux = OS === "linux";
export const isMac = OS === "darwin";

/** True when running from a packaged Electron build (equivalent of PyInstaller's `sys.frozen`). */
// `electron .` in development sets process.defaultApp; a packaged build does not.
export const FROZEN =
  Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp && process.env.MINIFY_DEV !== "1";

export const state = {
  /** CLI subcommands run headless, the GUI does not. */
  HEADLESS: true,
  originalCwd: process.cwd(),
};

export const OWNER = "Egezenn";
export const REPO = "dota2-minify";

if (isLinux) {
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
    process.env.GDK_BACKEND ??= "x11";
  }
}

export const DOTA_EXECUTABLE_PATH = isLinux
  ? path.join("steamapps", "common", "dota 2 beta", "game", "bin", "linuxsteamrt64", "dota2")
  : isMac
    ? path.join("steamapps", "common", "dota 2 beta", "game", "bin", "osx64", "dota2.app", "Contents", "MacOS", "dota2")
    : path.join("steamapps", "common", "dota 2 beta", "game", "bin", "win64", "dota2.exe");

export const STEAM_DEFAULT_INSTALLATION_PATH = isLinux
  ? path.join(os.homedir(), ".local", "share", "Steam")
  : isMac
    ? path.join(os.homedir(), "Library", "Application Support", "Steam")
    : path.join("C:\\", "Program Files (x86)", "Steam");

export const DOTA_TOOLS_EXECUTABLE_PATH = path.join("steamapps", "common", "dota 2 beta", "game", "bin", "win64", "dota2cfg.exe");
export const DOTA_EXECUTABLE_PATH_FALLBACK = path.join("steamapps", "common", "dota 2 beta", "game", "bin", "win64", "dota2.exe");

export const STEAM_DOTA_ID = "570";

// --------------------------------------------------------------------------
// Static directories. `baseDir` is the "Minify" folder that holds mods, bin,
// locales, themes, plugins. The process chdirs into it on startup, so the
// relative paths below (mods, config, cache, logs ...) resolve against it.
// --------------------------------------------------------------------------

function resolveBaseDir(): string {
  if (process.env.MINIFY_ROOT) return path.resolve(process.env.MINIFY_ROOT);
  if (FROZEN) return path.dirname(process.execPath);
  // dist/core/base.js -> <project>/Minify
  return path.resolve(__dirname, "..", "..", "Minify");
}

export const baseDir = resolveBaseDir();
export const bundleDir = baseDir;
export const webDir = path.join(baseDir, "ui", "web", "dist");

export const pluginsDir = path.join(baseDir, "plugins");
export const themesDir = path.join(baseDir, "themes");
export const distIndex = path.join(webDir, "index.html");

export const bundleBinDir = path.join(bundleDir, "bin");
export const binDir = bundleBinDir;
export const buildDir = "vpk_build";
export const replaceDir = "vpk_replace";
export const mergeDir = "vpk_merge";
export const logsDir = "logs";
export const modsDir = "mods";
export const configDir = "config";
export const cacheDir = "cache";

// bin
export const blankFilesDir = path.join(bundleBinDir, "blank-files");
export const imgDir = path.join(bundleBinDir, "images");
export const faviconFile = path.join(imgDir, "favicon.ico");
export const logoFile = path.join(imgDir, "logo.png");
export const localesDir = path.join(bundleDir, "locales");
export const localizationFileDir = path.join(localesDir, "en.json");
export const settingsFileDir = path.join(bundleBinDir, "settings.json");
export const soundsDir = path.join(bundleBinDir, "sounds");

// logs
export const logCrashlog = path.join(logsDir, "crashlog.txt");
export const logWarnings = path.join(logsDir, "warnings.txt");
export const logUnhandled = path.join(logsDir, "unhandled.txt");
export const logS2v = path.join(logsDir, "Source2Viewer-CLI.txt");
export const logRescomp = path.join(logsDir, "resourcecompiler.txt");

// cache
export const dotaSteamInfCache = path.join(cacheDir, "steam.inf");
export const statesFileDir = path.join(cacheDir, "states.json");
export const gamepakcontentsFileDir = path.join(cacheDir, "gamepakcontents.txt");

// config (overridable from the CLI with --config / --mods)
export const rescompOverrideDir = path.join(configDir, "rescomproot");
export const paths = {
  mainConfigFile: path.join(configDir, "minify_config.json"),
  modsConfig: path.join(configDir, "mods.json"),
};

// links
export const discord = "https://discord.com/invite/9867CPv7cy";
export const telegram = "https://t.me/dota2minify";
export const github = `https://github.com/${OWNER}/${REPO}`;
export const githubLatest = github + "/releases/latest";
export const githubIo = `https://${OWNER}.github.io/${REPO}`;
