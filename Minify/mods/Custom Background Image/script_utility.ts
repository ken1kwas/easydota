import fs from "node:fs";
import path from "node:path";

import { base, fs as mfs, proc, ui, utils } from "@minify/sdk";

const ALLOWED = [".png", ".jpg", ".webp"];

export async function select_background(): Promise<void> {
  const filePath = await ui.pickFile("Select Background Image", [
    { name: "Image Files", extensions: ["png", "jpg", "jpeg", "webp"] },
    { name: "All Files", extensions: ["*"] },
  ]);
  if (!filePath) return;

  let actualExt = mfs.getFileType(filePath);
  if (actualExt === ".jpeg") actualExt = ".jpg";
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
  await ui.alert(`Successfully set background image to ${path.basename(dest)}.`, [], "success");

  let originalExt = path.extname(filePath).toLowerCase();
  if (originalExt === ".jpeg") originalExt = ".jpg";
  if (originalExt !== actualExt) await ui.alert(`Warning: Extension mismatch. Renamed from ${originalExt} to ${actualExt}.`, [], "warning");

  if ((actualExt === ".jpg" || actualExt === ".webp") && !proc.which("magick")) {
    await ui.alert(
      "Warning: ImageMagick (magick) is required to convert this image to PNG during patching but is not found on your system.",
      [],
      "warning",
    );
  }
}
