import path from "node:path";

import { base, fs as mfs, steam } from "@minify/sdk";

export function main(): void {
  const fontsDir = path.join(steam.LIBRARY, "steamapps", "common", "dota 2 beta", "game", "dota", "panorama", "fonts");
  mfs.restoreDirectory(fontsDir, path.join(base.baseDir, "backup", path.basename(__dirname)));
}
