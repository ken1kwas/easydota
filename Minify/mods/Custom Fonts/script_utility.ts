import fs from "node:fs";
import path from "node:path";

import { base, fs as mfs, ui, utils } from "@minify/sdk";

const ALLOWED = [".ttf", ".otf"];

export async function select_font(): Promise<void> {
  const filePath = await ui.pickFile("Select Custom Font File", [
    { name: "Font Files", extensions: ["ttf", "otf"] },
    { name: "All Files", extensions: ["*"] },
  ]);
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED.includes(ext)) {
    await ui.alert(
      `Unsupported Format: Selected file must be a TrueType or OpenType font file (.ttf, .otf). Detected extension: ${ext}`,
      [],
      "error",
    );
    return;
  }

  mfs.createDirs(base.configDir);
  for (const old of ALLOWED) {
    const p = path.join(base.configDir, `font${old}`);
    if (fs.existsSync(p)) utils.tryPass(() => mfs.removePath(p));
  }

  const dest = path.join(base.configDir, `font${ext}`);
  fs.copyFileSync(filePath, dest);
  await ui.alert(`Successfully copied font to ${path.basename(dest)} in config/.`, [], "success");
}
