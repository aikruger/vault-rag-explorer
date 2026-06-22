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

			const smartFolder = plugin.getSmartFolderPath();
			if (!smartFolder) {
				new Notice("Set the Smart folder in settings first.");
				return;
			}
			const multiPath = `${smartFolder}/multi`;
			console.log('[Commands] Index build — scanning folder:', multiPath);

				console.log('[IndexBuilder] scan start', { smartFolderPath: smartFolder });

			console.log('[IndexBuilder] scan start', { smartFolderPath: smartFolder });

			const folderExists = await plugin.app.vault.adapter.exists(multiPath);
			if (!folderExists) {
				new Notice(`Vault RAG Explorer: folder not found: ${multiPath}. Check Smart Connections has indexed your vault.`);
				return;
			}
			new Notice("Building index… this may take a moment.");

			try {
				const { AjsonParser } = await import("../parsers/AjsonParser");
				const parser = new AjsonParser(plugin.settings.enableDebugLogging);

				const listed = await plugin.app.vault.adapter.list(multiPath);
				const ajsonFiles = listed.files.filter(f => f.endsWith('.ajson'));
				console.log(`[Commands] Found ${ajsonFiles.length} .ajson files to index`);

				if (ajsonFiles.length === 0) {
					new Notice('Vault RAG Explorer: no .ajson files found. Has Smart Connections indexed your vault?');
					return;
				}

				const allSources: any[] = [];
				const allBlocks: any[] = [];
				const allErrors: any[] = [];
				let skipped = 0;
					let parsedOk = 0;
					const failedFiles: string[] = [];
					const modelCounts = new Map<string, number>();

				for (const filePath of ajsonFiles) {
					try {
						const content = await plugin.app.vault.adapter.read(filePath);
						const result = parser.parseContent(content, filePath);
						allSources.push(...result.sources);
						allBlocks.push(...result.blocks);
						allErrors.push(...result.errors);
						skipped += result.skippedCount ?? 0;
					} catch (e) {
						console.warn(`[Commands] Failed to parse ${filePath}:`, e);
						allErrors.push(`Parse error in ${filePath}: ${String(e)}`);
					}
				}

				console.log(`[Commands] Directory parse complete — sources=${allSources.length} blocks=${allBlocks.length} skipped=${skipped} errors=${allErrors.length}`);

				const buildResult = await plugin.indexBuilder.buildIndex(
					allSources,
					allBlocks,
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

			const smartFolder = plugin.getSmartFolderPath();
			if (!smartFolder) {
				new Notice("Set the Smart folder in settings first.");
				return;
			}
			const multiPath = `${smartFolder}/multi`;
			console.log('[Commands] Index force build — scanning folder:', multiPath);

			const folderExists = await plugin.app.vault.adapter.exists(multiPath);
			if (!folderExists) {
				new Notice(`Vault RAG Explorer: folder not found: ${multiPath}. Check Smart Connections has indexed your vault.`);
				return;
			}

			new Notice("Vault RAG Explorer: force building index… (check console for progress)");

			try {
				const { AjsonParser } = await import("../parsers/AjsonParser");
				const parser = new AjsonParser(plugin.settings.enableDebugLogging);

				const listed = await plugin.app.vault.adapter.list(multiPath);
				const ajsonFiles = listed.files.filter(f => f.endsWith('.ajson'));

				console.log('[IndexBuilder] scan results', {
					ajsonFileCount: ajsonFiles.length,
					sampleFiles: ajsonFiles.slice(0, 5),
				});

				if (ajsonFiles.length === 0) {
					console.log('[IndexBuilder] no .ajson files found', { smartFolderPath: smartFolder });
					new Notice('Vault RAG Explorer: no .ajson files found. Has Smart Connections indexed your vault?');
					return;
				}

				const allSources: any[] = [];
				const allBlocks: any[] = [];
				const allErrors: any[] = [];
				let skipped = 0;

				for (const filePath of ajsonFiles) {
					try {
						const content = await plugin.app.vault.adapter.read(filePath);
						const result = parser.parseContent(content, filePath);
						allSources.push(...result.sources);
						allBlocks.push(...result.blocks);
						allErrors.push(...result.errors);
						skipped += result.skippedCount ?? 0;
					} catch (e) {
						console.warn(`[Commands] Failed to parse ${filePath}:`, e);
						allErrors.push(`Parse error in ${filePath}: ${String(e)}`);
					}
				}

				console.log(`[Commands] Directory parse complete — sources=${allSources.length} blocks=${allBlocks.length} skipped=${skipped} errors=${allErrors.length}`);

				if (allSources.length === 0 && allBlocks.length === 0) {
					new Notice(
						"Vault RAG Explorer: no records found. Check your export path in settings."
					);
					console.error("[VaultRagExplorer] No records parsed — aborting index build");
					return;
				}

				console.log("[VaultRagExplorer] Writing to database (force)…");
				const buildResult = await plugin.indexBuilder.buildIndex(
					allSources,
					allBlocks,
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

		plugin.addCommand({
			id: "debug-vault-rag-index-status",
			name: "Debug Index Status",
			callback: async () => {
				console.log("[VaultRagExplorer] Command: debug-vault-rag-index-status");
				try {
					const { getScalar, getRows } = await import("../db/IndexBuilder");
					const dbPath = plugin.settings.indexDbPath;
					const adapter = plugin.app.vault.adapter;
					const exists = await adapter.exists(dbPath);
					const stat = exists ? await adapter.stat(dbPath) : { size: 0 };

					const rawDb = plugin.db.getDb();
					console.log('[VaultRagExplorerPlugin] debug index status', {
						dbPath,
						exists,
						size: stat?.size,
						tables: getRows(rawDb, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`),
						counts: {
							sources: getScalar(rawDb, 'SELECT COUNT(*) FROM sources'),
							blocks: getScalar(rawDb, 'SELECT COUNT(*) FROM blocks'),
							embeddings: getScalar(rawDb, 'SELECT COUNT(*) FROM embeddings'),
						},
						embeddingsByModel: getRows(rawDb, `
							SELECT model_name as modelname, COUNT(*) AS count
							FROM embeddings
							GROUP BY model_name
							ORDER BY count DESC
						`),
						sampleEmbeddings: getRows(rawDb, `
							SELECT owner_type as ownertype, owner_id as ownerid, model_name as modelname, dim
							FROM embeddings
							LIMIT 5
						`),
					});
					new Notice("Debug Index Status logged to console.");
				} catch (e) {
					console.error("[VaultRagExplorer] Debug Index Status failed:", e);
					new Notice("Debug Index Status failed. Check console.");
				}
			},
		});

		plugin.addCommand({
			id: "debug-parse-first-ajson-file",
			name: "Debug Parse First AJSON File",
			callback: async () => {
				console.log("[VaultRagExplorer] Command: debug-parse-first-ajson-file");
				try {
					const smartFolder = plugin.getSmartFolderPath();
					if (!smartFolder) {
						new Notice("Set the Smart folder in settings first.");
						return;
					}
					const multiPath = `${smartFolder}/multi`;
					const listed = await plugin.app.vault.adapter.list(multiPath);
					const ajsonFiles = listed.files.filter(f => f.endsWith('.ajson'));

					if (ajsonFiles.length === 0) {
						new Notice("No .ajson files found to parse.");
						return;
					}

					const firstFile = ajsonFiles[0];
					if (!firstFile) return;

					console.log(`[VaultRagExplorer] Parsing first file: ${firstFile}`);
					const content = await plugin.app.vault.adapter.read(firstFile);

					const { AjsonParser } = await import("../parsers/AjsonParser");
					const parser = new AjsonParser(true);
					const result = parser.parseContent(content, firstFile);

					console.log(`[VaultRagExplorer] First file parse result:`, {
						filePath: firstFile,
						sources: result.sources.length,
						blocks: result.blocks.length,
						errors: result.errors.length,
					});
					new Notice(`Parsed ${firstFile}. Check console for details.`);
				} catch (e) {
					console.error("[VaultRagExplorer] Debug Parse First AJSON File failed:", e);
					new Notice("Debug Parse First AJSON File failed. Check console.");
				}
			},
		});

	console.log("[VaultRagExplorer] Commands registered");
}