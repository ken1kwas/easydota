// Filesystem access

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import AdmZip from "adm-zip";
import * as tar from "tar";

import * as base from "./base";
import * as output from "./output";
import { launchDetached, run, shlexSplit } from "./proc";

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** Recursively yields every file below `dir` (os.walk flattened). */
export function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

/** Opens files or directories in their registered applications. */
export function openThing(target: string, args = ""): void {
  try {
    if (args) {
      if (base.isWin) {
        launchDetached(target, shlexSplit(args));
        return;
      }
      try {
        fs.accessSync(target, fs.constants.X_OK);
        if (isFile(target)) {
          launchDetached(target, shlexSplit(args));
          return;
        }
      } catch {
        /* fall through */
      }
      target = path.dirname(target) || ".";
    }

    if (!exists(target)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    if (base.isWin) launchDetached("explorer.exe", [path.resolve(target)]);
    else if (base.isMac) launchDetached("open", isDir(target) ? [target] : ["-R", target]);
    else launchDetached("xdg-open", [target]);
  } catch {
    output.addText("&open_thing_fail", [target], { msgType: "error" });
  }
}

function makeWritable(p: string): void {
  try {
    const st = fs.statSync(p);
    fs.chmodSync(p, st.mode | 0o200);
    if (st.isDirectory()) for (const child of fs.readdirSync(p)) makeWritable(path.join(p, child));
  } catch {
    /* ignore */
  }
}

/** Superset of `shutil.move` handling permissions for moving and renaming. */
export function movePath(src: string, dst: string): void {
  const attempt = () => {
    try {
      fs.renameSync(src, dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        fs.cpSync(src, dst, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  };
  try {
    attempt();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log(`Skipped move of: ${src} (not found)`);
      return;
    }
    if (code === "EPERM" || code === "EACCES") {
      makeWritable(src);
      if (exists(dst)) makeWritable(dst);
      try {
        attempt();
      } catch {
        require("./log").writeWarning();
      }
      return;
    }
    throw err;
  }
}

/** Superset of `shutil.rmtree` & `os.remove` handling permissions. */
export function removePath(...paths: string[]): void {
  for (const p of paths) {
    if (!p) continue;
    if (!fs.existsSync(p)) {
      console.log(`Skipped deletion of: ${p}`);
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        makeWritable(p);
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          require("./log").writeWarning();
        }
      } else {
        throw err;
      }
    }
  }
}

/** Recursively creates directories (like mkdir -p). Skips empty paths. */
export function createDirs(...paths: string[]): void {
  for (const p of paths) if (p) fs.mkdirSync(p, { recursive: true });
}

/** `shutil.copytree(src, dst, dirs_exist_ok=True)` */
export function copyTree(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

export function copyFile(src: string, dst: string): void {
  if (isDir(dst)) dst = path.join(dst, path.basename(src));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** Moves the entire contents of source into backup. No-op if backup already exists. */
export function backupDirectory(source: string, backup: string): void {
  if (exists(backup)) return;
  createDirs(backup);
  for (const name of listDir(source)) movePath(path.join(source, name), path.join(backup, name));
}

/** Restores contents from backup into source, then removes backup. */
export function restoreDirectory(source: string, backup: string): void {
  if (!exists(backup)) return;
  for (const name of listDir(source)) removePath(path.join(source, name));
  for (const name of listDir(backup)) movePath(path.join(backup, name), path.join(source, name));
  removePath(backup);
  const parent = path.dirname(backup);
  if (exists(parent) && listDir(parent).length === 0) removePath(parent);
}

export interface DownloadOptions {
  progressTag?: boolean;
  name?: string;
  emitProgress?: boolean;
  taskId?: string;
  headers?: Record<string, string>;
}

/** Downloads `url` to `targetPath`, emitting progress events for the UI. */
export async function downloadFile(url: string, targetPath: string, opts: DownloadOptions = {}): Promise<boolean> {
  const fileName = opts.name ?? path.basename(targetPath);
  const taskId = opts.taskId ?? targetPath;
  const emit = opts.emitProgress ?? true;

  const report = (downloaded: number, total: number) => {
    const dl = (downloaded / 1048576).toFixed(2);
    output.addText(total > 0 ? `Downloading: ${dl}/${(total / 1048576).toFixed(2)} MB` : `Downloading: ${dl} MB`);
  };

  try {
    const response = await fetch(url, { headers: { "User-Agent": "dota2-minify", ...opts.headers }, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    let downloaded = 0;
    let lastReport = 0;

    if (emit) output.emitDownloadProgress(taskId, fileName, 0, total, "downloading");
    createDirs(path.dirname(targetPath));

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 100) {
          if (emit) output.emitDownloadProgress(taskId, fileName, downloaded, total, "downloading");
          if (opts.progressTag) report(downloaded, total);
          lastReport = now;
        }
        cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body as any), counter, fs.createWriteStream(targetPath));

    if (emit) output.emitDownloadProgress(taskId, fileName, downloaded, total, "finished");
    if (opts.progressTag) report(downloaded, total);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (emit) output.emitDownloadProgress(taskId, fileName, 0, 0, "error", msg);
    output.addText(`Failed to open ${targetPath}: ${msg}`, { msgType: "error" });
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Extracts a zip or tar.gz archive. If `targetFile` is given only that entry is extracted.
 * Entries escaping `extractDir` are skipped.
 */
export async function extractArchive(archivePath: string, extractDir = ".", targetFile?: string): Promise<boolean> {
  try {
    const root = path.resolve(extractDir);
    createDirs(root);
    if (archivePath.endsWith(".zip")) {
      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        const name = entry.entryName.replace(/\\/g, "/");
        if (targetFile && name !== targetFile) continue;
        const dest = path.resolve(root, name);
        if (!isInside(root, dest)) continue;
        if (entry.isDirectory) {
          createDirs(dest);
        } else {
          createDirs(path.dirname(dest));
          fs.writeFileSync(dest, entry.getData());
        }
      }
    } else if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
      await tar.x({
        file: archivePath,
        cwd: root,
        filter: (p) => isInside(root, path.resolve(root, p)) && (!targetFile || p.replace(/\\/g, "/") === targetFile),
      });
    } else {
      output.addText(`Unsupported archive format: ${archivePath}`, { msgType: "error" });
      return false;
    }
    return true;
  } catch (err) {
    output.addText(`Extraction failed: ${err instanceof Error ? err.message : err}`, { msgType: "error" });
    return false;
  }
}

/**
 * Identifies the file type by magic bytes (.png, .jpg, .webp, .webm, .mp4, .gif), falling back to
 * the extension from the first dot in the filename.
 */
export function getFileType(p: string): string | null {
  try {
    if (!exists(p)) return null;
    const fd = fs.openSync(p, "r");
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    const starts = (bytes: number[] | string, offset = 0) => {
      const b = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
      return header.subarray(offset, offset + b.length).equals(b);
    };
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
    if (starts([0xff, 0xd8, 0xff])) return ".jpg";
    if (starts("RIFF") && starts("WEBP", 8)) return ".webp";
    if (starts([0x1a, 0x45, 0xdf, 0xa3])) return ".webm";
    if (starts("ftyp", 4)) return ".mp4";
    if (starts("GIF87a") || starts("GIF89a")) return ".gif";
  } catch {
    /* fall back */
  }
  const name = path.basename(p);
  const dot = name.indexOf(".");
  return dot !== -1 ? name.slice(dot) : name;
}

export async function readText(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

export { run };
