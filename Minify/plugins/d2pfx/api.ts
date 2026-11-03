import fs from "node:fs";
import path from "node:path";

import { base, config, fs as mfs, modsShared, output, PluginRouter, utils, type Params } from "@minify/sdk";

import { DataManager, type D2Mod } from "./data";
import { RENAME_CATEGORIES, VERSION } from "./meta";

const router = new PluginRouter();
const D2PFX_INSTALLS_KEY = "d2pfx_installs";

interface InstallRecord {
  source_date?: unknown;
  folder?: string;
}

function installKey(category: string, name: string, label?: string | null): string {
  const key = `${category}::${name}`;
  return label ? `${key}::${label}` : key;
}

function installRecords(): Record<string, InstallRecord> {
  const records = utils.readStates()[D2PFX_INSTALLS_KEY];
  if (!records || typeof records !== "object" || Array.isArray(records)) return {};

  const normalized: Record<string, InstallRecord> = {};
  for (const [key, record] of Object.entries<any>(records)) {
    if (!record || typeof record !== "object") continue;
    const k =
      typeof record.category === "string" && typeof record.name === "string"
        ? installKey(record.category, record.name, record.label)
        : key.replace(/::$/, "");
    normalized[k] = {};
    for (const field of ["source_date", "folder"] as const) if (field in record) (normalized[k] as any)[field] = record[field];
  }
  if (JSON.stringify(normalized) !== JSON.stringify(records)) utils.writeStates(D2PFX_INSTALLS_KEY, normalized);
  return normalized;
}

export function reconcileInstallStates(): void {
  const records = installRecords();
  const valid = Object.fromEntries(
    Object.entries(records).filter(([, r]) => typeof r.folder === "string" && mfs.isDir(path.join(base.modsDir, r.folder))),
  );
  if (Object.keys(valid).length !== Object.keys(records).length) utils.writeStates(D2PFX_INSTALLS_KEY, valid);
}

function saveInstallRecord(record: { category: string; name: string; label?: string | null; source_date?: unknown; folder: string }): void {
  const records = installRecords();
  records[installKey(record.category, record.name, record.label)] = { source_date: record.source_date, folder: record.folder };
  utils.writeStates(D2PFX_INSTALLS_KEY, records);
}

const sourceDate = (mod: D2Mod) => (mod.meta && typeof mod.meta === "object" ? mod.meta.date : null);

function hasTag(tags: unknown, tag: string): boolean {
  if (Array.isArray(tags)) return tags.some((t) => String(t).toLowerCase() === tag);
  if (tags && typeof tags === "object") return Object.entries(tags).some(([k, v]) => k.toLowerCase() === tag && v);
  return false;
}

function activeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (tags && typeof tags === "object") return Object.entries(tags).filter(([, v]) => v).map(([k]) => k);
  return tags == null ? [] : [String(tags)];
}

function defaultFolderName(catId: string, name: string, label?: string | null): string {
  let dir = `D2PFX ${catId.toUpperCase()} - ${name}`;
  if (label) dir = `${dir} ${label}`;
  return utils.sanitizeWinPath(dir);
}

/** Finds the installed folder of a d2pfx mod (by manifest), or the folder it would be installed to. */
function findModFolder(name: string, catId: string, label?: string | null): { folder: string; exists: boolean } {
  if (fs.existsSync(base.modsDir)) {
    for (const folder of fs.readdirSync(base.modsDir)) {
      const modPath = path.join(base.modsDir, folder);
      if (!mfs.isDir(modPath)) continue;
      const cfg = modsShared.readManifest(modPath);
      if (cfg.browser === "d2pfx" && cfg.name === name && cfg.category === catId && (cfg.label ?? null) === (label ?? null)) {
        return { folder, exists: true };
      }
    }
  }
  const folder = defaultFolderName(catId, name, label);
  return { folder, exists: fs.existsSync(path.join(base.modsDir, folder)) };
}

router.route("get_categories", async () => {
  const dm = new DataManager();
  if (!(await dm.load())) return [];
  return dm.getCategories().map((id) => ({ id, name: dm.getCategoryName(id), description: dm.getCategoryDescription(id) }));
});

