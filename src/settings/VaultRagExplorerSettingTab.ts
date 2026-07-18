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
		new Setting(containerEl)
			.setName('Index status')
			.setDesc('External indexer progress (run indexer/run-indexer.py from terminal)')
			.addButton(btn => {
				btn.setButtonText('Refresh status');
				btn.onClick(() => {
					void this.refreshIndexStatus(containerEl, statusDiv);
				});
			});

		// Add a status div below:
		const statusDiv = containerEl.createEl('div', { cls: 'vre-index-status' });
		void this.refreshIndexStatus(containerEl, statusDiv);

		// ── Build Button ────────────────────────────────────────────────────────
		const buildSetting = new Setting(containerEl)
			.setName('Build index')
			.setDesc('Parse all Smart Connections embeddings and write to the local SQLite database.');

		buildSetting.addButton(btn => {
			btn.setButtonText('Build Index (External)')
				.setCta()
				.onClick(async () => {
					void this.startExternalIndex();
				});
		});

		// ── Retrieval Settings ──────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Retrieval granularity")
			.setDesc("Choose whether semantic search returns files first or individual blocks. Default retrieval count used unless overridden in the query interface.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("file", "File level")
					.addOption("block", "Block level")
					.setValue(this.plugin.settings.retrievalGranularity)
					.onChange(async (value: string) => {
						this.plugin.settings.retrievalGranularity = value as "file" | "block";
						console.log("[VaultRagExplorerSettingTab] retrievalGranularity changed", { value });
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Documents to retrieve")
			.setDesc("Default number of files/documents to retrieve. Default retrieval count used unless overridden in the query interface.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.retrievalDocumentLimit))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed <= 0) return;
						this.plugin.settings.retrievalDocumentLimit = parsed;
						console.log("[VaultRagExplorerSettingTab] retrievalDocumentLimit changed", { value: parsed });
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Blocks per document")
			.setDesc("Maximum number of matched passages/blocks to return per document in file mode.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.retrievalBlocksPerDocument))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed <= 0) return;
						this.plugin.settings.retrievalBlocksPerDocument = parsed;
						console.log("[VaultRagExplorerSettingTab] retrievalBlocksPerDocument changed", { value: parsed });
						await this.plugin.saveSettings();
					})
			);

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

	private indexProcess: any = null;

	private getVaultRoot(): string {
		const adapter = this.app.vault.adapter as { basePath?: string };
		const basePath = adapter?.basePath;
		console.log('[SettingTab] getVaultRoot', { basePath });
		if (!basePath) throw new Error('Vault basePath not available');
		return basePath;
	}

	private getPluginDir(): string {
		const path = require('path');
		const vaultRoot = this.getVaultRoot();
		const pluginDir = path.join(vaultRoot, '.obsidian', 'plugins', this.plugin.manifest.id);
		console.log('[SettingTab] getPluginDir', { pluginDir });
		return pluginDir;
	}

	private getIndexerPy(): string {
		const path = require('path');
		const scriptPath = path.join(this.getPluginDir(), 'indexer', 'run-indexer.py');
		console.log('[SettingTab] getIndexerPy', { scriptPath });
		return scriptPath;
	}

	private async startExternalIndex(): Promise<void> {
		if (this.indexProcess) {
			new Notice('Indexer already running');
			console.log('[SettingTab] startExternalIndex skipped: already running');
			return;
		}

		const fs = require('fs');
		const { spawn } = require('child_process');

		const vaultRoot = this.getVaultRoot();
		const scriptPath = this.getIndexerPy();

		if (!fs.existsSync(scriptPath)) {
			console.error('[SettingTab] missing run-indexer.py', { scriptPath });
			new Notice('run-indexer.py not found in plugin indexer folder');
			return;
		}

		console.log('[SettingTab] launching external indexer', { scriptPath, vaultRoot });

		this.indexProcess = spawn('python', [scriptPath, vaultRoot], {
			cwd: vaultRoot,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		this.indexProcess.stdout.on('data', (buf: Buffer) => {
			const text = buf.toString();
			console.log('[SettingTab][indexer stdout]', text);
		});

		this.indexProcess.stderr.on('data', (buf: Buffer) => {
			const text = buf.toString();
			console.error('[SettingTab][indexer stderr]', text);
		});

		this.indexProcess.on('close', (code: number) => {
			console.log('[SettingTab] external indexer exited', { code });
			this.indexProcess = null;
			void this.refreshIndexStatus(this.containerEl, this.containerEl.querySelector('.vre-index-status') as HTMLElement);
			new Notice(code === 0 ? 'Index build completed' : `Index build failed (${code})`);
		});

		new Notice('External index build started');
		void this.refreshIndexStatus(this.containerEl, this.containerEl.querySelector('.vre-index-status') as HTMLElement);
	}

	private async refreshIndexStatus(containerEl: HTMLElement, statusDiv?: HTMLElement): Promise<void> {
		const fs = require('fs');
		const path = require('path');
		const basePath = (this.plugin.app.vault.adapter as unknown as { basePath: string }).basePath;
		const progressFile = path.join(
			this.getPluginDir(), 'index-progress.json'
		);
		console.log('[SettingTab] refreshIndexStatus reading:', progressFile);

		if (!statusDiv) return;
		statusDiv.empty();

		if (!fs.existsSync(progressFile)) {
			statusDiv.createEl('p', { text: 'No index run yet. Run the external indexer script.' });
			return;
		}

		try {
			const raw = fs.readFileSync(progressFile, 'utf8');
			const prog = JSON.parse(raw) as {
				status: string; filesProcessed: number; totalFiles: number;
				lastFile: string; completedAt: number | null; error: string | null;
				existingSources?: number; sourcesInserted?: number; sourcesUpdated?: number;
				sourcesDeleted?: number; blocksUpserted?: number; embeddingsUpserted?: number;
				errors?: number;
			};

			statusDiv.createEl('p', {
				text: `Status: ${prog.status.toUpperCase()}`
			});
			statusDiv.createEl('p', {
				text: `Existing DB sources: ${prog.existingSources ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Files discovered: ${prog.totalFiles}`
			});
			statusDiv.createEl('p', {
				text: `Files processed: ${prog.filesProcessed}`
			});
			statusDiv.createEl('p', {
				text: `Sources inserted: ${prog.sourcesInserted ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Sources updated: ${prog.sourcesUpdated ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Sources deleted: ${prog.sourcesDeleted ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Blocks upserted: ${prog.blocksUpserted ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Embeddings upserted: ${prog.embeddingsUpserted ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Errors: ${prog.errors ?? 0}`
			});
			statusDiv.createEl('p', {
				text: `Last file processed: ${prog.lastFile ?? ''}`
			});

			if (prog.status === 'complete' && prog.completedAt) {
				statusDiv.createEl('p', {
					text: `Completed: ${new Date(prog.completedAt).toLocaleString()}`
				});
			}
			if (prog.error) {
				statusDiv.createEl('p', { text: `Error: ${prog.error}`, cls: 'vre-error' });
			}

			// Auto-poll if still running
			if (prog.status === 'running') {
				window.setTimeout(() => void this.refreshIndexStatus(containerEl, statusDiv), 2000);
			}
		} catch (e) {
			console.error('[SettingTab] failed to parse progress file:', e);
			statusDiv.createEl('p', { text: 'Could not read index status file.' });
		}
	}
}
