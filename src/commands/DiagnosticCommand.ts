import { Notice } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";

export function registerDiagnosticCommand(plugin: VaultRagExplorerPlugin) {
  plugin.addCommand({
    id: "rag-query-diagnostics",
    name: "Debug: RAG Query Diagnostics",
    callback: () => {
      try {
        const scBridge = (plugin as any).embeddingService;
        if (!scBridge) {
          new Notice("RAG Diagnostics: Embedding service not initialized.");
          return;
        }

        const health = scBridge.getIndexHealth();
        const modelName = scBridge.getModelName();

        const diagMsg = `
Model: ${modelName}
Index Loaded: ${health.loaded}
Status: ${health.status}
Dimension: ${health.dimension ?? "Unknown"}
Size: ${health.size ?? "Unknown"}
        `.trim();

        console.log("[Diagnostics] Smart Connections Index Health:", {
          modelName,
          ...health
        });

        new Notice(`RAG Query Diagnostics\n${diagMsg}`, 10000);
      } catch (err: any) {
        console.error("[Diagnostics] Failed to run diagnostics", err);
        new Notice(`RAG Diagnostics Error: ${err.message}`);
      }
    },
  });
}
