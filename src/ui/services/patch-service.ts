import * as output from "../../core/output";
import * as patch from "../../patch";

export interface LogEntry {
  text: string;
  type: string;
  timestamp?: string;
}

/** Pushes events to the frontend (`window.onLogReceived(...)` etc). */
export type EventSink = (callbackName: string, payload: unknown) => void;

export class PatchService {
  private sink: EventSink | null = null;
  private patching = false;
  private readonly logs: LogEntry[] = [];
  private readonly downloads = new Map<string, output.DownloadProgress>();

  private readonly onLog: output.LogListener = (text, msgType) => {
    if (msgType === "clear") {
      this.logs.length = 0;
      this.sink?.("onLogReceived", { text: "", type: "clear" });
      return;
    }
    const entry: LogEntry = { text, type: msgType || "info", timestamp: new Date().toTimeString().slice(0, 8) };
    this.logs.push(entry);
    this.sink?.("onLogReceived", entry);
  };

  private readonly onDownload: output.DownloadListener = (data) => {
    this.downloads.set(data.id, { ...data });
    this.sink?.("onDownloadProgress", data);
  };

  constructor() {
    output.registerListener(this.onLog);
    output.registerDownloadListener(this.onDownload);
  }

  setSink(sink: EventSink | null): void {
    this.sink = sink;
  }

  close(): void {
    output.unregisterListener(this.onLog);
    output.unregisterDownloadListener(this.onDownload);
    this.sink = null;
  }

  getDownloads(): output.DownloadProgress[] {
    return [...this.downloads.values()];
  }

  private runExclusive(task: () => Promise<void>): { status: string } {
    if (this.patching) return { status: "already_running" };
    this.patching = true;
    this.sink?.("onPatchStatusChange", true);
    void task()
      .catch((err) => output.addText(String(err), { msgType: "error" }))
      .finally(() => {
        this.patching = false;
        this.sink?.("onPatchStatusChange", false);
      });
    return { status: "started" };
  }

  startPatch(): { status: string } {
    return this.runExclusive(() => patch.patcher());
  }

  startUninstall(removeEverything = false): { status: string } {
    return this.runExclusive(() => (removeEverything ? patch.unins.wipe() : patch.unins.uninstall()));
  }

  isPatching(): boolean {
    return this.patching;
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): boolean {
    this.logs.length = 0;
    return true;
  }
}
