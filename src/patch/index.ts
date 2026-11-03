// The universe: builds pakXX_dir.vpk out of the enabled mods.

import fs from "node:fs";
import path from "node:path";

import * as conditions from "../conditions";
import * as base from "../core/base";
import * as config from "../core/config";
import { C } from "../core/constants";
import * as mfs from "../core/fs";
import { readJsonc } from "../core/jsonc";
import * as log from "../core/log";
import * as modsShared from "../core/mods-shared";
import * as output from "../core/output";
import { isProcessRunning, launchDetached, run } from "../core/proc";
import { getPlugins } from "../core/registry";
import * as steam from "../core/steam";
import { mapConcurrent, sleep } from "../core/utils";
import { VpkFile } from "../core/vpk";
import * as helper from "../helper";
import * as blacklist from "./blacklist";
import * as manifestUtils from "./manifest-utils";
import * as remapProcessor from "./remap-processor";
import * as replacer from "./replacer";
import * as styling from "./styling";
import * as unins from "./unins";
import { parseModsString, selectMods } from "./util";
import * as validators from "./validators";
import * as vpkUtils from "./vpk-utils";
import * as xmlUtils from "./xml-utils";

export { unins };

export const state = { dotaVersionChanged: false };

function readTextIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function runPluginHook(hook: "onPreBuild" | "onPostBuild", modList: string[]): Promise<void> {
  for (const plugin of getPlugins()) {
    const fn = plugin[hook];
    if (fn) await fn.call(plugin, modList);
  }
}

