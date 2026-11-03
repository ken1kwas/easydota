import fs from "node:fs";
import path from "node:path";

import { base, config, log, output, steam } from "@minify/sdk";

export const IMPORT_SUFFIX = " #Minify-Import";
const REMOTE_URL = "https://github.com/Egezenn/dota2-precompiled-grids/releases/latest/download/hero_grid_config.json";
const MOD_NAME = path.basename(__dirname);

interface GridConfig {
  config_name?: string;
  [key: string]: unknown;
}
interface GridFile {
  version?: number;
  configs?: GridConfig[];
  [key: string]: unknown;
}

/** `<steam>/userdata/<id>/570/remote/cfg`, or null when it can't be resolved. */
export function gridConfigDir(): string | null {
  const steamId = config.get("steam_id", "");
  const userdata = path.join(steam.ROOT, "userdata");
  if (!steamId || !fs.existsSync(userdata)) return null;
  const dest = path.join(userdata, String(steamId), base.STEAM_DOTA_ID, "remote", "cfg");
  return fs.existsSync(dest) ? dest : null;
}

export function warnMissingSteamPath(): void {
  log.writeWarning(
    `A valid user ID or path to your steam installation couldn't be found for ${MOD_NAME}, manually set it from \`minify_config.json\` under \`modconf\` > \`${MOD_NAME}\` key with \`steam_path\``,
  );
}

export async function fetchGrids(releaseTag?: string): Promise<boolean> {
  const destPath = gridConfigDir();
  if (!destPath) {
    warnMissingSteamPath();
    return false;
  }

  let newGridData: GridFile | null = null;
  const localConfig = path.join(__dirname, "config", "hero_grid_config.json");
  if (fs.existsSync(localConfig)) {
    newGridData = config.readJsonFile<GridFile>(localConfig);
  } else {
    const url = releaseTag
      ? `https://github.com/Egezenn/dota2-precompiled-grids/releases/download/${encodeURIComponent(releaseTag)}/hero_grid_config.json`
      : REMOTE_URL;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) newGridData = (await res.json()) as GridFile;
      else {
        log.writeWarning(`Couldn't fetch grids from ${url}. Status: ${res.status}`);
        output.addText("&connection_error", { msgType: "error", indent: true });
      }
    } catch (err) {
      log.writeWarning(`Failed to fetch remote grids: ${err}`);
      output.addText("&connection_error", { msgType: "error", indent: true });
    }
  }

  if (!newGridData?.configs) {
    log.writeWarning("No grid data found to import.");
    return false;
  }

  const gridPath = path.join(destPath, "hero_grid_config.json");
  const current = config.readJsonFile<GridFile>(gridPath);
  current.configs ??= [];
  current.version ??= 3;

  // drop previously imported configs, then append the new ones with the suffix
  current.configs = current.configs.filter((c) => !(c.config_name ?? "").endsWith(IMPORT_SUFFIX));
  for (const c of newGridData.configs) {
    if (!(c.config_name ?? "").endsWith(IMPORT_SUFFIX)) c.config_name = (c.config_name ?? "") + IMPORT_SUFFIX;
  }
  current.configs.push(...newGridData.configs);

  config.writeJsonFile(gridPath, current);
  return true;
}

export function main(): Promise<boolean> {
  return fetchGrids();
}
