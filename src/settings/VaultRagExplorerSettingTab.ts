import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";

const LOG_PREFIX = "[VaultRagExplorerSettingTab]";

export class VaultRagExplorerSettingTab extends PluginSettingTab {
	plugin: VaultRagExplorerPlugin;

	constructor(app: App, plugin: VaultRagExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		console.log("[VaultRagExplorerSettingTab] ✅ Real settings tab constructed — not SampleSettingTab");
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		console.log(`${LOG_PREFIX} display`);

		new Setting(containerEl).setName("Vault RAG Explorer Settings").setHeading();

		containerEl.createEl("p", {
			text: "Configure where Vault RAG Explorer should look for Smart Connections-derived files or related indexed data.",
		});

		new Setting(containerEl)
			.setName("Smart folder")
			.setDesc("Path to the folder containing Smart Connections exports, derived SQLite data, or related smart files.")
			.addText((text) =>
				text
					.setPlaceholder("e.g. .smart-connections")
					.setValue(this.plugin.settings.smartFolderPath)
					.onChange(async (value) => {
						const nextValue = value.trim();
						console.log(`${LOG_PREFIX} smart folder updated`, nextValue);

						this.plugin.settings.smartFolderPath = nextValue;
						await this.plugin.saveSettings();

						new Notice(
							nextValue
								? `Vault RAG Explorer Smart folder set to: ${nextValue}`
								: "Vault RAG Explorer Smart folder cleared"
						);
					})
			);

		new Setting(containerEl)
			.setName("Validate configuration")
			.setDesc("Check whether a Smart folder path has been configured.")
			.addButton((button) =>
				button.setButtonText("Validate").onClick(() => {
					const path = this.plugin.settings.smartFolderPath.trim();
					console.log(`${LOG_PREFIX} validate clicked`, { path });

					if (!path) {
						new Notice("No Smart folder configured yet.");
						console.warn(`${LOG_PREFIX} validation failed: missing path`);
						return;
					}

					new Notice(`Smart folder configured: ${path}`);
					console.log(`${LOG_PREFIX} validation passed`, { path });
				})
			);

		// Keep the other existing settings from the original tab for completeness
		// (indexDbPath, etc.), but as requested we focus the exact file replacement.
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
