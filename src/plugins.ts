// Discovers and initializes plugins from Minify/plugins/<folder>/{manifest.json, main.ts}.

import fs from "node:fs";
import path from "node:path";

import * as base from "./core/base";
import * as config from "./core/config";
import * as modsShared from "./core/mods-shared";
import * as output from "./core/output";
import * as registry from "./core/registry";
import * as scriptLoader from "./core/script-loader";

/** plugin id -> folder path */
const loadedPaths = new Map<string, string>();

export function initialize(): Promise<void> {
  registry.clear();
  loadedPaths.clear();
  if (!fs.existsSync(base.pluginsDir)) return Promise.resolve();

  for (const entry of fs.readdirSync(base.pluginsDir).sort()) {
    if (modsShared.isIgnoredFolder(entry)) continue;
    const pPath = path.join(base.pluginsDir, entry);
    const manifestPath = path.join(pPath, "manifest.json");
    if (!fs.existsSync(manifestPath) || !fs.statSync(pPath).isDirectory()) continue;

    try {
      const manifest = config.readJsonFile(manifestPath);
      const mainFile = scriptLoader.resolveScript(pPath, "main");
      if (!mainFile) continue;
      const pluginId = manifest.id;
      if (typeof pluginId !== "string" || !pluginId) continue;
      if (loadedPaths.has(pluginId)) {
        output.addText(`Duplicate plugin id '${pluginId}' in '${entry}'.`, { msgType: "warning" });
        continue;
      }

      scriptLoader.invalidate(pPath);
      const mod = scriptLoader.loadCached<{ default?: registry.MinifyPlugin } & registry.MinifyPlugin>(mainFile);
      const plugin: registry.MinifyPlugin = mod.default ?? mod;
      plugin.id ??= pluginId;
      registry.registerPlugin(plugin);
      loadedPaths.set(pluginId, pPath);
    } catch (err) {
      output.addText(`Error initializing plugin '${entry}': ${err instanceof Error ? err.message : err}`, { msgType: "warning" });
    }
  }

  return (async () => {
    for (const plugin of registry.getPlugins()) {
      if (!plugin.onInitialize) continue;
      try {
        await plugin.onInitialize();
      } catch (err) {
        output.addText(`Error running plugin initialization hook: ${err}`, { msgType: "warning" });
      }
    }
  })();
}
