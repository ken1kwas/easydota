// UI-agnostic dialogs. The Electron app installs real implementations; headless falls back to output.

import * as localization from "../core/localization";
import * as output from "../core/output";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface DialogBackend {
  pickFile(title: string, filters: FileFilter[]): Promise<string | null>;
  pickFiles(title: string, filters: FileFilter[]): Promise<string[]>;
  pickFolder(title: string): Promise<string | null>;
  pickSaveFile(title: string, defaultFilename: string, filters: FileFilter[]): Promise<string | null>;
  alert(title: string, text: string, msgType: string): Promise<void>;
}

const headless: DialogBackend = {
  pickFile: async () => null,
  pickFiles: async () => [],
  pickFolder: async () => null,
  pickSaveFile: async () => null,
  alert: async () => undefined,
};

let backend: DialogBackend = headless;

export function setBackend(b: DialogBackend): void {
  backend = b;
}

export const pickFile = (title = "Select File", filters: FileFilter[] = []) => backend.pickFile(title, filters);
export const pickFiles = (title = "Select Files", filters: FileFilter[] = []) => backend.pickFiles(title, filters);
export const pickFolder = (title = "Select Folder") => backend.pickFolder(title);
export const pickSaveFile = (title = "Save File", defaultFilename = "", filters: FileFilter[] = []) =>
  backend.pickSaveFile(title, defaultFilename, filters);

/** Displays a user-facing alert (with `&` localization) and mirrors it to the terminal output. */
export async function alert(textOrId: string, args: unknown[] = [], msgType: output.MsgType | "success" = "info", title?: string): Promise<void> {
  let text = textOrId;
  if (textOrId.startsWith("&")) text = localization.localizationDict[textOrId.slice(1)] ?? textOrId;
  text = output.pyFormat(text, args);
  title ??= msgType === "error" ? "Error" : msgType === "warning" ? "Warning" : "Notice";
  output.addText(textOrId, args, { msgType });
  await backend.alert(title, text, msgType ?? "info");
}
