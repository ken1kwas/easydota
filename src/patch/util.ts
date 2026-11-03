// Parsing helpers for the --mods-string patch option.

/** Split a comma-separated mod list, honoring `\,` and `\\` escapes. */
export function parseModsString(value: string): string[] {
  const mods: string[] = [];
  let current = "";
  const flush = () => {
    const name = current.trim();
    if (name && !mods.includes(name)) mods.push(name);
    current = "";
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length && (value[i + 1] === "," || value[i + 1] === "\\")) {
      current += value[++i];
    } else if (ch === ",") {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return mods;
}

/** Resolve requested names against available mods, case-insensitively. */
export function selectMods(requested: string[], available: string[]): [string[], string[]] {
  const canonical = new Map(available.map((m) => [m.toLowerCase(), m]));
  const selected: string[] = [];
  const missing: string[] = [];
  for (const name of requested) {
    const match = canonical.get(name.toLowerCase());
    if (match === undefined) missing.push(name);
    else if (!selected.includes(match)) selected.push(match);
  }
  return [selected, missing];
}

/** fnmatch-style glob to RegExp (`*` also matches `/`, like python's fnmatch). */
export function globToRegExp(pattern: string, caseInsensitive = process.platform === "win32"): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
      } else {
        let cls = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += `[${cls}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "is" : "s");
}
