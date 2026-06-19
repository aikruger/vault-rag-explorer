import { Editor, MarkdownView, Notice } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";
import { VIEW_TYPE_VAULT_RAG_EXPLORER } from "../types";
import { VaultRagExplorerView } from "../views/VaultRagExplorerView";

export function registerCommands(plugin: VaultRagExplorerPlugin): void {
	console.log("[VaultRagExplorer] Registering commands");

	plugin.addCommand({
		id: "open-vault-rag-explorer",
		name: "Open Vault RAG Explorer",
		callback: async () => {
			console.log("[VaultRagExplorer] Command: open-vault-rag-explorer");
			await plugin.activateView();
		},
	});

	plugin.addCommand({
		id: "new-vault-rag-session",
		name: "New Vault RAG session",
		callback: async () => {
			console.log("[VaultRagExplorer] Command: new-vault-rag-session");
			await plugin.activateView();
			new Notice("New session: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "run-vault-rag-query-from-selection",
		name: "Run Vault RAG query from selection",
		editorCallback: async (editor: Editor, view: MarkdownView | import("obsidian").MarkdownFileInfo) => {
			const selection = editor.getSelection().trim();
			console.log("[VaultRagExplorer] Command: run-vault-rag-query-from-selection", {
				hasSelection: !!selection,
				file: view.file?.path,
			});

			if (!selection) {
				new Notice("Select some text first");
				return;
			}

			await plugin.activateView();
			const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_RAG_EXPLORER)[0];
			const ragView = leaf?.view;

			if (ragView instanceof VaultRagExplorerView) {
				ragView.setQueryText(selection);
				await ragView.runQuery();
			}
		},
	});

	plugin.addCommand({
		id: "add-active-file-to-rag-session",
		name: "Add active file to RAG session",
		checkCallback: (checking: boolean) => {
			const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView?.file) return false;

			if (!checking) {
				console.log("[VaultRagExplorer] Command: add-active-file-to-rag-session", {
					path: markdownView.file.path,
				});
				new Notice("Add active file to RAG session: not implemented yet");
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "lock-active-file-in-rag-session",
		name: "Lock active file in RAG session",
		checkCallback: (checking: boolean) => {
			const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView?.file) return false;

			if (!checking) {
				console.log("[VaultRagExplorer] Command: lock-active-file-in-rag-session", {
					path: markdownView.file.path,
				});
				new Notice("Lock active file in RAG session: not implemented yet");
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "expand-selected-node-semantically",
		name: "Expand selected node semantically",
		callback: () => {
			console.log("[VaultRagExplorer] Command: expand-selected-node-semantically");
			new Notice("Expand selected node semantically: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "expand-selected-node-by-wikilinks",
		name: "Expand selected node by wikilinks",
		callback: () => {
			console.log("[VaultRagExplorer] Command: expand-selected-node-by-wikilinks");
			new Notice("Expand selected node by wikilinks: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "lock-all-visible-rag-nodes",
		name: "Lock all visible RAG nodes",
		callback: () => {
			console.log("[VaultRagExplorer] Command: lock-all-visible-rag-nodes");
			new Notice("Lock all visible nodes: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "unlock-all-rag-nodes",
		name: "Unlock all RAG nodes",
		callback: () => {
			console.log("[VaultRagExplorer] Command: unlock-all-rag-nodes");
			new Notice("Unlock all nodes: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "save-current-rag-session",
		name: "Save current RAG session",
		callback: () => {
			console.log("[VaultRagExplorer] Command: save-current-rag-session");
			new Notice("Save current session: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "load-rag-session",
		name: "Load RAG session",
		callback: async () => {
			console.log("[VaultRagExplorer] Command: load-rag-session");
			await plugin.activateView();
			new Notice("Load RAG session: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "export-locked-rag-context",
		name: "Export locked RAG context",
		callback: () => {
			console.log("[VaultRagExplorer] Command: export-locked-rag-context");
			new Notice("Export locked RAG context: not implemented yet");
		},
	});

	plugin.addCommand({
		id: "vault-rag-explorer-build-index",
		name: "Build / Rebuild Index from Smart Connections export",
		callback: async () => {
			console.log("[Commands] Build index triggered");
			const exportPath = plugin.settings.smartConnectionsExportPath;
			if (!exportPath) {
				new Notice("Set the Smart Connections export path in settings first.");
				return;
			}
			new Notice("Building index… this may take a moment.");

			try {
				const { AjsonParser } = await import("../parsers/AjsonParser");
				const parser = new AjsonParser(plugin.settings.enableDebugLogging);
				const parseResult = await parser.parseFile(exportPath);

				console.log("[Commands] Parse complete", {
					sources: parseResult.sources.length,
					blocks: parseResult.blocks.length,
					errors: parseResult.errors.length,
				});

				const buildResult = await plugin.indexBuilder.buildIndex(
					parseResult.sources,
					parseResult.blocks,
					false // incremental by default
				);

				new Notice(
					`Index built: ${buildResult.sourcesInserted + buildResult.sourcesUpdated} sources, ` +
					`${buildResult.blocksInserted + buildResult.blocksUpdated} blocks, ` +
					`${buildResult.embeddingsWritten} embeddings in ${buildResult.durationMs}ms`
				);
				console.log("[Commands] Build index complete", buildResult);
			} catch (e) {
				const msg = `Index build failed: ${String(e)}`;
				console.error("[Commands]", msg, e);
				new Notice(`Vault RAG Explorer: ${msg}`);
			}
		},
	});

	plugin.addCommand({
		id: "rebuild-vault-rag-index-force",
		name: "Force Rebuild Vault RAG index",
		callback: async () => {
			console.log("[VaultRagExplorer] Command: rebuild-vault-rag-index-force");

			const exportPath = plugin.settings.smartConnectionsExportPath?.trim();
			if (!exportPath) {
				new Notice(
					"Vault RAG Explorer: set a Smart Connections export path in settings first."
				);
				console.warn("[VaultRagExplorer] rebuild-vault-rag-index-force: no export path configured");
				return;
			}

			new Notice("Vault RAG Explorer: force building index… (check console for progress)");
			console.log("[VaultRagExplorer] Starting force index build from:", exportPath);

			try {
				const { AjsonParser } = await import("../parsers/AjsonParser");
				const parser = new AjsonParser(plugin.settings.enableDebugLogging);

				console.log("[VaultRagExplorer] Parsing .ajson files from:", exportPath);
				const parseResult = await parser.parseFile(exportPath);

				console.log("[VaultRagExplorer] Parse complete", {
					sources: parseResult.sources.length,
					blocks: parseResult.blocks.length,
					skipped: parseResult.skippedCount,
					parseErrors: parseResult.errors.length,
				});

				if (parseResult.errors.length > 0) {
					console.warn(
						"[VaultRagExplorer] Parse warnings:",
						parseResult.errors.slice(0, 10)
					);
				}

				if (parseResult.sources.length === 0 && parseResult.blocks.length === 0) {
					new Notice(
						"Vault RAG Explorer: no records found. Check your export path in settings."
					);
					console.error("[VaultRagExplorer] No records parsed — aborting index build");
					return;
				}

				console.log("[VaultRagExplorer] Writing to database (force)…");
				const buildResult = await plugin.indexBuilder.buildIndex(
					parseResult.sources,
					parseResult.blocks,
					true // forceRebuild: DO NOT skip unchanged records
				);

				console.log("[VaultRagExplorer] Index force build complete", buildResult);

				const summary =
					`Force index built in ${buildResult.durationMs}ms: ` +
					`${buildResult.sourcesInserted} sources inserted, ` +
					`${buildResult.blocksInserted} blocks inserted, ` +
					`${buildResult.embeddingsWritten} embeddings written.`;

				new Notice(`Vault RAG Explorer: ${summary}`);
				console.log("[VaultRagExplorer]", summary);

				if (buildResult.errors.length > 0) {
					console.warn(
						`[VaultRagExplorer] ${buildResult.errors.length} non-fatal index errors:`,
						buildResult.errors.slice(0, 10)
					);
				}
			} catch (e) {
				const msg = `Index build failed: ${String(e)}`;
				console.error("[VaultRagExplorer]", msg, e);
				new Notice(`Vault RAG Explorer: ${msg}`);
			}
		},
	});

	console.log("[VaultRagExplorer] Commands registered");
}