# Dota 2 Mod Patcher

A desktop mod patcher for Dota 2, built with TypeScript and Electron. It bundles your enabled mods into a VPK pak and hooks it into the game.

## Getting started

```bash
npm install            # dependencies + Electron
npm run build:web      # build the UI (Svelte)
npm start              # launch the GUI
node dist/cli.js patch # CLI: patch | prelaunch | config | mods | uninstall | --host
npm test               # smoke tests (VPK, VDF, directives, XML, script loader)
```

## Project layout

```
src/
  core/      config, Steam/Dota paths, VPK, VDF, files, logging, localization, migrations, script loader
  patch/     pak build pipeline: blacklist, replacer, styling, xml, remap, vpk, uninstall
  ui/        UI-facing API, services, --host mode, dialogs
  app/       Electron main process and preload
  sdk.ts     public API for mods and plugins
Minify/      app data: mods, plugins, bin, locales, themes, ui/web (frontend)
```

## How it works

- **UI** — a Svelte app running in an Electron window; it talks to the backend through the bridge in `src/app/preload.ts`.
- **VPK and VDF** — in-house readers and writers (`src/core/vpk.ts`, `src/core/vdf.ts`).
- **Resource decompiling and compiling** — Source2Viewer-CLI (downloaded automatically) and resourcecompiler from the Dota 2 Workshop Tools.
- **Mod and plugin scripts** are written in TypeScript and transpiled on the fly (`src/core/script-loader.ts`).

## Writing a mod script

```ts
// Minify/mods/My Mod/script_after_patch.ts
import { output, type ScriptContext } from "@minify/sdk";

export async function main(ctx: ScriptContext) {
  output.addText(`Hello from ${ctx.modName}`, { indent: true });
}
```

Available hooks: `script` (runs during the build), `script_initial`, `script_after_decompile`, `script_after_recompile`,
`script_after_patch`, `script_prelaunch`, and `script_uninstall`. A `script_utility` file exports functions bound to
buttons in the settings panel (the function name matches the button's `key` in `manifest.json`). Run
`npm run typecheck` to type-check your scripts.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

Based on [Egezenn/dota2-minify](https://github.com/Egezenn/dota2-minify) (GPL-3.0), rewritten from Python to TypeScript and modified.
