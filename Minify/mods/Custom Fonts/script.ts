import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { base, config, fs as mfs, output, steam, utils, type ScriptContext } from "@minify/sdk";

const dotaFontsPath = () => path.join(steam.LIBRARY, "steamapps", "common", "dota 2 beta", "game", "dota", "panorama", "fonts");
const backupPath = path.join(base.baseDir, "backup", path.basename(__dirname));

// file -> [family, full name, postscript name]
const REPLACE_MAP: Record<string, [string, string, string]> = {
  "radiance-black.otf": ["Radiance Black", "Radiance Black", "Radiance-Black"],
  "radiance-blackitalic.otf": ["Radiance Black", "Radiance Black Italic", "Radiance-BlackItalic"],
  "radiance-bold.otf": ["Radiance", "Radiance Bold", "Radiance-Bold"],
  "radiance-bolditalic.otf": ["Radiance", "Radiance Bold Italic", "Radiance-BoldItalic"],
  "radiance-light.otf": ["Radiance", "Radiance Light", "Radiance-Light"],
  "radiance-lightitalic.otf": ["Radiance", "Radiance Light Italic", "Radiance-LightItalic"],
  "radiance-regular.otf": ["Radiance", "Radiance Regular", "Radiance-Regular"],
  "radiance-regularitalic.otf": ["Radiance", "Radiance Regular Italic", "Radiance-RegularItalic"],
  "radiance-semibold.otf": ["Radiance Semibold", "Radiance Semibold", "Radiance-Semibold"],
  "radiance-semibolditalic.otf": ["Radiance Semibold", "Radiance Semibold Italic", "Radiance-SemiboldItalic"],
  "radiance-ultralight.otf": ["Radiance UltraLight", "Radiance UltraLight", "Radiance-UltraLight"],
  "radiance-ultralightitalic.otf": ["Radiance", "Radiance UltraLight Italic", "Radiance-UltraLightItalic"],
  "radiancem-black.otf": ["RadianceM Black", "RadianceM Black", "RadianceM-Black"],
  "radiancem-blackitalic.otf": ["RadianceM Black", "RadianceM Black Italic", "RadianceM-BlackItalic"],
  "radiancem-bold.otf": ["RadianceM", "RadianceM Bold", "RadianceM-Bold"],
  "radiancem-bolditalic.otf": ["RadianceM", "RadianceM Bold Italic", "RadianceM-BoldItalic"],
  "radiancem-italic.otf": ["RadianceM", "RadianceM Italic", "RadianceM-Italic"],
  "radiancem-light.otf": ["RadianceM", "RadianceM Light", "RadianceM-Light"],
  "radiancem-lightitalic.otf": ["RadianceM", "RadianceM Light Italic", "RadianceM-LightItalic"],
  "radiancem-regular.otf": ["RadianceM", "RadianceM Regular", "RadianceM-Regular"],
  "radiancem-regularitalic.otf": ["RadianceM", "RadianceM Regular Italic", "RadianceM-RegularItalic"],
  "radiancem-semibold.otf": ["RadianceM Semibold", "RadianceM Semibold", "RadianceM-Semibold"],
  "radiancem-semibolditalic.otf": ["RadianceM Semibold", "RadianceM Semibold Italic", "RadianceM-SemiboldItalic"],
  "radiancem-ultralight.otf": ["RadianceM UltraLight", "RadianceM UltraLight", "RadianceM-UltraLight"],
  "reaver-black.otf": ["Reaver Black", "Reaver Black", "Reaver-Black"],
  "reaver-bold.otf": ["Reaver", "Reaver Bold", "Reaver-Bold"],
  "reaver-light.otf": ["Reaver Light", "Reaver Light", "Reaver-Light"],
  "reaver-regular.otf": ["Reaver", "Reaver Regular", "Reaver-Regular"],
  "reaver-semibold.otf": ["Reaver SemiBold", "Reaver SemiBold", "Reaver-SemiBold"],
};

const FONT_EXTENSIONS = [".otf", ".ttf"];

