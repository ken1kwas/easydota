// Electron main process: the desktop GUI (replaces pywebview).

import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import * as bootstrap from "../bootstrap";
import { buildProgram, SUBCOMMANDS } from "../cli-commands";
import * as conditions from "../conditions";
import * as base from "../core/base";
import * as config from "../core/config";
import * as log from "../core/log";
import * as output from "../core/output";
import * as steam from "../core/steam";
import * as utils from "../core/utils";
import { Api, apiMethodNames, invokeApi } from "../ui/api";
import * as dialogs from "../ui/dialogs";
import { ConfigService } from "../ui/services/config-service";

// argv: [electron, app, ...args] in development, [exe, ...args] when packaged
const cliArgs = process.argv.slice((process as { defaultApp?: boolean }).defaultApp ? 2 : 1);
const wantsCli = cliArgs.some((a) => SUBCOMMANDS.includes(a) || a === "-v" || a === "--version" || a === "-h" || a === "--help");

if (base.isWin) app.commandLine.appendSwitch("disable-gpu"); // see upstream issue #186

let mainWindow: BrowserWindow | null = null;

function filtersFromPatterns(filters: dialogs.FileFilter[]): Electron.FileFilter[] {
  return filters.length ? filters : [{ name: "All Files", extensions: ["*"] }];
}

function installGuiHooks(): void {
  dialogs.setBackend({
    async pickFile(title, filters) {
      const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ["openFile"], filters: filtersFromPatterns(filters) });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    async pickFiles(title, filters) {
      const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ["openFile", "multiSelections"], filters: filtersFromPatterns(filters) });
      return res.canceled ? [] : res.filePaths;
    },
    async pickFolder(title) {
      const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ["openDirectory"] });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    async pickSaveFile(title, defaultPath, filters) {
      const res = await dialog.showSaveDialog(mainWindow!, { title, defaultPath, filters: filtersFromPatterns(filters) });
      return res.canceled ? null : (res.filePath ?? null);
    },
    async alert(title, text, msgType) {
      const type = msgType === "error" ? "error" : msgType === "warning" ? "warning" : "info";
      if (mainWindow) await dialog.showMessageBox(mainWindow, { type, title, message: text });
      else dialog.showErrorBox(title, text);
    },
  });

  log.hooks.alert = (textOrId, args) => void dialogs.alert(textOrId, args);
  conditions.hooks.openUrl = (url) => void shell.openExternal(url);

  steam.hooks.promptSteamRoot = async () => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "Minify Install Path Handler",
      message: "We couldn't find your Steam installation, please select your Steam installation directory",
      buttons: ["Select folder", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
    const res = await dialog.showOpenDialog({ title: "Steam installation directory", properties: ["openDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  };
}

function savedWindowSize(): { width: number; height: number } {
  const size = utils.readStates().window_size ?? {};
  const width = Number.isInteger(size.width) && size.width >= 700 ? size.width : 960;
  const height = Number.isInteger(size.height) && size.height >= 500 ? size.height : 680;
  return { width, height };
}

async function createWindow(api: Api): Promise<void> {
  const theme = new ConfigService().getThemeCss(config.get("theme", "light"));
  mainWindow = new BrowserWindow({
    title: base.TITLE,
    ...savedWindowSize(),
    minWidth: 700,
    minHeight: 500,
    backgroundColor: ConfigService.extractBgColor(theme),
    icon: fs.existsSync(base.logoFile) ? base.logoFile : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // plugin tabs are iframes that call the API themselves
      nodeIntegrationInSubFrames: true,
    },
  });

  mainWindow.on("resize", () => {
    const [width, height] = mainWindow!.getSize();
    if (width >= 700 && height >= 500) utils.writeStates("window_size", { width, height });
  });

  // links clicked inside the UI open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  api.setSink((callback, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const js = `window.${callback} && window.${callback}(${JSON.stringify(payload)});`;
    mainWindow.webContents.executeJavaScript(js).catch(() => undefined);
  });

  if (config.get("debug_env")) mainWindow.webContents.openDevTools({ mode: "detach" });

  if (!fs.existsSync(base.distIndex)) {
    output.addText(`Error: Web UI build not found at '${base.distIndex}'. Run 'npm run build:web'.`, { msgType: "error" });
    await mainWindow.loadURL(`data:text/html,<h3>Web UI not built. Run <code>npm run build:web</code>.</h3>`);
    return;
  }
  await mainWindow.loadFile(base.distIndex);
}

async function runGui(): Promise<void> {
  await app.whenReady();
  base.state.HEADLESS = false;
  installGuiHooks();

  const api = new Api({
    openUrl: (url) => void shell.openExternal(url),
    quit: () => app.quit(),
  });

  ipcMain.on("minify:methods", (event) => {
    event.returnValue = apiMethodNames(api);
  });
  ipcMain.handle("minify:api", (_event, method: string, args: unknown[]) => invokeApi(api, method, args ?? []));

  try {
    await bootstrap.setupSystem();
  } catch (err) {
    log.writeCrashlog(err);
    dialog.showErrorBox("Minify", `Startup failed: ${err instanceof Error ? err.message : err}`);
  }

  await createWindow(api);
  app.on("window-all-closed", () => {
    api.close();
    app.quit();
  });
}

async function runCli(): Promise<void> {
  try {
    await buildProgram({ launchGui: () => undefined }).parseAsync(cliArgs, { from: "user" });
  } finally {
    app.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  }
}

bootstrap.enterRoot();
if (wantsCli) {
  void runCli();
} else {
  runGui().catch((err) => {
    log.writeCrashlog(err, undefined, false);
    app.exit(1);
  });
}
