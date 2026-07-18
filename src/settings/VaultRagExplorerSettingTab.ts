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
		this.clearIndexStatusRefresh();
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

	private readIndexArtifacts(): {
		progress: any | null;
		progressMtimeMs: number | null;
		dbExists: boolean;
		dbMtimeMs: number | null;
		dbSize: number | null;
		readError: string | null;
	} {
		const fs = require('fs');
		const path = require('path');

		try {
			const pluginDir = this.getPluginDir();
			const progressPath = path.join(pluginDir, 'index-progress.json');
			const dbPath = path.join(pluginDir, 'data', 'smart_index.db');

			console.log('[SettingTab] readIndexArtifacts paths', { progressPath, dbPath });

			let progress = null;
			let progressMtimeMs: number | null = null;

			if (fs.existsSync(progressPath)) {
				const stat = fs.statSync(progressPath);
				progressMtimeMs = stat.mtimeMs;
				const raw = fs.readFileSync(progressPath, 'utf8');
				progress = JSON.parse(raw);
				console.log('[SettingTab] readIndexArtifacts progress loaded', {
					progressMtimeMs,
					status: progress?.status,
					processedFiles: progress?.processedFiles ?? progress?.filesProcessed,
					totalFiles: progress?.totalFiles,
				});
			} else {
				console.log('[SettingTab] progress file missing');
			}

			let dbExists = false;
			let dbMtimeMs: number | null = null;
			let dbSize: number | null = null;

			if (fs.existsSync(dbPath)) {
				dbExists = true;
				const dbStat = fs.statSync(dbPath);
				dbMtimeMs = dbStat.mtimeMs;
				dbSize = dbStat.size;
				console.log('[SettingTab] DB stat loaded', { dbMtimeMs, dbSize });
			} else {
				console.log('[SettingTab] DB file missing');
			}

			return { progress, progressMtimeMs, dbExists, dbMtimeMs, dbSize, readError: null };
		} catch (e) {
			console.error('[SettingTab] readIndexArtifacts error', e);
			return {
				progress: null,
				progressMtimeMs: null,
				dbExists: false,
				dbMtimeMs: null,
				dbSize: null,
				readError: e instanceof Error ? e.message : String(e),
			};
		}
	}

	// Decision Rules:
	// RUNNING: progress file updated within the last 3 minutes and status is running.
	// COMPLETE: progress file says complete, or completedAt exists, or processed files reached total files.
	// BROKEN: progress file says error, JSON cannot be parsed, or last process exit code is non-zero.
	// STALLED: progress file says running but has not changed within the timeout.
	// STALLED WITH DB ACTIVITY: progress file stale, but DB newer than progress file; display as STALLED (DB MOVED AFTER LAST PROGRESS).
	// MISSING: neither progress file nor DB exists.
	// IDLE: DB exists but no current progress activity exists.
	private classifyIndexState(input: {
		progress: any | null;
		progressMtimeMs: number | null;
		dbExists: boolean;
		dbMtimeMs: number | null;
	}): {
		state: 'missing' | 'idle' | 'running' | 'complete' | 'stalled' | 'broken';
		reason: string;
	} {
		const now = Date.now();
		const staleMs = 3 * 60 * 1000; // 3 minutes without progress update => suspicious

		const progress = input.progress;
		const progressStatus = progress?.status ?? null;
		const progressUpdatedRecently =
			input.progressMtimeMs !== null && now - input.progressMtimeMs < staleMs;

		const processedFiles = progress?.processedFiles ?? progress?.filesProcessed ?? null;
		const totalFiles = progress?.totalFiles ?? null;
		const completedAt = progress?.completedAt ?? null;
		const explicitError = progress?.error ?? null;

		if (!progress && !input.dbExists) {
			return { state: 'missing', reason: 'No progress file and no database file found.' };
		}

		if (explicitError) {
			return { state: 'broken', reason: `Progress file reports error: ${explicitError}` };
		}

		if (progressStatus === 'complete' || completedAt) {
			return { state: 'complete', reason: 'Progress file reports indexing complete.' };
		}

		if (progressStatus === 'running') {
			if (progressUpdatedRecently) {
				return { state: 'running', reason: 'Progress file is being updated recently.' };
			}

			if (
				input.dbMtimeMs !== null &&
				input.progressMtimeMs !== null &&
				input.dbMtimeMs > input.progressMtimeMs
			) {
				return {
					state: 'stalled',
					reason: 'Database updated after the progress file; progress reporting appears stale.',
				};
			}

			return {
				state: 'stalled',
				reason: 'Progress file still says running, but it has not been updated recently.',
			};
		}

		if (
			processedFiles !== null &&
			totalFiles !== null &&
			totalFiles > 0 &&
			processedFiles >= totalFiles
		) {
			return { state: 'complete', reason: 'Processed file count reached total files.' };
		}

		if (input.dbExists) {
			return { state: 'idle', reason: 'Database exists but no active indexing signal detected.' };
		}

		return { state: 'missing', reason: 'Insufficient status artifacts.' };
	}

	private async refreshIndexStatus(containerEl: HTMLElement, statusDiv?: HTMLElement): Promise<void> {
		console.log('[SettingTab] refreshIndexStatus start');
		if (!statusDiv) return;
		statusDiv.empty();

		const artifacts = this.readIndexArtifacts();

		if (artifacts.readError) {
		  statusDiv.createEl('p', { text: `Status: BROKEN` });
		  statusDiv.createEl('p', { text: `Reason: ${artifacts.readError}` });
		  console.error('[SettingTab] refreshIndexStatus readError', artifacts.readError);
		  return;
		}

		const classification = this.classifyIndexState(artifacts);
		const progress = artifacts.progress ?? {};

		const processedFiles = progress.processedFiles ?? progress.filesProcessed ?? 0;
		const totalFiles = progress.totalFiles ?? 0;
		const errors = progress.errors ?? 0;
		const lastFile = progress.lastFile ?? 'n/a';

		console.log('[SettingTab] refreshIndexStatus classification', {
		  classification,
		  processedFiles,
		  totalFiles,
		  errors,
		  lastFile,
		  progressMtimeMs: artifacts.progressMtimeMs,
		  dbMtimeMs: artifacts.dbMtimeMs,
		});

		statusDiv.createEl('p', { text: `Status: ${classification.state.toUpperCase()}` });
		statusDiv.createEl('p', { text: `Reason: ${classification.reason}` });
		statusDiv.createEl('p', { text: `Files processed: ${processedFiles}` });
		statusDiv.createEl('p', { text: `Files discovered: ${totalFiles}` });
		statusDiv.createEl('p', { text: `Errors: ${errors}` });
		statusDiv.createEl('p', { text: `Last file processed: ${lastFile}` });

		if (artifacts.progressMtimeMs) {
		  statusDiv.createEl('p', {
			text: `Progress file updated: ${new Date(artifacts.progressMtimeMs).toLocaleString()}`,
		  });
		}

		if (artifacts.dbMtimeMs) {
		  statusDiv.createEl('p', {
			text: `Database updated: ${new Date(artifacts.dbMtimeMs).toLocaleString()}`,
		  });
		}

		if (classification.state === 'running') {
		  console.log('[SettingTab] status running, scheduling refresh');
		  this.scheduleIndexStatusRefresh(statusDiv);
		} else {
		  console.log('[SettingTab] status not running, polling not rescheduled');
		}
	}

	private indexStatusTimer: number | null = null;

	private scheduleIndexStatusRefresh(statusDiv: HTMLElement): void {
		if (this.indexStatusTimer !== null) {
			console.log('[SettingTab] scheduleIndexStatusRefresh skipped: timer already active');
			return;
		}

		this.indexStatusTimer = window.setTimeout(async () => {
			console.log('[SettingTab] scheduleIndexStatusRefresh firing');
			this.indexStatusTimer = null;
			await this.refreshIndexStatus(this.containerEl, statusDiv);
		}, 2000);

		console.log('[SettingTab] scheduleIndexStatusRefresh set', { timer: this.indexStatusTimer });
	}

	private clearIndexStatusRefresh(): void {
		if (this.indexStatusTimer !== null) {
			window.clearTimeout(this.indexStatusTimer);
			console.log('[SettingTab] clearIndexStatusRefresh cleared', { timer: this.indexStatusTimer });
			this.indexStatusTimer = null;
		}
	}
}
