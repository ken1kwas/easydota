import fs from "node:fs";
import path from "node:path";

import { base, conditions, constants, fs as mfs } from "@minify/sdk";

export function main(): void {
  const imgAvailable = [".png", ".jpg", ".jpeg", ".webp"].some((ext) => fs.existsSync(path.join(base.configDir, `background${ext}`)));
  if (!conditions.state.workshopInstalled || !imgAvailable) return;

  mfs.removePath(
    path.join(constants.minifyDotaCompileOutputPath, "panorama", "images", "backgrounds", "imgref.vxml_c"),
    path.join(base.configDir, "_background.png"),
  );
}
