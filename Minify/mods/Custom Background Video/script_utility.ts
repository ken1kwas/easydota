import fs from "node:fs";
import path from "node:path";

import { base, fs as mfs, proc, ui, utils } from "@minify/sdk";

const ALLOWED = [".mp4", ".webm"];

export async function select_background(): Promise<void> {
  const filePath = await ui.pickFile("Select Background Video", [
    { name: "Video Files", extensions: ["mp4", "webm"] },
    { name: "All Files", extensions: ["*"] },
  ]);
  if (!filePath) return;

  const actualExt = mfs.getFileType(filePath);
  if (!actualExt || !ALLOWED.includes(actualExt)) {
    await ui.alert(`Unsupported Format: The selected file has an unsupported format or invalid magic bytes. Detected: ${actualExt}`, [], "error");
    return;
  }

  mfs.createDirs(base.configDir);
  for (const ext of ALLOWED) {
    const old = path.join(base.configDir, `background${ext}`);
    if (fs.existsSync(old)) utils.tryPass(() => mfs.removePath(old));
  }

  const dest = path.join(base.configDir, `background${actualExt}`);
  fs.copyFileSync(filePath, dest);
  await ui.alert(`Successfully set background video to ${path.basename(dest)}.`, [], "success");

  const originalExt = path.extname(filePath).toLowerCase();
  if (originalExt !== actualExt) await ui.alert(`Warning: Extension mismatch. Renamed from ${originalExt} to ${actualExt}.`, [], "warning");

  if (actualExt !== ".webm" && !proc.which("ffmpeg")) {
    await ui.alert(
      "Warning: FFmpeg is required to convert this video to WEBM (VP9) during patching but is not found on your system.",
      [],
      "warning",
    );
  }
}
