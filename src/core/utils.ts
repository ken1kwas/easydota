import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as base from "./base";
import { isPlainObject, type JsonObject } from "./jsonc";
import { run } from "./proc";

// ------------------------------------------------------------------ states --

export function readStates(): JsonObject {
  try {
    const data = JSON.parse(fs.readFileSync(base.statesFileDir, "utf8"));
    return isPlainObject(data) ? data : {};
  } catch {
    return {};
  }
}

export function writeStates(statesOrKey: JsonObject | string, value?: unknown): void {
  const states = readStates();
  if (typeof statesOrKey === "string") states[statesOrKey] = value;
  else Object.assign(states, statesOrKey);
  fs.mkdirSync(base.cacheDir, { recursive: true });
  fs.writeFileSync(base.statesFileDir, JSON.stringify(states, null, 2), "utf8");
}

export function getState<T = any>(modName: string, key: string, def?: T): T {
  const states = readStates();
  let modData = states[modName];
  if (!isPlainObject(modData)) modData = {};
  if (!(key in modData) && def !== undefined && def !== null) {
    modData[key] = def;
    writeStates(modName, modData);
  }
  return (key in modData ? modData[key] : def) as T;
}

export function setState(modName: string, key: string, value: unknown): void {
  const states = readStates();
  const modData = isPlainObject(states[modName]) ? states[modName] : {};
  modData[key] = value;
  writeStates(modName, modData);
}

// ------------------------------------------------------------------ misc ----

export function tryPass<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export async function tryPassAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export function hexToRgba(hex: string): number[] {
  try {
    let h = hex.replace(/^#+/, "");
    if (h.length === 6) h += "FF";
    else if (h.length !== 8) return [255, 255, 255, 255];
    const out = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
    return out.some(Number.isNaN) ? [255, 255, 255, 255] : out;
  } catch {
    return [255, 255, 255, 255];
  }
}

export function rgbaToHex(rgba: number[]): string {
  try {
    const clamp = (v: number) => Math.trunc(Math.max(0, Math.min(255, v)));
    return "#" + rgba.slice(0, 4).map((v) => clamp(v).toString(16).padStart(2, "0")).join("");
  } catch {
    return "#ffffffff";
  }
}

export function parseColor(val: unknown): number[] {
  if (Array.isArray(val)) return val as number[];
  return hexToRgba(typeof val === "string" && val ? val : "#ffffffff");
}

export function sanitizeWinPath(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[ .]+$/, "");
  return cleaned || crypto.randomBytes(4).toString("hex");
}

function normalizeFontName(filename: string): string {
  return path.parse(filename).name.toLowerCase().replace(/[ \-_]/g, "");
}

async function findFontLinux(fontName: string): Promise<string | null> {
  try {
    const res = await run("fc-match", ["-f", "%{file}", fontName]);
    const p = res.stdout.trim();
    if (res.code === 0 && p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

export async function findSystemFont(fontName: string): Promise<string | null> {
  const normalized = fontName.toLowerCase().replace(/[ \-_]/g, "");
  let fontDirs: string[];
  if (base.isWin) {
    fontDirs = [
      path.join(process.env.windir ?? "C:\\Windows", "Fonts"),
      path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts"),
    ];
  } else if (base.isLinux) {
    const found = await findFontLinux(fontName);
    if (found) return found;
    fontDirs = ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local/share/fonts")];
  } else if (base.isMac) {
    fontDirs = ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library/Fonts")];
  } else {
    return null;
  }

  for (const dir of fontDirs) {
    for (const file of walkFiles(dir)) {
      const lower = file.toLowerCase();
      if ((lower.endsWith(".ttf") || lower.endsWith(".otf")) && normalizeFontName(path.basename(file)).includes(normalized)) {
        return file;
      }
    }
  }
  return null;
}

/** Converts a local file path to a valid file:// URI cross-platform. */
export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` over `items` with at most `limit` concurrent promises (ThreadPoolExecutor.map equivalent). */
export async function mapConcurrent<T, R>(items: Iterable<T>, fn: (item: T) => Promise<R> | R, limit = os.cpus().length || 4): Promise<R[]> {
  const list = [...items];
  const results: R[] = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
