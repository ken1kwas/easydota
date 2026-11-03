import fs from "node:fs";
import path from "node:path";

import { base, conditions, constants, fs as mfs, output, proc } from "@minify/sdk";

export async function main(): Promise<void> {
  let sourceFile: string | null = null;
  let actualExt: string | null = null;

  for (const ext of [".mp4", ".webm"]) {
    const p = path.join(base.configDir, `background${ext}`);
    if (!fs.existsSync(p)) continue;

    actualExt = mfs.getFileType(p);
    if (!actualExt) {
      output.addText("Unsupported background video format\n   {}", [p], { msgType: "error", indent: true });
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

  const targetFile = sourceFile.endsWith(".webm") ? sourceFile : path.join(base.configDir, "_background.webm");
  if (targetFile !== sourceFile) {
    const ffmpeg = proc.which("ffmpeg");
    if (!ffmpeg) {
      output.addText("Conversion tools missing\n   {} ({})", ["FFmpeg", `${actualExt} -> .webm`], { msgType: "error", indent: true });
      return;
    }
    // prettier-ignore
    await proc.run(ffmpeg, [
      "-y", "-i", sourceFile, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p",
      "-deadline", "realtime", "-cpu-used", "4", "-threads", "0", "-an", targetFile,
    ]);
  }

  if (!fs.existsSync(targetFile)) return;
  const compileLocation = path.join(constants.minifyDotaCompileOutputPath, "panorama", "videos");
  mfs.createDirs(compileLocation);
  fs.copyFileSync(targetFile, path.join(compileLocation, "background.webm"));
  if (targetFile !== sourceFile) mfs.removePath(targetFile);
}
