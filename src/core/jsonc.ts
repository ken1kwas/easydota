// JSON with comments (equivalent of the `jsonc` python package)

import fs from "node:fs";
import { parse, type ParseError } from "jsonc-parser";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: any };

export class JsoncError extends Error {}

export function parseJsonc<T = any>(text: string): T {
  const errors: ParseError[] = [];
  // strip a UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new JsoncError(`Invalid JSON(C): error code ${errors[0].error} at offset ${errors[0].offset}`);
  return value as T;
}

export function readJsonc<T = any>(file: string): T {
  return parseJsonc<T>(fs.readFileSync(file, "utf8"));
}

export function stringify(data: unknown, indent = 2): string {
  return JSON.stringify(data, null, indent);
}

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns a copy of `obj` with keys sorted (python's `dict(sorted(d.items()))`). */
export function sortKeys<T extends JsonObject>(obj: T): T {
  const out: JsonObject = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out as T;
}
