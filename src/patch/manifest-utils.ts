import { isPlainObject } from "../core/jsonc";
import { readManifest } from "../core/mods-shared";

type VersionPart = [number, number, number];

function parseVersion(v: string): VersionPart[] {
  const parts: VersionPart[] = String(v)
    .split(".")
    .map((part) => {
      const m = part.match(/^(\d+)(.*)$/);
      if (!m) throw new Error(`Invalid version string part: ${part}`);
      const num = Number(m[1]);
      const suffix = m[2];
      if (!suffix) return [num, 0, 0];
      if (suffix.startsWith("rc")) {
        const rc = suffix.slice(2);
        return [num, -1, /^\d+$/.test(rc) ? Number(rc) : 0];
      }
      return [num, -2, 0];
    });
  // Pad to handle cases like "1.13" vs "1.13.0"
  while (parts.length < 4) parts.push([0, 0, 0]);
  return parts;
}

function compare(a: VersionPart[], b: VersionPart[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? [0, 0, 0];
    const y = b[i] ?? [0, 0, 0];
    for (let j = 0; j < 3; j++) if (x[j] !== y[j]) return x[j] < y[j] ? -1 : 1;
  }
  return 0;
}

/**
 * Compares `current` against a requirement string (e.g. ">=1.13,<=1.14" or "1.13").
 * Without an operator ">=" is assumed.
 */
export function isVersionAtLeast(current: string | null | undefined, requirements: string | null | undefined): boolean {
  try {
    if (current == null || requirements == null) return false;
    const cur = parseVersion(current);
    for (const req of requirements.split(",").map((r) => r.trim()).filter(Boolean)) {
      const m = req.match(/^(>=|<=|>|<|==|=)?\s*(.+)$/);
      if (!m) return false;
      const op = m[1] ?? ">=";
      const c = compare(cur, parseVersion(m[2]));
      const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
      if (!ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const getMod = readManifest;

/** Combines default setting values from the manifest with configured mod settings. */
export function getEffectiveSettings(modCfg: Record<string, any> | null | undefined, modSettings: Record<string, any> | null | undefined): Record<string, any> {
  const settings: Record<string, any> = {};
  if (isPlainObject(modCfg) && Array.isArray(modCfg.settings)) {
    for (const s of modCfg.settings) if (isPlainObject(s) && "key" in s && "default" in s) settings[s.key] = s.default;
  }
  if (isPlainObject(modSettings)) Object.assign(settings, modSettings);
  return settings;
}

/** Truthiness for condition evaluations. */
export function isTruthy(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  const s = String(val).trim().toLowerCase();
  return !["", "false", "0", "no", "off", "null", "none"].includes(s);
}

/** null/true -> true, false -> false, "key" -> isTruthy(settings[key]) */
export function evaluateCondition(expr: unknown, settings: Record<string, any>): boolean {
  if (expr === null || expr === undefined || expr === true) return true;
  if (expr === false) return false;
  if (typeof expr !== "string") return Boolean(expr);
  const key = expr.trim();
  if (!key) return true;
  return isTruthy(settings[key]);
}

/** Replaces <&var_name> with the matching setting value. */
export function interpolateVariables(text: string, settings: Record<string, any>): string {
  if (!text || typeof text !== "string" || !text.includes("<&")) return text;
  return text.replace(/<&(.*?)>/g, (m, key: string) => (key in settings && settings[key] !== undefined ? String(pyStr(settings[key])) : m));
}

/** Mirrors python's str() for the values settings usually hold. */
function pyStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null) return "None";
  return String(v);
}

/** Filters blacklist.txt lines by nestable `#if:<expr>` / `#endif` directives and interpolates <&var>. */
export function processBlacklistLines(lines: string[], settings: Record<string, any>): string[] {
  const ifRe = /^\s*#\s*if:(.+)$/i;
  const endifRe = /^\s*#\s*endif(?::.*)?$/i;
  const result: string[] = [];
  const stack: boolean[] = [];

  for (const line of lines) {
    const stripped = line.trim();
    const ifMatch = stripped.match(ifRe);
    if (ifMatch) {
      const parent = stack.length ? stack[stack.length - 1] : true;
      stack.push(parent && evaluateCondition(ifMatch[1].trim(), settings));
      continue;
    }
    if (endifRe.test(stripped)) {
      stack.pop();
      continue;
    }
    if (stack.length ? stack[stack.length - 1] : true) result.push(interpolateVariables(line, settings));
  }
  return result;
}

/** Processes nestable `/* if:<expr> *\/` / `/* endif *\/` CSS directives and interpolates <&var>. */
export function processCssContent(content: string, settings: Record<string, any>): string {
  const ifRe = /\/\*\s*if:(.*?)\s*\*\//i;
  const ifReG = /\/\*\s*if:(.*?)\s*\*\//gi;
  const endifRe = /\/\*\s*endif(?::.*?)?\s*\*\//i;
  const endifReG = /\/\*\s*endif(?::.*?)?\s*\*\//gi;

  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: string[] = [];
  const stack: boolean[] = [];

  for (let line of lines) {
    const ifMatch = line.match(ifRe);
    if (ifMatch) {
      const parent = stack.length ? stack[stack.length - 1] : true;
      stack.push(parent && evaluateCondition(ifMatch[1].trim(), settings));
      const without = line.replace(ifReG, "");
      if (!without.trim()) continue;
      line = without;
    }
    if (endifRe.test(line)) {
      stack.pop();
      const without = line.replace(endifReG, "");
      if (!without.trim()) continue;
      line = without;
    }
    if (stack.length ? stack[stack.length - 1] : true) result.push(line);
  }
  return interpolateVariables(result.join(""), settings);
}
