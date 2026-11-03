import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as scriptLoader from "../core/script-loader";
import * as vdf from "../core/vdf";
import { pack, VpkFile, crc32 } from "../core/vpk";
import * as mu from "../patch/manifest-utils";
import { globToRegExp, parseModsString, selectMods } from "../patch/util";
import * as xml from "../patch/xml-utils";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "minify-test-"));

test("crc32 matches zlib reference", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

for (const chunk of [null, 16] as const) {
  test(`vpk pack/read round trip (chunkSize=${chunk})`, async () => {
    const src = tmp();
    const files: Record<string, string> = {
      "root.txt": "at root",
      "noext": "no extension",
      "panorama/styles/a.vcss_c": "A".repeat(40),
      "panorama/styles/b.vcss_c": "B",
      "sounds/x.vsnd_c": "sound",
    };
    for (const [rel, data] of Object.entries(files)) {
      fs.mkdirSync(path.join(src, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), data);
    }
    const out = path.join(tmp(), "pak66_dir.vpk");
    await pack(src, out, chunk);
    const pak = VpkFile.open(out);
    assert.equal(pak.version, 2);
    assert.deepEqual(pak.paths().sort(), Object.keys(files).sort());
    for (const [rel, data] of Object.entries(files)) assert.equal(pak.read(rel)!.toString(), data);
    assert.equal(pak.read("missing"), null);
    pak.close();
    if (chunk) assert.ok(fs.existsSync(out.replace("_dir.vpk", "_001.vpk")), "expected multiple chunks");
  });
}

test("vdf parse/dump round trip with escapes and nesting", () => {
  const text = `"UserLocalConfigStore"
{
  // comment
  "Software" { "Valve" { "Steam" { "apps" { "570" { "LaunchOptions" "-novid -language dutch" } } } } }
  "path" "C:\\\\Games\\\\Steam"
}`;
  const data = vdf.parse(text);
  assert.equal(vdf.getPath(data, ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps", "570", "LaunchOptions"]), "-novid -language dutch");
  assert.equal(vdf.getPath(data, ["UserLocalConfigStore", "path"]), "C:\\Games\\Steam");
  assert.deepEqual(vdf.parse(vdf.dump(data)), data);
});

test("manifest directives: blacklist #if/#endif and interpolation", () => {
  const lines = ["a.vtex_c", "#if:flag", "b_<&name>.vtex_c", "#if:off", "c.vtex_c", "#endif", "#endif", "d.vtex_c"];
  assert.deepEqual(mu.processBlacklistLines(lines, { flag: true, off: "false", name: "x" }), ["a.vtex_c", "b_x.vtex_c", "d.vtex_c"]);
  assert.deepEqual(mu.processBlacklistLines(lines, { flag: false }), ["a.vtex_c", "d.vtex_c"]);
});

test("manifest directives: css if/endif", () => {
  const css = "/* if:on */\n.a { color: <&c>; }\n/* endif */\n/* if:off */\n.b {}\n/* endif */\n.c {}\n";
  assert.equal(mu.processCssContent(css, { on: 1, off: 0, c: "red" }), ".a { color: red; }\n.c {}\n");
});

test("version requirements", () => {
  assert.ok(mu.isVersionAtLeast("1.13", "1.12"));
  assert.ok(mu.isVersionAtLeast("2rc9", ">=2rc1,<2"));
  assert.ok(!mu.isVersionAtLeast("2rc9", ">=2"));
});

test("--mods-string parsing and glob", () => {
  assert.deepEqual(parseModsString("a, b\\,c ,a,d\\\\"), ["a", "b,c", "d\\"]);
  assert.deepEqual(selectMods(["TREE mod", "nope"], ["Tree Mod"]), [["Tree Mod"], ["nope"]]);
  assert.ok(globToRegExp("panorama/*.vxml_c", false).test("panorama/layout/x.vxml_c"));
  assert.ok(!globToRegExp("a?c", false).test("abbc"));
});

test("xml modifications", () => {
  const dir = tmp();
  const file = path.join(dir, "layout.xml");
  fs.writeFileSync(file, `<root><Panel id="Main" class="a b"><Label id="L" text="x"/></Panel></root>`);
  xml.applyModifications(file, [
    { action: "add_style_include", src: "file://{resources}/styles/m.css" },
    { action: "set_attribute", selector: "Label#L", attribute: "text", value: "y" },
    { action: "add_child", selector: ".a.b", xml: `<Button id="B"/>` },
    { action: "insert_before", selector: "#L", xml: `<Image id="I"/>` },
  ]);
  const out = fs.readFileSync(file, "utf8");
  assert.match(out, /<styles>\s*<include src="file:\/\/\{resources\}\/styles\/m.css"\/>/);
  assert.match(out, /<Image id="I"\/>\s*<Label id="L" text="y"\/>\s*<Button id="B"\/>/);
});

test("script loader transpiles .ts and resolves @minify/sdk", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "helper.ts"), `export const answer: number = 41;`);
  fs.writeFileSync(
    path.join(dir, "script.ts"),
    `import { answer } from "./helper";\nimport { manifestUtils } from "@minify/sdk";\nexport function main(): number { return answer + Number(manifestUtils.isTruthy("yes")); }`,
  );
  const mod = scriptLoader.loadFresh<{ main(): number }>(scriptLoader.resolveScript(dir, "script")!);
  assert.equal(mod.main(), 42);
});
