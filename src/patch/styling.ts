import fs from "node:fs";
import path from "node:path";

import * as base from "../core/base";
import { getEffectiveSettings, processCssContent } from "./manifest-utils";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes every `<start> { ... }` block (with nested braces) matching `startPattern`. */
function removeBracedBlock(text: string, startPattern: RegExp): string {
  for (;;) {
    const match = startPattern.exec(text);
    if (!match) break;
    const start = match.index;
    const open = text.indexOf("{", start + match[0].length);
    if (open === -1) break;

    let depth = 1;
    let i = open + 1;
    while (depth > 0 && i < text.length) {
      const nextOpen = text.indexOf("{", i);
      const nextClose = text.indexOf("}", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 1;
      } else {
        depth--;
        i = nextClose + 1;
      }
    }
    if (depth !== 0) break;
    text = text.slice(0, start) + text.slice(i);
  }
  return text;
}

/** Appends mod styles to a decompiled CSS file, replacing @define and @keyframes they redefine. */
export function applyStylesToFile([filePath, styles]: [string, string[]]): void {
  let content = fs.readFileSync(filePath, "utf8");

  const newDefines = new Set<string>();
  const newKeyframes = new Set<string>();
  for (const style of styles) {
    for (const m of style.matchAll(/@define\s+([\w-]+)\s*:/g)) newDefines.add(m[1]);
    for (const m of style.matchAll(/@keyframes\s+(?:'|")?([\w\s-]+)(?:'|")?/g)) newKeyframes.add(m[1]);
  }

  for (const name of newDefines) {
    content = content.replace(new RegExp(`@define\\s+${escapeRe(name)}\\s*:\\s*[\\s\\S]*?(?:;|$)`, "g"), "");
  }
  for (const name of newKeyframes) {
    content = removeBracedBlock(content, new RegExp(`@keyframes\\s+(?:'|")?${escapeRe(name)}(?:'|")?`));
  }

  const unique: string[] = [];
  for (const style of styles) if (!content.includes(style) && !unique.includes(style)) unique.push(style);

  fs.writeFileSync(filePath, unique.length ? content + "\n" + unique.join("\n") : content, "utf8");
}

/**
 * Splits a mod's styling.css into blocks:
 *   /* g:panorama/styles/foo *\/  -> applied to game pak file panorama/styles/foo.css
 *   /* c:panorama/styles/bar *\/  -> applied to core pak file
 */
export function parseStylingFile(
  stylingCss: string,
  modCfg: Record<string, any>,
  folder: string,
  modSettings: Record<string, any>,
  stylingDictionary: Map<string, [string, string]>,
  coreExtracts: string[],
  dotaExtracts: string[],
): void {
  const settings = getEffectiveSettings(modCfg, modSettings);
  const content = processCssContent(fs.readFileSync(stylingCss, "utf8"), settings);

  const matches = [...content.matchAll(/\/\*\s*([cg]):(.*?)\s*\*\//g)];
  matches.forEach((match, i) => {
    const indicator = match[1];
    let p = match[2].trim();
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    const style = content.slice(start, end).trim();
    if (style) {
      if (indicator === "c") p = `!${p}`;
      stylingDictionary.set(`styling-css-${folder}-${i}`, [p, style]);
    }
  });

  for (const [key, [indicatorPath]] of stylingDictionary) {
    if (!key.startsWith(`styling-css-${folder}-`)) continue;
    const sanitized = indicatorPath.startsWith("!") ? indicatorPath.slice(1) : indicatorPath;
    fs.mkdirSync(path.join(base.buildDir, path.dirname(sanitized)), { recursive: true });
    (indicatorPath.startsWith("!") ? coreExtracts : dotaExtracts).push(`${sanitized}.vcss_c`);
  }
}
