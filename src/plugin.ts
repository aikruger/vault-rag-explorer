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
import { Database } from "./db/Database";
import { AjsonParser } from "./parsers/AjsonParser";
import { IndexBuilder } from "./db/IndexBuilder";

export default class VaultRagExplorerPlugin extends Plugin {
	settings!: VaultRagExplorerSettings;
	view: VaultRagExplorerView | null = null;
	db!: Database;
	public indexBuilder!: IndexBuilder;

	async onload(): Promise<void> {
		console.log("[VaultRagExplorer] Plugin loading");

		await this.loadSettings();
		console.log("[VaultRagExplorer] Settings loaded", this.settings);

		// Initialize Database
		this.db = new Database(this.app, this.settings.indexDbPath);
		await this.db.init();

		this.indexBuilder = new IndexBuilder(this.db, this.settings.enableDebugLogging);
		console.log("[VaultRagExplorer] IndexBuilder instantiated");

		this.registerView(
			VIEW_TYPE_VAULT_RAG_EXPLORER,
			(leaf: WorkspaceLeaf) => {
				console.log("[VaultRagExplorer] Creating view instance");
				this.view = new VaultRagExplorerView(leaf, this);
				return this.view;
			}
		);

		registerCommands(this);

		this.addRibbonIcon("network", "Open Vault RAG Explorer", async () => {
			console.log("[VaultRagExplorer] Ribbon click: open view");
			await this.activateView();
		});

		this.addSettingTab(new VaultRagExplorerSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			console.log("[VaultRagExplorer] Layout ready");
		});

		console.log("[VaultRagExplorer] Plugin loaded successfully");
	}

	onunload(): void {
		console.log("[VaultRagExplorer] Plugin unloading");

		this.view = null;
		if (this.db) {
			this.db.close();
		}
		console.log("[VaultRagExplorer] Plugin unloaded");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		console.log("[VaultRagExplorer] Saving settings");
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		console.log("[VaultRagExplorer] Activating view");

		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_VAULT_RAG_EXPLORER)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
			if (!leaf) {
				new Notice("Could not create Vault RAG Explorer leaf");
				console.error("[VaultRagExplorer] Failed to obtain workspace leaf");
				return;
			}
			await leaf.setViewState({
				type: VIEW_TYPE_VAULT_RAG_EXPLORER,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);
		console.log("[VaultRagExplorer] View activated");
	}
}

class VaultRagExplorerSettingTab extends PluginSettingTab {
	plugin: VaultRagExplorerPlugin;

	constructor(app: App, plugin: VaultRagExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Vault RAG Explorer Settings").setHeading();

		new Setting(containerEl)
			.setName("Smart Connections export path")
			.setDesc("Path to Smart Connections export folder or source file")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/export")
					.setValue(this.plugin.settings.smartConnectionsExportPath)
					.onChange(async (value) => {
						console.log("[VaultRagExplorer] Setting changed: smartConnectionsExportPath", value);
						this.plugin.settings.smartConnectionsExportPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Index DB path")
			.setDesc("SQLite DB path for the local retrieval index")
			.addText((text) =>
				text
					.setPlaceholder(".obsidian/plugins/vault-rag-explorer/data/smart_index.db")
					.setValue(this.plugin.settings.indexDbPath)
					.onChange(async (value) => {
						console.log("[VaultRagExplorer] Setting changed: indexDbPath", value);
						this.plugin.settings.indexDbPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Embedding model name")
			.setDesc("Must match the model used to build the index")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.embeddingModelName)
					.onChange(async (value) => {
						console.log("[VaultRagExplorer] Setting changed: embeddingModelName", value);
						this.plugin.settings.embeddingModelName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default top K")
			.setDesc("Default number of retrieval results")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.defaultTopK))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed <= 0) return;
						console.log("[VaultRagExplorer] Setting changed: defaultTopK", parsed);
						this.plugin.settings.defaultTopK = parsed;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Enable verbose console logging")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLogging)
					.onChange(async (value) => {
						console.log("[VaultRagExplorer] Setting changed: enableDebugLogging", value);
						this.plugin.settings.enableDebugLogging = value;
						await this.plugin.saveSettings();
					})
			);
	}
}