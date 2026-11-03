/**
 * Public API for mod scripts and plugin backends.
 *
 *   import { config, output, steam, type ScriptContext } from "@minify/sdk";
 *
 *   export async function main(ctx: ScriptContext) {
 *     output.addText(`Hello from ${ctx.modName}`, { indent: true });
 *   }
 */

export * as base from "./core/base";
export * as config from "./core/config";
export { C as constants, resolveLocale, recalcRescompDirs } from "./core/constants";
export * as fs from "./core/fs";
export * as jsonc from "./core/jsonc";
export * as localization from "./core/localization";
export * as log from "./core/log";
export * as modsShared from "./core/mods-shared";
export * as output from "./core/output";
export * as proc from "./core/proc";
export * as registry from "./core/registry";
export * as steam from "./core/steam";
export * as utils from "./core/utils";
export * as vdf from "./core/vdf";
export { VpkFile, pack as packVpk, packSingle as packVpkSingle } from "./core/vpk";
export { PluginRouter, type Params } from "./core/plugin-sdk";
export type { MinifyPlugin } from "./core/registry";

export * as conditions from "./conditions";
export * as helper from "./helper";
export type { ScriptContext } from "./helper";
export * as manifestUtils from "./patch/manifest-utils";
export * as vpkUtils from "./patch/vpk-utils";
export * as xmlUtils from "./patch/xml-utils";
export * as ui from "./ui/dialogs";
export { initialize as reloadPlugins } from "./plugins";

// Third-party helpers re-exported so scripts don't depend on node_modules being resolvable from Minify/.
export { default as AdmZip } from "adm-zip";
