import type { MinifyPlugin } from "@minify/sdk";

import { reconcileInstallStates } from "./api";
import { restoreD2pfxCursors, runPostBuild, runPreBuild } from "./build-hook";

export { RENAME_CATEGORIES, VERSION } from "./meta";

const plugin: MinifyPlugin = {
  id: "d2pfx",
  onPreBuild: (modList) => runPreBuild(modList),
  onPostBuild: (modList) => runPostBuild(modList),
  onUninstall: () => restoreD2pfxCursors(),
  onInitialize: () => reconcileInstallStates(),
};

export default plugin;
