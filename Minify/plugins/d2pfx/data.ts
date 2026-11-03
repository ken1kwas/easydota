import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { base, config, fs as mfs, output, utils } from "@minify/sdk";

// D2PFX browser data sources
const BASE_URL = "https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/data/";
const ASSETS_URL = "https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/files/";
const PREVIEWS_URL = "https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/previews/";

// Hugging Face fallback
const HF_DATA_URL = "https://huggingface.co/datasets/hrdq/Dota2PornFx/resolve/data/data/";
const HF_ASSETS_URL = "https://huggingface.co/datasets/hrdq/Dota2PornFx/resolve/main/assets/files/";
const HF_PREVIEWS_URL = "https://huggingface.co/datasets/hrdq/Dota2PornFx/resolve/main/assets/previews/";

const URL_FALLBACK_MAP: Array<[string, string]> = [
  [ASSETS_URL, HF_ASSETS_URL],
  [PREVIEWS_URL, HF_PREVIEWS_URL],
];

export const CACHE_DIR = path.join(base.cacheDir, "plugins", "d2pfx");
const BLACKLIST = ["guides", "item-sounds", "news", "optimization", "tools", "sites", "packs", "fonts", "huds"];
const REACHABILITY_TTL_MS = 60_000;

const hostReachable = new Map<string, [boolean, number]>();
const notifiedHosts = new Set<string>();

export type D2Mod = Record<string, any>;

export class DataManager {
  readonly cacheDir = CACHE_DIR;
  metadata: Record<string, any> | null = {};
  constants: Record<string, any> | null = {};

  constructor() {
    mfs.createDirs(this.cacheDir);
  }

  static toHfFallback(url?: string | null): string | null {
    if (!url) return null;
    for (const [gh, hf] of URL_FALLBACK_MAP) if (url.startsWith(gh)) return hf + url.slice(gh.length);
    return null;
  }

  static async isUrlReachable(url: string, timeoutMs = 3000): Promise<boolean> {
    const host = new URL(url).host;
    const cached = hostReachable.get(host);
    if (cached && Date.now() - cached[1] < REACHABILITY_TTL_MS) return cached[0];
    let reachable = false;
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    hostReachable.set(host, [reachable, Date.now()]);
    return reachable;
  }

  static notifyFallbackOnce(ghUrl: string): void {
    const host = new URL(ghUrl).host;
    if (notifiedHosts.has(host)) return;
    notifiedHosts.add(host);
    output.addText(`${host} unreachable, D2PFX is using the Hugging Face mirror`, { msgType: "info" });
  }

  async downloadFile(url: string, dest: string, opts: { name?: string; emitProgress?: boolean; fallbackUrl?: string | null } = {}): Promise<boolean> {
    const fallback = opts.fallbackUrl ?? DataManager.toHfFallback(url);
    const useFallback = Boolean(fallback && fallback !== url);
    let ok = false;
    if (!(useFallback && !(await DataManager.isUrlReachable(url)))) {
      ok = await mfs.downloadFile(url, dest, { name: opts.name, emitProgress: opts.emitProgress ?? true });
    }
    if (!ok && useFallback) {
      DataManager.notifyFallbackOnce(url);
      ok = await mfs.downloadFile(fallback!, dest, { name: opts.name, emitProgress: opts.emitProgress ?? true });
    }
    return ok;
  }

