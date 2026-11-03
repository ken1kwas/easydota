import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AdmZip, base, config, fs as mfs, localization, modsShared, reloadPlugins, utils, type Params } from "@minify/sdk";

const REGISTRY_URL = "https://raw.githubusercontent.com/Dota-Modding-Community/community/main/registry.json";
const STATES_KEY = "community_installs";
const REGISTRY_TYPES = new Set(["mod", "plugin", "theme"]);
const HEADERS = { "User-Agent": "Dota2-Minify-Community-Registry" };
const MAX_ARCHIVE_SIZE = 5 * 1024 * 1024 * 1024;
const REGISTRY_STATE_KEY = "community_registry";
const REGISTRY_REFRESH_INTERVAL = 86400;

type RegistryItem = Record<string, any>;
type ItemType = "mod" | "plugin" | "theme";
interface InstallRecord {
  type: ItemType;
  name: string;
  repo: string;
  tag: string;
  path?: string;
  files?: string[];
  plugin_id?: string;
}

const absBase = () => path.resolve(base.baseDir);
const rootFor = (type: ItemType) => path.resolve({ mod: base.modsDir, plugin: base.pluginsDir, theme: base.themesDir }[type]);

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------- registry --

function readRegistryCache(cachePath: string): RegistryItem[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read the cached community registry: ${err}`);
  }
  if (!Array.isArray(data)) throw new Error("The cached community registry must contain a JSON array.");
  return data.filter((i) => i && typeof i === "object");
}

async function getRegistry(): Promise<RegistryItem[]> {
  const cachePath = path.join(base.cacheDir, "plugins", "community", "registry.json");
  const lastRefresh = Number(utils.getState(REGISTRY_STATE_KEY, "last_refresh", 0));
  const cacheExists = fs.existsSync(cachePath);
  const refreshDue = config.get("community_auto_refresh_catalogue", true) && Date.now() / 1000 - lastRefresh > REGISTRY_REFRESH_INTERVAL;
  if (cacheExists && !refreshDue) return readRegistryCache(cachePath);

  try {
    const res = await fetch(REGISTRY_URL, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("The community registry must contain a JSON array.");
    const registry = data.filter((i) => i && typeof i === "object");
    mfs.createDirs(path.dirname(cachePath));
    fs.writeFileSync(cachePath, JSON.stringify(registry, null, 2), "utf8");
    utils.setState(REGISTRY_STATE_KEY, "last_refresh", Math.floor(Date.now() / 1000));
    return registry;
  } catch (err) {
    if (cacheExists) return readRegistryCache(cachePath);
    throw new Error(`Failed to fetch the community registry: ${err instanceof Error ? err.message : err}`);
  }
}

function versionList(versions: unknown): string[] {
  if (typeof versions === "string") return versions.split(",").map((v) => v.trim()).filter(Boolean);
  if (Array.isArray(versions)) return versions.map((v) => String(v).trim()).filter(Boolean);
  return [];
}

function releaseCompatibility(item: RegistryItem): Record<string, string[]> | null {
  if (!item.releases || typeof item.releases !== "object" || Array.isArray(item.releases)) return null;
  return Object.fromEntries(Object.entries(item.releases).filter(([tag]) => tag).map(([tag, v]) => [tag, versionList(v)]));
}

function compatibleVersions(item: RegistryItem): string[] {
  const releases = releaseCompatibility(item);
  if (releases) return [...new Set(Object.values(releases).flat())];
  return versionList(item.versions);
}

function tagIsCompatible(item: RegistryItem, tag: unknown): boolean {
  const releases = releaseCompatibility(item);
  if (releases) return typeof tag === "string" && (releases[tag] ?? []).includes(base.VERSION);
  return compatibleVersions(item).includes(base.VERSION);
}

function releaseVersionKey(tag: string): number[] {
  const nums = tag.match(/\d+/g);
  return nums ? nums.map(Number) : [-1];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function latestRelease(item: RegistryItem): { tag: string; asset_url: string; sha512?: string } {
  const releases = releaseCompatibility(item);
  const template = item["asset-url"];
  if (typeof template !== "string" || !template.includes("{tag}")) throw new Error("The registry entry has an invalid asset URL template.");

  let tag: string;
  if (!releases) tag = "latest";
  else {
    const compatible = Object.entries(releases).filter(([, v]) => v.includes(base.VERSION)).map(([t]) => t);
    if (!compatible.length) throw new Error(`No release supports Minify ${base.VERSION}.`);
    tag = compatible.reduce((best, t) => (compareKeys(releaseVersionKey(t), releaseVersionKey(best)) > 0 ? t : best));
  }

  const assetUrl = template.replace("{tag}", encodeURIComponent(tag));
  const parsed = new URL(assetUrl);
  if (parsed.protocol !== "https:" || !parsed.host) throw new Error("The registry entry has an invalid asset URL template.");

  const release: { tag: string; asset_url: string; sha512?: string } = { tag, asset_url: assetUrl };
  if (item.sha512 && typeof item.sha512 === "object") {
    const checksum = item.sha512[tag];
    if (typeof checksum !== "string" || !/^[0-9a-fA-F]{128}$/.test(checksum)) {
      throw new Error(`The registry entry has no valid SHA-512 checksum for release ${tag}.`);
    }
    release.sha512 = checksum.toLowerCase();
  }
  return release;
}

function verifyArchiveChecksum(archivePath: string, expected: string): void {
  const actual = crypto.createHash("sha512").update(fs.readFileSync(archivePath)).digest();
  const want = Buffer.from(expected.toLowerCase(), "hex");
  if (want.length !== actual.length || !crypto.timingSafeEqual(actual, want)) {
    throw new Error("Downloaded package checksum does not match the registry.");
  }
}

// ----------------------------------------------------------- install state --

function installRecords(): Record<string, InstallRecord> {
  const records = utils.readStates()[STATES_KEY];
  return records && typeof records === "object" && !Array.isArray(records) ? records : {};
}

function recordExists(record: InstallRecord): boolean {
  if (record.type === "mod" || record.type === "plugin") return typeof record.path === "string" && mfs.isDir(path.join(absBase(), record.path));
  if (record.type === "theme") {
    return Array.isArray(record.files) && record.files.length > 0 && record.files.every((f) => typeof f === "string" && mfs.isFile(path.join(absBase(), f)));
  }
  return false;
}

export function reconcileInstallStates(): void {
  const records = installRecords();
  const valid = Object.fromEntries(Object.entries(records).filter(([, r]) => r && typeof r === "object" && recordExists(r)));
  if (Object.keys(valid).length !== Object.keys(records).length) utils.writeStates(STATES_KEY, valid);
}

const itemKey = (type: string, name: string) => `${type}:${name}`;

async function enrichEntry(item: RegistryItem, records: Record<string, InstallRecord>) {
  const type = String(item.type ?? "").toLowerCase();
  const name = item.name;
  if (!REGISTRY_TYPES.has(type) || typeof name !== "string" || !name.trim()) return null;

  const key = itemKey(type, name);
  const record = records[key];
  const installed = Boolean(record && Object.keys(record).length);
  const compatible = compatibleVersions(item).includes(base.VERSION);
  if (!compatible && !installed) return null;

  const result: Record<string, unknown> = {
    id: key,
    name,
    type,
    repo: item.repo ?? "",
    preview: item.preview ?? "",
    notes_url: item.notes ?? "",
    manifest_url: item.manifest ?? "",
    compatible_versions: compatibleVersions(item),
    installed,
    installed_tag: record?.tag ?? null,
    installed_compatible: installed && tagIsCompatible(item, record?.tag),
    current_version: base.VERSION,
    latest_tag: null,
    update_available: false,
    available: false,
    error: null,
  };
  if (compatible) {
    try {
      const latest = latestRelease(item);
      result.latest_tag = latest.tag;
      result.available = true;
      result.update_available = installed && result.installed_tag !== latest.tag;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

async function getCatalogue() {
  const records = installRecords();
  const entries = await Promise.all((await getRegistry()).map((i) => enrichEntry(i, records)));
  return entries.filter(Boolean);
}

async function getItemDetails(params: Params) {
  for (const item of await getRegistry()) {
    if (!REGISTRY_TYPES.has(item.type) || typeof item.name !== "string" || itemKey(item.type, item.name) !== params.id) continue;
    let notes = "";
    if (item.notes) {
      const res = await fetch(item.notes, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notes = localization.parseNotesForLocale((await res.text()).slice(0, 100_000), config.get("locale") || "en");
    }
    return { notes, manifest_url: item.manifest ?? "" };
  }
  throw new Error("The registry item no longer exists.");
}

// ------------------------------------------------------------ packaging -----

function safePackageName(name: string): string {
  const devices = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name !== name.trim() ||
    name.endsWith(".") ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    devices.has(name.split(".")[0].toUpperCase())
  ) {
    throw new Error(`Registry name cannot be used as a folder name: ${JSON.stringify(name)}`);
  }
  return name;
}

function unpackZip(archivePath: string, destination: string): void {
  const root = path.resolve(destination);
  let declared = 0;
  const zip = new AdmZip(archivePath);
  for (const entry of zip.getEntries()) {
    const member = entry.entryName.replace(/\\/g, "/");
    const parts = member.split("/").filter((p, i, arr) => !(p === "" && i === arr.length - 1));
    if (member.startsWith("/") || !parts.length || member.includes(":") || parts.some((p) => p === "" || p === "." || p === "..")) {
      throw new Error(`Unsafe path in archive: ${entry.entryName}`);
    }
    const mode = (entry.header.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new Error(`Symbolic links are not allowed in archives: ${entry.entryName}`);
    declared += entry.header.size;
    if (declared > MAX_ARCHIVE_SIZE) throw new Error("Archive contents exceed the 5 GiB extraction limit.");

    const target = path.resolve(root, ...parts);
    if (!isInside(root, target)) throw new Error(`Archive path escapes its destination: ${entry.entryName}`);
    if (entry.isDirectory) mfs.createDirs(target);
    else {
      mfs.createDirs(path.dirname(target));
      fs.writeFileSync(target, entry.getData());
    }
  }
}

function packageRoot(dir: string): string {
  const entries = fs.readdirSync(dir);
  if (entries.length === 1 && mfs.isDir(path.join(dir, entries[0]))) return path.join(dir, entries[0]);
  return dir;
}

const relativeToBase = (p: string) => path.relative(absBase(), p).split(path.sep).join("/");

function recordOwnedFiles(record: InstallRecord): string[] {
  if (!Array.isArray(record.files) || !record.files.every((f) => typeof f === "string")) throw new Error("Saved theme installation record is invalid.");
  const root = path.resolve(base.themesDir);
  return record.files.map((rel) => {
    const target = path.resolve(absBase(), rel);
    if (!isInside(root, target)) throw new Error(`Saved theme path is outside the themes directory: ${rel}`);
    return target;
  });
}

function removeEmptyParents(file: string, root: string): void {
  let parent = path.dirname(file);
  while (isInside(path.resolve(root), path.resolve(parent))) {
    try {
      fs.rmdirSync(parent);
    } catch {
      break;
    }
    parent = path.dirname(parent);
  }
}

function deleteRecordFiles(record: InstallRecord): void {
  if (record.type === "theme") {
    for (const target of recordOwnedFiles(record)) {
      if (mfs.isFile(target)) {
        fs.rmSync(target);
        removeEmptyParents(target, base.themesDir);
      }
    }
    return;
  }
  if (typeof record.path !== "string") throw new Error("Saved package installation record is invalid.");
  const target = path.resolve(absBase(), record.path);
  if (!isInside(rootFor(record.type), target)) throw new Error(`Saved package path is outside its install directory: ${record.path}`);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function themeFiles(sourceRoot: string, name: string): Array<[string, string]> {
  const files: Array<[string, string]> = [...mfs.walk(sourceRoot)].map((src) => [src, path.relative(sourceRoot, src).split(path.sep).join("/")]);
  const stylesheets = files.filter(([, rel]) => rel.toLowerCase().endsWith(".css")).sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()));
  if (!stylesheets.length) throw new Error("Theme archive does not contain a CSS stylesheet.");
  const primary = stylesheets[0][1];
  if (primary.includes("/")) throw new Error("Theme archive must place its main stylesheet at the package root.");
  const canonical = `${safePackageName(name)}.css`;
  const result = files.map(([src, rel]): [string, string] => [src, rel === primary ? canonical : rel]);
  const dests = result.map(([, rel]) => rel.toLowerCase());
  if (dests.length !== new Set(dests).size) throw new Error("Theme archive contains file paths that collide after installation.");
  return result;
}

async function refreshPluginRuntime(): Promise<void> {
  // re-discovers every plugin and runs their onInitialize hooks
  await reloadPlugins();
}

function pluginIdFromRecord(record: InstallRecord): string {
  if (record.plugin_id) return record.plugin_id;
  if (typeof record.path === "string") {
    const manifest = path.join(absBase(), record.path, "manifest.json");
    if (mfs.isFile(manifest)) {
      const id = config.readJsonFile(manifest).id;
      if (typeof id === "string" && id) return id;
    }
  }
  throw new Error("Cannot determine the plugin id for the installed package.");
}

async function installPackage(item: RegistryItem, release: ReturnType<typeof latestRelease>, existing: InstallRecord | null): Promise<InstallRecord> {
  const type = String(item.type ?? "").toLowerCase() as ItemType;
  const name = safePackageName(String(item.name ?? ""));
  const root = rootFor(type);
  mfs.createDirs(root, base.cacheDir);
  const key = itemKey(type, name);
  const records = installRecords();
  const oldRecord = existing ?? records[key] ?? null;
  const target = path.join(root, name);

  const workDir = fs.mkdtempSync(path.join(path.resolve(base.cacheDir), "community-"));
  try {
    const archive = path.join(workDir, "package.zip");
    if (!(await mfs.downloadFile(release.asset_url, archive, { name: `${name} (${release.tag})`, taskId: `community:${key}`, headers: HEADERS }))) {
      throw new Error(`Failed to download ${name} (${release.tag}).`);
    }
    if (release.sha512) verifyArchiveChecksum(archive, release.sha512);
    const extracted = path.join(workDir, "extracted");
    mfs.createDirs(extracted);
    unpackZip(archive, extracted);
    const pkgRoot = packageRoot(extracted);

    if (type === "mod" || type === "plugin") {
      const manifestPath = path.join(pkgRoot, "manifest.json");
      if (!mfs.isFile(manifestPath)) throw new Error(`${type} archive is missing its root manifest.json.`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${type} manifest must contain a JSON object.`);

      let pluginId: string | undefined;
      if (type === "plugin") {
        pluginId = manifest.id;
        if (typeof pluginId !== "string" || !pluginId.trim()) throw new Error("Plugin manifest must declare a non-empty id.");
        if (!mfs.isFile(path.join(pkgRoot, "ui", "index.html"))) throw new Error("Plugin archive is missing ui/index.html.");
        for (const folder of fs.readdirSync(base.pluginsDir)) {
          const other = path.join(base.pluginsDir, folder, "manifest.json");
          if (folder !== name && mfs.isFile(other) && config.readJsonFile(other).id === pluginId) {
            throw new Error(`Another plugin already uses the id ${JSON.stringify(pluginId)}.`);
          }
        }
      }

      if (fs.existsSync(target) && !oldRecord) throw new Error(`Install folder already exists and is not managed by the registry: ${target}`);

      const backup = path.join(workDir, "previous");
      if (oldRecord && fs.existsSync(target)) {
        if (path.resolve(absBase(), String(oldRecord.path ?? "")) !== path.resolve(target)) {
          throw new Error("Saved package path does not match its registry-name folder.");
        }
        fs.renameSync(target, backup);
      }
      try {
        mfs.movePath(pkgRoot, target);
        if (type === "mod") {
          modsShared.setState(name, true);
          modsShared.scanMods();
        }
      } catch (err) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(backup)) fs.renameSync(backup, target);
        throw err;
      }
      records[key] = { type, name, repo: item.repo ?? "", tag: release.tag, path: relativeToBase(target) };
      if (pluginId) records[key].plugin_id = pluginId;
    } else {
      const install = themeFiles(pkgRoot, name);
      const oldFiles = oldRecord ? recordOwnedFiles(oldRecord) : [];
      const oldSet = new Set(oldFiles.map((f) => path.normalize(f).toLowerCase()));
      const themesRoot = path.resolve(base.themesDir);
      const planned = install.map(([src, rel]): [string, string] => {
        const dest = path.resolve(themesRoot, ...rel.split("/"));
        if (!isInside(themesRoot, dest)) throw new Error(`Theme archive path escapes the themes directory: ${rel}`);
        if (fs.existsSync(dest) && !oldSet.has(path.normalize(dest).toLowerCase())) {
          throw new Error(`Theme file already exists; refusing to overwrite it: ${dest}`);
        }
        return [src, dest];
      });

      const backupDir = path.join(workDir, "previous-theme-files");
      mfs.createDirs(backupDir);
      const backedUp = new Map<string, string>();
      oldFiles.forEach((f, i) => {
        if (mfs.isFile(f)) {
          const b = path.join(backupDir, String(i));
          fs.copyFileSync(f, b);
          backedUp.set(f, b);
        }
      });
      const removed: string[] = [];
      const created: string[] = [];
      try {
        for (const f of oldFiles) {
          if (mfs.isFile(f)) {
            fs.rmSync(f);
            removed.push(f);
          }
        }
        for (const [src, dest] of planned) {
          mfs.createDirs(path.dirname(dest));
          fs.copyFileSync(src, dest);
          created.push(dest);
        }
      } catch (err) {
        for (const d of created) if (mfs.isFile(d)) fs.rmSync(d);
        for (const f of removed) {
          mfs.createDirs(path.dirname(f));
          fs.copyFileSync(backedUp.get(f)!, f);
        }
        throw err;
      }
      for (const f of oldFiles) removeEmptyParents(f, base.themesDir);
      records[key] = { type, name, repo: item.repo ?? "", tag: release.tag, files: planned.map(([, d]) => relativeToBase(d)) };
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  utils.writeStates(STATES_KEY, records);
  if (type === "plugin") await refreshPluginRuntime();
  return records[key];
}

