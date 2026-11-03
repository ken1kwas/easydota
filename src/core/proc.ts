// Child process helpers: running tools, finding executables, detecting running processes.

import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

export interface RunResult {
  code: number;
  stdout: string;
  /** stdout + stderr interleaved as raw bytes (like `stderr=subprocess.STDOUT`). */
  output: Buffer;
  stderr: string;
}

export function run(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const all: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => {
      out.push(d);
      all.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      err.push(d);
      all.push(d);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        output: Buffer.concat(all),
      }),
    );
  });
}

/** Spawns a detached process and forgets about it. */
export function launchDetached(command: string, args: string[] = [], cwd?: string): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, cwd });
  child.on("error", () => undefined);
  child.unref();
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (isWin) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `shutil.which` equivalent. */
export function which(name: string): string | null {
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) return isExecutableFile(name) ? path.resolve(name) : null;
  const exts = isWin ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Lists running process image names (basename, as reported by the OS). */
export async function listProcessNames(): Promise<string[]> {
  try {
    if (isWin) {
      const res = await run("tasklist", ["/FO", "CSV", "/NH"]);
      return res.stdout
        .split(/\r?\n/)
        .map((line) => line.match(/^"([^"]+)"/)?.[1])
        .filter((n): n is string => Boolean(n));
    }
    const res = await run("ps", ["-A", "-o", "comm="]);
    return res.stdout
      .split(/\r?\n/)
      .map((line) => path.basename(line.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function isProcessRunning(imageName: string): Promise<boolean> {
  const target = imageName.toLowerCase();
  return (await listProcessNames()).some((n) => n.toLowerCase() === target);
}

/** Splits a command line like `shlex.split`. */
export function shlexSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && !isWin && i + 1 < input.length) {
      cur += input[++i];
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
