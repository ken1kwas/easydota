// Central registry for plugins.

export interface MinifyPlugin {
  id?: string;
  onInitialize?(): void | Promise<void>;
  onPreBuild?(modList: string[]): void | Promise<void>;
  onPostBuild?(modList: string[]): void | Promise<void>;
  onUninstall?(): void | Promise<void>;
}

const plugins: MinifyPlugin[] = [];

export function registerPlugin(plugin: MinifyPlugin): void {
  if (!plugins.includes(plugin)) plugins.push(plugin);
}

export function getPlugins(): readonly MinifyPlugin[] {
  return plugins;
}

export function clear(): void {
  plugins.length = 0;
}
