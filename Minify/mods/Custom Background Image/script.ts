import fs from "node:fs";
import path from "node:path";

import { base, conditions, config, constants, fs as mfs, helper, output, proc, type ScriptContext } from "@minify/sdk";

const IMG_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export async function main(ctx: ScriptContext): Promise<void> {
  let sourceFile: string | null = null;
  let actualExt: string | null = null;

  for (const ext of IMG_EXTENSIONS) {
    const p = path.join(base.configDir, `background${ext}`);
    if (!fs.existsSync(p)) continue;

    actualExt = mfs.getFileType(p);
    if (actualExt === ".jpeg") actualExt = ".jpg";
    if (!actualExt) {
      output.addText("Unsupported background image format\n   {}", [p], { msgType: "error", indent: true });
      return;
    }
    if (actualExt !== ext) {
      const renamed = path.join(base.configDir, `background${actualExt}`);
      output.addText("Background extension mismatch\n   {} -> {}", [p, renamed], { msgType: "warning", indent: true });
      mfs.movePath(p, renamed);
      return;
    }
    sourceFile = p;
    break;
  }
  if (!sourceFile || !conditions.state.workshopInstalled) return;

  const targetFile = sourceFile.endsWith(".png") ? sourceFile : path.join(base.configDir, "_background.png");
  if (targetFile !== sourceFile) {
    const magick = proc.which("magick");
    if (!magick) {
      output.addText("Conversion tools missing\n   {} ({})", ["ImageMagick", `${actualExt} -> .png`], { msgType: "error", indent: true });
      return;
    }
    await proc.run(magick, [sourceFile, targetFile]);
  }

  if (!fs.existsSync(targetFile)) return;
  const compileLocation = path.join(constants.minifyDotaCompileInputPath, "panorama", "images", "backgrounds");
  mfs.createDirs(compileLocation);
  fs.copyFileSync(targetFile, path.join(compileLocation, "background.png"));
  fs.writeFileSync(path.join(compileLocation, "imgref.xml"), helper.createImgRefXml(["panorama/images/backgrounds/background.png"]));

  config.setMod(ctx.modName, {
    bg_img_style:
      'url("s2r://panorama/images/backgrounds/background_png.vtex"), url("s2r://panorama/images/loadingscreens/international_2026_ls_5/loadingscreen.vtex")',
  });
}
