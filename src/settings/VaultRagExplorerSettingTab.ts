import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";

const LOG_PREFIX = "[VaultRagExplorerSettingTab]";

export class VaultRagExplorerSettingTab extends PluginSettingTab {
	plugin: VaultRagExplorerPlugin;
	private indexProcess: any = null;
	private indexStatusTimer: number | null = null;
	private lastProgressFingerprint: string | null = null;
	private lastObservedProgressAt: number | null = null;

	constructor(app: App, plugin: VaultRagExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		console.log("[VaultRagExplorerSettingTab] ✅ Real settings tab constructed — not SampleSettingTab");
		console.log('[SettingTab] timer state initialized');
	}

	display(): void {
		this.clearIndexStatusTimer();
		console.log('[SettingTab] display() start — cleared prior timer');
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

	private getVaultRoot(): string {
		const adapter = this.plugin.app.vault.adapter as { basePath?: string };
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

		console.log('[SettingTab] external indexer spawned', {
			pid: this.indexProcess?.pid,
			scriptPath,
			vaultRoot,
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
			this.clearIndexStatusTimer();
			void this.refreshIndexStatus(this.containerEl, this.containerEl.querySelector('.vre-index-status') as HTMLElement);
			new Notice(code === 0 ? 'Index build completed' : `Index build failed (${code})`);
		});

		new Notice('External index build started');
		void this.refreshIndexStatus(this.containerEl, this.containerEl.querySelector('.vre-index-status') as HTMLElement);
	}

	private readStatusArtifacts(): {
		progressPath: string;
		dbPath: string;
		progressExists: boolean;
		dbExists: boolean;
		progressMtimeMs: number | null;
		dbMtimeMs: number | null;
		dbSize: number | null;
		prog: any | null;
		error: string | null;
	} {
		const fs = require('fs');
		const path = require('path');

		try {
		  const pluginDir = this.getPluginDir();
		  const progressPath = path.join(pluginDir, 'index-progress.json');
		  const dbPath = path.join(pluginDir, 'data', 'smart_index.db');

		  const progressExists = fs.existsSync(progressPath);
		  const dbExists = fs.existsSync(dbPath);

		  let progressMtimeMs: number | null = null;
		  let dbMtimeMs: number | null = null;
		  let dbSize: number | null = null;
		  let prog: any | null = null;

		  if (progressExists) {
			const stat = fs.statSync(progressPath);
			progressMtimeMs = stat.mtimeMs;
			prog = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
		  }

		  if (dbExists) {
			const dbStat = fs.statSync(dbPath);
			dbMtimeMs = dbStat.mtimeMs;
			dbSize = dbStat.size;
		  }

		  console.log('[SettingTab] readStatusArtifacts', {
			progressPath,
			dbPath,
			progressExists,
			dbExists,
			progressMtimeMs,
			dbMtimeMs,
			dbSize,
			status: prog?.status,
			processedFiles: prog?.processedFiles,
			totalFiles: prog?.totalFiles,
		  });

		  return {
			progressPath,
			dbPath,
			progressExists,
			dbExists,
			progressMtimeMs,
			dbMtimeMs,
			dbSize,
			prog,
			error: null,
		  };
		} catch (e) {
		  console.error('[SettingTab] readStatusArtifacts error', e);
		  return {
			progressPath: '',
			dbPath: '',
			progressExists: false,
			dbExists: false,
			progressMtimeMs: null,
			dbMtimeMs: null,
			dbSize: null,
			prog: null,
			error: e instanceof Error ? e.message : String(e),
		  };
		}
	}

	private classifyIndexStatus(artifacts: {
		progressExists: boolean;
		dbExists: boolean;
		progressMtimeMs: number | null;
		dbMtimeMs: number | null;
		prog: any | null;
		error: string | null;
	}): { state: string; reason: string } {
		if (artifacts.error) {
			return { state: 'BROKEN', reason: `Failed reading status artifacts: ${artifacts.error}` };
		}

		if (!artifacts.progressExists && !artifacts.dbExists) {
			return { state: 'MISSING', reason: 'No progress file and no database found.' };
		}

		if (!artifacts.progressExists && artifacts.dbExists) {
			return { state: 'IDLE', reason: 'Database exists but no progress file is present.' };
		}

		const prog = artifacts.prog ?? {};
		const now = Date.now();
		const heartbeatAt = prog.heartbeatAt ?? null;
		const completedAt = prog.completedAt ?? null;
		const processedFiles = prog.processedFiles ?? 0;
		const totalFiles = prog.totalFiles ?? 0;
		const explicitError = prog.error ?? null;

		const lastSignalAt =
			typeof heartbeatAt === 'number'
				? heartbeatAt
				: artifacts.progressMtimeMs;

		const staleMs = 3 * 60 * 1000;
		const stale = typeof lastSignalAt === 'number' ? now - lastSignalAt > staleMs : true;

		if (explicitError) {
			return { state: 'BROKEN', reason: `Progress file reports error: ${explicitError}` };
		}

		if (prog.status === 'complete' || completedAt || (totalFiles > 0 && processedFiles >= totalFiles)) {
			return { state: 'COMPLETE', reason: 'Progress indicates all files were processed.' };
		}

		if (prog.status === 'running') {
			if (!stale) {
				return { state: 'RUNNING', reason: 'Progress heartbeat is recent.' };
			}

			if (
				typeof artifacts.dbMtimeMs === 'number' &&
				typeof artifacts.progressMtimeMs === 'number' &&
				artifacts.dbMtimeMs > artifacts.progressMtimeMs
			) {
				return {
					state: 'STALLED',
					reason: 'Progress file is stale, but database changed afterwards. Progress reporting likely stopped first.',
				};
			}

			return {
				state: 'STALLED',
				reason: 'Progress file still says running, but heartbeat/progress timestamp is stale.',
			};
		}

		return { state: 'IDLE', reason: 'No active indexing signal detected.' };
	}

	private async refreshIndexStatus(containerEl: HTMLElement, statusDiv?: HTMLElement): Promise<void> {
		console.log('[SettingTab] refreshIndexStatus start');
		if (!statusDiv) return;
		statusDiv.empty();

		const artifacts = this.readStatusArtifacts();

		if (artifacts.error) {
			statusDiv.createEl('p', { text: `Status: BROKEN` });
			statusDiv.createEl('p', { text: `Reason: ${artifacts.error}` });
			console.error('[SettingTab] refreshIndexStatus readError', artifacts.error);
			return;
		}

		const derived = this.classifyIndexStatus(artifacts);
		const prog = artifacts.prog ?? {};

		console.log('[SettingTab] refreshIndexStatus classification', { derived, prog });

		statusDiv.createEl('p', { text: `Status: ${derived.state}` });
		statusDiv.createEl('p', { text: `Reason: ${derived.reason}` });
		statusDiv.createEl('p', { text: `Existing DB sources: ${prog.existingSources ?? 0}` });
		statusDiv.createEl('p', { text: `Files discovered: ${prog.totalFiles ?? 0}` });
		statusDiv.createEl('p', { text: `Files processed: ${prog.processedFiles ?? 0}` });
		statusDiv.createEl('p', { text: `Sources inserted: ${prog.sourcesInserted ?? 0}` });
		statusDiv.createEl('p', { text: `Sources updated: ${prog.sourcesUpdated ?? 0}` });
		statusDiv.createEl('p', { text: `Sources deleted: ${prog.sourcesDeleted ?? 0}` });
		statusDiv.createEl('p', { text: `Blocks upserted: ${prog.blocksUpserted ?? 0}` });
		statusDiv.createEl('p', { text: `Embeddings upserted: ${prog.embeddingsUpserted ?? 0}` });
		statusDiv.createEl('p', { text: `Errors: ${prog.errors ?? 0}` });
		statusDiv.createEl('p', { text: `Last file processed: ${prog.lastFile ?? ''}` });
		statusDiv.createEl('p', { text: `Progress updated: ${artifacts.progressMtimeMs ? new Date(artifacts.progressMtimeMs).toLocaleString() : 'n/a'}` });
		statusDiv.createEl('p', { text: `Database updated: ${artifacts.dbMtimeMs ? new Date(artifacts.dbMtimeMs).toLocaleString() : 'n/a'}` });

		if (derived.state === 'RUNNING') {
			this.scheduleIndexStatusRefresh(statusDiv);
		} else {
			this.clearIndexStatusTimer();
			console.log('[SettingTab] refreshIndexStatus not scheduling further polling', { state: derived.state });
		}
	}

	private scheduleIndexStatusRefresh(statusDiv: HTMLElement): void {
		if (this.indexStatusTimer !== null) {
			console.log('[SettingTab] scheduleIndexStatusRefresh skipped: timer already active');
			return;
		}

		this.indexStatusTimer = window.setTimeout(() => {
			console.log('[SettingTab] scheduleIndexStatusRefresh firing');
			this.indexStatusTimer = null;
			void this.refreshIndexStatus(this.containerEl, statusDiv);
		}, 2000);

		console.log('[SettingTab] scheduleIndexStatusRefresh set', { timer: this.indexStatusTimer });
	}

	private clearIndexStatusTimer(): void {
		if (this.indexStatusTimer !== null) {
			window.clearTimeout(this.indexStatusTimer);
			console.log('[SettingTab] clearIndexStatusTimer', { timer: this.indexStatusTimer });
			this.indexStatusTimer = null;
		}
	}
}
