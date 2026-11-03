import fs from "node:fs";
import path from "node:path";

import * as base from "../../core/base";
import * as config from "../../core/config";
import * as localization from "../../core/localization";
import * as modsShared from "../../core/mods-shared";
import * as scriptLoader from "../../core/script-loader";
import { pathToUri } from "../../core/utils";
import { ConfigService } from "./config-service";

const PLUGIN_TAB_NAVIGATION_SCRIPT = `
<script>
  window.addEventListener("keydown", function (event) {
    if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: "CYCLE_TAB", forward: !event.shiftKey }, "*");
    }
  });
</script>
`;

type PluginApiModule = {
  handleApi?: (action: string, params: Record<string, any>) => unknown;
  [action: string]: unknown;
};

export class PluginService {
  static resolvePluginEntry(pPath: string): string | null {
    const target = path.resolve(pPath, "ui", "index.html");
    return fs.existsSync(target) ? target : null;
  }

  static findPluginPath(pluginId: string): string | null {
    const direct = path.join(base.pluginsDir, pluginId);
    const directManifest = path.join(direct, "manifest.json");
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
      if (!fs.existsSync(directManifest)) return direct;
      if (config.readJsonFile(directManifest).id === pluginId) return direct;
    }
    if (!fs.existsSync(base.pluginsDir)) return null;
    for (const folder of fs.readdirSync(base.pluginsDir).sort()) {
      if (modsShared.isIgnoredFolder(folder)) continue;
      const manifest = path.join(base.pluginsDir, folder, "manifest.json");
      if (fs.existsSync(manifest) && config.readJsonFile(manifest).id === pluginId) return path.join(base.pluginsDir, folder);
    }
    return null;
  }

  getTabs(): Array<{ id: string; name: string; entry_point: string }> {
    const tabs: Array<{ id: string; name: string; entry_point: string }> = [];
    if (!fs.existsSync(base.pluginsDir)) return tabs;
    for (const name of fs.readdirSync(base.pluginsDir).sort()) {
      if (modsShared.isIgnoredFolder(name)) continue;
      const pPath = path.join(base.pluginsDir, name);
      const manifestPath = path.join(pPath, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = config.readJsonFile(manifestPath);
      if (!("id" in manifest) || !("name" in manifest)) continue;
      const entry = PluginService.resolvePluginEntry(pPath);
      if (entry) tabs.push({ id: manifest.id, name: manifest.name, entry_point: pathToUri(entry) });
    }
    return tabs;
  }

  getContent(pluginId: string): string {
    const pPath = PluginService.findPluginPath(pluginId);
    const entry = pPath && PluginService.resolvePluginEntry(pPath);
    if (!entry) return "";
    const cs = new ConfigService();
    let content = fs.readFileSync(entry, "utf8");
    content = ConfigService.injectThemeIntoContent(content, cs.getThemeCss(config.get("theme", "light")), cs.getBaseCss());
    const headClose = content.lastIndexOf("</head>");
    return headClose !== -1
      ? content.slice(0, headClose) + PLUGIN_TAB_NAVIGATION_SCRIPT + content.slice(headClose)
      : PLUGIN_TAB_NAVIGATION_SCRIPT + content;
  }

  getLocalization(pluginId: string, lang = "en"): Record<string, string> {
    const pPath = PluginService.findPluginPath(pluginId);
    return localization.getForPlugin(pPath ? path.basename(pPath) : pluginId, lang);
  }

  /** Dispatches to `plugins/<id>/api.ts` (`handleApi(action, params)` or a same-named export). */
  async callApi(pluginId: string, action: string, params?: Record<string, any> | null): Promise<unknown> {
    const pPath = PluginService.findPluginPath(pluginId);
    if (!pPath) throw new Error(`Plugin directory for '${pluginId}' was not found.`);
    const apiFile = scriptLoader.resolveScript(pPath, "api");
    if (!apiFile) throw new Error(`No API file (api.ts) found for plugin '${pluginId}'.`);

    const mod = scriptLoader.loadCached<PluginApiModule>(apiFile);
    if (typeof mod.handleApi === "function") return mod.handleApi(action, params ?? {});
    const fn = mod[action];
    if (typeof fn === "function") return fn(params ?? {});
    throw new Error(`Action '${action}' not found in plugin '${pluginId}'.`);
  }
}
