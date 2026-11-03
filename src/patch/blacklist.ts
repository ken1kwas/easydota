import fs from "node:fs";
import path from "node:path";

import * as base from "../core/base";
import { C } from "../core/constants";
import * as log from "../core/log";
import { getEffectiveSettings, processBlacklistLines } from "./manifest-utils";

let pakContentsCache: { mtimeMs: number; lines: string[] } | null = null;

/** Lines of cache/gamepakcontents.txt (every file path inside the game pak01_dir.vpk). */
function gamePakContents(): string[] {
  const stat = fs.statSync(base.gamepakcontentsFileDir);
  if (!pakContentsCache || pakContentsCache.mtimeMs !== stat.mtimeMs) {
    pakContentsCache = {
      mtimeMs: stat.mtimeMs,
      lines: fs.readFileSync(base.gamepakcontentsFileDir, "utf8").split(/\r?\n/).filter(Boolean),
    };
  }
  return pakContentsCache.lines;
}

/**
 * Resolves a directory/regex line against the game pak contents.
 *   >>path/to/dir   every file inside the directory
 *   **regex         every path matching the regex
 *   *-regex         exclusion variant of **
 * The python version shelled out to ripgrep; a JS RegExp does the same job here.
 */
export function processDir(index: number, line: string, folder: string): string[] {
  let pattern = line.startsWith("**") || line.startsWith("*-") ? line.slice(2) : line;
  if (pattern.startsWith(">>")) pattern = pattern.slice(2) + "/";

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    log.writeWarning(`[Invalid Pattern] '${pattern}' in 'mods/${folder}/blacklist.txt' [line: ${index + 1}]: ${err}`);
    return [];
  }
  const data = gamePakContents().filter((l) => re.test(l));
  if (!data.length) {
    log.writeWarning(`[Directory Not Found] Could not find '${pattern}' in pak01_dir.vpk -> mods/${folder}/blacklist.txt [line: ${index + 1}]`);
  }
  return data;
}

export function process(
  blacklistTxt: string,
  folder: string,
  blankFileExtensions: string[],
  modCfg?: Record<string, any>,
  modSettings?: Record<string, any>,
): void {
  const rawLines = fs.readFileSync(blacklistTxt, "utf8").split(/\r?\n/);
  const lines = processBlacklistLines(rawLines, getEffectiveSettings(modCfg, modSettings));

  const data: string[] = [];
  const exclusions = new Set<string>();

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith(">>") || line.startsWith("**")) data.push(...processDir(index, line, folder));
    else if (line.startsWith("*-")) for (const p of processDir(index, line, folder)) exclusions.add(p);
    else if (line.startsWith("--")) exclusions.add(line.slice(2));
    else if (blankFileExtensions.some((ext) => line.endsWith(ext))) data.push(line);
    else {
      log.writeWarning(
        `[Invalid Extension] '${line}' in 'mods/${folder}/blacklist.txt' [line: ${index + 1}] does not end in one of the valid extensions -> ${blankFileExtensions.join(", ")}`,
      );
    }
  });

  for (const item of data) {
    if (exclusions.has(item)) continue;
    const entry = item.trim();
    const ext = path.extname(entry);
    const dest = path.join(C.minifyDotaCompileOutputPath, entry);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(base.blankFilesDir, `blank${ext}`), dest);
    } catch {
      log.writeWarning(
        `[Invalid Extension] '${entry}' in 'mods/${path.basename(folder)}/blacklist.txt' does not end in one of the valid extensions -> ${blankFileExtensions.join(", ")}`,
      );
    }
  }
}
