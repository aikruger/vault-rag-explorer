import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
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

		new Setting(containerEl).setName("Vault RAG Explorer").setHeading();

		// ── Smart Env Path ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Smart Connections folder')
			.setDesc('Path to your .smart-env folder. Usually: <vault>/.smart-env')
			.addText(text => {
				text
					.setPlaceholder('/path/to/vault/.smart-env')
					.setValue(this.plugin.settings.smartFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.smartFolderPath = value.trim();
						await this.plugin.saveSettings();
						console.log('[VaultRagSettings] smartFolderPath updated to:', value.trim());
					});
				text.inputEl.style.width = '100%';
			})
			.addButton(btn => {
				btn.setButtonText('Auto-detect')
					.onClick(async () => {
						const detected = this.plugin.detectSmartEnvPath();
						if (detected) {
							this.plugin.settings.smartFolderPath = detected;
							await this.plugin.saveSettings();
							this.display(); // re-render to show new value
							new Notice('Smart env folder detected: ' + detected);
							console.log('[VaultRagSettings] auto-detected smartFolderPath:', detected);
						} else {
							new Notice('Could not auto-detect .smart-env folder. Please enter manually.');
							console.log('[VaultRagSettings] auto-detect failed');
						}
					});
			});

		// ── Index Status ────────────────────────────────────────────────────────
		const statusEl = containerEl.createEl('p', {
			cls: 'setting-item-description',
		});
		this.renderIndexStatus(statusEl);

		// ── Build Button ────────────────────────────────────────────────────────
		const buildSetting = new Setting(containerEl)
			.setName('Build index')
			.setDesc('Parse all Smart Connections embeddings and write to the local SQLite database.');

		let buildBtn: ButtonComponent;
		buildSetting.addButton(btn => {
			buildBtn = btn;
			btn.setButtonText('Build Index Now')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.settings.smartFolderPath) {
						new Notice('Please set the Smart Connections folder path first.');
						return;
					}
					btn.setButtonText('Building…').setDisabled(true);
					statusEl.setText('Building index…');
					console.log('[VaultRagSettings] starting index build');

					try {
						const result = await this.plugin.buildIndexFromSettings();
						this.plugin.settings.lastIndexBuild = Date.now();
						await this.plugin.saveSettings();
						this.renderIndexStatus(statusEl);
						btn.setButtonText('Build Index Now').setDisabled(false);
						new Notice(`Index built: ${result.embeddings} embeddings from ${result.sources} sources`);
						console.log('[VaultRagSettings] index build complete', result);
					} catch (err) {
						btn.setButtonText('Build Index Now').setDisabled(false);
						statusEl.setText('Build failed — check console for details');
						new Notice('Index build failed: ' + (err as Error).message);
						console.error('[VaultRagSettings] index build failed', err);
					}
				});
		});

		// Keep the other existing settings from the original tab for completeness
		// (indexDbPath, etc.), but as requested we focus the exact file replacement.

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

		// ── RAG Export Folder ────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("RAG export folder")
			.setDesc(
				"Vault-relative folder path where RAG context exports are saved. " +
				"Leave blank to save to the vault root. " +
				"Example: RAG Exports/Sessions"
			)
			.addText(text => {
				text
					.setPlaceholder("RAG Exports/Sessions")
					.setValue(this.plugin.settings.ragExportFolder)
					.onChange(async (value) => {
						this.plugin.settings.ragExportFolder = value.trim();
						await this.plugin.saveSettings();
						console.log("[VaultRagSettings] ragExportFolder updated to:", value.trim());
					});
				text.inputEl.style.width = "100%";
			})
			.addButton(btn => {
				btn.setButtonText("Create folder")
					.onClick(async () => {
						const folder = this.plugin.settings.ragExportFolder.trim();
						if (!folder) {
							new Notice("Enter a folder path first.");
							return;
						}
						try {
							const exists = this.app.vault.getAbstractFileByPath(folder);
							if (exists) {
								new Notice(`Folder already exists: ${folder}`);
								console.log("[VaultRagSettings] ragExportFolder already exists:", folder);
								return;
							}
							await this.app.vault.createFolder(folder);
							new Notice(`Created folder: ${folder}`);
							console.log("[VaultRagSettings] ragExportFolder created:", folder);
						} catch (err) {
							new Notice("Failed to create folder: " + (err as Error).message);
							console.error("[VaultRagSettings] ragExportFolder create failed", err);
						}
					});
			});
	}

	private renderIndexStatus(el: HTMLElement): void {
		const ts = this.plugin.settings.lastIndexBuild;
		if (!ts) {
			el.setText('Index not yet built.');
			return;
		}
		const date = new Date(ts).toLocaleString();
		el.setText(`Last built: ${date}`);
		console.log('[VaultRagSettings] rendering status — lastBuild:', date);
	}
}