router.route("get_mods", async (params: Params) => {
  const catId = String(params.cat_id ?? "");
  const search = String(params.search ?? "");
  let sortMode = String(params.sort_mode ?? "");

  const dm = new DataManager();
  if (!(await dm.load())) return [];

  const expanded: D2Mod[] = [];
  for (const m of dm.getMods(catId)) {
    if (Array.isArray(m.styles)) for (const style of m.styles) expanded.push({ ...m, ...style });
    else expanded.push({ ...m });
  }

  const filterNsfw = Boolean(config.get("d2pfx_filter_nsfw", true));
  const filterAnime = Boolean(config.get("d2pfx_filter_anime", false));
  let filtered = expanded.filter(
    (m) => !(filterNsfw && hasTag(m.tags, "adult")) && !(filterAnime && hasTag(m.tags, "anime")) && !hasTag(m.tags, "css"),
  );

  if (search) {
    for (const token of search.toLowerCase().match(/(?:by:|tag:|sort:)?\S+/g) ?? []) {
      if (token.startsWith("by:")) {
        const val = token.slice(3);
        if (val) filtered = filtered.filter((m) => [].concat(m.author ?? []).some((a) => String(a).toLowerCase().includes(val)));
      } else if (token.startsWith("tag:")) {
        const val = token.slice(4);
        if (val) filtered = filtered.filter((m) => activeTags(m.tags).some((t) => t.toLowerCase().includes(val)));
      } else if (token.startsWith("sort:")) {
        sortMode = token.slice(5);
      } else {
        filtered = filtered.filter((m) => String(m.name ?? "").toLowerCase().includes(token) || String(m.label ?? "").toLowerCase().includes(token));
      }
    }
  }

  const byName = (a: D2Mod, b: D2Mod) => String(a.name ?? "").toLowerCase().localeCompare(String(b.name ?? "").toLowerCase());
  const byDate = (a: D2Mod, b: D2Mod) => Number(a.meta?.date ?? 0) - Number(b.meta?.date ?? 0);
  if (sortMode === "a-z") filtered.sort(byName);
  else if (sortMode === "z-a") filtered.sort((a, b) => byName(b, a));
  else if (sortMode === "new") filtered.sort((a, b) => byDate(b, a));
  else if (sortMode === "old") filtered.sort(byDate);

  for (const m of filtered) {
    const prev = m.preview;
    m.preview_url = prev ? (String(prev).startsWith("http") ? prev : dm.getPreviewUrl(catId, prev)) : null;
  }
  return filtered;
});

router.route("get_installed_mods", () => {
  const records = installRecords();
  if (!fs.existsSync(base.modsDir)) return [];
  const installed: D2Mod[] = [];
  for (const folder of fs.readdirSync(base.modsDir)) {
    const modPath = path.join(base.modsDir, folder);
    if (!mfs.isDir(modPath)) continue;
    const cfg = modsShared.readManifest(modPath);
    if (cfg.browser !== "d2pfx") continue;
    const record = records[installKey(cfg.category ?? "", cfg.name ?? "", cfg.label)];
    installed.push({
      name: cfg.name,
      category: cfg.category,
      label: cfg.label,
      folder,
      enabled: modsShared.getState(folder),
      source_date: record && "source_date" in record ? record.source_date : cfg.source_date,
    });
  }
  return installed;
});

router.route("set_mod_state", (params: Params) => {
  const { folder } = findModFolder(String(params.mod_name ?? params.name ?? ""), String(params.cat_id ?? ""), params.label);
  const enabled = params.enabled === undefined ? true : Boolean(params.enabled);
  modsShared.setState(folder, enabled);
  return { success: true, folder, enabled };
});

