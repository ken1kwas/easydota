import fs from "node:fs";
import path from "node:path";

import * as base from "../core/base";
import { C } from "../core/constants";
import { isPlainObject, readJsonc } from "../core/jsonc";
import * as log from "../core/log";
import * as output from "../core/output";
import { evaluateCondition, getEffectiveSettings, interpolateVariables } from "./manifest-utils";

export type ReplacerTarget = [source: string, target: string];

export function processReplacer([source, target]: ReplacerTarget): void {
  output.addText("&replacing_terminal", [source, target], { indent: true });
  const dest = path.join(C.minifyDotaCompileOutputPath, target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(base.replaceDir, source), dest);
}

export function process(
  replacerFile: string,
  folder: string,
  sourceExtracts: string[],
  targets: ReplacerTarget[],
  modCfg?: Record<string, any>,
  modSettings?: Record<string, any>,
): void {
  if (!fs.existsSync(replacerFile)) return;
  try {
    const replacements = readJsonc(replacerFile);
    const settings = getEffectiveSettings(modCfg, modSettings);

    for (const [target, sourceVal] of Object.entries<any>(replacements ?? {})) {
      if (!target || sourceVal == null) continue;
      const targetClean = interpolateVariables(String(target), settings);

      if (typeof sourceVal === "string") {
        const src = interpolateVariables(sourceVal, settings);
        sourceExtracts.push(src);
        targets.push([src, targetClean]);
      } else if (isPlainObject(sourceVal)) {
        const cond = sourceVal.if ?? sourceVal.condition;
        if (cond != null && !evaluateCondition(cond, settings)) continue;
        const srcRaw = sourceVal.source ?? sourceVal.src;
        if (srcRaw) {
          const src = interpolateVariables(String(srcRaw), settings);
          sourceExtracts.push(src);
          targets.push([src, targetClean]);
        } else {
          log.writeWarning(`Missing 'source' in replacer.json rule for ${folder}: ${target}`);
        }
      } else {
        log.writeWarning(`Invalid entry in replacer.json for ${folder}: ${target} -> ${JSON.stringify(sourceVal)}`);
      }
    }
  } catch (err) {
    log.writeWarning(`Failed to parse replacer.json for ${folder}: ${err instanceof Error ? err.message : err}`);
  }
}
