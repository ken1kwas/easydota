// Agnostic output interface

import { localizationDict } from "./localization";

const RED = "\x1b[38;2;255;0;0m";
const YELLOW = "\x1b[38;2;255;255;0m";
const GREEN = "\x1b[38;2;0;255;0m";
const RESET = "\x1b[0m";

export type MsgType = "info" | "error" | "warning" | "success" | "separator" | "clear" | null | undefined;
export type LogListener = (text: string, msgType: MsgType) => void;

export interface DownloadProgress {
  id: string;
  name: string;
  downloaded_bytes: number;
  total_bytes: number;
  status: "downloading" | "finished" | "error";
  error: string | null;
}
export type DownloadListener = (data: DownloadProgress) => void;

const listeners: LogListener[] = [];
const downloadListeners: DownloadListener[] = [];

export function registerListener(cb: LogListener): void {
  if (!listeners.includes(cb)) listeners.push(cb);
}
export function unregisterListener(cb: LogListener): void {
  const i = listeners.indexOf(cb);
  if (i !== -1) listeners.splice(i, 1);
}
export function registerDownloadListener(cb: DownloadListener): void {
  if (!downloadListeners.includes(cb)) downloadListeners.push(cb);
}
export function unregisterDownloadListener(cb: DownloadListener): void {
  const i = downloadListeners.indexOf(cb);
  if (i !== -1) downloadListeners.splice(i, 1);
}

export function emitDownloadProgress(
  taskId: string,
  name: string,
  downloadedBytes: number,
  totalBytes: number,
  status: DownloadProgress["status"],
  error: string | null = null,
): void {
  const data: DownloadProgress = {
    id: taskId,
    name,
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    status,
    error,
  };
  for (const listener of [...downloadListeners]) {
    try {
      listener(data);
    } catch {
      /* ignore */
    }
  }
}

/** Python-style `str.format` supporting `{}` and `{0}` placeholders. */
export function pyFormat(text: string, args: unknown[]): string {
  if (!args.length) return text;
  let auto = 0;
  return text.replace(/\{(\d*)\}/g, (match, idx: string) => {
    const i = idx === "" ? auto++ : Number(idx);
    return i < args.length ? String(args[i]) : match;
  });
}

/** Resolves `&key` localization ids into text. */
export function localize(textOrId: string, args: unknown[] = []): string {
  let text = textOrId;
  if (textOrId.startsWith("&")) {
    text = localizationDict[textOrId.slice(1)] ?? textOrId;
  }
  return pyFormat(text, args);
}

export interface AddTextOptions {
  msgType?: MsgType;
  indent?: boolean | number;
}

/**
 * Prints a message and notifies UI listeners.
 *
 *   addText("&installing_terminal", ["Mod"], { indent: true })
 *   addText("plain text", { msgType: "error" })
 */
export function addText(textOrId: string, argsOrOpts?: unknown[] | AddTextOptions, opts?: AddTextOptions): void {
  let args: unknown[] = [];
  let options: AddTextOptions = {};
  if (Array.isArray(argsOrOpts)) {
    args = argsOrOpts;
    options = opts ?? {};
  } else if (argsOrOpts) {
    options = argsOrOpts;
  }

  let text = localize(textOrId, args);

  if (options.indent) {
    const indentStr = typeof options.indent === "number" ? " ".repeat(options.indent) : "   ";
    text = text
      .split("\n")
      .map((line) => (line ? indentStr + line : ""))
      .join("\n");
  }

  const prefix =
    options.msgType === "error" ? RED : options.msgType === "warning" ? YELLOW : options.msgType === "success" ? GREEN : "";
  console.log(`${prefix}${text}${RESET}`);

  for (const listener of [...listeners]) listener(text, options.msgType);
}

export function addSeparator(): void {
  console.log("-".repeat(50));
  for (const listener of [...listeners]) listener("", "separator");
}

export function clean(): void {
  for (const listener of [...listeners]) {
    try {
      listener("", "clear");
    } catch {
      /* ignore */
    }
  }
}