async function installMod(params: Params, updateTarget?: string): Promise<Record<string, unknown>> {
  const mod: D2Mod = params.mod ?? {};
  const catId = String(params.cat_id ?? "");
  const dm = new DataManager();
  const name = String(mod.name ?? "Unknown");
  const label: string | null = mod.label ?? null;
  const links: D2Mod[] = Array.isArray(mod.links) ? mod.links : [];

  let modUrl: string | null = null;
  let isZip = false;
  if (typeof mod.file === "string" && (mod.file.endsWith(".vpk") || mod.file.endsWith(".zip"))) {
    modUrl = mod.file;
    isZip = mod.file.endsWith(".zip");
  }
  if (!modUrl) {
    const vpkLink = links.find((l) => String(l.url ?? "").endsWith(".vpk"));
    const zipLink = links.find((l) => String(l.url ?? "").endsWith(".zip"));
    if (vpkLink) modUrl = vpkLink.url;
    else if (zipLink) {
      modUrl = zipLink.url;
      isZip = true;
    }
  }
  if (!modUrl) return { success: false, error: `No compatible mod file (.vpk/.zip) found for '${name}'.` };
  if (!modUrl.startsWith("http")) modUrl = dm.getFileUrl(catId, modUrl);

  const finalTarget = updateTarget ?? path.join(base.modsDir, defaultFolderName(catId, name, label));
  const targetDir = updateTarget ? fs.mkdtempSync(path.join(base.modsDir, ".d2pfx-update-")) : finalTarget;
  mfs.createDirs(targetDir);

  // 1. Download the mod file and the preview concurrently
  const modDest = path.join(targetDir, path.basename(new URL(modUrl).pathname));
  const previewFile: string | undefined = mod.preview;
  const previewUrl = previewFile ? (previewFile.startsWith("http") ? previewFile : dm.getPreviewUrl(catId, previewFile)) : null;

  const [modOk] = await Promise.all([
    dm.downloadFile(modUrl, modDest, { name: `${name} (${catId.toUpperCase()})`, emitProgress: true }),
    previewUrl
      ? dm.downloadFile(previewUrl, path.join(targetDir, "preview.webp"), { emitProgress: false }).catch(() => false)
      : Promise.resolve(true),
  ]);
  if (!modOk) {
    mfs.removePath(targetDir);
    return { success: false, error: "Failed to download mod file." };
  }

  // 2. Extract if zip
  if (isZip) {
    if (!(await mfs.extractArchive(modDest, targetDir))) {
      mfs.removePath(targetDir);
      return { success: false, error: "Failed to extract mod archive." };
    }
    mfs.removePath(modDest);
  }

  // 3. manifest.json
  const tags = activeTags(mod.tags);
  const modcfg: Record<string, unknown> = {
    browser: "d2pfx",
    name,
    category: catId,
    author: mod.author,
    sender: mod.sender,
    links,
    tags,
    version: VERSION,
    label,
    source_date: sourceDate(mod),
  };
  if (RENAME_CATEGORIES.includes(catId)) modcfg.order = 2;
  config.writeJsonFile(path.join(targetDir, "manifest.json"), modcfg);

  // 4. notes.md
  let notes = `Installed via D2PFX Browser ${VERSION}\n\n`;
  if (catId && catId.toLowerCase() !== "unknown") notes += `Category: ${catId}\n`;
  const typeLabels: Record<string, string> = { author: "Author", source: "Source", modded: "Modded", sender: "Sender" };
  for (const t of Object.keys(typeLabels)) {
    const vals = links.filter((l) => l.type === t).map((l) => l.name || l.url).filter(Boolean);
    if (vals.length) notes += `${typeLabels[t]}: ${vals.join(", ")}\n`;
  }
  if (tags.length) notes += `Tags: ${tags.join(", ")}\n`;
  fs.writeFileSync(path.join(targetDir, "notes.md"), notes, "utf8");

  if (updateTarget) {
    const backup = fs.mkdtempSync(path.join(base.modsDir, ".d2pfx-backup-"));
    fs.rmdirSync(backup);
    fs.renameSync(finalTarget, backup);
    try {
      fs.renameSync(targetDir, finalTarget);
    } catch (err) {
      fs.renameSync(backup, finalTarget);
      mfs.removePath(targetDir);
      throw err;
    }
    mfs.removePath(backup);
  }

  const folder = path.basename(finalTarget);
  saveInstallRecord({ category: catId, name, label, source_date: modcfg.source_date, folder });
  if (!updateTarget) modsShared.setState(folder, true);
  modsShared.scanMods();
  output.addText(`D2PFX mod '${name}' installed successfully.`, { msgType: "success" });
  return { success: true, folder };
}

router.route("install_mod", (params: Params) => installMod(params));

router.route("update_mod", (params: Params) => {
  const mod: D2Mod = params.mod ?? {};
  const { folder, exists } = findModFolder(String(mod.name ?? ""), String(params.cat_id ?? ""), mod.label);
  if (!exists) return { success: false, error: "Installed mod directory not found." };
  return installMod(params, path.join(base.modsDir, folder));
});

router.route("uninstall_mod", (params: Params) => {
  const modName = String(params.mod_name ?? "");
  const catId = String(params.cat_id ?? "");
  const label = params.label ?? null;
  const { folder, exists } = findModFolder(modName, catId, label);
  if (!exists) return { success: false, error: "Mod directory not found." };

  mfs.removePath(path.join(base.modsDir, folder));
  const records = installRecords();
  delete records[installKey(catId, modName, label)];
  utils.writeStates(D2PFX_INSTALLS_KEY, records);

  const states = config.readJsonFile<Record<string, boolean>>(base.paths.modsConfig);
  if (folder in states) {
    delete states[folder];
    config.writeJsonFile(base.paths.modsConfig, Object.fromEntries(Object.entries(states).sort(([a], [b]) => (a < b ? -1 : 1))));
  }
  modsShared.scanMods();
  output.addText(`D2PFX mod '${modName}' removed.`, { msgType: "info" });
  return { success: true };
});

router.route("prune_metadata_cache", async () => {
  const dm = new DataManager();
  mfs.removePath(path.join(dm.cacheDir, "mods.json"), path.join(dm.cacheDir, "constants.json"));
  return { success: await dm.refresh() };
});

export function handleApi(action: string, params?: Params): Promise<unknown> {
  return router.dispatch(action, params);
}
