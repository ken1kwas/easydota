// Variables that depend on 3rd parties (Steam library location, platform binaries)

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import * as steam from "./steam";

export const LOCALE_ALIASES: Record<string, string> = { english: "dutch" };
export const LOCALE_MOD_REQUIREMENTS: Record<string, string[]> = { english: ["#English Fix"] };

export function resolveLocale(locale: string): string {
  return LOCALE_ALIASES[locale] ?? locale;
}

export const minifyOutputList = [
  "english", "brazilian", "bulgarian", "czech", "danish", "dutch", "finnish", "french", "german", "greek",
  "hungarian", "italian", "japanese", "koreana", "latam", "norwegian", "polish", "portuguese", "romanian",
  "russian", "schinese", "spanish", "swedish", "tchinese", "thai", "turkish", "ukrainian", "vietnamese",
];

export const s2vCliVer = "20.1";

function dota(...parts: string[]): string {
  return path.join(steam.LIBRARY, "steamapps", "common", "dota 2 beta", ...parts);
}

/** Paths computed from the Steam library. Mutable: refreshed by `init()` / `recalcRescompDirs()`. */
export const C = {
  rescompOverride: false,
  minifyDotaCompileInputPath: "",
  minifyDotaCompileOutputPath: "",
  gameResourceCompilerPath: "",
  dotaResourceCompilerPath: "",
  minifyDotaToolsRequiredPath: "",
  minifyDefaultDotaPakOutputPath: "",
  minifyDotaPossibleLanguageOutputPaths: [] as string[],
  dota2Executable: "",
  dota2ToolsExecutable: "",
  dotaGamePakPath: "",
  dotaCorePakPath: "",
  dotaSteamInfPath: "",
  dotaToolsPaths: [] as string[],
  dotaToolsExtractionPaths: [] as string[],
  s2vExecutable: base.isWin ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI",
  s2vLatest: "",
  s2vExecPath: "",
};

/** Swaps the resourcecompiler paths when Workshop Tools were extracted to config/rescomproot. */
export function recalcRescompDirs(): void {
  C.rescompOverride = fs.existsSync(base.rescompOverrideDir);
  if (C.rescompOverride && !fs.existsSync(C.gameResourceCompilerPath)) {
    C.minifyDotaCompileInputPath = path.join(base.rescompOverrideDir, "content", "dota_addons", "minify");
    C.minifyDotaCompileOutputPath = path.join(base.rescompOverrideDir, "game", "dota_addons", "minify");
    C.dotaResourceCompilerPath = path.join(base.rescompOverrideDir, "game", "bin", "win64", "resourcecompiler.exe");
  } else {
    C.minifyDotaCompileInputPath = dota("content", "dota_addons", "minify");
    C.minifyDotaCompileOutputPath = dota("game", "dota_addons", "minify");
    C.dotaResourceCompilerPath = C.gameResourceCompilerPath;
  }
}

function s2vDownloadUrl(): string {
  const rel = `https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${s2vCliVer}`;
  const arm64 = base.MACHINE === "arm64";
  if (base.isWin) return `${rel}/cli-windows-${arm64 ? "arm64" : "x64"}.zip`;
  if (base.isLinux) return `${rel}/cli-linux-${arm64 ? "arm64" : base.MACHINE === "arm" ? "arm" : "x64"}.zip`;
  if (base.isMac) return `${rel}/cli-macos-${arm64 ? "arm64" : "x64"}.zip`;
  throw new Error(`Unsupported configuration (${base.OS}/${base.MACHINE}/${base.ARCHITECTURE})`);
}

export function init(): void {
  C.gameResourceCompilerPath = dota("game", "bin", "win64", "resourcecompiler.exe");
  recalcRescompDirs();

  C.minifyDotaToolsRequiredPath = dota("content", "dota_dutch");
  C.minifyDefaultDotaPakOutputPath = dota("game", "dota_dutch");
  C.minifyDotaPossibleLanguageOutputPaths = minifyOutputList.filter((l) => l !== "english").map((l) => dota("game", `dota_${l}`));

  C.dota2Executable = path.join(steam.LIBRARY, base.DOTA_EXECUTABLE_PATH);
  C.dota2ToolsExecutable = path.join(steam.LIBRARY, base.DOTA_TOOLS_EXECUTABLE_PATH);
  C.dotaGamePakPath = dota("game", "dota", "pak01_dir.vpk");
  C.dotaCorePakPath = dota("game", "core", "pak01_dir.vpk");
  C.dotaSteamInfPath = dota("game", "dota", "steam.inf");

  C.dotaToolsPaths = [
    dota("game", "bin"),
    dota("game", "core"),
    dota("game", "dota", "bin"),
    dota("game", "dota", "tools"),
    dota("game", "dota", "gameinfo.gi"),
  ];
  C.dotaToolsExtractionPaths = [
    path.join(base.rescompOverrideDir, "game", "bin"),
    path.join(base.rescompOverrideDir, "game", "core"),
    path.join(base.rescompOverrideDir, "game", "dota", "bin"),
    path.join(base.rescompOverrideDir, "game", "dota", "tools"),
    path.join(base.rescompOverrideDir, "game", "dota", "gameinfo.gi"),
  ];

  C.s2vLatest = s2vDownloadUrl();
  C.s2vExecPath = path.isAbsolute(C.s2vExecutable) ? C.s2vExecutable : path.join(".", C.s2vExecutable);
}
