import fs from "node:fs";
import path from "node:path";

import { log, output, utils, type ScriptContext } from "@minify/sdk";

import { fetchGrids } from "./script";

const RELEASE_API_URL = "https://api.github.com/repos/Egezenn/dota2-precompiled-grids/releases/latest";

export async function main(ctx: ScriptContext): Promise<boolean | undefined> {
  if (fs.existsSync(path.join(__dirname, "config", "hero_grid_config.json"))) {
    await fetchGrids();
    return true;
  }

  let releaseTag: string;
  try {
    const res = await fetch(RELEASE_API_URL, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "dota2-minify" } });
    if (!res.ok) throw new Error(`GitHub API returned status ${res.status}`);
    const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || !tag) throw new Error("GitHub API response did not include a release tag");
    releaseTag = tag;
  } catch (err) {
    log.writeWarning(`Failed to check custom hero grid release: ${err instanceof Error ? err.message : err}`);
    output.addText("&connection_error", { msgType: "error", indent: true });
    return undefined;
  }

  if (releaseTag !== utils.getState(ctx.modName, "last_tag")) {
    if (await fetchGrids(releaseTag)) utils.setState(ctx.modName, "last_tag", releaseTag);
    return true;
  }
  return undefined;
}
