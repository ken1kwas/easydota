import fs from "node:fs";
import path from "node:path";

import { state as conditions } from "../conditions";
import * as base from "../core/base";
import { C } from "../core/constants";
import * as mfs from "../core/fs";
import { isPlainObject, readJsonc } from "../core/jsonc";
import * as log from "../core/log";
import * as output from "../core/output";
import { run } from "../core/proc";
import type { VpkFile } from "../core/vpk";
import { evaluateCondition, getEffectiveSettings, interpolateVariables } from "./manifest-utils";
import { globToRegExp } from "./util";

/**
 * Processes remap.json for a mod: matches targeted compiled resources and remaps references in
 * their decompiled sources.
 */
export async function process(
  remapFile: string,
  folder: string,
  dotaPak: VpkFile,
  modCfg?: Record<string, any>,
  modSettings?: Record<string, any>,
): Promise<void> {
  if (!fs.existsSync(remapFile)) return;
  let rules: Record<string, any>;
  try {
    rules = readJsonc(remapFile);
  } catch (err) {
    log.writeWarning(`Failed to parse remap.json for ${folder}: ${err}`);
    return;
  }
  const settings = getEffectiveSettings(modCfg, modSettings);

  for (let [targetPattern, ruleVal] of Object.entries<any>(rules ?? {})) {
    if (!targetPattern || !ruleVal || !isPlainObject(ruleVal)) continue;
    targetPattern = interpolateVariables(targetPattern, settings);

    const cond = ruleVal.if ?? ruleVal.condition;
    if (cond != null && !evaluateCondition(cond, settings)) continue;

    const rawRedirects: Record<string, any> = isPlainObject(ruleVal.redirects) ? ruleVal.redirects : ruleVal;
    const redirectMap = new Map<string, string>();
    for (const [srcRef, dstRef] of Object.entries<any>(rawRedirects)) {
      if (srcRef === "if" || srcRef === "condition" || srcRef === "redirects") continue;
      if (typeof dstRef === "string") {
        redirectMap.set(interpolateVariables(srcRef, settings), interpolateVariables(dstRef, settings));
      } else if (isPlainObject(dstRef)) {
        const subCond = dstRef.if ?? dstRef.condition;
        if (subCond != null && !evaluateCondition(subCond, settings)) continue;
        const target = dstRef.target ?? dstRef.dst ?? dstRef.to;
        if (target) redirectMap.set(interpolateVariables(srcRef, settings), interpolateVariables(String(target), settings));
      }
    }
    if (!redirectMap.size) continue;

    let targetPaths: string[];
    if (/[*?[]/.test(targetPattern)) {
      const re = globToRegExp(targetPattern);
      targetPaths = dotaPak.paths().filter((p) => re.test(p));
    } else {
      targetPaths = [targetPattern];
    }
    if (!targetPaths.length) {
      log.writeWarning(`No assets found matching '${targetPattern}' in remap.json for ${folder}`);
      continue;
    }

    for (const p of targetPaths) {
      const cleanPath = p.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/").replace(/^\/+/, "");
      try {
        const destFile = path.join(C.minifyDotaCompileOutputPath, cleanPath);
        let data: Buffer | null;
        if (fs.existsSync(destFile)) {
          data = fs.readFileSync(destFile);
        } else {
          data = dotaPak.read(cleanPath);
          if (!data) {
            log.writeWarning(`Target asset '${cleanPath}' not found in game VPK for ${folder}`);
            continue;
          }
        }

        // Quick pre-check: only process if at least one redirect source is present
        if (![...redirectMap.keys()].some((src) => data!.includes(Buffer.from(src, "utf8")))) continue;

        if (cleanPath.endsWith("_c") && conditions.workshopInstalled) {
          const outSource = path.join(base.buildDir, cleanPath.slice(0, -2));
          const tempC = path.join(base.buildDir, cleanPath);
          mfs.createDirs(path.dirname(outSource), path.dirname(tempC));
          fs.writeFileSync(tempC, data);

          const res = await run(C.s2vExecPath, ["-i", tempC, "-d", "-o", outSource]);
          mfs.removePath(tempC);

          if (res.code === 0 && fs.existsSync(outSource)) {
            try {
              let source = fs.readFileSync(outSource, "utf8");
              for (const [src, dst] of redirectMap) source = source.split(src).join(dst);
              fs.writeFileSync(outSource, source, "utf8");
              output.addText(`Remapped references in ${cleanPath}`, { indent: true });
            } catch (err) {
              log.writeWarning(`Failed to remap references in '${outSource}': ${err}`);
            }
          } else {
            log.writeWarning(`Failed to decompile '${cleanPath}' for ${folder}`);
          }
        }
      } catch (err) {
        log.writeWarning(`Failed to process remap for '${cleanPath}' in ${folder}: ${err}`);
      }
    }
  }
}
