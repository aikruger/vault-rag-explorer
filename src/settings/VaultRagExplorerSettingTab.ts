import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";
import * as path from "path";
import * as fs from "fs";

const LOG_PREFIX = "[VaultRagExplorerSettingTab]";

export class VaultRagExplorerSettingTab extends PluginSettingTab {
	plugin: VaultRagExplorerPlugin;
    private indexStatusTimer: NodeJS.Timeout | null = null;
    private statusEl: HTMLElement | null = null;
    private spinnerEl: HTMLElement | null = null;
    private buildBtn: ButtonComponent | null = null;

	constructor(app: App, plugin: VaultRagExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

        if (!document.getElementById('vre-spinner-style')) {
            const style = document.createElement('style');
            style.id = 'vre-spinner-style';
            style.innerHTML = `
                .vre-spinner.is-running {
                  animation: vre-spin 1s linear infinite;
                  display: inline-block;
                  margin-left: 10px;
                }
                @keyframes vre-spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(style);
        }


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
						} else {
							new Notice('Could not auto-detect .smart-env folder. Please enter manually.');
						}
					});
			});

		// ── Index Status Dashboard ────────────────────────────────────────────────────────
		this.statusEl = containerEl.createEl('div', {
			cls: 'setting-item-description',
		});
        this.statusEl.style.whiteSpace = 'pre-wrap';
        this.statusEl.style.fontFamily = 'monospace';
        this.statusEl.style.backgroundColor = 'var(--background-secondary)';
        this.statusEl.style.padding = '10px';
        this.statusEl.style.borderRadius = '5px';
        this.statusEl.style.marginBottom = '15px';

        this.spinnerEl = containerEl.createEl('span', {
            cls: 'vre-spinner',
            text: '↻'
        });
        this.spinnerEl.style.display = 'none';
        this.statusEl.parentElement?.insertBefore(this.spinnerEl, this.statusEl);


		this.refreshIndexStatus();

        this.clearIndexStatusTimer();
        this.indexStatusTimer = setInterval(() => {
            this.refreshIndexStatus();
        }, 2000);

		// ── Build Button ────────────────────────────────────────────────────────
		const buildSetting = new Setting(containerEl)
			.setName('Build index')
			.setDesc('Parse all Smart Connections embeddings and write to the local SQLite database in the background.');

		let buildBtn: ButtonComponent;
        this.buildBtn = null;
		buildSetting.addButton(btn => {
            this.buildBtn = btn;
			buildBtn = btn;
			btn.setButtonText('Build Index (External)')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.settings.smartFolderPath) {
						new Notice('Please set the Smart Connections folder path first.');
						return;
					}
					if (this.plugin.isExternalIndexerRunning()) {
                        new Notice('Indexing is already running.');
                        return;
                    }

                    btn.setButtonText('Starting external indexer…').setDisabled(true);
                    if (this.spinnerEl) {
                        this.spinnerEl.style.display = 'inline-block';
                        this.spinnerEl.classList.add('is-running');
                    }

					try {
                        const child_process = require('child_process');
                        const vaultAdapter = this.app.vault.adapter as any;
                        const basePath = vaultAdapter.getBasePath();
                        const pluginDir = path.join(basePath, '.obsidian', 'plugins', this.plugin.manifest.id);
                        const dataDir = path.join(pluginDir, 'data');
                        const progressFile = path.join(dataDir, 'index-progress.json');
                        fs.mkdirSync(dataDir, { recursive: true });
                        fs.writeFileSync(
                            progressFile,
                            JSON.stringify({
                                status: 'running',
                                phase: 'startup',
                                startedAt: Date.now(),
                                heartbeatAt: Date.now(),
                                progressUpdatedAt: Date.now(),
                                processedFiles: 0,
                                totalFiles: 0,
                                lastFile: '',
                                sourcesInserted: 0,
                                sourcesUpdated: 0,
                                sourcesDeleted: 0,
                                blocksUpserted: 0,
                                embeddingsUpserted: 0,
                                errors: 0,
                                pid: null,
                            })
                        );

                        // Run detached so we don't block Obsidian
                        const nodeScriptPath = path.join(pluginDir, 'indexer', 'build-index.js');
                        const child = child_process.spawn('node', [nodeScriptPath, basePath], {
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: true
                        });

                        child.unref();

						new Notice(`Background indexer launched (PID: ${child.pid})`);
                        setTimeout(() => { this.refreshIndexStatus(); }, 2000);
					} catch (err) {
						btn.setButtonText('Build Index (External)').setDisabled(false);
						new Notice('Failed to launch indexer: ' + (err as Error).message);
					}
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
								return;
							}
							await this.app.vault.createFolder(folder);
							new Notice(`Created folder: ${folder}`);
						} catch (err) {
							new Notice("Failed to create folder: " + (err as Error).message);
						}
					});
			});
	}

    hide(): void {
        this.clearIndexStatusTimer();
    }

    private clearIndexStatusTimer(): void {
        if (this.indexStatusTimer) {
            clearInterval(this.indexStatusTimer);
            this.indexStatusTimer = null;
        }
    }

    private refreshIndexStatus(): void {
        if (!this.statusEl) return;

        const vaultAdapter = this.app.vault.adapter as any;
        const basePath = vaultAdapter.getBasePath();
        const pluginDir = path.join(basePath, '.obsidian', 'plugins', this.plugin.manifest.id);
        const progressFile = path.join(pluginDir, 'data', 'index-progress.json');
        const dbPath = path.join(basePath, this.plugin.settings.indexDbPath);

        let dbMtime = 0;
        let dbSize = 0;
        if (fs.existsSync(dbPath)) {
            const stat = fs.statSync(dbPath);
            dbMtime = stat.mtimeMs;
            dbSize = stat.size;
        }

        let derivedStatusPayload = null;

        if (!fs.existsSync(progressFile)) {
            this.statusEl.setText('Status: MISSING\nNo progress file found.');
            if (this.spinnerEl) {
                this.spinnerEl.style.display = 'none';
                this.spinnerEl.classList.remove('is-running');
            }
            if (this.buildBtn) {
                this.buildBtn.setButtonText('Build Index (External)').setDisabled(false);
            }
            return;
        }

        if (fs.existsSync(progressFile)) {
            try {
                const content = fs.readFileSync(progressFile, 'utf8');
                const progress = JSON.parse(content);

                const now = Date.now();
                const staleThreshold = 10 * 60 * 1000; // 10 minutes
                const heartbeatStale = (now - (progress.heartbeatAt || 0)) > staleThreshold;

                let status = String(progress.status || 'BROKEN').toUpperCase();
                if (status === 'RUNNING') {
                    if (heartbeatStale) {
                        // Check if DB is still moving even though heartbeat is stale
                        if (dbMtime > progress.heartbeatAt) {
                            status = 'SOFT_STALLED';
                        } else {
                            status = 'STALLED';
                        }
                    }
                }
                if (status === 'COMPLETE' && Number(progress.errors || 0) > 0) {
                    status = 'PARTIAL';
                }


        if (status === 'RUNNING') {
            if (this.spinnerEl && !this.spinnerEl.classList.contains('is-running')) {
                this.spinnerEl.style.display = 'inline-block';
                this.spinnerEl.classList.add('is-running');
            }
            if (this.buildBtn) {
                this.buildBtn.setButtonText('Indexing…').setDisabled(true);
            }
        } else {
            if (this.spinnerEl && this.spinnerEl.classList.contains('is-running')) {
                this.spinnerEl.style.display = 'none';
                this.spinnerEl.classList.remove('is-running');
            }
            if (this.buildBtn && this.buildBtn.disabled) {
                this.buildBtn.setButtonText('Build Index (External)').setDisabled(false);
            }
        }

                progress.derivedStatus = status;
                derivedStatusPayload = progress;

            } catch (e) {
                this.statusEl.setText('Status: BROKEN\nProgress file is unreadable.');
                return;
            }
        }

        if (!derivedStatusPayload) {
            this.statusEl.setText('Status: IDLE\nNo index build has been run yet.');
            return;
        }

        const p = derivedStatusPayload;

        const startedStr = new Date(p.startedAt || 0).toLocaleString();
        const heartbeatStr = new Date(p.heartbeatAt || 0).toLocaleTimeString();
        const updatedStr = new Date(p.progressUpdatedAt || 0).toLocaleTimeString();
        const dbMtimeStr = dbMtime > 0 ? new Date(dbMtime).toLocaleTimeString() : 'N/A';
        const mbSize = (dbSize / (1024 * 1024)).toFixed(2);

        const lines = [
            `Status:             ${p.derivedStatus.toUpperCase()}`,
            `Phase:              ${p.phase}`,
            `PID:                ${p.pid || 'N/A'}`,
            `-------------------------------------------`,
            `Files Processed:    ${p.processedFiles} / ${p.totalFiles}`,
            `Last File:          ${p.lastFile}`,
            `Active Sources:     ${p.activeSources}`,
            `Soft-deleted:       ${p.softDeletedSources}`,
            `Sources Inserted:   ${p.sourcesInserted}`,
            `Sources Updated:    ${p.sourcesUpdated}`,
            `Sources Deleted:    ${p.sourcesDeleted ?? p.sourcesSoftDeleted ?? 0}`,
            `Blocks Upserted:    ${p.blocksUpserted}`,
            `Embeddings Written: ${p.embeddingsUpserted}`,
            `Errors:             ${p.errors}`,
            `-------------------------------------------`,
            `Started:            ${startedStr}`,
            `Heartbeat:          ${heartbeatStr}`,
            `Progress Updated:   ${updatedStr}`,
            `Database Updated:   ${dbMtimeStr}`,
            `Database Size:      ${mbSize} MB`
        ];

        this.statusEl.setText(lines.join('\n'));
	}
}