  async fetchGzJson(filename: string, forceRefresh = false): Promise<Record<string, any> | null> {
    const localPath = path.join(this.cacheDir, filename.replace(".gz", ""));
    const ghUrl = `${BASE_URL}data/${filename}`;
    const hfUrl = `${HF_DATA_URL}${filename}`;

    if (!forceRefresh && fs.existsSync(localPath)) {
      try {
        return JSON.parse(fs.readFileSync(localPath, "utf8"));
      } catch {
        /* refetch */
      }
    }

    let candidates: string[];
    if (await DataManager.isUrlReachable(ghUrl)) candidates = [ghUrl, hfUrl];
    else {
      DataManager.notifyFallbackOnce(ghUrl);
      candidates = [hfUrl];
    }

    for (const url of candidates) {
      let body: Buffer;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(String(res.status));
        body = Buffer.from(await res.arrayBuffer());
      } catch {
        if (url === ghUrl) DataManager.notifyFallbackOnce(ghUrl);
        continue;
      }
      try {
        const data = JSON.parse(zlib.gunzipSync(body).toString("utf8"));
        fs.writeFileSync(localPath, JSON.stringify(data, null, 2), "utf8");
        return data;
      } catch {
        continue; // decompression, parsing, or local write failed; try the next candidate
      }
    }
    output.addText(`D2PFX: Unable to download ${filename} from either GitHub or Hugging Face`, { msgType: "error" });
    return null;
  }

  async refresh(): Promise<boolean> {
    this.metadata = await this.fetchGzJson("mods.json.gz", true);
    this.constants = await this.fetchGzJson("constants.json.gz", true);
    if (this.metadata !== null) utils.setState("d2pfx", "last_refresh", Math.floor(Date.now() / 1000));
    return this.metadata !== null;
  }

  private needsRefresh(): boolean {
    if (!config.get("d2pfx_auto_refresh_catalogue", true)) return false;
    const last = Number(utils.getState("d2pfx", "last_refresh", 0));
    return Date.now() / 1000 - last > 21600;
  }

  async load(): Promise<boolean> {
    if (this.needsRefresh()) await this.refresh();
    this.metadata = await this.fetchGzJson("mods.json.gz");
    this.constants = await this.fetchGzJson("constants.json.gz");
    return this.metadata !== null;
  }

  getCategories(): string[] {
    const cats: unknown[] = this.constants?.categories ?? [];
    return cats
      .filter((c): c is Record<string, any> => typeof c === "object" && c !== null)
      .filter((c) => c.id && !c.hidden && !BLACKLIST.includes(String(c.id).toLowerCase()))
      .map((c) => String(c.id));
  }

  private translation(key: string, locale: string): string | null {
    const translations = this.constants?.translations ?? {};
    const localized = translations[locale];
    if (localized && typeof localized[key] === "string") return localized[key];
    if (typeof translations[key] === "string") return translations[key];
    if (typeof this.constants?.[key] === "string") return this.constants[key];
    return null;
  }

  getCategoryName(catId: string): string {
    return this.translation(catId, config.get("locale", "en")) ?? catId.charAt(0).toUpperCase() + catId.slice(1).toLowerCase();
  }

  getCategoryDescription(catId: string): string {
    return this.translation(`${catId}-desc`, config.get("locale", "en")) ?? "";
  }

  getMods(catId: string): D2Mod[] {
    if (!this.metadata) return [];
    const flattened: D2Mod[] = [];
    const flatten = (item: unknown): void => {
      if (Array.isArray(item)) item.forEach(flatten);
      else if (item && typeof item === "object") {
        const obj = item as D2Mod;
        if ("groups" in obj) flatten(obj.groups);
        else if ("mods" in obj) flatten(obj.mods);
        else if ("name" in obj) {
          const links: D2Mod[] = Array.isArray(obj.links) ? obj.links : [];
          for (const [key, types] of [
            ["author", ["author", "modded"]],
            ["sender", ["sender"]],
          ] as const) {
            const vals = links.filter((l) => (types as readonly string[]).includes(l.type)).map((l) => l.name || l.url).filter(Boolean);
            obj[key] = vals.length === 1 ? vals[0] : vals.length ? vals : null;
          }
          flattened.push(obj);
        } else {
          Object.values(obj).forEach((v) => typeof v === "object" && flatten(v));
        }
      }
    };
    flatten(this.metadata.modsData?.[catId] ?? []);
    return flattened;
  }

  getPreviewUrl(catId: string, filename?: string | null): string | null {
    return filename ? `${PREVIEWS_URL}${catId}/${filename}` : null;
  }

  getFileUrl(catId: string, filename: string): string {
    return `${ASSETS_URL}${catId}/${filename}`;
  }
}
