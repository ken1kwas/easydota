/**
 * `--host` mode: serves the web UI on 127.0.0.1 and answers `POST /api` calls (the frontend's
 * main.js installs a fetch-based `window.pywebview.api` shim when loaded over http).
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as base from "../core/base";
import * as config from "../core/config";
import * as output from "../core/output";
import { launchDetached, which } from "../core/proc";
import { Api, invokeApi } from "./api";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Rewrites file:// URLs below themes/ or plugins/ into served http paths. */
function hostFileUrls(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("file://")) {
    const p = fileURLToPath(value);
    for (const [root, prefix] of [
      [base.themesDir, "/themes/"],
      [base.pluginsDir, "/plugins/"],
    ] as const) {
      if (isInside(root, p)) return prefix + path.relative(root, p).split(path.sep).join("/");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(hostFileUrls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostFileUrls(v)]));
  return value;
}

function serveFile(res: http.ServerResponse, root: string, rel: string): void {
  const target = path.resolve(root, decodeURIComponent(rel).replace(/^\/+/, ""));
  if (!isInside(root, target) && target !== root) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream" }).end(data);
  });
}

export function startServer(api: Api): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        let status = 200;
        let payload: unknown;
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          payload = { result: hostFileUrls(await invokeApi(api, String(request.method), request.args ?? [])) ?? null };
        } catch (err) {
          status = 500;
          payload = { error: err instanceof Error ? err.message : String(err) };
        }
        const body = JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body);
      });
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === "/favicon.ico") return serveFile(res, path.dirname(base.faviconFile), path.basename(base.faviconFile));
    if (url.pathname.startsWith("/themes/")) return serveFile(res, base.themesDir, url.pathname.slice(8));
    if (url.pathname.startsWith("/plugins/")) return serveFile(res, base.pluginsDir, url.pathname.slice(9));
    return serveFile(res, base.webDir, url.pathname === "/" ? "index.html" : url.pathname);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function findAppBrowser(): string | null {
  const configured = config.get<string>("browser_exec");
  if (typeof configured === "string" && configured.trim()) {
    const exe = configured.trim().replace(/^~/, os.homedir());
    for (const c of [exe, which(exe), path.join(base.state.originalCwd, exe)]) if (c && fs.existsSync(c)) return c;
    output.addText(`Browser not found at '${configured}', trying auto-detection...`, { msgType: "warning" });
  }
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = base.isWin
    ? [
        path.join(pf, "Chromium", "Application", "chrome.exe"),
        path.join(local, "Chromium", "Application", "chrome.exe"),
        path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(pf, "Vivaldi", "Application", "vivaldi.exe"),
        path.join(local, "Vivaldi", "Application", "vivaldi.exe"),
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : base.isMac
      ? [
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["chromium", "chromium-browser", "brave-browser", "vivaldi", "google-chrome", "google-chrome-stable", "microsoft-edge"]
          .map((n) => which(n))
          .filter((p): p is string => Boolean(p));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function openDefaultBrowser(url: string): void {
  if (base.isWin) launchDetached("cmd", ["/c", "start", "", url]);
  else if (base.isMac) launchDetached("open", [url]);
  else launchDetached("xdg-open", [url]);
}

/** Runs the UI in a Chromium `--app` window (or the default browser) until shutdown is requested. */
export async function runHosted(): Promise<void> {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const api = new Api({ openUrl: openDefaultBrowser, shutdown: () => resolveDone(), quit: () => process.exit(0) });
  const server = await startServer(api);
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/index.html`;
  output.addText(`Minify UI hosted at ${url}`);

  const exe = findAppBrowser();
  if (exe) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "minify-browser-"));
    launchDetached(exe, [`--app=${url}`, `--user-data-dir=${profile}`, "--window-size=960,680", "--no-first-run", "--no-default-browser-check"]);
  } else {
    openDefaultBrowser(url);
  }

  process.once("SIGINT", () => resolveDone());
  await done;
  api.close();
  server.close();
}
