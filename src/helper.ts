// Dangling random functions: resource compiling and mod script execution

import fs from "node:fs";
import path from "node:path";

import * as base from "./core/base";
import * as config from "./core/config";
import { C, recalcRescompDirs } from "./core/constants";
import * as mfs from "./core/fs";
import * as log from "./core/log";
import * as modsShared from "./core/mods-shared";
import * as output from "./core/output";
import { run } from "./core/proc";
import * as scriptLoader from "./core/script-loader";
import { packSingle } from "./core/vpk";
import * as validators from "./patch/validators";

export const state = {
  compilerFilepickerPath: "",
  outputPath: "",
};

export function syncOutputPath(): void {
  const locale = config.getLocale();
  const matching = C.minifyDotaPossibleLanguageOutputPaths.filter((p) => p.includes(locale));
  state.outputPath = matching[0] ?? C.minifyDefaultDotaPakOutputPath;
  config.set("output_path", state.outputPath);
}

/** Extensions available in bin/blank-files (".vtex_c", ...). */
export function getBlankFileExtensions(): string[] {
  return fs.readdirSync(base.blankFilesDir).map((f) => path.extname(f));
}

/** A wrapper for the Dota 2 Resource Compiler. */
export async function compile(): Promise<void> {
  const args = ["-i", C.minifyDotaCompileInputPath + "/*", "-r"];
  const [cmd, cmdArgs] = base.isWin ? [C.dotaResourceCompilerPath, args] : ["wine", [C.dotaResourceCompilerPath, ...args]];
  const res = await run(cmd, cmdArgs);
  fs.mkdirSync(base.logsDir, { recursive: true });
  fs.writeFileSync(base.logRescomp, res.output);
  validators.resourcecompiler(res.code, res.output);
}

/** Helper to create reference XMLs for images. */
export function createImgRefXml(imgPaths: string[]): string {
  const images = imgPaths.map((p) => `\t\t\t<Image src="file://${p}" />`).join("\n");
  return `<root>
    <Panel class="AddonLoadingRoot">
${images}
    </Panel>
</root>
`;
}

function* walkRel(root: string, rel = ""): Generator<string> {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) yield* walkRel(root, r);
    else yield r;
  }
}

/** resourcecompiler's friendly cousin: automagically handles image compilation. */
export async function compileAssets(inputPath?: string, outputPath?: string, pakPath?: string): Promise<void> {
  if (state.compilerFilepickerPath) {
    inputPath = state.compilerFilepickerPath;
    outputPath = path.join(inputPath, "..", "#Minify_compiled");
    output.clean();
  }
  if (!inputPath || !fs.existsSync(inputPath)) {
    output.addText("&compile_no_path");
    return;
  }
  outputPath ??= path.join(inputPath, "..", "#Minify_compiled");

  const imgList = [...walkRel(inputPath)].filter((f) => f.endsWith(".png")).map((f) => f.replace(/\\/g, "/"));
  output.addText("&compile_init", [inputPath]);
  mfs.removePath(C.minifyDotaCompileInputPath, outputPath);
  mfs.createDirs(C.minifyDotaCompileInputPath);
  fs.writeFileSync(path.join(inputPath, "ref.xml"), createImgRefXml(imgList), "utf8");

  for (const item of fs.readdirSync(inputPath)) {
    const src = path.join(inputPath, item);
    if (mfs.isDir(src)) mfs.copyTree(src, path.join(C.minifyDotaCompileInputPath, item));
    else mfs.copyFile(src, C.minifyDotaCompileInputPath);
  }

  await compile();

  mfs.createDirs(C.minifyDotaCompileOutputPath);
  mfs.copyTree(C.minifyDotaCompileOutputPath, outputPath);
  mfs.removePath(
    C.minifyDotaCompileInputPath,
    C.minifyDotaCompileOutputPath,
    path.join(inputPath, "ref.xml"),
    path.join(outputPath, "ref.vxml_c"),
  );
  mfs.createDirs(C.minifyDotaToolsRequiredPath);
  output.addText("&compile_successful", [outputPath]);

  if (pakPath) {
    await packSingle(outputPath, pakPath);
    output.addText("&compile_created_pak", [pakPath]);
  }
}

