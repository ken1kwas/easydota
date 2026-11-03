/**
 * Exposes `window.pywebview.api` to the web UI and plugin iframes, so the existing Svelte frontend
 * runs unchanged. Every method forwards to the main process over IPC.
 */

import { contextBridge, ipcRenderer } from "electron";

const methods: string[] = ipcRenderer.sendSync("minify:methods");

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const method of methods) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke("minify:api", method, args);
}

contextBridge.exposeInMainWorld("pywebview", { api });

// pywebview fires this once the bridge is ready; the frontend waits for it when needed.
const fireReady = () => window.dispatchEvent(new Event("pywebviewready"));
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", fireReady, { once: true });
else fireReady();
