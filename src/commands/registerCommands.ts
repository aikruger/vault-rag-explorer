interface AjsonParseResult {
  sources: { embeddings: unknown[] }[];
  blocks: { embeddings: unknown[] }[];
  errors: unknown[];
  skippedCount?: number;
}
import type { FileSystemAdapter } from "../types";
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

				const allSources: unknown[] = [];
				const allBlocks: unknown[] = [];
				const allErrors: unknown[] = [];
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

					new Notice("Vault RAG Explorer: Indexing is now handled by the standalone CLI indexer. Please run `node indexer/build-index.js <vault-path>` from the terminal.");
					console.log("[VaultRagExplorer] build index command retired — use standalone CLI indexer.");
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

				const allSources: unknown[] = [];
				const allBlocks: unknown[] = [];
				const allErrors: unknown[] = [];
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

					new Notice("Vault RAG Explorer: Indexing is now handled by the standalone CLI indexer. Please run `node indexer/build-index.js <vault-path>` from the terminal.");
					console.log("[VaultRagExplorer] force build index command retired — use standalone CLI indexer.");
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
				const fs = await import("fs");
				const path = await import("path");

				const basePath = (plugin.app.vault.adapter as unknown as FileSystemAdapter).basePath;
					console.log('[TypeFix] registerCommands: resolved basePath via FileSystemAdapter', { basePath });
				const smartFolder = path.join(basePath, ".smart-env", "multi");

				console.log("[VaultRagExplorerPlugin] debug-parse-first-ajson-file", { smartFolder });

				if (!fs.existsSync(smartFolder)) {
					console.log("[VaultRagExplorerPlugin] FATAL: smart folder missing", { smartFolder });
					new Notice("Smart folder not found: " + smartFolder);
					return;
				}

				const all = fs.readdirSync(smartFolder);
				const ajson = all.filter((f: string) => f.endsWith(".ajson"));
				console.log("[VaultRagExplorerPlugin] ajson files found", {
					total: all.length,
					ajsonCount: ajson.length,
					first5: ajson.slice(0, 5),
				});

				if (ajson.length === 0) {
					const rootFolder = path.join(basePath, ".smart-env");
					let rootAll: string[] = [];
					try {
						rootAll = fs.readdirSync(rootFolder);
					} catch(e) { /* ignore */ }
					console.log("[VaultRagExplorerPlugin] root .smart-env contents", { rootAll });
					new Notice("No .ajson files in multi/ — check console for root folder contents");
					return;
				}

				const firstFile = ajson[0];
				if (!firstFile) return;

				const firstPath = path.join(smartFolder, firstFile);
				const raw = fs.readFileSync(firstPath, "utf8");

				console.log("[VaultRagExplorerPlugin] first file raw", {
					fileName: firstFile,
					rawLength: raw.length,
					startsWithNewline: raw.startsWith("\n"),
					first400: raw.slice(0, 400).replace(/\n/g, "\\n"),
				});

				let parsed: AjsonParseResult | undefined;
				try {
					const { AjsonParser } = await import("../parsers/AjsonParser");
					const parser = new AjsonParser(true);
					parsed = parser.parseContent(raw, firstPath);
					console.log('[TypeFix] registerCommands: parseContent result typed as AjsonParseResult');
				} catch (err) {
					console.log("[VaultRagExplorerPlugin] parser THREW", { error: String(err), stack: (err as Error).stack });
					new Notice("Parser threw — see console");
					return;
				}

				const totalEmbeddings =
					(parsed?.sources?.reduce((a: number, s: unknown) => a + (s.embeddings ? s.embeddings.length : 0), 0) ?? 0) +
					(parsed?.blocks?.reduce((a: number, b: unknown) => a + (b.embeddings ? b.embeddings.length : 0), 0) ?? 0);

				console.log("[VaultRagExplorerPlugin] parser result", {
					sources: (parsed)?.sources?.length ?? "MISSING",
					blocks: (parsed)?.blocks?.length ?? "MISSING",
					embeddings: totalEmbeddings,
					sampleEmbedding: (parsed)?.sources?.[0]?.embeddings?.[0] ?? (parsed)?.blocks?.[0]?.embeddings?.[0] ?? null,
				});

				new Notice(`Parse result: ${totalEmbeddings} embeddings from first file`);
			},
		});

		plugin.addCommand({
			id: "debug-run-index-build",
			name: "Vault RAG Explorer: Debug — Run Index Build",
			callback: async () => {
				console.log("[VaultRagExplorerPlugin] === INDEX BUILD START ===");

				// Step A: resolve paths
				const basePath = (plugin.app.vault.adapter as unknown as FileSystemAdapter).basePath;
				console.log('[TypeFix] registerCommands: resolved basePath via FileSystemAdapter', { basePath });
				const path = await import("path");
				const pluginDir = path.join(basePath, ".obsidian", "plugins", plugin.manifest.id);
				const dataDir = path.join(pluginDir, "data");
				const dbPath = path.join(dataDir, "smart_index.db");
				const smartFolderPath = path.join(basePath, ".smart-env", "multi");

				console.log("[VaultRagExplorerPlugin] resolved paths", {
					basePath,
					pluginDir,
					dataDir,
					dbPath,
					smartFolderPath,
				});

				// Step B: check smart folder exists
				const fs = await import("fs");
				const smartFolderExists = fs.existsSync(smartFolderPath);
				console.log("[VaultRagExplorerPlugin] smart folder exists?", {
					smartFolderPath,
					exists: smartFolderExists,
				});

				if (!smartFolderExists) {
					console.log("[VaultRagExplorerPlugin] FATAL: smart folder not found — aborting");
					new Notice("Vault RAG Explorer: .smart-env/multi folder not found. Has Smart Connections run?");
					return;
				}

				// Step C: list .ajson files
				const allFiles = fs.readdirSync(smartFolderPath);
				const ajsonFiles = allFiles.filter((f: string) => f.endsWith(".ajson"));
				console.log("[VaultRagExplorerPlugin] ajson file discovery", {
					totalFilesInFolder: allFiles.length,
					ajsonCount: ajsonFiles.length,
					first5: ajsonFiles.slice(0, 5),
				});

				if (ajsonFiles.length === 0 || !ajsonFiles[0]) {
					console.log("[VaultRagExplorerPlugin] FATAL: no .ajson files found — aborting");
					new Notice("Vault RAG Explorer: No .ajson files found in .smart-env/multi");
					return;
				}

				// Step D: parse first file manually to test parser
				const firstFile = path.join(smartFolderPath, ajsonFiles[0]);
				const rawContent = fs.readFileSync(firstFile, "utf8");
				console.log("[VaultRagExplorerPlugin] first file raw preview", {
					file: ajsonFiles[0],
					rawLength: rawContent.length,
					startsWithNewline: rawContent.startsWith("\n"),
					first300chars: rawContent.slice(0, 300).replace(/\n/g, "\\n"),
				});

				// Step E: trigger the actual index build
				console.log("[VaultRagExplorerPlugin] triggering indexBuilder.buildIndex()");
				try {
					const { AjsonParser } = await import("../parsers/AjsonParser");
					const parser = new AjsonParser(plugin.settings.enableDebugLogging);

					const allSources: unknown[] = [];
					const allBlocks: unknown[] = [];

						await plugin.indexBuilder.buildFromPath(smartFolderPath, ajsonFiles.map((f: string) => path.join(smartFolderPath, f)));
						console.log("[VaultRagExplorerPlugin] buildFromPath() completed without throwing");
				} catch (err) {
					console.log("[VaultRagExplorerPlugin] buildIndex() THREW", { error: String(err), stack: (err as Error).stack });
					new Notice("Vault RAG Explorer: Index build failed — see console");
					return;
				}

				// Step F: verify DB after build
				const dbExists = fs.existsSync(dbPath);
				const dbSize = dbExists ? fs.statSync(dbPath).size : 0;
				console.log("[VaultRagExplorerPlugin] post-build DB stat", {
					dbPath,
					exists: dbExists,
					sizeBytes: dbSize,
				});

				new Notice(`Vault RAG Explorer: Index build complete — DB size: ${dbSize} bytes`);
				console.log("[VaultRagExplorerPlugin] === INDEX BUILD END ===");
			}
		});

		plugin.addCommand({
			id: 'build-index',
			name: 'Vault RAG Explorer: Build Index',
			callback: async () => {
				if (!plugin.settings.smartFolderPath) {
					new Notice('Please set the Smart Connections folder in plugin settings first.');
					return;
				}
				new Notice('Building index…');
				try {
					const result = await plugin.buildIndexFromSettings();
					plugin.settings.lastIndexBuild = Date.now();
					await plugin.saveSettings();
					new Notice(`Done: ${result.embeddings} embeddings indexed`);
				} catch (err) {
					new Notice('Build failed: ' + (err as Error).message);
					console.error('[VaultRagPlugin] command build-index failed', err);
				}
			}
		});

	console.log("[VaultRagExplorer] Commands registered");
}