/** Extracts the bare minimum requirements for resourcecompiler.exe. */
export function extractWorkshopTools(): boolean {
  output.clean();
  mfs.removePath(base.rescompOverrideDir);
  let fails = 0;

  C.dotaToolsPaths.forEach((src, i) => {
    if (!fs.existsSync(src)) {
      output.addText(`Extraction of ${src} failed`, { msgType: "error" });
      fails++;
      return;
    }
    const dst = C.dotaToolsExtractionPaths[i];
    if (mfs.isDir(src)) mfs.copyTree(src, dst);
    else mfs.copyFile(src, dst);
  });

  if (fails) return false;
  recalcRescompDirs();
  if (fs.existsSync(C.dotaResourceCompilerPath)) {
    output.addText("Extracted workshop tools successfully.");
    return true;
  }
  output.addText(`Extraction of ${C.dotaResourceCompilerPath} failed`, { msgType: "error" });
  return false;
}

// ------------------------------------------------------------- scripts -----

export interface ScriptContext {
  /** Folder name of the mod (e.g. "Custom Fonts"). */
  modName: string;
  /** Absolute path of the mod folder. */
  modDir: string;
  /** Hook the script runs for: loop, initial, after_decompile, after_recompile, after_patch, prelaunch, uninstall. */
  order: string;
}

type ScriptModule = { main?: (ctx: ScriptContext) => unknown; [fn: string]: unknown };

/** `<modDir>/<baseName>.ts` (or `.js`), null when the mod has no such script. */
export const resolveScriptPath = scriptLoader.resolveScript;

/** Executes `script.ts` (or a hook script) of a mod. Returns whatever `main` returned. */
export async function execScript(scriptPath: string | null, modName: string, orderName: string, terminalOutput = true): Promise<unknown> {
  if (!scriptPath || !fs.existsSync(scriptPath)) return undefined;
  const modDir = path.dirname(scriptPath);
  if (modsShared.readManifest(modDir).browser) {
    log.writeWarning(`Script execution is disabled for browser mods: ${modName}`);
    return undefined;
  }

  const mod = scriptLoader.loadFresh<ScriptModule>(scriptPath);
  if (typeof mod.main !== "function") {
    log.writeWarning("&script_no_main", [modName, orderName], undefined, { indent: true });
    return undefined;
  }
  if (terminalOutput) output.addText("&script_execution", [modName, orderName], { indent: true });
  const result = await mod.main({ modName, modDir: path.resolve(modDir), order: orderName });
  if (terminalOutput) output.addText("&script_success", [modName, orderName], { msgType: "success", indent: true });
  return result;
}

/**
 * Runs `script_<order>.ts` for every (enabled) mod:
 * initial, after_decompile, after_recompile, after_patch, prelaunch, uninstall.
 * When `mods` is given only those mods run.
 */
export async function bulkExecScript(orderName: string, terminalOutput = true, mods?: Set<string> | null): Promise<boolean> {
  let anyRan = false;
  let names = [...modsShared.modsWithOrder];
  if (mods) names = names.filter((m) => mods.has(m));

  for (const modName of names) {
    if (modsShared.isIgnoredFolder(modName)) continue;
    const root = path.join(base.modsDir, modName);
    const scriptPath = scriptLoader.resolveScript(root, `script_${orderName}`);
    if (!scriptPath) continue;

    const cfg = modsShared.readManifest(root);
    if ("browser" in cfg) continue;

    // Uninstall scripts decide by themselves whether the mod is installed.
    if (!mods && !(cfg.always || orderName === "initial" || orderName === "uninstall" || modsShared.getState(modName))) continue;

    try {
      if (await execScript(scriptPath, modName, orderName, terminalOutput)) anyRan = true;
    } catch (err) {
      log.writeWarning(`Script ${path.basename(scriptPath)} of ${modName} failed`, [], err);
    }
  }
  return anyRan;
}

/** Executes a named function exported from a mod's `script_utility.ts`. */
export async function execScriptFunction(scriptPath: string, modName: string, functionName = "main"): Promise<void> {
  if (!fs.existsSync(scriptPath)) {
    log.writeWarning(`Script file not found: ${scriptPath}`);
    return;
  }
  const modDir = path.dirname(scriptPath);
  if (modsShared.readManifest(modDir).browser) {
    log.writeWarning(`Script execution is disabled for browser mods: ${modName}`);
    return;
  }
  const mod = scriptLoader.loadFresh<ScriptModule>(scriptPath);
  const fn = mod[functionName];
  if (typeof fn === "function") await fn({ modName, modDir: path.resolve(modDir), order: "utility" });
  else log.writeWarning(`Function '${functionName}' not found in ${scriptPath}`);
}
