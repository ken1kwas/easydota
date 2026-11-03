// Valve Pak (VPK v1/v2) reader and writer. Replaces the `vpk` python package.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const VPK_SIGNATURE = 0x55aa1234;
const EMBEDDED_ARCHIVE = 0x7fff;
export const DEFAULT_VPK_CHUNK_SIZE = 100 * 1024 * 1024;
const VPK_ARCHIVE_MD5_CHUNK_SIZE = 1024 * 1024;

// ----------------------------------------------------------------- crc32 ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- reader ---

interface VpkEntry {
  crc: number;
  preload: Buffer | null;
  archiveIndex: number;
  offset: number;
  length: number;
}

export class VpkFile {
  readonly version: number;
  private readonly entries = new Map<string, VpkEntry>();
  private readonly headerLength: number;
  private readonly treeLength: number;
  private readonly archivePrefix: string;
  private readonly fds = new Map<number, number>();

  private constructor(readonly vpkPath: string) {
    const fd = fs.openSync(vpkPath, "r");
    try {
      const head = Buffer.alloc(28);
      fs.readSync(fd, head, 0, 28, 0);
      if (head.readUInt32LE(0) !== VPK_SIGNATURE) throw new Error(`Not a VPK file: ${vpkPath}`);
      this.version = head.readUInt32LE(4);
      this.treeLength = head.readUInt32LE(8);
      if (this.version === 1) this.headerLength = 12;
      else if (this.version === 2) this.headerLength = 28;
      else throw new Error(`Unsupported VPK version ${this.version}`);

      const tree = Buffer.alloc(this.treeLength);
      fs.readSync(fd, tree, 0, this.treeLength, this.headerLength);
      this.parseTree(tree);
    } finally {
      fs.closeSync(fd);
    }
    const base = vpkPath.replace(/\.vpk$/i, "");
    this.archivePrefix = base.endsWith("_dir") ? base.slice(0, -4) : base;
  }

  static open(vpkPath: string): VpkFile {
    return new VpkFile(vpkPath);
  }

  private parseTree(tree: Buffer): void {
    let pos = 0;
    const readStr = (): string => {
      const end = tree.indexOf(0, pos);
      if (end === -1) throw new Error("Malformed VPK tree");
      const s = tree.toString("utf8", pos, end);
      pos = end + 1;
      return s;
    };

    for (;;) {
      const ext = readStr();
      if (!ext) break;
      for (;;) {
        let dir = readStr();
        if (!dir) break;
        if (dir === " ") dir = "";
        for (;;) {
          const name = readStr();
          if (!name) break;
          const crc = tree.readUInt32LE(pos);
          const preloadLength = tree.readUInt16LE(pos + 4);
          const archiveIndex = tree.readUInt16LE(pos + 6);
          const offset = tree.readUInt32LE(pos + 8);
          const length = tree.readUInt32LE(pos + 12);
          pos += 18; // includes 0xffff terminator
          const preload = preloadLength ? Buffer.from(tree.subarray(pos, pos + preloadLength)) : null;
          pos += preloadLength;

          const fileName = ext === " " ? name : `${name}.${ext}`;
          this.entries.set(dir ? `${dir}/${fileName}` : fileName, { crc, preload, archiveIndex, offset, length });
        }
      }
    }
  }

