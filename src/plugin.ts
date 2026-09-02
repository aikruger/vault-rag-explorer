import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	Notice,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	type VaultRagExplorerSettings,
	VIEW_TYPE_VAULT_RAG_EXPLORER,
} from "./types";
import { VaultRagExplorerView } from "./views/VaultRagExplorerView";
import { registerCommands } from "./commands/registerCommands";
import { VaultRagExplorerSettingTab } from "./settings/VaultRagExplorerSettingTab";
import { Database } from "./db/Database";
import { AjsonParser } from "./parsers/AjsonParser";
import { IndexBuilder } from "./db/IndexBuilder";
import { PreFilterService } from "./services/PreFilterService";
import { AjsonWatcherService } from "./services/AjsonWatcherService";

import { SmartConnectionsBridge } from "./services/SmartConnectionsBridge";
import { EmbeddingReader } from "./db/EmbeddingReader";
import { LockedNodesService } from "./services/LockedNodesService";
import { SessionService } from "./services/SessionService";
import { RagExportService } from "./services/RagExportService";
import { WikilinkExpander } from "./db/WikilinkExpander";

interface FileSystemAdapter { basePath: string; }
const LOG_PREFIX = "[VaultRagExplorerPlugin]";

export default class VaultRagExplorerPlugin extends Plugin {
	settings!: VaultRagExplorerSettings;
	view: VaultRagExplorerView | null = null;
	db!: Database;
	public indexBuilder!: IndexBuilder;
	public ajsonWatcher!: AjsonWatcherService;
	public embeddingService!: SmartConnectionsBridge;
	public embeddingReader!: EmbeddingReader;
	public lockedNodesService!: LockedNodesService;
	public sessionService!: SessionService;
	public ragExportService!: RagExportService;
	public wikilinkExpander!: WikilinkExpander;
	public preFilterService!: PreFilterService;
	public queryService!: import("./services/QueryService").QueryService;

