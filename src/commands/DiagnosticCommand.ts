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

  plugin.addCommand({
    id: "rag-check-source-path",
    name: "Debug: Check source path in DB",
    callback: async () => {
      const path = await plugin.app.vault.getAbstractFileByPath(
        plugin.app.workspace.getActiveFile()?.path ?? ""
      )?.path;

      if (!path) {
        new Notice("No active file");
        return;
      }

      try {
        const rawDb = plugin.db.getDb();
        if (!rawDb) {
            new Notice("Database not loaded");
            return;
        }

        const res = rawDb.exec(`SELECT id, path, mtime FROM sources WHERE path = '${path.replace(/'/g, "''")}'`);

        let row = null;
        if (res && res.length > 0 && res[0] && res[0].values.length > 0) {
            row = res[0].values[0];
        }

        console.log("[DiagnosticCommand] source path check", {
          queriedPath: path,
          row,
        });

        new Notice(`Source path check: see console for details`);
      } catch (err: any) {
        console.error("[DiagnosticCommand] Failed to check source path", err);
        new Notice(`Source path check Error: ${err.message}`);
      }
    },
  });
}