async function findCompatibleItem(id: unknown): Promise<RegistryItem> {
  for (const item of await getRegistry()) {
    if (!REGISTRY_TYPES.has(item.type) || typeof item.name !== "string" || itemKey(item.type, item.name) !== id) continue;
    if (!compatibleVersions(item).includes(base.VERSION)) throw new Error(`This item does not support Minify ${base.VERSION}.`);
    return item;
  }
  throw new Error("The registry item no longer exists.");
}

async function installItem(params: Params) {
  if (installRecords()[params.id]) throw new Error("This item is already installed. Use Update or Uninstall.");
  const item = await findCompatibleItem(params.id);
  return { success: true, installed: await installPackage(item, latestRelease(item), null) };
}

async function updateItem(params: Params) {
  const existing = installRecords()[params.id];
  if (!existing || typeof existing !== "object") throw new Error("This item is not installed.");
  const item = await findCompatibleItem(params.id);
  const release = latestRelease(item);
  if (release.tag === existing.tag) throw new Error("This item is already up to date.");
  return { success: true, installed: await installPackage(item, release, existing) };
}

async function uninstallItem(params: Params) {
  const records = installRecords();
  const record = records[params.id];
  if (!record || typeof record !== "object" || !REGISTRY_TYPES.has(record.type)) throw new Error("This item is not installed by the community registry.");
  const pluginId = record.type === "plugin" ? pluginIdFromRecord(record) : null;
  deleteRecordFiles(record);
  delete records[params.id];
  utils.writeStates(STATES_KEY, records);

  if (record.type === "mod") {
    modsShared.setState(record.name, false);
    modsShared.scanMods();
  } else if (record.type === "theme" && config.get("theme") === safePackageName(record.name)) {
    config.set("theme", "light");
  } else if (record.type === "plugin" && pluginId) {
    await refreshPluginRuntime();
  }
  return { success: true };
}

const ROUTES: Record<string, (params: Params) => Promise<unknown>> = {
  get_catalogue: getCatalogue,
  get_item_details: getItemDetails,
  install_item: installItem,
  update_item: updateItem,
  uninstall_item: uninstallItem,
};

export function handleApi(action: string, params: Params = {}): Promise<unknown> {
  const route = ROUTES[action];
  if (!route) throw new Error(`Unknown community registry action: ${action}`);
  return route(params ?? {});
}
