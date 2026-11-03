import type { MinifyPlugin } from "@minify/sdk";

import { reconcileInstallStates } from "./api";

const plugin: MinifyPlugin = {
  id: "community",
  onInitialize: () => reconcileInstallStates(),
};

export default plugin;
