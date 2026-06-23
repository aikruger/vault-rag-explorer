// src/main.ts
// Entry point consumed by esbuild.config.mjs (entryPoints: ['src/main.ts']).
// Previously contained the Obsidian sample boilerplate (MyPlugin / dice icon).
// This file now simply re-exports the real plugin class so the build is correct.

console.log("[VaultRagExplorer] src/main.ts loaded — entry point is VaultRagExplorerPlugin");

import VaultRagExplorerPlugin from "./plugin";
export default VaultRagExplorerPlugin;