export async function patcher(number = 66, modsString?: string | null): Promise<void> {
  if (await conditions.isDotaRunning("&close_dota_terminal", "warning")) return;

  if (!conditions.checkBinaries()) {
    await conditions.resolveDependencies();
    if (!conditions.checkBinaries()) {
      output.addText("&failure_terminal", { msgType: "error" });
      return;
    }
  }

  const workshop = conditions.state.workshopInstalled;
  let dotaPak: VpkFile | null = null;

  try {
    let modList = [...modsShared.modsWithOrder];
    let explicitMods: Set<string> | null = null;

    if (modsString != null) {
      const requested = parseModsString(modsString);
      if (!requested.length) {
        output.addText("No mods specified in --mods-string.", { msgType: "error" });
        return;
      }
      const [selected, missing] = selectMods(requested, modsShared.modsWithOrder);
      if (missing.length) {
        output.addText(`Unknown mod(s) in --mods-string: ${missing.join(", ")}`, { msgType: "error" });
        return;
      }
      explicitMods = new Set(selected);
      modList = modsShared.modsWithOrder.filter((m) => explicitMods!.has(m));
    } else {
      modsShared.enforceLocaleModStates();
    }
    const scriptMods = explicitMods;

    fs.mkdirSync(base.logsDir, { recursive: true });
    for (const item of fs.readdirSync(base.logsDir)) mfs.removePath(path.join(base.logsDir, item));

    mfs.createDirs(base.cacheDir, base.buildDir, base.replaceDir, base.mergeDir, C.minifyDotaCompileInputPath, C.minifyDotaToolsRequiredPath);

    const blankFileExtensions = helper.getBlankFileExtensions();

    const currentDotaVersion = readTextIfExists(C.dotaSteamInfPath);
    const cachedDotaVersion = readTextIfExists(base.dotaSteamInfCache);
    state.dotaVersionChanged = currentDotaVersion !== cachedDotaVersion;
    if (state.dotaVersionChanged && currentDotaVersion) fs.writeFileSync(base.dotaSteamInfCache, currentDotaVersion, "utf8");

    dotaPak = VpkFile.open(C.dotaGamePakPath);
    let dotaExtracts: string[] = [];
    let coreExtracts: string[] = [];
    const stylingDictionary = new Map<string, [string, string]>();
    const xmlModifications: Record<string, xmlUtils.XmlModification[]> = {};
    const replacerSourceExtracts: string[] = [];
    const replacerTargets: replacer.ReplacerTarget[] = [];

    // ---------------------------------------------------- dependencies -----
    if (!explicitMods) {
      let previous = modsShared.modsWithOrder.filter((m) => modsShared.getState(m)).length;
      for (;;) {
        for (const depDict of modsShared.modDependenciesList) {
          for (const [dependant, dependencies] of Object.entries(depDict)) {
            if (!modsShared.getState(dependant)) continue;
            for (const dependency of dependencies) {
              try {
                const needsWorkshop =
                  !workshop && conditions.workshopRequiredMethods.some((m) => fs.existsSync(path.join(base.modsDir, dependency, m)));
                modsShared.setState(dependency, !needsWorkshop);
              } catch {
                log.writeWarning(`Mod dependency ${dependency} couldn't be resolved, might be that the mod doesn't exist.`);
              }
            }
          }
        }
        const current = modsShared.modsWithOrder.filter((m) => modsShared.getState(m)).length;
        if (current === previous) break;
        previous = current;
      }
    }

    const isModActive = (modName: string, always = false) =>
      explicitMods ? explicitMods.has(modName) : always || modsShared.getState(modName);

    // ------------------------------------------------------- conflicts -----
    const conflictsFound: Record<string, string[]> = {};
    for (const conflictDict of modsShared.modConflictsList) {
      for (const [conflictMod, conflicts] of Object.entries(conflictDict)) {
        if (!modList.includes(conflictMod) || !isModActive(conflictMod)) continue;
        const active = conflicts.filter((m) => modList.includes(m) && isModActive(m));
        if (active.length) conflictsFound[conflictMod] = active;
      }
    }
    if (Object.keys(conflictsFound).length) {
      output.addText("&conflicts_detected", { msgType: "error" });
      for (const [mod, active] of Object.entries(conflictsFound)) output.addText(`${mod} -> ${active.join(", ")}`, { msgType: "error" });
      return;
    }

    // ---------------------------------- PRE-BUILD: dump base VPK mods ------
    const vpkModsToMerge = modList.filter((m) => m.endsWith(".vpk") && isModActive(m));
    if (vpkModsToMerge.length) {
      output.addText("&merging_vpks");
      for (const modName of vpkModsToMerge) {
        try {
          const modVpk = VpkFile.open(path.join(base.modsDir, modName));
          vpkUtils.dump(modVpk, C.minifyDotaCompileOutputPath, true);
          modVpk.close();
          output.addText("&merged_mod", [modName], { indent: true });
        } catch {
          log.writeWarning("&failed_merge_mod", [modName]);
        }
      }
    }

    await runPluginHook("onPreBuild", modList);

    // ------------------------ STEP 1: collect mod data, extract files ------
    let gameContentsFileInit = false;
    for (const folder of modList) {
      const modPath = path.join(base.modsDir, folder);
      const modCfg = manifestUtils.getMod(modPath);
      try {
        if (isModActive(folder, Boolean(modCfg.always))) {
          const blacklistTxt = path.join(modPath, "blacklist.txt");
          const stylingCss = path.join(modPath, "styling.css");
          const xmlFile = path.join(modPath, "xml.json");
          const filesUncompiledDir = path.join(modPath, "files_uncompiled");
          const remapFile = path.join(modPath, "remap.json");
          const replacerFile = path.join(modPath, "replacer.json");
          const filesDir = path.join(modPath, "files");
          const modSettings = config.getMod(folder);

          await helper.execScript(helper.resolveScriptPath(modPath, "script"), folder, "loop");
          output.addText("&installing_terminal", [folder]);

          if (workshop && fs.existsSync(filesUncompiledDir)) mfs.copyTree(filesUncompiledDir, C.minifyDotaCompileInputPath);
          if (fs.existsSync(filesDir)) mfs.copyTree(filesDir, C.minifyDotaCompileOutputPath);

          if (workshop && fs.existsSync(xmlFile)) {
            const effective = manifestUtils.getEffectiveSettings(modCfg, modSettings);
            const processed = xmlUtils.processModXml(readJsonc(xmlFile), effective);
            for (const [p, mods] of Object.entries(processed)) (xmlModifications[p] ??= []).push(...mods);
          }

          if (!gameContentsFileInit) {
            if (state.dotaVersionChanged || !fs.existsSync(base.gamepakcontentsFileDir)) {
              fs.writeFileSync(base.gamepakcontentsFileDir, dotaPak.paths().join("\n") + "\n", "utf8");
            }
            gameContentsFileInit = true;
          }

          if (fs.existsSync(blacklistTxt)) blacklist.process(blacklistTxt, folder, blankFileExtensions, modCfg, modSettings);

          if (workshop && fs.existsSync(stylingCss)) {
            styling.parseStylingFile(stylingCss, modCfg, folder, modSettings, stylingDictionary, coreExtracts, dotaExtracts);
          }

          replacer.process(replacerFile, folder, replacerSourceExtracts, replacerTargets, modCfg, modSettings);

          if (workshop && fs.existsSync(remapFile)) await remapProcessor.process(remapFile, folder, dotaPak, modCfg, modSettings);
        }
      } catch (err) {
        log.writeWarning(undefined, [], err);
      }

      // Extract XMLs to be modified (assume they are in game VPK)
      if (workshop) for (const p of Object.keys(xmlModifications)) dotaExtracts.push(p.replace(".xml", ".vxml_c"));
    }

    if (workshop) {
      coreExtracts = [...new Set(coreExtracts)];
      dotaExtracts = [...new Set(dotaExtracts)];

      // ----------------------- STEP 2: decompile to the build folder -----
      output.addText("&decompiling_terminal");
      const s2vLog: Buffer[] = [];
      try {
        for (const [pakPath, extracts] of [
          [C.dotaCorePakPath, coreExtracts],
          [C.dotaGamePakPath, dotaExtracts],
        ] as const) {
          if (!extracts.length) continue;
          const res = await run(C.s2vExecPath, [
            "--input", pakPath, "--vpk_decompile", "--vpk_filepath", extracts.join(","), "--output", base.buildDir,
          ]);
          s2vLog.push(res.output);
          validators.source2viewer(res.code, res.output);
        }
      } finally {
        fs.writeFileSync(base.logS2v, Buffer.concat(s2vLog));
      }

      await mapConcurrent(Object.entries(xmlModifications), ([p, mods]) => xmlUtils.applyModifications(path.join(base.buildDir, p), mods));
      await helper.bulkExecScript("after_decompile", true, scriptMods);

      // ------------------------------- STEP 3: CSS resourcecompile -------
      output.addText("&compiling_resource_terminal");
      const stylesByFile = new Map<string, string[]>();
      for (const [p, style] of stylingDictionary.values()) {
        const sanitized = p.startsWith("!") ? p.slice(1) : p;
        const cssFile = path.join(base.buildDir, `${sanitized}.css`);
        if (!stylesByFile.has(cssFile)) stylesByFile.set(cssFile, []);
        stylesByFile.get(cssFile)!.push(style);
      }
      for (const entry of stylesByFile) {
        try {
          styling.applyStylesToFile(entry);
        } catch (err) {
          log.writeWarning(`Failed to apply styles to ${entry[0]}`, [], err);
        }
      }

      mfs.copyTree(base.buildDir, C.minifyDotaCompileInputPath);
      await helper.compile();
    }
    await helper.bulkExecScript("after_recompile", true, scriptMods);

    if (replacerSourceExtracts.length) {
      vpkUtils.extract(dotaPak, replacerSourceExtracts, base.replaceDir);
      for (const t of replacerTargets) replacer.processReplacer(t);
    }

    // --------------------------------- STEP 4: plugin override hooks -------
    await runPluginHook("onPostBuild", modList);

    // ---------------------------------------- STEP 5: create the VPK -------
    vpkUtils.dumpMetadata(C.minifyDotaCompileOutputPath);
    mfs.createDirs(helper.state.outputPath);
    output.addText("&compiling_terminal");
    await vpkUtils.pack(
      C.minifyDotaCompileOutputPath,
      path.join(helper.state.outputPath, `pak${String(number).padStart(2, "0")}_dir.vpk`),
      config.get("non_chunked_vpk") ? null : vpkUtils.DEFAULT_VPK_CHUNK_SIZE,
    );

    // ------------------------------------- STEP 6: clean paths, inform -----
    dotaPak.close();
    dotaPak = null;
    mfs.removePath(C.minifyDotaCompileInputPath, C.minifyDotaCompileOutputPath, base.buildDir, base.replaceDir, base.mergeDir);

    // handle language option automatically
    if (config.get("fix_options")) await fixSteamOptions();

    await helper.bulkExecScript("after_patch", false, scriptMods);

    output.addSeparator();
    output.addText("&success_terminal", { msgType: "success" });
    output.addText("&launch_option", [config.getLocale()], { msgType: "warning" });

    if (fs.existsSync(base.logWarnings) && fs.statSync(base.logWarnings).size !== 0) {
      output.addText("&minify_encountered_errors_terminal", { msgType: "warning" });
    }
  } catch (err) {
    log.writeCrashlog(err);
    output.addSeparator();
    output.addText("&failure_terminal", { msgType: "error" });
    output.addText("&check_logs_terminal", { msgType: "warning" });
  } finally {
    dotaPak?.close();
  }
}

