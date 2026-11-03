import fs from "node:fs";
import path from "node:path";

import * as conditions from "../../conditions";
import * as base from "../../core/base";
import * as config from "../../core/config";
import { parseJsonc } from "../../core/jsonc";
import * as localization from "../../core/localization";
import * as modsShared from "../../core/mods-shared";
import { VpkFile } from "../../core/vpk";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  size?: number;
  children?: TreeNode[];
}

export interface ModMethod {
  name: string;
  type: "tree" | "json" | "blacklist" | "css" | "python" | "typescript" | "xml" | "text";
  content?: string;
  tree?: TreeNode;
  badge?: string;
}

const PREVIEW_NAMES = ["preview.jpg", "preview.jpeg", "preview.png", "preview.webp", "preview.gif"];
const SCRIPT_PRIORITY = [
  "script_initial", "script", "script_after_decompile", "script_after_recompile",
  "script_after_patch", "script_prelaunch", "script_uninstall", "script_utility",
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lineCount = (s: string) => (s ? s.split(/\r?\n/).length - (s.endsWith("\n") ? 1 : 0) : 0);

export class ModService {
  static getModPreview(modPath: string): string | null {
    if (!fs.existsSync(modPath) || !fs.statSync(modPath).isDirectory()) return null;
    for (const filename of fs.readdirSync(modPath)) {
      if (!PREVIEW_NAMES.includes(filename.toLowerCase())) continue;
      const ext = filename.toLowerCase().split(".").pop()!;
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      return `data:${mime};base64,${fs.readFileSync(path.join(modPath, filename)).toString("base64")}`;
    }
    return null;
  }

  getMods() {
    modsShared.scanMods();
    const workshop = conditions.state.workshopInstalled;
    if (!workshop) conditions.disableWorkshopMods();

    return modsShared.visuallyAvailableMods.map((mod) => {
      const modPath = path.join(base.modsDir, mod);
      let always = false;
      let untickable = false;
      let displayName = mod;
      if (fs.existsSync(modPath) && fs.statSync(modPath).isDirectory()) {
        const cfg = modsShared.readManifest(modPath);
        always = Boolean(cfg.always);
        if (cfg.name) displayName = String(cfg.name);
        if (!workshop && conditions.isWorkshopRequiredMod(modPath, cfg)) untickable = true;
      }
      return {
        name: mod,
        display_name: displayName,
        enabled: !untickable && (always || modsShared.getState(mod)),
        always,
        untickable,
        preview: ModService.getModPreview(modPath),
      };
    });
  }

  static buildDirectoryTree(dirPath: string): TreeNode {
    const scan = (current: string, rel: string): TreeNode => {
      const entries = fs
        .readdirSync(current, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "__pycache__")
        .sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const children = entries.map((e): TreeNode => {
        const full = path.join(current, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        return e.isDirectory() ? scan(full, childRel) : { name: e.name, type: "file", path: childRel, size: fs.statSync(full).size };
      });
      return { name: rel ? path.basename(current) : path.basename(dirPath), type: "directory", path: rel, children };
    };
    return scan(dirPath, "");
  }

  static countTreeFiles(node: TreeNode): number {
    return node.type === "file" ? 1 : (node.children ?? []).reduce((n, c) => n + ModService.countTreeFiles(c), 0);
  }

  static buildVpkTree(modName: string, vpkPath: string): TreeNode {
    const root: TreeNode = { name: modName, type: "directory", path: "", children: [] };
    const pak = VpkFile.open(vpkPath);
    for (const p of pak.paths().sort()) {
      const parts = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/");
      let cur = root;
      let curPath = "";
      parts.forEach((part, i) => {
        curPath = curPath ? `${curPath}/${part}` : part;
        const isFile = i === parts.length - 1;
        const type = isFile ? "file" : "directory";
        let found = cur.children!.find((c) => c.name === part && c.type === type);
        if (!found) {
          found = { name: part, type, path: curPath, ...(isFile ? {} : { children: [] }) };
          cur.children!.push(found);
        }
        cur = found;
      });
    }
    pak.close();
    const sort = (node: TreeNode) => {
      if (!node.children) return;
      node.children.sort((a, b) => (a.type === b.type ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.type === "directory" ? -1 : 1));
      node.children.forEach(sort);
    };
    sort(root);
    return root;
  }

  static formatJson(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.includes("\n")) return trimmed;
    return JSON.stringify(parseJsonc(trimmed), null, 2);
  }

  getModMethods(modName: string, modPath: string): ModMethod[] {
    const methods: ModMethod[] = [];
    const isDirectory = fs.existsSync(modPath) && fs.statSync(modPath).isDirectory();

    if (modName.endsWith(".vpk") && fs.existsSync(modPath) && !isDirectory) {
      const tree = ModService.buildVpkTree(modName, modPath);
      methods.push({ name: modName, type: "tree", tree, badge: plural(ModService.countTreeFiles(tree), "file") });
      return methods;
    }
    if (!isDirectory) return methods;

    const read = (f: string) => fs.readFileSync(path.join(modPath, f), "utf8");
    const textMethod = (name: string, type: ModMethod["type"], content: string): ModMethod => ({
      name,
      type,
      content,
      badge: plural(lineCount(content), "line"),
    });

    for (const dir of ["files", "files_uncompiled"]) {
      const full = path.join(modPath, dir);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        const tree = ModService.buildDirectoryTree(full);
        methods.push({ name: dir, type: "tree", tree, badge: plural(ModService.countTreeFiles(tree), "file") });
      }
    }

    const has = (f: string) => fs.existsSync(path.join(modPath, f)) && fs.statSync(path.join(modPath, f)).isFile();
    if (has("blacklist.txt")) methods.push(textMethod("blacklist.txt", "blacklist", read("blacklist.txt")));
    for (const json of ["xml.json", "replacer.json"]) if (has(json)) methods.push(textMethod(json, "json", ModService.formatJson(read(json))));
    if (has("styling.css")) methods.push(textMethod("styling.css", "css", read("styling.css")));

    const scripts = fs
      .readdirSync(modPath)
      .filter((f) => /^script.*\.(ts|js)$/.test(f) && has(f))
      .sort((a, b) => {
        const ia = SCRIPT_PRIORITY.indexOf(a.replace(/\.(ts|js)$/, ""));
        const ib = SCRIPT_PRIORITY.indexOf(b.replace(/\.(ts|js)$/, ""));
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.toLowerCase().localeCompare(b.toLowerCase());
      });
    for (const s of scripts) methods.push(textMethod(s, "typescript", read(s)));

    if (has("manifest.json")) methods.push(textMethod("manifest.json", "json", ModService.formatJson(read("manifest.json"))));

    const known = new Set([...PREVIEW_NAMES, "notes.md", "blacklist.txt", "xml.json", "replacer.json", "styling.css", "manifest.json", "files", "files_uncompiled", "__pycache__"]);
    for (const item of fs.readdirSync(modPath).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      if (known.has(item.toLowerCase()) || item.startsWith("script") || item.startsWith(".") || item.startsWith("_") || !has(item)) continue;
      const ext = item.includes(".") ? item.toLowerCase().split(".").pop() : "";
      const type: ModMethod["type"] =
        ext === "json" ? "json" : ext === "xml" || ext === "vxml" ? "xml" : ext === "css" ? "css" : ext === "ts" ? "typescript" : "text";
      methods.push(textMethod(item, type, read(item)));
    }
    return methods;
  }

  getModDetails(modName: string, lang?: string | null) {
    lang ||= String(config.get("locale") || "en");
    const modPath = path.join(base.modsDir, modName);
    const methods = this.getModMethods(modName, modPath);
    const isDirectory = fs.existsSync(modPath) && fs.statSync(modPath).isDirectory();

    let displayName = modName;
    if (isDirectory) {
      const cfg = modsShared.readManifest(modPath);
      if (cfg.name) displayName = String(cfg.name);
    }
    if (!isDirectory) {
      return { name: modName, display_name: displayName, notes: null, preview: null, has_notes: false, has_preview: false, methods };
    }

    const notesPath = path.join(modPath, "notes.md");
    const notes = fs.existsSync(notesPath) ? localization.parseNotesForLocale(fs.readFileSync(notesPath, "utf8"), lang) : null;
    const preview = ModService.getModPreview(modPath);
    return { name: modName, display_name: displayName, notes, preview, has_notes: Boolean(notes), has_preview: Boolean(preview), methods };
  }

  setMods(data: Record<string, boolean>): boolean {
    for (const [modName, enabled] of Object.entries(data)) {
      const modPath = path.join(base.modsDir, modName);
      if (fs.existsSync(modPath) && fs.statSync(modPath).isDirectory()) {
        const cfg = modsShared.readManifest(modPath);
        if (cfg.always) continue;
        if (!conditions.state.workshopInstalled && conditions.isWorkshopRequiredMod(modPath, cfg)) continue;
      }
      modsShared.setState(modName, Boolean(enabled));
    }
    return true;
  }
}