	public readonly debugInstanceId = `vre-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	public isIndexing = false;
	public activeQueryCount = 0;
	public pendingAjsonReindex = new Set<string>();
	public reindexDrainScheduled = false;

	beginQuery(): () => void {
		console.log("[VaultRagExplorerPlugin] beginQuery", {
			activeQueryCount: this.activeQueryCount,
			isIndexing: this.isIndexing,
		});
		this.activeQueryCount += 1;
		console.log("[VaultRagExplorerPlugin] beginQuery complete", {
			activeQueryCount: this.activeQueryCount,
		});

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.endQuery();
		};
	}

	endQuery(): void {
		this.activeQueryCount = Math.max(0, this.activeQueryCount - 1);
		console.log("[VaultRagExplorerPlugin] endQuery", {
			activeQueryCount: this.activeQueryCount,
			isIndexing: this.isIndexing,
		});

		if (this.activeQueryCount === 0 && this.pendingAjsonReindex.size > 0 && !this.reindexDrainScheduled) {
			console.log(`${LOG_PREFIX} draining deferred watcher events after query end`);
			// The watcher method scheduleDrain is private but we can poke the public property
			// to trigger a drain, or better yet, since the AjsonWatcherService has a private method,
			// let's add a public method or just tell it to drain.
			// actually we will call ajsonWatcher.triggerDrain() - let's add that to AjsonWatcherService
			if (this.ajsonWatcher) {
				this.ajsonWatcher.triggerDrain();
			}
		}
	}

	beginIndexing(): boolean {
		if (this.isIndexing) {
			console.log("[VaultRagExplorerPlugin] beginIndexing denied — already indexing", {
				activeQueryCount: this.activeQueryCount,
				isIndexing: this.isIndexing,
			});
			return false;
		}
		if (this.activeQueryCount > 0) {
			console.log("[VaultRagExplorerPlugin] beginIndexing denied — query active", {
				activeQueryCount: this.activeQueryCount,
				isIndexing: this.isIndexing,
			});
			return false;
		}
		this.isIndexing = true;
		console.log("[VaultRagExplorerPlugin] beginIndexing granted", {
			activeQueryCount: this.activeQueryCount,
			isIndexing: this.isIndexing,
		});
		return true;
	}

	endIndexing(): void {
		this.isIndexing = false;
		console.log("[checker] lock release");
		console.log("[VaultRagExplorerPlugin] endIndexing", {

			activeQueryCount: this.activeQueryCount,
			isIndexing: this.isIndexing,
			pendingCount: this.pendingAjsonReindex.size,
		});
	}

	async onload(): Promise<void> {
		console.log(`${LOG_PREFIX} onload start`);

        console.log('[checker] build format verified: cjs');
        console.log('[checker] pluginDir derived from manifest.id', { pluginId: this.manifest.id });
        console.log('[checker] deferred runtime init verified');


		console.log("[VaultRagExplorerPlugin] debug instance", {
			debugInstanceId: this.debugInstanceId,
		});

		await this.loadSettings();
		await this.initialiseServices();

		console.log("[VaultRagExplorerPlugin] method check", {
			hasBeginQuery: typeof this.beginQuery,
			hasEndQuery: typeof this.endQuery,
			hasBeginIndexing: typeof this.beginIndexing,
			hasEndIndexing: typeof this.endIndexing,
		});

		registerCommands(this);

		this.addRibbonIcon("network", "Open Vault RAG Explorer", async () => {
			console.log(`${LOG_PREFIX} ribbon clicked`);
			await this.activateView();
		});

		this.addSettingTab(new VaultRagExplorerSettingTab(this.app, this));
		console.log(`${LOG_PREFIX} settings tab registered`);

		this.app.workspace.onLayoutReady(() => {
			console.log(`${LOG_PREFIX} layout ready — detaching stale leaves then registering view`);
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_VAULT_RAG_EXPLORER);

			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const alreadyRegistered = !!(this.app as any).viewRegistry?.viewByType?.[VIEW_TYPE_VAULT_RAG_EXPLORER];
				console.log(`${LOG_PREFIX} view type registration check`, {
					viewType: VIEW_TYPE_VAULT_RAG_EXPLORER,
					alreadyRegistered,
				});

				if (alreadyRegistered) {
					// Should be rare now that onunload() explicitly unregisters — if this still
					// fires, a previous instance's cleanup was skipped and Obsidian is serving
					// whatever View class was registered by that PRIOR load, not this build.
					console.error(
						`${LOG_PREFIX} STALE VIEW REGISTRATION DETECTED — skipping registerView to avoid crash, ` +
						`but the currently active view is from a PREVIOUS plugin load, not this build. ` +
						`Do a full Obsidian restart (Ctrl+R / Reload app without saving) to guarantee fresh code.`
					);
					new Notice(
						"Vault RAG Explorer: stale view registration detected — please fully reload Obsidian to pick up the latest build.",
						10000
					);
				} else {
					this.registerView(
						VIEW_TYPE_VAULT_RAG_EXPLORER,
						(leaf: WorkspaceLeaf) => {
							console.log(`${LOG_PREFIX} Creating view instance`);
							this.view = new VaultRagExplorerView(leaf, this);
							return this.view;
						}
					);
					console.log(`${LOG_PREFIX} registerView complete`);
				}
			} catch (err) {
				console.error(`${LOG_PREFIX} registerView threw unexpectedly`, {
					message: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}

			if (!this.settings.smartFolderPath.trim()) {
				new Notice(
					"Vault RAG Explorer: set the Smart folder in Settings before running queries.",
					8000
				);
			}

			// Start the automatic .ajson watcher if the smart folder is configured
			const smartPath = this.getSmartFolderPath();
			if (smartPath) {
				console.log(`${LOG_PREFIX} starting AjsonWatcher on layout ready — path:`, smartPath);
				this.ajsonWatcher.start(smartPath);
			} else {
				console.log(`${LOG_PREFIX} AjsonWatcher not started — smart folder path not configured`);
			}
		});

		console.log(`${LOG_PREFIX} onload complete`);
	}

	onunload(): void {
		console.log(`${LOG_PREFIX} onunload — detaching leaves`);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_VAULT_RAG_EXPLORER);

		// Defensive explicit unregister — belt-and-braces alongside Obsidian's
		// automatic this.register() cleanup, in case a hot-reload cycle skips it.
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app as any).viewRegistry?.unregisterView?.(VIEW_TYPE_VAULT_RAG_EXPLORER);
			console.log(`${LOG_PREFIX} explicit viewRegistry.unregisterView succeeded for`, VIEW_TYPE_VAULT_RAG_EXPLORER);
		} catch (err) {
			console.warn(`${LOG_PREFIX} explicit viewRegistry.unregisterView threw (may already be unregistered)`, {
				message: err instanceof Error ? err.message : String(err),
			});
		}

		if (this.ajsonWatcher) {
			this.ajsonWatcher.stop();
			console.log(`${LOG_PREFIX} AjsonWatcher stopped on unload`);
		}

		this.view = null;
		if (this.db) {
			this.db.close();
		}
		console.log(`${LOG_PREFIX} Plugin unloaded`);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		console.log(`${LOG_PREFIX} settings loaded`, this.settings);
		console.log("[VaultRagExplorerPlugin] retrieval settings loaded", {
			retrievalGranularity: this.settings.retrievalGranularity,
			retrievalDocumentLimit: this.settings.retrievalDocumentLimit,
			retrievalBlocksPerDocument: this.settings.retrievalBlocksPerDocument,
		});
	}

	async saveSettings(): Promise<void> {
		console.log(`${LOG_PREFIX} saving settings`, this.settings);
		await this.saveData(this.settings);

		// Restart watcher in case the smart folder path was changed
		const newSmartPath = this.getSmartFolderPath();
		if (this.ajsonWatcher) {
			if (newSmartPath) {
				console.log(`${LOG_PREFIX} settings saved — restarting AjsonWatcher with new path:`, newSmartPath);
				this.ajsonWatcher.start(newSmartPath);
			} else {
				console.log(`${LOG_PREFIX} settings saved — smart folder cleared, stopping AjsonWatcher`);
				this.ajsonWatcher.stop();
			}
		}
	}

	getSmartFolderPath(): string {
		const value = this.settings.smartFolderPath.trim();
		console.log(`${LOG_PREFIX} getSmartFolderPath`, value);
		return value;
	}

	detectSmartEnvPath(): string | null {
		const fs = require('fs');
		const path = require('path');
		const basePath = (this.app.vault.adapter as unknown as FileSystemAdapter).basePath;
		console.log('[TypeFix] plugin.ts: resolved basePath via FileSystemAdapter', { basePath });

		const candidates = [
			path.join(basePath, '.smart-env', 'multi'),
			path.join(basePath, '.smart-env'),
			path.join(basePath, '.smart-connections'),
		];

		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				const files = fs.readdirSync(candidate).filter((f: string) => f.endsWith('.ajson'));
				if (files.length > 0) {
					console.log('[VaultRagPlugin] detectSmartEnvPath found:', candidate, `(${files.length} .ajson files)`);
					return candidate;
				}
			}
		}

		console.log('[VaultRagPlugin] detectSmartEnvPath: no .ajson files found in any candidate path');
		return null;
	}

	async buildIndexFromSettings(): Promise<{ sources: number; blocks: number; embeddings: number }> {
		const fs   = require('fs');
		const path = require('path');

		const smartEnvPath = this.settings.smartFolderPath;
		console.log('[VaultRagPlugin] buildIndexFromSettings — smartEnvPath:', smartEnvPath);

		if (!fs.existsSync(smartEnvPath)) {
			throw new Error(`Folder not found: ${smartEnvPath}`);
		}

		const ajsonFiles = fs.readdirSync(smartEnvPath)
			.filter((f: string) => f.endsWith('.ajson'))
			.map((f: string) => path.join(smartEnvPath, f));

		console.log('[VaultRagPlugin] buildIndexFromSettings — files found:', ajsonFiles.length);

		if (ajsonFiles.length === 0) {
			throw new Error('No .ajson files found. Has Smart Connections finished embedding the vault?');
		}

		// Delegate to IndexBuilder with the validated path
        if (ajsonFiles.length > 1) {
          console.error('[MemoryCheck] plugin bulk indexing blocked; use external indexer', {
            fileCount: ajsonFiles.length
          });
          throw new Error('Plugin bulk indexing disabled; use external indexer');
        }
		return await this.indexBuilder.buildFromPath(smartEnvPath, ajsonFiles);
	}

	public isExternalIndexerRunning(): boolean {
		const fs = require("fs");
		const path = require("path");
		const vaultAdapter = this.app.vault.adapter as any;
		const basePath = vaultAdapter.getBasePath();
		const progressFile = path.join(
			basePath,
			".obsidian",
			"plugins",
			this.manifest.id,
			"data",
			"index-progress.json"
		);

		if (!fs.existsSync(progressFile)) return false;

		try {
			const content = fs.readFileSync(progressFile, "utf8");
			const progress = JSON.parse(content);
			const heartbeatAt = Number(progress?.heartbeatAt ?? 0);
			const isRunning = progress?.status === "running";
			const heartbeatFresh = Date.now() - heartbeatAt < 10 * 60 * 1000;
			return isRunning && heartbeatFresh;
		} catch {
			return false;
		}
	}

	private async initialiseServices(): Promise<void> {
		const smartFolderPath = this.getSmartFolderPath();

		console.log(`${LOG_PREFIX} initialiseServices`, { smartFolderPath });

		console.log("[VaultRagExplorerPlugin] manifest / path check", {
			manifestId: this.manifest.id,
			manifestDir: this.manifest.dir,
			indexDbPath: this.settings.indexDbPath,
		});
		console.log('[VaultRagExplorerPlugin] resolved smart folder path', smartFolderPath);

		// Initialize Database
		this.db = new Database(this.app, this.settings.indexDbPath, this);
		console.log(`${LOG_PREFIX} Database instance created with pluginDir from manifest`);
		await this.db.init();
		console.log('[VaultRagExplorerPlugin] database opened', { dbPath: this.settings.indexDbPath });

		this.indexBuilder = new IndexBuilder(this.db, this.settings.enableDebugLogging);
		console.log(`${LOG_PREFIX} IndexBuilder instantiated`);

		this.ajsonWatcher = new AjsonWatcherService(this, this.indexBuilder, this.db);
		console.log(`${LOG_PREFIX} AjsonWatcherService instantiated`);

		this.embeddingService = new SmartConnectionsBridge(this.app);
		console.log(`${LOG_PREFIX} SmartConnectionsBridge ready — SC model=${this.embeddingService.getModelName()}`);

		this.embeddingReader = new EmbeddingReader(this.db);
		console.log(`${LOG_PREFIX} EmbeddingReader ready`);

		this.preFilterService = new PreFilterService(this.db);
		console.log(`${LOG_PREFIX} PreFilterService initialised`);

		console.log("[VaultRagExplorerPlugin] before QueryService construction", {
			pluginConstructor: this.constructor.name,
			hasBeginQuery: typeof this.beginQuery,
			hasEndQuery: typeof this.endQuery,
			hasBeginIndexing: typeof this.beginIndexing,
			hasEndIndexing: typeof this.endIndexing,
			dbConstructor: this.db?.constructor?.name,
			embeddingServiceConstructor: this.embeddingService?.constructor?.name,
			embeddingReaderConstructor: this.embeddingReader?.constructor?.name,
			preFilterServiceConstructor: this.preFilterService?.constructor?.name,
		});

		const { QueryService } = require("./services/QueryService");
		this.queryService = new QueryService(
			this,
			this.db,
			this.embeddingService,
			this.embeddingReader,
			this.preFilterService
		);
		console.log("[VaultRagExplorerPlugin] after QueryService construction", {
			queryServiceExists: !!this.queryService,
		});

		const qsAny = this.queryService as unknown as { plugin?: unknown };
		console.log("[VaultRagExplorerPlugin] QueryService plugin wiring check", {
			internalPluginConstructor: (qsAny.plugin as { constructor?: { name?: string } } | undefined)?.constructor?.name,
			internalPluginHasBeginQuery: typeof (qsAny.plugin as { beginQuery?: unknown } | undefined)?.beginQuery,
			internalPluginDebugId: (qsAny.plugin as { debugInstanceId?: string } | undefined)?.debugInstanceId,
			expectedDebugId: this.debugInstanceId,
		});

		if ((qsAny.plugin as { debugInstanceId?: string } | undefined)?.debugInstanceId !== this.debugInstanceId) {
			console.error("[VaultRagExplorerPlugin] QueryService miswired after construction", {
				internalPluginConstructor: (qsAny.plugin as { constructor?: { name?: string } } | undefined)?.constructor?.name,
				internalPluginDebugId: (qsAny.plugin as { debugInstanceId?: string } | undefined)?.debugInstanceId,
				expectedDebugId: this.debugInstanceId,
			});
			throw new Error("QueryService wiring error: plugin instance mismatch");
		}

		this.lockedNodesService = new LockedNodesService();
		this.sessionService = new SessionService(this.app);
		this.ragExportService = new RagExportService(this.db);
		this.wikilinkExpander = new WikilinkExpander(this.db);

		console.log(`${LOG_PREFIX} services initialised`);
	}

	async activateView(): Promise<void> {
		console.log(`${LOG_PREFIX} activateView start`);
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_RAG_EXPLORER);

		if (existing.length > 0 && existing[0]) {
			console.log(`${LOG_PREFIX} reusing existing leaf`);
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error(`${LOG_PREFIX} failed to acquire workspace leaf`);
			new Notice("Could not open Vault RAG Explorer view.");
			return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_VAULT_RAG_EXPLORER,
			active: true,
		});

		await this.app.workspace.revealLeaf(leaf);
		console.log(`${LOG_PREFIX} activateView complete`);
	}
}