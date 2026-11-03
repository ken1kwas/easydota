import path from "node:path";

import { config, log, output } from "@minify/sdk";

import { gridConfigDir, IMPORT_SUFFIX, warnMissingSteamPath } from "./script";

export function main(): void {
  const destPath = gridConfigDir();
  if (!destPath) {
    warnMissingSteamPath();
    return;
  }

  const gridPath = path.join(destPath, "hero_grid_config.json");
  const current = config.readJsonFile<{ configs?: Array<{ config_name?: string }> }>(gridPath);
  if (!current.configs) {
    log.writeWarning("Config file missing 'configs' key.");
    return;
  }

  const before = current.configs.length;
  current.configs = current.configs.filter((c) => !(c.config_name ?? "").endsWith(IMPORT_SUFFIX));
  if (before - current.configs.length > 0) config.writeJsonFile(gridPath, current);
  else output.addText(`No hero grids with '${IMPORT_SUFFIX}' found to remove.`, { indent: true });
}