/** Fixes boot language + launch options; restarts Steam when launch options must be rewritten. */
async function fixSteamOptions(): Promise<void> {
  steam.fixBootLanguage();
  const launchNeedsFix = Boolean(steam.fixLaunchOptions(true));
  const prelaunchNeedsFix = steam.addPrelaunchToLaunchOptions(true);
  if (!launchNeedsFix && !prelaunchNeedsFix) return;

  // Steam overwrites localconfig.vdf on exit, so it must be closed first.
  if (base.isWin) launchDetached(steam.steamExecutablePath, ["-exitsteam"]);
  else launchDetached("bash", ["-c", "steam -exitsteam"]);

  const steamImage = path.basename(steam.steamExecutablePath);
  let retries = 0;
  while (await isProcessRunning(steamImage)) {
    if (retries >= 3) {
      output.addText("&failed_steam_close", [3], { msgType: "error", indent: true });
      break;
    }
    output.addText("&waiting_steam_to_close", { indent: true });
    await sleep(2000);
    retries++;
  }
  await sleep(1000);

  const launchFixed = steam.fixLaunchOptions();
  const prelaunchAdded = steam.addPrelaunchToLaunchOptions();
  if ((Array.isArray(launchFixed) && launchFixed.length) || prelaunchAdded || retries < 5) {
    if (base.isWin) launchDetached(steam.steamExecutablePath);
    else launchDetached("bash", ["-c", "steam"]);
  }
}