  /** Iterates over every file path in the archive. */
  [Symbol.iterator](): IterableIterator<string> {
    return this.entries.keys();
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  private archiveFd(index: number): number {
    let fd = this.fds.get(index);
    if (fd === undefined) {
      const file = index === EMBEDDED_ARCHIVE ? this.vpkPath : `${this.archivePrefix}_${String(index).padStart(3, "0")}.vpk`;
      fd = fs.openSync(file, "r");
      this.fds.set(index, fd);
    }
    return fd;
  }

  /** Returns the file contents, or null when the path is not in the archive. */
  read(filePath: string): Buffer | null {
    const entry = this.entries.get(filePath);
    if (!entry) return null;
    const parts: Buffer[] = [];
    if (entry.preload) parts.push(entry.preload);
    if (entry.length > 0) {
      const buf = Buffer.alloc(entry.length);
      const position =
        entry.archiveIndex === EMBEDDED_ARCHIVE ? this.headerLength + this.treeLength + entry.offset : entry.offset;
      fs.readSync(this.archiveFd(entry.archiveIndex), buf, 0, entry.length, position);
      parts.push(buf);
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Writes a file from the archive to `dest`. Returns false if missing. */
  save(filePath: string, dest: string): boolean {
    const data = this.read(filePath);
    if (data === null) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    return true;
  }

  close(): void {
    for (const fd of this.fds.values()) fs.closeSync(fd);
    this.fds.clear();
  }
}

// ---------------------------------------------------------------- writer ---

interface PackEntry {
  name: string;
  absPath: string;
  crc: number;
  archiveIndex: number;
  offset: number;
  length: number;
}

function* walkFiles(root: string, rel = ""): Generator<[string, string]> {
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(root, childRel);
    else if (entry.isFile()) yield [rel, entry.name];
  }
}

/**
 * Packs `sourceDir` into a VPK v2 archive (e.g. pak66_dir.vpk + pak66_000.vpk, ...).
 * Each external archive is capped at `chunkSize` bytes. When `chunkSize` is null the file
 * data is embedded in the directory VPK.
 */
export async function pack(sourceDir: string, outputVpkDirPath: string, chunkSize: number | null = DEFAULT_VPK_CHUNK_SIZE): Promise<void> {
  const baseName = outputVpkDirPath.replace(/\.vpk$/i, "");
  const chunkPrefix = baseName.endsWith("_dir") ? baseName.slice(0, -4) : baseName;
  const outputDir = path.dirname(outputVpkDirPath) || ".";
  fs.mkdirSync(outputDir, { recursive: true });

  // Clean up any existing dir and chunk files for this prefix
  const prefixFilename = path.basename(chunkPrefix);
  for (const item of fs.readdirSync(outputDir)) {
    if (item.startsWith(`${prefixFilename}_`) && item.endsWith(".vpk")) fs.rmSync(path.join(outputDir, item), { force: true });
  }

  // ext -> relpath -> entries
  const tree = new Map<string, Map<string, PackEntry[]>>();
  for (const [relDir, filename] of walkFiles(sourceDir)) {
    const rel = relDir || " ";
    const dot = filename.lastIndexOf(".");
    const [name, ext] = dot === -1 ? [filename, " "] : [filename.slice(0, dot), filename.slice(dot + 1)];
    if (!tree.has(ext)) tree.set(ext, new Map());
    const byDir = tree.get(ext)!;
    if (!byDir.has(rel)) byDir.set(rel, []);
    byDir.get(rel)!.push({ name, absPath: path.join(sourceDir, relDir, filename), crc: 0, archiveIndex: 0, offset: 0, length: 0 });
  }

  let treeLength = 1;
  for (const [ext, byDir] of tree) {
    treeLength += Buffer.byteLength(ext) + 2;
    for (const [rel, entries] of byDir) {
      treeLength += Buffer.byteLength(rel) + 2;
      for (const e of entries) treeLength += Buffer.byteLength(e.name) + 1 + 18;
    }
  }

  const HEADER_LENGTH = 28;
  const embedded = chunkSize === null;
  const embeddedDataOffset = HEADER_LENGTH + treeLength;
  let chunkIdx = embedded ? EMBEDDED_ARCHIVE : 0;
  let chunkBytes = 0;
  let writePos = embedded ? embeddedDataOffset : 0;
  const chunkPath = (idx: number) => `${chunkPrefix}_${String(idx).padStart(3, "0")}.vpk`;

  let handle = await fsp.open(embedded ? outputVpkDirPath : chunkPath(chunkIdx), "w+");
  try {
    for (const byDir of tree.values()) {
      for (const entries of byDir.values()) {
        for (const e of entries) {
          const data = await fsp.readFile(e.absPath);
          if (!embedded && chunkBytes > 0 && chunkBytes + data.length > chunkSize!) {
            await handle.close();
            chunkIdx++;
            chunkBytes = 0;
            writePos = 0;
            handle = await fsp.open(chunkPath(chunkIdx), "w+");
          }
          e.crc = crc32(data);
          e.archiveIndex = chunkIdx;
          e.offset = embedded ? writePos - embeddedDataOffset : writePos;
          e.length = data.length;
          await handle.write(data, 0, data.length, writePos);
          writePos += data.length;
          chunkBytes += data.length;
        }
      }
    }
  } finally {
    await handle.close();
  }

  // archive md5 section (external chunks only)
  const md5Entries: Buffer[] = [];
  if (!embedded) {
    for (let idx = 0; idx <= chunkIdx; idx++) {
      const data = await fsp.readFile(chunkPath(idx));
      for (let off = 0; off < data.length; off += VPK_ARCHIVE_MD5_CHUNK_SIZE) {
        const slice = data.subarray(off, off + VPK_ARCHIVE_MD5_CHUNK_SIZE);
        const rec = Buffer.alloc(28);
        rec.writeUInt16LE(idx, 0);
        rec.writeUInt16LE(0, 2);
        rec.writeUInt32LE(off, 4);
        rec.writeUInt32LE(slice.length, 8);
        crypto.createHash("md5").update(slice).digest().copy(rec, 12);
        md5Entries.push(rec);
      }
    }
  }
  const archiveMd5 = Buffer.concat(md5Entries);

  // tree bytes
  const treeBuf = Buffer.alloc(treeLength);
  let p = 0;
  const writeStr = (s: string) => {
    p += treeBuf.write(s, p, "utf8");
    treeBuf[p++] = 0;
  };
  for (const [ext, byDir] of tree) {
    writeStr(ext);
    for (const [rel, entries] of byDir) {
      writeStr(rel);
      for (const e of entries) {
        writeStr(e.name);
        treeBuf.writeUInt32LE(e.crc, p);
        treeBuf.writeUInt16LE(0, p + 4);
        treeBuf.writeUInt16LE(e.archiveIndex, p + 6);
        treeBuf.writeUInt32LE(e.offset, p + 8);
        treeBuf.writeUInt32LE(e.length, p + 12);
        treeBuf.writeUInt16LE(0xffff, p + 16);
        p += 18;
      }
      treeBuf[p++] = 0;
    }
    treeBuf[p++] = 0;
  }
  treeBuf[p++] = 0;
  if (p !== treeLength) throw new Error(`Tree length mismatch: expected ${treeLength}, got ${p}`);

  const embedChunkLength = embedded ? chunkBytes : 0;
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32LE(VPK_SIGNATURE, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(treeLength, 8);
  header.writeUInt32LE(embedChunkLength, 12);
  header.writeUInt32LE(archiveMd5.length, 16);
  header.writeUInt32LE(48, 20);
  header.writeUInt32LE(0, 24);

  const dirHandle = await fsp.open(outputVpkDirPath, embedded ? "r+" : "w+");
  try {
    await dirHandle.write(header, 0, HEADER_LENGTH, 0);
    await dirHandle.write(treeBuf, 0, treeLength, HEADER_LENGTH);
    const md5Pos = HEADER_LENGTH + treeLength + embedChunkLength;
    if (archiveMd5.length) await dirHandle.write(archiveMd5, 0, archiveMd5.length, md5Pos);

    const treeChecksum = crypto.createHash("md5").update(treeBuf).digest();
    const archiveMd5Checksum = crypto.createHash("md5").update(archiveMd5).digest();
    const dataLength = md5Pos + archiveMd5.length;

    const fileHash = crypto.createHash("md5");
    const block = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < dataLength; ) {
      const want = Math.min(block.length, dataLength - pos);
      const { bytesRead } = await dirHandle.read(block, 0, want, pos);
      if (!bytesRead) break;
      fileHash.update(block.subarray(0, bytesRead));
      pos += bytesRead;
    }
    fileHash.update(treeChecksum);
    fileHash.update(archiveMd5Checksum);

    const trailer = Buffer.concat([treeChecksum, archiveMd5Checksum, fileHash.digest()]);
    await dirHandle.write(trailer, 0, trailer.length, dataLength);
  } finally {
    await dirHandle.close();
  }
}

/** Equivalent of `vpk.new(dir).save(path)`: a single self-contained VPK. */
export function packSingle(sourceDir: string, outputPath: string): Promise<void> {
  return pack(sourceDir, outputPath, null);
}
