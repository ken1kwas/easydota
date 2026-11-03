// Valve KeyValues (VDF) text format: parse + dump. Port of the `vdf` python package behaviour.

import fs from "node:fs";

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

const UNESCAPE: Record<string, string> = { n: "\n", t: "\t", v: "\v", b: "\b", r: "\r", f: "\f", a: "\x07", "\\": "\\", "?": "?", '"': '"', "'": "'" };
const ESCAPE: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\v": "\\v", "\b": "\\b", "\r": "\\r", "\f": "\\f", "\x07": "\\a" };

export class VdfSyntaxError extends Error {}

export function parse(text: string, escaped = true): VdfObject {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  const len = text.length;

  const skipWs = () => {
    for (;;) {
      while (i < len && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) {
        while (i < len && text[i] !== "\n") i++;
        continue;
      }
      break;
    }
  };

  const readToken = (): { value: string; quoted: boolean } | null => {
    skipWs();
    if (i >= len) return null;
    const c = text[i];
    if (c === "{" || c === "}") {
      i++;
      return { value: c, quoted: false };
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < len && text[i] !== '"') {
        if (escaped && text[i] === "\\" && i + 1 < len && text[i + 1] in UNESCAPE) {
          out += UNESCAPE[text[i + 1]];
          i += 2;
        } else {
          out += text[i++];
        }
      }
      if (i >= len) throw new VdfSyntaxError("Unterminated string");
      i++; // closing quote
      return { value: out, quoted: true };
    }
    // unquoted token
    const start = i;
    while (i < len && !/[\s{}"]/.test(text[i])) i++;
    return { value: text.slice(start, i), quoted: false };
  };

  const skipConditional = () => {
    skipWs();
    if (text[i] === "[") {
      const end = text.indexOf("]", i);
      i = end === -1 ? len : end + 1;
    }
  };

  const parseObject = (top: boolean): VdfObject => {
    const obj: VdfObject = {};
    for (;;) {
      const keyTok = readToken();
      if (keyTok === null) {
        if (top) return obj;
        throw new VdfSyntaxError("Unexpected end of file, expected '}'");
      }
      if (keyTok.value === "}" && !keyTok.quoted) {
        if (top) throw new VdfSyntaxError("Unexpected '}'");
        return obj;
      }
      skipConditional();
      const valTok = readToken();
      if (valTok === null) throw new VdfSyntaxError(`Missing value for key "${keyTok.value}"`);
      if (valTok.value === "{" && !valTok.quoted) {
        const child = parseObject(false);
        const existing = obj[keyTok.value];
        // merge_duplicate_keys=True
        if (existing && typeof existing === "object") Object.assign(existing, child);
        else obj[keyTok.value] = child;
      } else {
        obj[keyTok.value] = valTok.value;
      }
      skipConditional();
    }
  };

  return parseObject(true);
}

function escape(s: string): string {
  return s.replace(/[\\"\n\t\v\b\r\f\x07]/g, (c) => ESCAPE[c]);
}

export function dump(data: VdfObject, pretty = true, escaped = true): string {
  const lines: string[] = [];
  const walk = (obj: VdfObject, level: number) => {
    const ind = pretty ? "\t".repeat(level) : "";
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = escaped ? escape(rawKey) : rawKey;
      if (typeof value === "object") {
        lines.push(`${ind}"${key}"\n${ind}{\n`);
        walk(value, level + 1);
        lines.push(`${ind}}\n`);
      } else {
        lines.push(`${ind}"${key}"\t\t"${escaped ? escape(String(value)) : value}"\n`);
      }
    }
  };
  walk(data, 0);
  return lines.join("");
}

export function load(file: string): VdfObject {
  return parse(fs.readFileSync(file, "utf8"));
}

export function save(file: string, data: VdfObject): void {
  fs.writeFileSync(file, dump(data), "utf8");
}

/** Safe nested lookup: getPath(data, ["a", "b"]) */
export function getPath(data: VdfObject, keys: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = data;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}
