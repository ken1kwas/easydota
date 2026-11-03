/**
 * JSON(C) config files
 *
 * Interactions with main config and mod configs
 */

import fs from "node:fs";
import path from "node:path";

import * as base from "./base";
import { isPlainObject, parseJsonc, sortKeys, stringify, type JsonObject } from "./jsonc";

export function readJsonFile<T = JsonObject>(file: string): T {
  try {
    const parsed = parseJsonc(fs.readFileSync(file, "utf8"));
    return (parsed ?? {}) as T;
  } catch {
    return {} as T;
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  const dir = path.dirname(file);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, stringify(data), "utf8");
}

export function updateJsonFile<T>(file: string, key: string, value: T): T {
  let data = readJsonFile<JsonObject>(file);
  if (!isPlainObject(data)) data = {};
  data[key] = value;
  if (file === base.paths.mainConfigFile || file === base.paths.modsConfig) data = sortKeys(data);
  writeJsonFile(file, data);
  return value;
}

function getDefaultSetting(key: string): unknown {
  const schema = readJsonFile<unknown>(base.settingsFileDir);
  if (Array.isArray(schema)) {
    for (const item of schema) {
      if (isPlainObject(item) && item.key === key) return item.default;
    }
  }
  return undefined;
}

/** Reads a key from the main config, persisting the default (argument or settings.json) if missing. */
export function get<T = any>(key: string, defaultValue?: T): T {
  const data = readJsonFile<JsonObject>(base.paths.mainConfigFile);
  if (isPlainObject(data) && key in data) return data[key] as T;

  let def: unknown = defaultValue;
  if (def === undefined || def === null) def = getDefaultSetting(key);
  if (def !== undefined && def !== null) return updateJsonFile(base.paths.mainConfigFile, key, def) as T;
  return undefined as T;
}

export function set<T>(key: string, value: T): T {
  return updateJsonFile(base.paths.mainConfigFile, key, value);
}

export function getMod(modName: string, def: JsonObject = {}): JsonObject {
  const modconf = get<JsonObject>("modconf", {});
  return isPlainObject(modconf) && isPlainObject(modconf[modName]) ? modconf[modName] : def;
}

export function setMod(modName: string, configData: JsonObject): void {
  const modconf = get<JsonObject>("modconf", {});
  modconf[modName] = configData;
  set("modconf", modconf);
}

/** Returns the valid locale instead of unresolved (e.g. english -> dutch). */
export function getLocale(): string {
  // lazy import to avoid a cycle with constants -> steam -> config
  const { resolveLocale } = require("./constants") as typeof import("./constants");
  return resolveLocale(get("output_locale", "english"));
}
