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

import { SmartConnectionsBridge } from "./services/SmartConnectionsBridge";
import { EmbeddingReader } from "./db/EmbeddingReader";
import { LockedNodesService } from "./services/LockedNodesService";
import { SessionService } from "./services/SessionService";
import { RagExportService } from "./services/RagExportService";
import { WikilinkExpander } from "./db/WikilinkExpander";

const LOG_PREFIX = "[VaultRagExplorerPlugin]";

export default class VaultRagExplorerPlugin extends Plugin {
	settings!: VaultRagExplorerSettings;
	view: VaultRagExplorerView | null = null;
	db!: Database;
	public indexBuilder!: IndexBuilder;
	public embeddingService!: SmartConnectionsBridge;
	public embeddingReader!: EmbeddingReader;
	public lockedNodesService!: LockedNodesService;
	public sessionService!: SessionService;
	public ragExportService!: RagExportService;
	public wikilinkExpander!: WikilinkExpander;

	async onload(): Promise<void> {
		console.log(`${LOG_PREFIX} ✅ VaultRagExplorerPlugin.onload() — boilerplate replaced successfully`);
		console.log(`${LOG_PREFIX} onload start`);
		console.log(`${LOG_PREFIX} default settings loaded`, DEFAULT_SETTINGS);

		await this.loadSettings();
		console.log(`${LOG_PREFIX} onload using smart folder`, this.settings.smartFolderPath);

		await this.initialiseServices();

		this.registerView(
			VIEW_TYPE_VAULT_RAG_EXPLORER,
			(leaf: WorkspaceLeaf) => {
				console.log(`${LOG_PREFIX} Creating view instance`);
				this.view = new VaultRagExplorerView(leaf, this);
				return this.view;
			}
		);

		registerCommands(this);

		this.addRibbonIcon("network", "Open Vault RAG Explorer", async () => {
			console.log(`${LOG_PREFIX} ribbon clicked`);
			await this.activateView();
		});

		this.addSettingTab(new VaultRagExplorerSettingTab(this.app, this));
		console.log(`${LOG_PREFIX} settings tab registered`);

		this.app.workspace.onLayoutReady(() => {
			console.log(`${LOG_PREFIX} layout ready`);
			if (!this.settings.smartFolderPath.trim()) {
				console.warn(`${LOG_PREFIX} smartFolderPath is not configured — showing notice`);
				new Notice(
					"Vault RAG Explorer: set the Smart folder in Settings before running queries.",
					8000
				);
			} else {
				console.log(`${LOG_PREFIX} smartFolderPath configured:`, this.settings.smartFolderPath);
			}
		});

		console.log(`${LOG_PREFIX} onload complete`);
	}

	onunload(): void {
		console.log(`${LOG_PREFIX} onunload`);

		this.view = null;
		if (this.db) {
			this.db.close();
		}
		console.log(`${LOG_PREFIX} Plugin unloaded`);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		console.log(`${LOG_PREFIX} settings loaded`, this.settings);
	}

	async saveSettings(): Promise<void> {
		console.log(`${LOG_PREFIX} saving settings`, this.settings);
		await this.saveData(this.settings);
	}

	getSmartFolderPath(): string {
		const value = this.settings.smartFolderPath.trim();
		console.log(`${LOG_PREFIX} getSmartFolderPath`, value);
		return value;
	}

	private async initialiseServices(): Promise<void> {
		const smartFolderPath = this.getSmartFolderPath();

		console.log(`${LOG_PREFIX} initialiseServices`, { smartFolderPath });

		// Initialize Database
		this.db = new Database(this.app, this.settings.indexDbPath, this);
		console.log(`${LOG_PREFIX} Database instance created with pluginDir from manifest`);
		await this.db.init();

		this.indexBuilder = new IndexBuilder(this.db, this.settings.enableDebugLogging);
		console.log(`${LOG_PREFIX} IndexBuilder instantiated`);

		this.embeddingService = new SmartConnectionsBridge(this.app);
		console.log(`${LOG_PREFIX} SmartConnectionsBridge ready — SC model=${this.embeddingService.getModelName()}`);

		this.embeddingReader = new EmbeddingReader(this.db);
		console.log(`${LOG_PREFIX} EmbeddingReader ready`);

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