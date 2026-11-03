import fs from "node:fs";
import path from "node:path";

import { base, conditions, fs as mfs, log, output, steam, utils } from "@minify/sdk";

const ODG_LATEST = "https://github.com/Egezenn/OpenDotaGuides/releases/latest/download/itembuilds.zip";

export const itembuildsPath = () => path.join(steam.LIBRARY, "steamapps", "common", "dota 2 beta", "game", "dota", "itembuilds");
export const backupPath = path.join(base.baseDir, "backup", path.basename(__dirname));
const zipPath = path.join(__dirname, "OpenDotaGuides.zip");
const tempDumpPath = path.join(__dirname, "temp");

export async function fetchGuides(releaseTag?: string): Promise<boolean> {
  if (conditions.state.workshopInstalled) {
    utils.tryPass(() => fs.copyFileSync(path.join(__dirname, "_styling.css"), path.join(__dirname, "styling.css")));
  }
  if (fs.existsSync(zipPath)) mfs.removePath(zipPath);

  const url = releaseTag ? `https://github.com/Egezenn/OpenDotaGuides/releases/download/${encodeURIComponent(releaseTag)}/itembuilds.zip` : ODG_LATEST;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    log.writeWarning(`Connection error while fetching guides: ${err}`);
    output.addText("&connection_error", { msgType: "error", indent: true });
    return false;
  }
  if (!res.ok) {
    log.writeWarning(`Failed to fetch guides. Status code: ${res.status}`);
    output.addText("&connection_error", { msgType: "error", indent: true });
    return false;
  }

  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const dest = itembuildsPath();
  mfs.backupDirectory(dest, backupPath);

  await mfs.extractArchive(zipPath, tempDumpPath);
  mfs.createDirs(dest);
  for (const file of fs.readdirSync(tempDumpPath)) {
    const src = path.join(tempDumpPath, file);
    if (mfs.isFile(src)) fs.copyFileSync(src, path.join(dest, file));
  }
  mfs.removePath(tempDumpPath, zipPath);
  return true;
}

export function main(): Promise<boolean> {
  return fetchGuides();
}
