/**
 * Runtime loader for mod scripts and plugin backends written in TypeScript.
 *
 * Mods ship `script*.ts` files and plugins ship `main.ts` / `api.ts`. They are transpiled on the
 * fly (no type checking) when required, the same way the python version imported `.py` files with
 * importlib. Scripts import the Minify API with `import { config, output } from "@minify/sdk"`.
 */

import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

import ts from "typescript";

export const SDK_MODULE = "@minify/sdk";
const SCRIPT_EXTENSIONS = [".ts", ".js"];

let installed = false;

type ModuleInternals = typeof Module & {
  _extensions: Record<string, (module: NodeJS.Module & { _compile(code: string, file: string): void }, filename: string) => void>;
  _resolveFilename: (request: string, parent: unknown, ...rest: unknown[]) => string;
};

export function transpile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      sourceMap: false,
      inlineSourceMap: true,
    },
  }).outputText;
}

/** Registers the `.ts` require hook and the `@minify/sdk` alias. Idempotent. */
export function install(): void {
  if (installed) return;
  installed = true;
  const M = Module as ModuleInternals;

  M._extensions[".ts"] = (module, filename) => {
    module._compile(transpile(fs.readFileSync(filename, "utf8"), filename), filename);
  };

  const sdkPath = require.resolve("../sdk");
  const originalResolve = M._resolveFilename;
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === SDK_MODULE) return sdkPath;
    return originalResolve.call(this, request, parent, ...rest);
  };
}

/** Finds `<dir>/<baseName>.ts` or `.js`. */
export function resolveScript(dir: string, baseName: string): string | null {
  for (const ext of SCRIPT_EXTENSIONS) {
    const candidate = path.join(dir, baseName + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Drops cached modules living under `dir` so edits are picked up on the next load. */
export function invalidate(dir: string): void {
  const root = path.resolve(dir) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root)) delete require.cache[key];
  }
}

/** Loads a script module fresh (python re-imported scripts on every execution). */
export function loadFresh<T = Record<string, unknown>>(file: string): T {
  install();
  invalidate(path.dirname(file));
  return require(path.resolve(file)) as T;
}

/** Loads a module once and keeps it cached (plugin backends). */
export function loadCached<T = Record<string, unknown>>(file: string): T {
  install();
  return require(path.resolve(file)) as T;
}