/** Rewrites the OpenType `name` table (IDs 1, 4, 6 for Windows platform) and clears OS/2 fsType. */
export function getPatchedFontData(source: Buffer, family: string, fullname: string, postscript: string): Buffer {
  const patches: Record<number, string> = { 1: family, 4: fullname, 6: postscript };
  let data = Buffer.from(source);

  const numTables = data.readUInt16BE(4);
  const tableDir = 12;
  let nameOffset: number | null = null;
  let nameLength = 0;
  let os2Offset: number | null = null;

  for (let i = 0; i < numTables; i++) {
    const entry = tableDir + i * 16;
    const tag = data.toString("latin1", entry, entry + 4);
    if (tag === "name") {
      nameOffset = data.readUInt32BE(entry + 8);
      nameLength = data.readUInt32BE(entry + 12);
    } else if (tag === "OS/2") {
      os2Offset = data.readUInt32BE(entry + 8);
    }
  }

  if (os2Offset !== null) data.writeUInt16BE(0, os2Offset + 8);
  if (nameOffset === null) return data;

  const count = data.readUInt16BE(nameOffset + 2);
  const stringsBase = nameOffset + data.readUInt16BE(nameOffset + 4);
  const records: Array<[number, number, number, number, Buffer]> = [];

  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const [platformId, encId, langId, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => data.readUInt16BE(r + o));
    let s = data.subarray(stringsBase + offset, stringsBase + offset + length);
    if (nameId in patches && platformId === 3) s = Buffer.from(patches[nameId], "utf16le").swap16(); // UTF-16BE
    records.push([platformId, encId, langId, nameId, Buffer.from(s)]);
  }

  const recBuf = Buffer.alloc(records.length * 12);
  const strParts: Buffer[] = [];
  let strLen = 0;
  records.forEach(([p, e, l, n, s], i) => {
    [p, e, l, n, s.length, strLen].forEach((v, j) => recBuf.writeUInt16BE(v, i * 12 + j * 2));
    strParts.push(s);
    strLen += s.length;
  });

  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(6 + records.length * 12, 4);
  let newTable = Buffer.concat([head, recBuf, ...strParts]);
  const pad = (4 - (newTable.length % 4)) % 4;
  newTable = Buffer.concat([newTable, Buffer.alloc(pad)]);

  data = Buffer.concat([data.subarray(0, nameOffset), newTable, data.subarray(nameOffset + nameLength)]);

  for (let i = 0; i < numTables; i++) {
    const entry = tableDir + i * 16;
    const off = data.readUInt32BE(entry + 8);
    if (off > nameOffset) data.writeUInt32BE(off + newTable.length - nameLength, entry + 8);
  }
  return data;
}

export async function main(ctx: ScriptContext): Promise<void> {
  const modData = config.getMod(ctx.modName);
  let foundFont: string | null = null;

  for (const ext of FONT_EXTENSIONS) {
    const p = path.join(base.configDir, `font${ext}`);
    if (fs.existsSync(p)) foundFont = p;
  }

  if (!foundFont) {
    const fontString = String(modData.font_string ?? "Calibri");
    for (const name of fontString.split(",")) {
      if (!name.trim()) continue;
      foundFont = await utils.findSystemFont(name.trim().replace(/^['"]+|['"]+$/g, ""));
      if (foundFont) break;
    }
  }

  if (!foundFont) {
    output.addText("No font configured: set a font name in settings or place font.otf/ttf in config/", { msgType: "error", indent: true });
    return;
  }

  const fontsDir = dotaFontsPath();
  mfs.backupDirectory(fontsDir, backupPath);
  const fontData = fs.readFileSync(foundFont);

  for (const [name, [family, fullname, postscript]] of Object.entries(REPLACE_MAP)) {
    const dest = path.join(fontsDir, name);
    const patched = getPatchedFontData(fontData, family, fullname, postscript);
    const expected = crypto.createHash("sha256").update(patched).digest("hex");

    if (fs.existsSync(dest) && crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex") === expected) {
      output.addText(`Skipped (already patched): ${name}`, { indent: true });
      continue;
    }
    mfs.createDirs(fontsDir);
    fs.writeFileSync(dest, patched);
    output.addText(`Installed: ${name}`, { indent: true });
  }
}
