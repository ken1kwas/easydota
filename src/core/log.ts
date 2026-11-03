// Crashlogs, warnings and debug zip creation

import fs from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

import * as base from "./base";
import * as output from "./output";
import { formatError } from "./utils";

/** Hook set by the GUI to surface the debug-zip alert in a dialog. */
export const hooks: { alert?: (textOrId: string, args: unknown[]) => void } = {};

function ensureLogsDir(): void {
  fs.mkdirSync(base.logsDir, { recursive: true });
}

export function writeCrashlog(error?: unknown, header?: string, handled = true): void {
  ensureLogsDir();
  const file = handled ? base.logCrashlog : base.logUnhandled;
  const trace = error === undefined ? "" : formatError(error);
  fs.writeFileSync(file, header ? `${header}\n\n${trace}` : trace, "utf8");
  if (base.FROZEN) createDebugZip();
}

/**
 * Appends a warning to logs/warnings.txt and prints it.
 *
 *   writeWarning("message")                    // plain header
 *   writeWarning("&failed_merge_mod", [name])  // localized
 *   writeWarning(undefined, [], err)           // exception only
 */
export function writeWarning(header?: string, args: unknown[] = [], error?: unknown, opts: output.AddTextOptions = {}): void {
  ensureLogsDir();
  if (!fs.existsSync(base.logWarnings)) fs.writeFileSync(base.logWarnings, "", "utf8");
  if (header === undefined && error === undefined) return;

  const headerText = header !== undefined ? output.localize(header, args) : "";
  const message = error !== undefined ? (headerText ? `${headerText}\n\n${formatError(error)}` : formatError(error)) : headerText;

  fs.appendFileSync(base.logWarnings, `${message}\n${"-".repeat(50)}\n\n`, "utf8");
  if (message) output.addText(message, { msgType: "warning", ...opts });
}

export function installUnhandledHandlers(): void {
  const handler = (err: unknown) => {
    try {
      writeCrashlog(err, undefined, false);
    } catch {
      /* ignore */
    }
    console.error(err);
  };
  process.on("uncaughtException", handler);
  process.on("unhandledRejection", handler);
}

export function createDebugZip(): string | undefined {
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const zipFilename = `minify_debug_${stamp}.zip`;
    const files = [base.paths.mainConfigFile, base.paths.modsConfig];
    if (fs.existsSync(base.logsDir)) for (const f of fs.readdirSync(base.logsDir)) files.push(path.join(base.logsDir, f));

    const zip = new AdmZip();
    for (const f of files) {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) zip.addLocalFile(f, path.dirname(f));
    }
    zip.writeZip(zipFilename);

    if (!base.state.HEADLESS && hooks.alert) hooks.alert("&heeeeeeeeeeeeeelp", [zipFilename]);
    else output.addText("&heeeeeeeeeeeeeelp", [zipFilename]);

    require("./fs").openThing(".");
    return zipFilename;
  } catch {
    return undefined;
  }
}
