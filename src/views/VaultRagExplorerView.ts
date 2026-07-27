
/* eslint-disable obsidianmd/rule-custom-message, obsidianmd/ui/sentence-case, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// @ts-nocheck
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";
import {
	type PersistedViewState,
	type QueryOptions,
	type RetrievalHit,
	type FileMatch,
	type BlockMatch,
	type QueryResultPayload,
	DEFAULT_QUERY_OPTIONS,
	VIEW_TYPE_VAULT_RAG_EXPLORER,
} from "../types";
import { RagExplorerStore } from "../state/RagExplorerStore";
import { QueryService } from "../services/QueryService";
import { D3GraphPanel, GraphNode, GraphEdge } from "./D3GraphPanel";

// @ts-nocheck


// @ts-nocheck

import type { LockedNode } from "../services/LockedNodesService";
import { EMPTY_PREFILTER, type PreFilterOptions } from "../services/PreFilterService";

export class VaultRagExplorerView extends ItemView {
	plugin: VaultRagExplorerPlugin;
	store: RagExplorerStore;
	queryService: QueryService;

	private queryInputEl: HTMLTextAreaElement | null = null;
	private resultsEl: HTMLDivElement | null = null;
	private graphEl: HTMLDivElement | null = null;
	private inspectorEl: HTMLDivElement | null = null;

	private unsubscribeStore: (() => void) | null = null;
	private graphPanel: D3GraphPanel | null = null;
	private preFilter: PreFilterOptions = JSON.parse(JSON.stringify(EMPTY_PREFILTER));
	private excludedSourceIds: Set<number> = new Set();
	private excludedBlockIds: Set<number> = new Set();
	private resultItemMap: Map<string, HTMLElement> = new Map();
	private resultsViewMode: "flat" | "groupedByFile" = "groupedByFile";
	private resultsToolbarEl: HTMLElement | null = null;
	private excludedPaths: Set<string> = new Set();

	private retrievalGranularityOverride: "file" | "block" | null = null;
	private retrievalCountOverride: number | null = null;
	private graphScoreRangeOverride: [number, number] | null = null;
	private lastQueryResults: QueryResultPayload | null = null;
	private syncResultsWithGraphFilter = false;

	private fileMatchMap: Map<string, FileMatch> = new Map();
	private blockMatchMap: Map<string, BlockMatch> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: VaultRagExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new RagExplorerStore();

		const queryService = this.plugin.queryService;
		console.log("[VaultRagExplorerView] using plugin.queryService", {
			exists: !!queryService,
		});
		this.queryService = queryService;

		console.log("[VaultRagExplorerView] constructor", {
			pluginConstructor: this.plugin?.constructor?.name,
			pluginDebugId: this.plugin?.debugInstanceId,
			queryServiceExists: !!this.plugin?.queryService,
		});
	}

	getViewType(): string {
		return VIEW_TYPE_VAULT_RAG_EXPLORER;
	}

	getDisplayText(): string {
		return "Vault RAG Explorer";
	}

	getIcon(): string {
		return "network";
	}

	async onOpen(): Promise<void> {

		console.log("[VaultRagExplorerView] onOpen");
		this.unsubscribeStore = this.store.subscribe((state) => {
			this.renderFromState(state);
		});
		this.render();
	}

	async onClose(): Promise<void> {

		console.log("[VaultRagExplorerView] onClose");
		if (this.unsubscribeStore) {
			this.unsubscribeStore();
			this.unsubscribeStore = null;
		}
	}

	getState(): Record<string, unknown> {
		const storeState = this.store.getState();
		const state: PersistedViewState = {
			activeSessionId: storeState.activeSessionId,
			currentQueryText: storeState.currentQueryText,
			queryOptions: storeState.queryOptions,
			selectedNodeId: storeState.selectedNodeId,
		};

		console.log("[VaultRagExplorerView] getState", state);
		return state as unknown as Record<string, unknown>;
	}

	async setState(state: Partial<PersistedViewState>, result: unknown): Promise<void> {

		console.log("[VaultRagExplorerView] setState", state, result);

		this.store.setState({
			activeSessionId: state.activeSessionId ?? null,
			currentQueryText: state.currentQueryText ?? "",
			queryOptions: state.queryOptions ?? { ...DEFAULT_QUERY_OPTIONS },
			selectedNodeId: state.selectedNodeId ?? null,
		});
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("vault-rag-explorer-view");

		const header = container.createDiv({ cls: "vre-header" });
		header.createEl("h2", { text: "Vault RAG Explorer" });

		const body = container.createDiv({ cls: "vre-body" });

		const leftPane = body.createDiv({ cls: "vre-left-pane" });
		const rightPane = body.createDiv({ cls: "vre-right-pane" });

		this.renderQueryPanel(leftPane);
		this.renderResultsPanel(leftPane);
		this.renderGraphPanel(rightPane);
		this.renderInspectorPanel(rightPane);

		const storeState = this.store.getState();
		this.renderFromState(storeState);


		console.log("[VaultRagExplorerView] Render complete");
	}

	private renderFromState(state: import("../types").RagExplorerState): void {
		if (this.queryInputEl && this.queryInputEl.value !== state.currentQueryText) {
			this.queryInputEl.value = state.currentQueryText;
		}
	}


	private renderPreFilterPanel(container: HTMLElement): void {
		const details = container.createEl('details', { cls: 'vre-prefilter-panel' });
		details.createEl('summary', { text: '🔍 Scope filters (SQL pre-filter)' });

		const grid = details.createEl('div', { cls: 'vre-prefilter-grid' });

		const addRow = (label: string, placeholder: string, storeKey: string, preFilterKey: keyof PreFilterOptions, isExclude = false) => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: label, cls: isExclude ? 'vre-label-exclude' : 'vre-label-include' });
			const input = row.createEl('input', {
				type: 'text',
				placeholder,
				cls: 'vre-prefilter-input',
			});
			input.addEventListener('change', () => {
				const values = input.value.split(',').map(v => v.trim()).filter(Boolean);

		console.log(`[VaultRagExplorerView] prefilter ${storeKey} changed`, values);
				this.store.setState({
					queryOptions: { ...this.store.getState().queryOptions, [storeKey]: values }
				});
				// Critical fix: also update this.preFilter so runQuery reads it
				(this.preFilter as unknown)[preFilterKey] = values;

		console.log(`[VaultRagExplorerView] this.preFilter.${preFilterKey} = `, values);
			});
			return input;
		};

		const addDateRow = (label: string, storeKey: 'createdAfter' | 'createdBefore', preFilterKey: 'createdAfter' | 'createdBefore') => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: label, cls: 'vre-label-include' });
			const input = row.createEl('input', { type: 'date', cls: 'vre-prefilter-input' });
			input.addEventListener('change', () => {
				const ms = input.value ? new Date(input.value).getTime() : null;

		console.log(`[VaultRagExplorerView] prefilter ${storeKey} changed`, ms);
				this.store.setState({
					queryOptions: { ...this.store.getState().queryOptions, [storeKey]: ms }
				});
				this.preFilter[preFilterKey] = ms;
			});
		};

		const addPropertyRow = () => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: 'Property (key=value, comma-separated)', cls: 'vre-label-include' });
			const input = row.createEl('input', {
				type: 'text',
				placeholder: 'status=active, type=concept',
				cls: 'vre-prefilter-input',
			});
			input.addEventListener('change', () => {
				const parsed = input.value
					.split(',')
					.map(v => v.trim())
					.filter(v => v.includes('='))
					.map(v => {
						const [k, ...rest] = v.split('=');
						if (k) return { key: k.trim(), value: rest.join('=').trim() };
						return undefined;
					})
					.filter((prop): prop is { key: string; value: string } => prop !== undefined);
				this.store.setState({
					queryOptions: { ...this.store.getState().queryOptions, propertyFilters: parsed }
				});
				this.preFilter.propertyFilters = parsed;

		console.log('[VaultRagExplorerView] prefilter propertyFilters changed', parsed);
			});
		};

		grid.createEl('div', { text: '✅ Include only', cls: 'vre-prefilter-section-label' });
		addRow('Folders (comma-separated)', 'Research/, Projects/Active', 'includeFolders', 'folderIncludes');
		addRow('Tags (comma-separated)', 'concept, permanent', 'includeTags', 'tagIncludes');
		addRow('Filename contains', 'MOC, index', 'filenameContains', 'fileNameIncludes');
		addRow('Filename exact', 'Home, Dashboard', 'filenameExact', 'fileNameExact');
		addDateRow('Created after', 'createdAfter', 'createdAfter');
		addDateRow('Created before', 'createdBefore', 'createdBefore');
		addPropertyRow();

		grid.createEl('div', { text: '❌ Exclude', cls: 'vre-prefilter-section-label' });
		addRow('Folders (comma-separated)', 'Archive/, Templates/', 'excludeFolders', 'folderExcludes', true);
		addRow('Tags (comma-separated)', 'draft, inbox', 'excludeTags', 'tagExcludes', true);
		addRow('Filename contains', 'draft, WIP', 'filenameExcludes', 'fileNameExcludes', true);
		addRow('File path (exact, comma-separated)', 'Research/MyNote.md, Archive/Old.md', 'filePathExcludes', 'filePathExcludes', true);

		const resetBtn = details.createEl('button', { text: 'Reset filters', cls: 'vre-prefilter-reset' });
		resetBtn.addEventListener('click', () => {

		console.log('[VaultRagExplorerView] prefilter reset');
			this.store.setState({
				queryOptions: {
					...this.store.getState().queryOptions,
					includeFolders: [],
					excludeFolders: [],
					includeTags: [],
					excludeTags: [],
					filenameContains: [],
					filenameExact: [],
					filenameExcludes: [],
					filePathExcludes: [],
					createdAfter: null,
					createdBefore: null,
					propertyFilters: [],
				}
			});
			// Also reset preFilter
			this.preFilter.folderIncludes = [];
			this.preFilter.tagIncludes = [];
			this.preFilter.fileNameIncludes = [];
			this.preFilter.fileNameExact = [];
			this.preFilter.createdAfter = null;
			this.preFilter.createdBefore = null;
			this.preFilter.propertyFilters = [];
			this.preFilter.folderExcludes = [];
			this.preFilter.tagExcludes = [];
			this.preFilter.fileNameExcludes = [];
			this.preFilter.filePathExcludes = [];

		console.log('[VaultRagExplorerView] this.preFilter reset', this.preFilter);
			details.querySelectorAll('input').forEach((el: HTMLInputElement) => { el.value = ''; });
		});
	}


	private clearSession(): void {
		console.log("[VaultRagExplorerView] clearSession called");
		this.store.setState({ currentQueryText: "", queryResponse: null, selectedNodeId: null, activeSessionId: null });
		if (this.queryInputEl) this.queryInputEl.value = "";
		if (this.resultsEl) {
			this.resultsEl.empty();
			this.resultsEl.createEl("div", { text: "No query run yet.", cls: "vre-empty-state" });
		}
		if (this.inspectorEl) {
			this.inspectorEl.empty();
			this.inspectorEl.createEl("div", { text: "Select a result or graph node to inspect it.", cls: "vre-empty-state" });
		}
		this.graphPanel?.setGraph([], []);
		this.excludedSourceIds.clear();
		this.excludedPaths.clear();
		this.preFilter = JSON.parse(JSON.stringify(EMPTY_PREFILTER));
		this.resultItemMap.clear();
		this.plugin.lockedNodesService.clear();
		console.log("[VaultRagExplorerView] clearSession complete");
	}

	private getEffectiveRetrievalCount(granularity: "file" | "block"): number {
		if (this.retrievalCountOverride != null) return this.retrievalCountOverride;
		return this.plugin.settings.retrievalDocumentLimit;
	}

	private renderQueryPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "vre-panel vre-query-panel" });
		panel.createEl("h3", { text: "Query" });

		this.queryInputEl = panel.createEl("textarea", {
			text: this.store.getState().currentQueryText,
		});
		this.queryInputEl.placeholder =
			'Ask a question, e.g. "Find discussions of student data quality issues linked to HESES"';

		this.queryInputEl.addEventListener("input", () => {
			this.store.setState({ currentQueryText: this.queryInputEl?.value ?? "" });

		console.log("[VaultRagExplorerView] Query input changed", {
				query: this.store.getState().currentQueryText,
			});
		});

		this.renderPreFilterPanel(panel);

		const controls = panel.createDiv({ cls: "vre-query-controls" });

		const retrievalControls = controls.createDiv({ cls: "vre-query-control-group" });

		const granularitySelect = retrievalControls.createEl("select", { cls: "vre-retrieval-granularity-select" });
		granularitySelect.createEl("option", { value: "file", text: "File level" });
		granularitySelect.createEl("option", { value: "block", text: "Block level" });
		const initialGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;
		granularitySelect.value = initialGranularity;

		const countLabel = retrievalControls.createEl("label", {
			text: initialGranularity === "file" ? " Documents" : " Passages"
		});
		const countInput = retrievalControls.createEl("input", {
			type: "number",
			cls: "vre-retrieval-count-input",
			value: String(this.getEffectiveRetrievalCount(initialGranularity)),
		});
		countInput.min = "1";
		countInput.max = "50";

		granularitySelect.addEventListener("change", () => {
			const value = granularitySelect.value as "file" | "block";
			this.retrievalGranularityOverride = value;
			countLabel.innerText = value === "file" ? " Documents" : " Passages";
			console.log("[VaultRagExplorerView] retrieval granularity override changed", { value });
		});

		countInput.addEventListener("input", () => {
			const parsed = Number(countInput.value);
			if (Number.isFinite(parsed) && parsed > 0) {
				this.retrievalCountOverride = parsed;
				console.log("[VaultRagExplorerView] retrieval count override changed", { value: parsed });
			}
		});

		const runBtn = controls.createEl("button", { text: "Run Query" });
		runBtn.addEventListener("click", async () => {
			console.log("[VaultRagExplorerView] pre-run queryService check", {
				queryServiceExists: !!this.plugin?.queryService,
				pluginDebugId: this.plugin?.debugInstanceId,
			});
			console.log("[VaultRagExplorerView] pre-runQuery plugin method check", {
				hasBeginQuery: typeof (this.plugin as { beginQuery?: unknown })?.beginQuery,
				hasEndQuery: typeof (this.plugin as { endQuery?: unknown })?.endQuery,
				pluginConstructor: this.plugin?.constructor?.name,
			});

			if (this.plugin.isIndexing) {
				console.log("[VaultRagExplorerView] query click blocked — indexing in progress");
				new Notice("Vault RAG Explorer is updating the index. Please wait a moment.");
				return;
			}

			console.log("[VaultRagExplorerView] query submit start");
			runBtn.setAttr("disabled", "true");
			runBtn.empty();
			runBtn.createSpan({ cls: "loading-spinner" });
			runBtn.createSpan({ text: " Running…" });
			console.log("[VaultRagExplorerView] runQuery started — spinner shown");
			try {
				await this.runQuery();
			} catch (error) {
				console.error("[VaultRagExplorerView] Query failed", error);
			} finally {
				runBtn.removeAttribute("disabled");
				runBtn.empty();
				runBtn.setText("Run Query");
				console.log("[VaultRagExplorerView] query submit end");
			}
		});

		const lockAllBtn = controls.createEl("button", { text: "Lock All Visible" });
		lockAllBtn.addEventListener("click", () => {

		console.log("[VaultRagExplorerView] Lock all visible clicked");
			const hits = this.store.getState().queryResponse?.hits || [];
			for (const hit of hits) {
				this.plugin.lockedNodesService.lock({
					nodeType: hit.nodeType,
					nodeId: hit.nodeId,
					path: hit.path,
					title: hit.title,
					blockKey: hit.blockKey,
					lockedAt: Date.now()
				});
			}
			new Notice(`Locked ${hits.length} visible nodes`);
			this.render(); // Re-render to update lock states
		});

		const saveBtn = controls.createEl("button", { text: "Save Session" });
		saveBtn.addEventListener("click", async () => {

		console.log("[VaultRagExplorerView] Save session clicked");
			const state = this.store.getState();
			if (!state.queryResponse) {
				new Notice("No active query to save.");
				return;
			}

			const sessionId = state.activeSessionId || `session-${Date.now()}`;

			const graphPositions = this.graphPanel?.getPositions() ?? {};

		console.log(`[VaultRagExplorerView] saveSession: captured ${Object.keys(graphPositions).length} node positions`);

			await this.plugin.sessionService.save({
				id: sessionId,
				createdAt: Date.now(),
				queryText: state.currentQueryText,
				queryOptions: state.queryOptions,
				lockedNodes: this.plugin.lockedNodesService.getAll(),
				graphPositions
			});

			this.store.setState({ activeSessionId: sessionId });
			new Notice(`Session saved: ${sessionId}`);
		});

		const loadBtn = controls.createEl("button", { text: "Load Session" });
		loadBtn.addEventListener("click", async () => {

		console.log("[VaultRagExplorerView] Load session clicked");
			const sessions = await this.plugin.sessionService.list();
			if (sessions.length === 0) {
				new Notice("No saved sessions found.");
				return;
			}
			// Load the most recent session for milestone purposes.
			// A real UI would show a modal selector.
			const recent = sessions[0];
			if (!recent) return;
			const session = await this.plugin.sessionService.load(recent.id);
			if (session) {
				this.store.setState({
					activeSessionId: session.id,
					currentQueryText: session.queryText,
					queryOptions: session.queryOptions
				});

				this.plugin.lockedNodesService.clear();
				for (const node of session.lockedNodes) {
					this.plugin.lockedNodesService.lock(node);
				}

				await this.runQuery(); // Re-run query to populate hits

				// Re-apply layout positions if possible
				if (this.graphPanel && session.graphPositions) {
					this.graphPanel.restorePositions(session.graphPositions);

		console.log("[VaultRagExplorerView] loadSession: positions restored");
				}
				new Notice(`Session loaded: ${session.id}`);
			}
		});

		const exportBtn = controls.createEl("button", { text: "Export RAG Context" });
		exportBtn.addEventListener("click", async () => {
			console.log("[VaultRagExplorerView] Export RAG Context clicked");
			const locked = this.plugin.lockedNodesService.getAll();
			if (locked.length === 0) {
				new Notice("No locked nodes to export.");
				return;
			}
			const bundle = await this.plugin.ragExportService.buildContextBundle(locked);
			const rawFolder = this.plugin.settings.ragExportFolder.trim();
			const fileName = `rag_context_export_${Date.now()}.md`;

			let filePath: string;
			if (rawFolder) {
				// Ensure the folder exists — create it silently if not
				const folderExists = this.app.vault.getAbstractFileByPath(rawFolder);
				if (!folderExists) {
					try {
						await this.app.vault.createFolder(rawFolder);
						console.log("[VaultRagExplorerView] export: created missing folder", rawFolder);
					} catch (err) {
						console.warn("[VaultRagExplorerView] export: could not create folder", rawFolder, err);
					}
				}
				// Normalise trailing slash before joining
				filePath = rawFolder.replace(/\/+$/, "") + "/" + fileName;
			} else {
				filePath = fileName; // vault root
			}

			await this.app.vault.adapter.write(filePath, bundle);
			new Notice(`Exported ${bundle.length} chars to ${filePath}`);
			console.log("[VaultRagExplorerView] export written to", filePath);
		});

		const clearBtn = controls.createEl("button", { text: "✕ Clear", cls: "vre-clear-btn" });
		clearBtn.title = "Clear query, results, graph and locked nodes";
		clearBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Clear button clicked");
			this.clearSession();
		});
	}

	private renderResultsPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "vre-panel vre-results-panel" });

		const headerRow = panel.createDiv({ cls: "vre-panel-header-row" });
		headerRow.createEl("h3", { text: "Results" });

		this.resultsToolbarEl = panel.createDiv({ cls: "vre-results-toolbar" });

		const btnFlat = this.resultsToolbarEl.createEl("button", { text: "Flat", cls: "vre-results-mode-btn" });
		const btnGrouped = this.resultsToolbarEl.createEl("button", { text: "Grouped by file", cls: "vre-results-mode-btn" });

		const updateToolbarState = () => {
			if (this.resultsViewMode === "flat") {
				btnFlat.addClass("is-active");
				btnGrouped.removeClass("is-active");
			} else {
				btnGrouped.addClass("is-active");
				btnFlat.removeClass("is-active");
			}
		};

		btnFlat.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Results mode changed to flat");
			this.resultsViewMode = "flat";
			updateToolbarState();
			const hits = this.store.getState().queryResponse?.hits;
			if (hits) this.renderResults(hits);
		});

		btnGrouped.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Results mode changed to groupedByFile");
			this.resultsViewMode = "groupedByFile";
			updateToolbarState();
			const hits = this.store.getState().queryResponse?.hits;
			if (hits) this.renderResults(hits);
		});

		updateToolbarState();

		this.resultsEl = panel.createDiv({ cls: "vre-results-list" });
		this.resultsEl.createEl("div", {
			text: "No query run yet.",
			cls: "vre-empty-state",
		});
	}

	private getVisibleFilesForGraph(files: FileMatch[]): FileMatch[] {
		if (!this.graphScoreRangeOverride) return files;

		const [minScore, maxScore] = this.graphScoreRangeOverride;
		const visible = files.filter((file) => file.score >= minScore && file.score <= maxScore);

		console.log("[VaultRagExplorerView] graph score filter applied", {
			minScore,
			maxScore,
			inputCount: files.length,
			outputCount: visible.length,
		});

		return visible;
	}

	private renderGraphScoreControls(panel: HTMLElement): void {
		if (!this.lastQueryResults || this.lastQueryResults.granularity !== "file") return;

		const files = this.lastQueryResults.files;
		if (files.length === 0) return;

		const globalMin = Math.min(...files.map(f => f.score));
		const globalMax = Math.max(...files.map(f => f.score));

		console.log("[VaultRagExplorerView] graph slider bounds", { globalMin, globalMax, fileCount: files.length });

		let minScore = globalMin;
		let maxScore = globalMax;

		if (!this.graphScoreRangeOverride) {
			this.graphScoreRangeOverride = [minScore, maxScore];
			console.log("[VaultRagExplorerView] graph score range initialized", {
				minScore,
				maxScore,
				fileCount: files.length,
			});
		} else {
			[minScore, maxScore] = this.graphScoreRangeOverride;
		}

		const filterPanel = panel.createDiv({ cls: "vre-graph-filter-panel" });

		const statusText = filterPanel.createDiv({ cls: "vre-graph-filter-status" });
		const updateStatus = () => {
			const visibleCount = this.getVisibleFilesForGraph(files).length;
			statusText.innerText = `Showing ${visibleCount} of ${files.length} retrieved files`;
			console.log("[VaultRagExplorerView] graph visibility summary", {
				visibleCount,
				totalCount: files.length,
				minScore: this.graphScoreRangeOverride![0],
				maxScore: this.graphScoreRangeOverride![1],
			});
		};
		updateStatus();

		const rowMin = filterPanel.createDiv({ cls: "vre-graph-filter-row" });
		rowMin.createEl("span", { text: "Min Score: ", cls: "vre-graph-filter-label" });
		const sliderMin = rowMin.createEl("input", { type: "range" });
		sliderMin.min = String(globalMin);
		sliderMin.max = String(globalMax);

		const step = (globalMax - globalMin <= 0.1) ? "0.001" : String((globalMax - globalMin) / 200);
		sliderMin.step = step;
		sliderMin.value = String(minScore);
		const valMin = rowMin.createEl("span", { text: minScore.toFixed(3), cls: "vre-graph-filter-value" });

		const rowMax = filterPanel.createDiv({ cls: "vre-graph-filter-row" });
		rowMax.createEl("span", { text: "Max Score: ", cls: "vre-graph-filter-label" });
		const sliderMax = rowMax.createEl("input", { type: "range" });
		sliderMax.min = String(globalMin);
		sliderMax.max = String(globalMax);
		sliderMax.step = step;
		sliderMax.value = String(maxScore);
		const valMax = rowMax.createEl("span", { text: maxScore.toFixed(3), cls: "vre-graph-filter-value" });

		if (globalMin === globalMax) {
			sliderMin.disabled = true;
			sliderMax.disabled = true;
			statusText.innerText = "All files have same score";
		}

		const handleInput = () => {
			let minVal = parseFloat(sliderMin.value);
			let maxVal = parseFloat(sliderMax.value);
			if (minVal > maxVal) {
				minVal = maxVal;
				sliderMin.value = String(minVal);
			}
			valMin.innerText = minVal.toFixed(3);
			valMax.innerText = maxVal.toFixed(3);
			this.graphScoreRangeOverride = [minVal, maxVal];

			console.log("[VaultRagExplorerView] graph slider input", { minVal, maxVal, visibleCount: this.getVisibleFilesForGraph(files).length });

			updateStatus();
			this.rerenderGraphFromFilters();
		};

		sliderMin.addEventListener("input", handleInput);
		sliderMax.addEventListener("input", handleInput);

		const resetBtn = filterPanel.createEl("button", { text: "Show all retrieved files", cls: "vre-graph-filter-reset" });
		resetBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] graph slider reset", { globalMin, globalMax });
			this.graphScoreRangeOverride = [globalMin, globalMax];
			sliderMin.value = String(globalMin);
			sliderMax.value = String(globalMax);
			valMin.innerText = globalMin.toFixed(3);
			valMax.innerText = globalMax.toFixed(3);
			updateStatus();
			this.rerenderGraphFromFilters();
		});
	}

	private async rerenderGraphFromFilters() {
		if (this.lastQueryResults && this.lastQueryResults.granularity === "file") {
			const visibleFiles = this.getVisibleFilesForGraph(this.lastQueryResults.files);
			await this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
			if (this.syncResultsWithGraphFilter) {
				this.renderResults(this.store.getState().queryResponse?.hits || []);
			}
		}
	}

	private renderGraphPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "vre-panel vre-graph-panel" });
		panel.createEl("h3", { text: "Graph" });

		const graphFilterContainer = panel.createDiv({ cls: "vre-graph-filter-container" });
		this.renderGraphScoreControls(graphFilterContainer);

		this.graphEl = panel.createDiv({ cls: "vre-graph-canvas" });
		if (this.graphPanel) {
			this.graphPanel.destroy();
			this.graphPanel = null;
		}
		this.graphPanel = new D3GraphPanel(this.graphEl);
		this.graphPanel.setOnNodeClick((nodeId) => {
			this.selectNodeAndSync(nodeId, "graph");
		});

		// Graph controls toolbar
		const controls = panel.createDiv({ cls: "vre-graph-controls" });

		const resetBtn = controls.createEl("button", { text: "⌖ Reset View", cls: "vre-graph-ctrl-btn" });
		resetBtn.title = "Fit all nodes into view";
		resetBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] graph reset view clicked");
			this.graphPanel?.resetView();
		});

		const reheatBtn = controls.createEl("button", { text: "⟳ Reheat", cls: "vre-graph-ctrl-btn" });
		reheatBtn.title = "Restart force simulation";
		reheatBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] graph reheat clicked");
			this.graphPanel?.reheat();
		});

		controls.createEl("label", { text: "Link dist", cls: "vre-graph-ctrl-label" });
		const linkSlider = controls.createEl("input", { cls: "vre-graph-ctrl-slider" }) ;
		linkSlider.type = "range"; linkSlider.min = "30"; linkSlider.max = "300"; linkSlider.value = "80";
		linkSlider.addEventListener("input", () => {
			console.log("[VaultRagExplorerView] linkDistance changed", linkSlider.value);
			this.graphPanel?.setSimulationParams({ linkDistance: parseInt(linkSlider.value, 10) });
		});

		controls.createEl("label", { text: "Repulsion", cls: "vre-graph-ctrl-label" });
		const chargeSlider = controls.createEl("input", { cls: "vre-graph-ctrl-slider" }) ;
		chargeSlider.type = "range"; chargeSlider.min = "-400"; chargeSlider.max = "-10"; chargeSlider.value = "-120";
		chargeSlider.addEventListener("input", () => {
			console.log("[VaultRagExplorerView] chargeStrength changed", chargeSlider.value);
			this.graphPanel?.setSimulationParams({ chargeStrength: parseInt(chargeSlider.value, 10) });
		});

		controls.createEl("label", { text: "Node size", cls: "vre-graph-ctrl-label" });
		const sizeSlider = controls.createEl("input", { cls: "vre-graph-ctrl-slider" }) ;
		sizeSlider.type = "range"; sizeSlider.min = "0.5"; sizeSlider.max = "3"; sizeSlider.step = "0.1"; sizeSlider.value = "1.0";
		sizeSlider.addEventListener("input", () => {
			console.log("[VaultRagExplorerView] nodeSizeScale changed", sizeSlider.value);
			this.graphPanel?.setSimulationParams({ nodeSizeScale: parseFloat(sizeSlider.value) });
		});

		console.log("[VaultRagExplorerView] renderGraphPanel — controls rendered");
	}

	private renderInspectorPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "vre-panel vre-inspector-panel" });
		panel.createEl("h3", { text: "Inspector / RAG Context" });

		this.inspectorEl = panel.createDiv({ cls: "vre-inspector-content" });
		this.inspectorEl.createEl("div", {
			text: "Select a result or graph node to inspect it.",
			cls: "vre-empty-state",
		});
	}

	setQueryText(text: string): void {
		this.store.setState({ currentQueryText: text });
	}

	async runQuery(): Promise<void> {
		const state = this.store.getState();
		const query = state.currentQueryText.trim();
		const effectiveGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;
		const effectiveRetrievalCount = this.getEffectiveRetrievalCount(effectiveGranularity);

		console.log("[VaultRagExplorerView] runQuery called", {
			query,
			options: state.queryOptions,
		});

		if (!query) {
			new Notice("Enter a query first");

		console.warn("[VaultRagExplorerView] Empty query blocked");
			return;
		}

		const smartFolderPath = this.plugin.getSmartFolderPath();

		console.log("[VaultRagExplorerView] runQuery smart folder check", { smartFolderPath });

		if (!smartFolderPath) {
			new Notice("Set the Smart folder in Vault RAG Explorer settings before running queries.");

		console.warn("[VaultRagExplorerView] blocked query because smart folder is not configured");
			return;
		}

		try {
			const response = await this.queryService.runQuery({
				queryText: query,
				options: {
					...state.queryOptions,
					preFilterOptions: this.preFilter,
					granularityOverride: effectiveGranularity,
					retrievalCountOverride: effectiveRetrievalCount,
				},
			});

			this.store.setState({ queryResponse: response });

			this.fileMatchMap.clear();
			this.blockMatchMap.clear();

			if (response.payload) {
				this.lastQueryResults = response.payload;
				this.graphScoreRangeOverride = null; // reset filter on new query

				console.log("[VaultRagExplorerView] query payload mode", {
					granularity: response.payload.granularity,
					fileCount: response.payload.files.length,
					blockCount: response.payload.blocks.length
				});

				if (response.payload.granularity === "file") {
					for (const file of response.payload.files) {
						this.fileMatchMap.set(`note-${file.sourceId}`, file);
						for (const block of file.matchedBlocks) {
							this.blockMatchMap.set(`block-${block.blockId}`, block);
						}
					}
				} else {
					for (const block of response.payload.blocks) {
						this.blockMatchMap.set(`block-${block.blockId}`, block);
					}
				}

				const rightPane = this.contentEl.querySelector(".vre-right-pane") as HTMLElement;
				if (rightPane) {
					const graphPanelEl = rightPane.querySelector(".vre-graph-panel");
					if (graphPanelEl) {
						const filterContainer = graphPanelEl.querySelector(".vre-graph-filter-container") as HTMLElement;
						if (filterContainer) {
							filterContainer.empty();
							this.renderGraphScoreControls(filterContainer);
						}
					}
				}
			}

			this.renderResults(response.hits);
			this.renderInspectorForNodeId(null);

			if (response.payload && response.payload.granularity === "file") {
				const visibleFiles = this.getVisibleFilesForGraph(response.payload.files);
				await this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
			} else if (response.payload && response.payload.granularity === "block") {
				await this.renderBlockGraph(response.payload.blocks, this.plugin.lockedNodesService.getAll());
			} else {
				await this.renderGraph(response.hits, this.plugin.lockedNodesService.getAll());
			}

			new Notice(`Query complete: ${response.hits.length} hits`);

		console.log("[VaultRagExplorerView] Query complete", { hitCount: response.hits.length });
		} catch (error) {

		console.error("[VaultRagExplorerView] Query failed", error);
			new Notice("Query failed. Check console for details.");
			throw error;
		}
	}

	public excludeFile(sourceId: number, path: string): void {
		console.log("[VaultRagExplorerView] excludeFile start", { sourceId, path });

		this.excludedSourceIds.add(sourceId);
		this.excludedPaths.add(path);

		if (!this.preFilter.excludedSourceIds.includes(sourceId)) {
			this.preFilter.excludedSourceIds.push(sourceId);
		}

		// Remove ALL graph nodes that belong to this source
		this.graphPanel?.excludeBySourceId(sourceId);

		const currentState = this.store.getState();
		if (currentState.selectedNodeId) {
			const activeHit = currentState.queryResponse?.hits.find(h => `${h.nodeType}-${h.nodeId}` === currentState.selectedNodeId);
			if ((activeHit && activeHit.sourceId === sourceId) || currentState.selectedNodeId === `note-${sourceId}`) {
				this.store.setState({ selectedNodeId: null });
				this.renderInspectorForNodeId(null);
				console.log("[VaultRagExplorerView] inspector cleared due to exclusion", { selectedNodeId: currentState.selectedNodeId });
			}
		}

		console.log("[VaultRagExplorerView] exclusion applied", { excludedSourceCount: this.excludedSourceIds.size, excludedBlockCount: this.excludedBlockIds.size });

		if ((this as unknown)._refreshExclusionList) (this as unknown)._refreshExclusionList();
		this.renderResults(this.store.getState().queryResponse?.hits || []);
	}

	public excludeBlock(blockId: number, sourceId: number, path: string): void {
		console.log("[VaultRagExplorerView] excludeBlock start", { blockId, sourceId, path });

		this.excludedBlockIds.add(blockId);
		this.graphPanel?.excludeByNodeId(`block-${blockId}`);

		const currentState = this.store.getState();
		if (currentState.selectedNodeId === `block-${blockId}`) {
			this.store.setState({ selectedNodeId: null });
			this.renderInspectorForNodeId(null);
			console.log("[VaultRagExplorerView] inspector cleared due to exclusion", { selectedNodeId: currentState.selectedNodeId });
		}

		console.log("[VaultRagExplorerView] exclusion applied", { excludedSourceCount: this.excludedSourceIds.size, excludedBlockCount: this.excludedBlockIds.size });

		if ((this as unknown)._refreshExclusionList) (this as unknown)._refreshExclusionList();
		this.renderResults(this.store.getState().queryResponse?.hits || []);
	}

	private renderExclusionList(container: HTMLElement): void {
		const details = container.createEl('details', { cls: 'vre-exclusion-panel' });
		details.createEl('summary', { text: '🚫 Excluded files' });

		const listEl = details.createEl('ul', { cls: 'vre-exclusion-list' });

		const refresh = () => {
			listEl.empty();
			if (this.excludedPaths.size === 0 && this.excludedBlockIds.size === 0) {
				listEl.createEl('li', { text: 'None', cls: 'vre-exclusion-empty' });
				return;
			}
			this.excludedPaths.forEach(path => {
				const li = listEl.createEl('li', { cls: 'vre-exclusion-item' });
				li.createEl('span', { text: `File: ${path.replace('.md', '')}`, cls: 'vre-exclusion-path' });
				const restore = li.createEl('button', { text: 'Restore', cls: 'vre-exclusion-restore' });
				restore.addEventListener('click', () => {
					this.excludedPaths.delete(path);
					const rawDb = this.plugin.db.getDb();
					const stmt = rawDb.prepare('SELECT id FROM sources WHERE path = $path');
					stmt.bind({ $path: path });
					if (stmt.step()) {
						const id = (stmt.getAsObject() as { id: number }).id;
						this.excludedSourceIds.delete(id);
						this.preFilter.excludedSourceIds = this.preFilter.excludedSourceIds.filter((i: number) => i !== id);
						this.graphPanel?.restoreBySourceId(id);

		console.log(`[VaultRagExplorerView] restored sourceId ${id} (path: ${path})`);
					}
					stmt.free();
					refresh();
					this.renderResults(this.store.getState().queryResponse?.hits || []);
				});
			});
			this.excludedBlockIds.forEach(blockId => {
				const li = listEl.createEl('li', { cls: 'vre-exclusion-item' });
				li.createEl('span', { text: `Block: ${blockId}`, cls: 'vre-exclusion-path' });
				const restore = li.createEl('button', { text: 'Restore', cls: 'vre-exclusion-restore' });
				restore.addEventListener('click', () => {
					this.excludedBlockIds.delete(blockId);
					this.graphPanel?.restoreByNodeId(`block-${blockId}`);
					console.log(`[VaultRagExplorerView] restored blockId ${blockId}`);
					refresh();
					this.renderResults(this.store.getState().queryResponse?.hits || []);
				});
			});
		};

		(this as unknown)._refreshExclusionList = refresh;
		refresh();
	}


	private renderResults(hits: RetrievalHit[]): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();
		this.resultItemMap.clear();
		this.renderExclusionList(this.resultsEl);

		const response = this.store.getState().queryResponse;
		if (response && response.payload) {
			if (response.payload.granularity === "file") {
				let files = response.payload.files;
				if (this.syncResultsWithGraphFilter) {
					files = this.getVisibleFilesForGraph(files);
				}
				this.renderFileResults(files);
			} else {
				this.renderBlockResults(response.payload.blocks);
			}
		} else {
			// Fallback to legacy rendering if payload is missing
			if (this.resultsViewMode === "flat") {
				this.renderFlatResults(hits);
			} else {
				this.renderGroupedResults(hits);
			}
		}

		const selectedId = this.store.getState().selectedNodeId;
		if (selectedId) {
			this.highlightResultItem(selectedId);
			console.log(`[VaultRagExplorerView] renderResults: restored highlight for ${selectedId}`);
		}
	}

	private renderFileResults(files: FileMatch[]): void {
		console.log("[VaultRagExplorerView] renderFileResults start", { fileCount: files.length });
		for (const file of files) {
			if (this.excludedSourceIds.has(file.sourceId) || this.excludedPaths.has(file.path)) continue;

			const visibleBlocks = file.matchedBlocks.filter(b => !this.excludedBlockIds.has(b.blockId));
			if (visibleBlocks.length === 0 && file.matchedBlocks.length > 0) continue;

			const card = this.resultsEl!.createDiv({ cls: "vre-file-result vre-result-selectable" });
			const nodeKey = `note-${file.sourceId}`;
			card.setAttribute("data-node-id", nodeKey);
			this.resultItemMap.set(nodeKey, card);

			const header = card.createDiv({ cls: "vre-file-result__header" });
			header.createEl("span", { text: file.score.toFixed(3), cls: "vre-file-result__score" });

			const link = header.createEl("a", { text: `[[${file.title}]]`, cls: "internal-link vre-file-result__title", href: file.path });
			link.setAttribute('data-href', file.path);
			link.setAttribute('data-type', 'link');
			link.setAttribute('target', '_blank');
			link.setAttribute('rel', 'noopener');

			this.registerDomEvent(link, 'click', (event: MouseEvent) => {
				event.preventDefault();
				this.openHit({ nodeType: "note", nodeId: file.sourceId, sourceId: file.sourceId, path: file.path, title: file.title, semanticScore: file.score, wikilinkBoost: 0, finalScore: file.score, reasons: [] });
			});

			card.addEventListener("click", () => {
				this.selectNodeAndSync(nodeKey, "results");
			});

			header.createEl("span", { text: file.path, cls: "vre-file-result__path" });

			const toggleBtn = header.createEl("button", { text: "Show matching passages", cls: "vre-file-result__toggle" });
			const blocksContainer = card.createDiv({ cls: "vre-file-result__blocks" });
			blocksContainer.style.display = "none";

			let expanded = false;
			toggleBtn.addEventListener("click", () => {
				expanded = !expanded;
				blocksContainer.style.display = expanded ? "block" : "none";
				toggleBtn.innerText = expanded ? "Hide matching passages" : "Show matching passages";
				console.log("[VaultRagExplorerView] toggle file result expansion", { path: file.path, expanded });
			});

			for (const block of visibleBlocks) {
				const blockItem = blocksContainer.createDiv({ cls: "vre-block-evidence" });
				blockItem.createEl("span", { text: block.score.toFixed(3), cls: "vre-result-score" });
				if (block.blockLabel) {
					blockItem.createEl("div", { text: block.blockLabel, cls: "vre-block-evidence-label" });
				}
				blockItem.createEl("div", { text: block.text, cls: "vre-block-evidence-text" });
			}
		}
	}

	private renderBlockResults(blocks: BlockMatch[]): void {
		console.log("[VaultRagExplorerView] renderBlockResults start", { blockCount: blocks.length });
		for (const block of blocks) {
			if (this.excludedSourceIds.has(block.sourceId) || this.excludedPaths.has(block.path) || this.excludedBlockIds.has(block.blockId)) continue;

			const hit: RetrievalHit = {
				nodeType: "block",
				nodeId: block.blockId,
				sourceId: block.sourceId,
				path: block.path,
				title: block.title,
				blockKey: block.blockKey,
				previewText: block.text,
				semanticScore: block.score,
				wikilinkBoost: 0,
				finalScore: block.score,
				reasons: []
			};
			this.renderHitItem(this.resultsEl!, hit, null);
		}
	}

	private renderFlatResults(hits: RetrievalHit[]): void {
		hits.forEach((hit) => {
			this.renderHitItem(this.resultsEl!, hit, null);
		});
		console.log(`[VaultRagExplorerView] rendered ${hits.length} flat results`);
	}

	private renderGroupedResults(hits: RetrievalHit[]): void {
		const groups = new Map<string, RetrievalHit[]>();
		for (const hit of hits) {
			if (!groups.has(hit.path)) groups.set(hit.path, []);
			groups.get(hit.path)!.push(hit);
		}

		// Sort groups by highest scoring hit
		const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
			const maxA = Math.max(...a[1].map(h => h.finalScore));
			const maxB = Math.max(...b[1].map(h => h.finalScore));
			return maxB - maxA;
		});

		for (const [path, groupHits] of sortedGroups) {
			const groupEl = this.resultsEl!.createDiv({ cls: "vre-result-group" });
			const headerEl = groupEl.createDiv({ cls: "vre-result-group-header" });
			headerEl.createEl("span", { cls: "vre-result-group-path", text: path });

			// note hit first, then blocks by score
			const sortedHits = groupHits.sort((a, b) => {
				if (a.nodeType === "note" && b.nodeType !== "note") return -1;
				if (b.nodeType === "note" && a.nodeType !== "note") return 1;
				return b.finalScore - a.finalScore;
			});

			const itemsContainer = groupEl.createDiv({ cls: "vre-result-group-items" });
			sortedHits.forEach(hit => {
				this.renderHitItem(itemsContainer, hit, null);
			});
		}
		console.log(`[VaultRagExplorerView] rendered ${sortedGroups.length} groups`);
	}

	private renderHitItem(container: HTMLElement, hit: RetrievalHit, selectedId: string | null = null): void {
		const item = container.createEl('div', { cls: 'vre-result-item vre-result-selectable' });
		const nodeKey = `${hit.nodeType}-${hit.nodeId}`;
		item.setAttribute("data-node-id", nodeKey);
		this.resultItemMap.set(nodeKey, item);
		console.log(`[VaultRagExplorerView] renderHitItem — mapped nodeKey=${nodeKey}`);

		item.createEl('span', {
			text: hit.finalScore.toFixed(3),
			cls: 'vre-result-score',
		});

		const linkText = hit.nodeType === 'block' && hit.blockKey
			? `${hit.path}#${hit.title}`
			: hit.path.replace('.md', '');

		const link = item.createEl('a', {
			text: `[[${hit.title}]]`,
			cls: 'internal-link vre-result-link',
			href: linkText,
		});
		link.setAttribute('data-href', linkText);
		link.setAttribute('data-type', 'link');
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener');

		this.registerDomEvent(link, 'mouseover', (event: MouseEvent) => {
			this.app.workspace.trigger('hover-link', {
				event,
				source: 'vault-rag-explorer',
				hoverParent: this,
				targetEl: link,
				linktext: linkText,
				sourcePath: hit.path,
			});
		});

		this.registerDomEvent(link, 'click', (event: MouseEvent) => {
			event.preventDefault();

		console.log('[VaultRagExplorerView] internal-link clicked', { path: hit.path, blockKey: hit.blockKey, lineStart: hit.lineStart });
			this.openHit(hit);
		});

		item.addEventListener("click", () => {
			this.selectNodeAndSync(nodeKey, "results");
		});

		if (hit.previewText) {
			item.createEl('div', {
				text: hit.previewText.slice(0, 120) + (hit.previewText.length > 120 ? '…' : ''),
				cls: 'vre-result-preview',
			});
		}

		const excludeBtn = item.createEl('button', {
			text: '✕',
			cls: 'vre-result-exclude',
			title: 'Remove and exclude from further exploration',
		});
		excludeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (hit.nodeType === "block") {
				this.excludeBlock(hit.nodeId, hit.sourceId, hit.path);
			} else {
				this.excludeFile(hit.sourceId, hit.path);
			}
			item.remove();
		});

		const actions = item.createDiv({ cls: "vre-result-actions" });

		const inspectBtn = actions.createEl("button", { text: "Inspect" });
			inspectBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.selectNodeAndSync(`${hit.nodeType}-${hit.nodeId}`, "results");
			});

			const isLocked = this.plugin.lockedNodesService.isLocked(`${hit.nodeType}-${hit.nodeId}`);
			const lockBtn = actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock" });
			lockBtn.addEventListener("click", () => {
				const key = `${hit.nodeType}-${hit.nodeId}`;
				if (this.plugin.lockedNodesService.isLocked(key)) {
					this.plugin.lockedNodesService.unlock(key);
					lockBtn.setText("Lock");
					new Notice(`Unlocked: ${hit.title}`);
				} else {
					this.plugin.lockedNodesService.lock({
						nodeType: hit.nodeType,
						nodeId: hit.nodeId,
						path: hit.path,
						title: hit.title,
						blockKey: hit.blockKey,
						lockedAt: Date.now(),
					});
					lockBtn.setText("Locked ✓");
					new Notice(`Locked: ${hit.title}`);
				}
				if (this.store.getState().selectedNodeId === key) {
					this.renderInspectorForNodeId(key);
				}
			});

			const openBtn = actions.createEl("button", { text: "Open" });
			openBtn.addEventListener("click", async () => {

		console.log('[VaultRagExplorerView] Open button clicked', { path: hit.path, lineStart: hit.lineStart });
				await this.openHit(hit);
			});
	}


	private selectNodeAndSync(nodeId: string | null, source: "graph" | "results"): void {
		if (source === "results") {
			console.log("[VaultRagExplorerView] result selected", { nodeId, source });
		} else {
			console.log("[VaultRagExplorerView] graph selected", { nodeId, source });
		}

		this.store.setState({ selectedNodeId: nodeId });
		this.graphPanel?.selectNode(nodeId);

		if (nodeId) {
			this.highlightResultItem(nodeId);
		} else {
			if (this.resultsEl) {
				this.resultsEl.querySelectorAll(".vre-result-selectable").forEach((el) => {
					(el as HTMLElement).removeClass("vre-result-highlighted");
				});
			}
		}

		this.renderInspectorForNodeId(nodeId);
	}

	private highlightResultItem(nodeId: string): void {
		console.log(`[VaultRagExplorerView] highlightResultItem called nodeId=${nodeId}`);
		if (!this.resultsEl) return;
		this.resultsEl.querySelectorAll(".vre-result-selectable").forEach((el) => {
			(el as HTMLElement).removeClass("vre-result-highlighted");
		});
		const item = this.resultItemMap.get(nodeId);
		if (item) {
			item.addClass("vre-result-highlighted");
			item.scrollIntoView({ behavior: "smooth", block: "nearest" });
			console.log("[VaultRagExplorerView] highlightResultItem success", { nodeId });
		} else {
			console.warn("[VaultRagExplorerView] highlightResultItem missing DOM node", { nodeId, mapSize: this.resultItemMap.size });
		}
	}

	public renderInspectorForNodeId(nodeId: string | null): void {
		if (!this.inspectorEl) return;
		this.inspectorEl.empty();

		if (!nodeId) {
			this.inspectorEl.createEl("div", {
				text: "No node selected.",
				cls: "vre-empty-state",
			});
			return;
		}

		const fileMatch = this.fileMatchMap.get(nodeId);
		if (fileMatch) {
			console.log("[VaultRagExplorerView] graph node resolved to file", { nodeId, sourceId: fileMatch.sourceId, path: fileMatch.path });
			this.renderFileInspector(fileMatch);
			return;
		}

		const blockMatch = this.blockMatchMap.get(nodeId);
		if (blockMatch) {
			console.log("[VaultRagExplorerView] graph node resolved to block", { nodeId, blockId: blockMatch.blockId, path: blockMatch.path });
			this.renderBlockInspector(blockMatch);
			return;
		}

		// Fallback for legacy RetrievalHit
		const response = this.store.getState().queryResponse;
		if (response) {
			const hit = response.hits.find(h => `${h.nodeType}-${h.nodeId}` === nodeId);
			if (hit) {
				this.renderLegacyInspector(hit);
				return;
			}
		}

		this.inspectorEl.createEl("div", {
			text: "No node selected.",
			cls: "vre-empty-state",
		});
	}

	private renderFileInspector(file: FileMatch): void {
		if (!this.inspectorEl) return;

		this.inspectorEl.createEl("h4", { text: file.title });
		this.inspectorEl.createEl("div", { text: `Type: file` });
		this.inspectorEl.createEl("div", { text: `Path: ${file.path}` });
		this.inspectorEl.createEl("div", {
			text: `File score: ${file.score.toFixed(3)}`
		});
		this.inspectorEl.createEl("div", {
			text: `Best block score: ${file.bestBlockScore.toFixed(3)}`
		});

		const blocksList = this.inspectorEl.createEl("ul");
		for (const block of file.matchedBlocks) {
			blocksList.createEl("li", { text: `[${block.score.toFixed(3)}] ${block.blockLabel || 'Passage'}` });
		}

		const actions = this.inspectorEl.createDiv({ cls: "vre-inspector-actions" });

		actions.createEl("button", { text: "Open File" }).addEventListener("click", async () => {
			console.log('[VaultRagExplorerView] Inspector open file clicked', { path: file.path });
			const hit: RetrievalHit = { nodeType: "note", nodeId: file.sourceId, sourceId: file.sourceId, path: file.path, title: file.title, semanticScore: file.score, wikilinkBoost: 0, finalScore: file.score, reasons: [] };
			await this.openHit(hit);
		});

		actions.createEl("button", { text: "Exclude File" }).addEventListener("click", () => {
			console.log('[VaultRagExplorerView] Inspector exclude file clicked', { file });
			this.excludeFile(file.sourceId, file.path);
		});

		const key = `note-${file.sourceId}`;
		const isLocked = this.plugin.lockedNodesService.isLocked(key);

		actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock File" }).addEventListener("click", (e) => {
			if (this.plugin.lockedNodesService.isLocked(key)) {
				this.plugin.lockedNodesService.unlock(key);
				(e.target as HTMLButtonElement).setText("Lock File");
				new Notice(`Unlocked: ${file.title}`);
			} else {
				this.plugin.lockedNodesService.lock({
					nodeType: "note",
					nodeId: file.sourceId,
					path: file.path,
					title: file.title,
					lockedAt: Date.now(),
				});
				(e.target as HTMLButtonElement).setText("Locked ✓");
				new Notice(`Locked: ${file.title}`);
			}
			const response = this.store.getState().queryResponse;
			if (response) {
				this.renderResults(response.hits);
			}
		});

		actions.createEl("button", { text: "Expand Semantic" }).addEventListener("click", async () => {
			console.log("[VaultRagExplorerView] Inspector semantic expand clicked", file);
			const state = this.store.getState();
			const modelName = state.queryOptions.embeddingModelName || "TaylorAI/bge-micro-v2";
			const currentGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;

			try {
				const response = await this.queryService.expandSemantic("source", file.sourceId, modelName, state.queryOptions.topK, {
					...state.queryOptions,
					granularityOverride: currentGranularity,
					retrievalCountOverride: this.getEffectiveRetrievalCount(currentGranularity),
				});

				console.log("[VaultRagExplorerView] semantic expansion merge start", { currentGranularity, incomingHitCount: response.hits.length });

				const currentResponse = state.queryResponse;
				if (currentResponse && currentResponse.payload && response.payload) {
					const mergedHits = [...currentResponse.hits];
					for (const newHit of response.hits) {
						if (!mergedHits.some(h => h.nodeId === newHit.nodeId && h.nodeType === newHit.nodeType)) {
							mergedHits.push(newHit);
						}
					}

					const mergedPayload: QueryResultPayload = {
						granularity: currentGranularity,
						files: [...currentResponse.payload.files],
						blocks: [...currentResponse.payload.blocks]
					};

					if (currentGranularity === "file") {
						for (const newFile of response.payload.files) {
							const existingFileIndex = mergedPayload.files.findIndex(f => f.sourceId === newFile.sourceId);
							if (existingFileIndex >= 0) {
								const existingFile = mergedPayload.files[existingFileIndex];
								const mergedBlocks = [...existingFile.matchedBlocks];
								for (const newBlock of newFile.matchedBlocks) {
									if (!mergedBlocks.some(b => b.blockId === newBlock.blockId)) {
										mergedBlocks.push(newBlock);
									}
								}
								mergedBlocks.sort((a, b) => b.score - a.score);
								mergedPayload.files[existingFileIndex] = {
									...existingFile,
									score: Math.max(existingFile.score, newFile.score),
									bestBlockScore: Math.max(existingFile.bestBlockScore, newFile.bestBlockScore),
									matchedBlocks: mergedBlocks
								};
							} else {
								mergedPayload.files.push(newFile);
							}
						}
					} else {
						for (const newBlock of response.payload.blocks) {
							if (!mergedPayload.blocks.some(b => b.blockId === newBlock.blockId)) {
								mergedPayload.blocks.push(newBlock);
							}
						}
					}

					console.log("[VaultRagExplorerView] semantic expansion merge complete", { mergedFileCount: mergedPayload.files.length, mergedBlockCount: mergedPayload.blocks.length });

					const newResponse = { ...currentResponse, hits: mergedHits, payload: mergedPayload };
					this.store.setState({ queryResponse: newResponse });

					// Rebuild maps
					this.fileMatchMap.clear();
					this.blockMatchMap.clear();
					this.lastQueryResults = mergedPayload;

					if (mergedPayload.granularity === "file") {
						for (const f of mergedPayload.files) {
							this.fileMatchMap.set(`note-${f.sourceId}`, f);
							for (const b of f.matchedBlocks) {
								this.blockMatchMap.set(`block-${b.blockId}`, b);
							}
						}
					} else {
						for (const b of mergedPayload.blocks) {
							this.blockMatchMap.set(`block-${b.blockId}`, b);
						}
					}

					this.renderResults(newResponse.hits);

					if (mergedPayload.granularity === "file") {
						const visibleFiles = this.getVisibleFilesForGraph(mergedPayload.files);
						await this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
					} else {
						await this.renderBlockGraph(mergedPayload.blocks, this.plugin.lockedNodesService.getAll());
					}

					new Notice(`Expanded semantics with ${response.hits.length} hits`);
				}
			} catch (e) {
				console.error("[VaultRagExplorerView] Expand Semantic failed", e);
				new Notice("Expand Semantic failed");
			}
		});

		actions.createEl("button", { text: "Expand Wikilinks" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector wikilink expand clicked", file);
			const expander = this.plugin.wikilinkExpander;
			const expansions = expander.expandFrom(file.path);

			if (expansions.length === 0) {
				new Notice("No wikilink expansions found.");
				return;
			}

			const state = this.store.getState();
			const currentResponse = state.queryResponse;
			if (currentResponse && currentResponse.payload) {
				const currentGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;
				const mergedPayload: QueryResultPayload = {
					granularity: currentGranularity,
					files: [...currentResponse.payload.files],
					blocks: [...currentResponse.payload.blocks]
				};
				const mergedHits = [...currentResponse.hits];

				let addedFileCount = 0;
				const resolvedSourceIds: number[] = [];
				for (const expansion of expansions) {
					const dstId = this.getSourceIdForPath(expansion.path);
					if (dstId) {
						resolvedSourceIds.push(dstId);
						if (currentGranularity === "file") {
							if (!mergedPayload.files.some(f => f.sourceId === dstId)) {
								const newTitle = expansion.path.replace('.md', '').split('/').pop() ?? expansion.path;
								mergedPayload.files.push({
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									score: 0.05,
									bestBlockScore: 0,
									matchedBlocks: []
								});
								mergedHits.push({
									nodeType: "note",
									nodeId: dstId,
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									semanticScore: 0.05,
									wikilinkBoost: 0,
									finalScore: 0.05,
									reasons: ["Expanded via wikilink"]
								});
								addedFileCount++;
							}
						} else {
							// Block mode note-level additions
							if (!mergedHits.some(h => h.nodeType === "note" && h.nodeId === dstId)) {
								const newTitle = expansion.path.replace('.md', '').split('/').pop() ?? expansion.path;
								mergedHits.push({
									nodeType: "note",
									nodeId: dstId,
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									semanticScore: 0.05,
									wikilinkBoost: 0,
									finalScore: 0.05,
									reasons: ["Expanded via wikilink"]
								});
								addedFileCount++;
							}
						}
					}
				}

				console.log("[VaultRagExplorerView] wikilink expansion resolved paths", { sourcePath: file.path, expansionCount: expansions.length, resolvedSourceIds });
				console.log("[VaultRagExplorerView] wikilink expansion merged into results", { addedFileCount, totalFileCount: mergedPayload.files.length });

				const newResponse = { ...currentResponse, hits: mergedHits, payload: mergedPayload };
				this.store.setState({ queryResponse: newResponse });

				this.fileMatchMap.clear();
				this.blockMatchMap.clear();
				this.lastQueryResults = mergedPayload;

				if (mergedPayload.granularity === "file") {
					for (const f of mergedPayload.files) {
						this.fileMatchMap.set(`note-${f.sourceId}`, f);
						for (const b of f.matchedBlocks) {
							this.blockMatchMap.set(`block-${b.blockId}`, b);
						}
					}
					// File rendering via payload
					this.renderResults(newResponse.hits);
					const visibleFiles = this.getVisibleFilesForGraph(mergedPayload.files);
					this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
				} else {
					for (const b of mergedPayload.blocks) {
						this.blockMatchMap.set(`block-${b.blockId}`, b);
					}
					// Block rendering
					this.renderResults(newResponse.hits);
					this.renderBlockGraph(mergedPayload.blocks, this.plugin.lockedNodesService.getAll());
				}

				// The graph rendering creates nodes, we need to explicitly inject the graph edges
				if (this.graphPanel) {
					const expansionEdges: unknown[] = [];
					for (const expansion of expansions) {
						const dstId = this.getSourceIdForPath(expansion.path);
						if (dstId) {
							const srcId = `note-${file.sourceId}`;
							const tgtId = `note-${dstId}`;
							expansionEdges.push({
								id: `edge-expansion-${file.sourceId}-${dstId}-${expansion.direction}`,
								source: expansion.direction === "outbound" ? srcId : tgtId,
								target: expansion.direction === "outbound" ? tgtId : srcId,
								edgeType: "wikilink",
								weight: 1.0,
								expansion: true,
							});
						}
					}
					this.graphPanel.addExpansion([], expansionEdges as GraphEdge[]);
					new Notice(`Expanded with ${addedFileCount} wikilinks`);
				}
			}
		});
	}

	private renderBlockInspector(block: BlockMatch): void {
		if (!this.inspectorEl) return;

		this.inspectorEl.createEl("h4", { text: block.blockLabel || 'Passage' });
		this.inspectorEl.createEl("div", { text: `Type: block` });
		this.inspectorEl.createEl("div", { text: `Path: ${block.path}` });
		this.inspectorEl.createEl("div", { text: `Block Key: ${block.blockKey}` });
		this.inspectorEl.createEl("div", {
			text: `Block score: ${block.score.toFixed(3)}`
		});
		this.inspectorEl.createEl("p", {
			text: block.text ?? "No preview text available.",
		});

		const actions = this.inspectorEl.createDiv({ cls: "vre-inspector-actions" });

		actions.createEl("button", { text: "Open File at Line" }).addEventListener("click", async () => {
			console.log('[VaultRagExplorerView] Inspector open block clicked', { path: block.path, lineStart: block.lineStart });
			const hit: RetrievalHit = { nodeType: "block", nodeId: block.blockId, sourceId: block.sourceId, path: block.path, title: block.title, blockKey: block.blockKey, lineStart: block.lineStart || undefined, lineEnd: block.lineEnd || undefined, previewText: block.text, semanticScore: block.score, wikilinkBoost: 0, finalScore: block.score, reasons: [] };
			await this.openHit(hit);
		});

		actions.createEl("button", { text: "Exclude Block" }).addEventListener("click", () => {
			console.log('[VaultRagExplorerView] Inspector exclude block clicked', { block });
			this.excludeBlock(block.blockId, block.sourceId, block.path);
		});
		actions.createEl("button", { text: "Exclude Parent File" }).addEventListener("click", () => {
			console.log('[VaultRagExplorerView] Inspector exclude parent file clicked', { block });
			this.excludeFile(block.sourceId, block.path);
		});

		const key = `block-${block.blockId}`;
		const isLocked = this.plugin.lockedNodesService.isLocked(key);

		actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock Block" }).addEventListener("click", (e) => {
			if (this.plugin.lockedNodesService.isLocked(key)) {
				this.plugin.lockedNodesService.unlock(key);
				(e.target as HTMLButtonElement).setText("Lock Block");
				new Notice(`Unlocked: ${block.blockLabel || 'Passage'}`);
			} else {
				this.plugin.lockedNodesService.lock({
					nodeType: "block",
					nodeId: block.blockId,
					path: block.path,
					title: block.blockLabel || 'Passage',
					blockKey: block.blockKey,
					lockedAt: Date.now(),
				});
				(e.target as HTMLButtonElement).setText("Locked ✓");
				new Notice(`Locked: ${block.blockLabel || 'Passage'}`);
			}
			const response = this.store.getState().queryResponse;
			if (response) {
				this.renderResults(response.hits);
			}
		});

		actions.createEl("button", { text: "Expand Semantic" }).addEventListener("click", async () => {
			console.log("[VaultRagExplorerView] Inspector semantic expand clicked", block);
			const state = this.store.getState();
			const modelName = state.queryOptions.embeddingModelName || "TaylorAI/bge-micro-v2";
			const currentGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;

			try {
				const response = await this.queryService.expandSemantic("block", block.blockId, modelName, state.queryOptions.topK, {
					...state.queryOptions,
					granularityOverride: currentGranularity,
					retrievalCountOverride: this.getEffectiveRetrievalCount(currentGranularity),
				});

				console.log("[VaultRagExplorerView] semantic expansion merge start", { currentGranularity, incomingHitCount: response.hits.length });

				const currentResponse = state.queryResponse;
				if (currentResponse && currentResponse.payload && response.payload) {
					const mergedHits = [...currentResponse.hits];
					for (const newHit of response.hits) {
						if (!mergedHits.some(h => h.nodeId === newHit.nodeId && h.nodeType === newHit.nodeType)) {
							mergedHits.push(newHit);
						}
					}

					const mergedPayload: QueryResultPayload = {
						granularity: currentGranularity,
						files: [...currentResponse.payload.files],
						blocks: [...currentResponse.payload.blocks]
					};

					if (currentGranularity === "file") {
						for (const newFile of response.payload.files) {
							const existingFileIndex = mergedPayload.files.findIndex(f => f.sourceId === newFile.sourceId);
							if (existingFileIndex >= 0) {
								const existingFile = mergedPayload.files[existingFileIndex];
								const mergedBlocks = [...existingFile.matchedBlocks];
								for (const newBlock of newFile.matchedBlocks) {
									if (!mergedBlocks.some(b => b.blockId === newBlock.blockId)) {
										mergedBlocks.push(newBlock);
									}
								}
								mergedBlocks.sort((a, b) => b.score - a.score);
								mergedPayload.files[existingFileIndex] = {
									...existingFile,
									score: Math.max(existingFile.score, newFile.score),
									bestBlockScore: Math.max(existingFile.bestBlockScore, newFile.bestBlockScore),
									matchedBlocks: mergedBlocks
								};
							} else {
								mergedPayload.files.push(newFile);
							}
						}
					} else {
						for (const newBlock of response.payload.blocks) {
							if (!mergedPayload.blocks.some(b => b.blockId === newBlock.blockId)) {
								mergedPayload.blocks.push(newBlock);
							}
						}
					}

					console.log("[VaultRagExplorerView] semantic expansion merge complete", { mergedFileCount: mergedPayload.files.length, mergedBlockCount: mergedPayload.blocks.length });

					const newResponse = { ...currentResponse, hits: mergedHits, payload: mergedPayload };
					this.store.setState({ queryResponse: newResponse });

					// Rebuild maps
					this.fileMatchMap.clear();
					this.blockMatchMap.clear();
					this.lastQueryResults = mergedPayload;

					if (mergedPayload.granularity === "file") {
						for (const f of mergedPayload.files) {
							this.fileMatchMap.set(`note-${f.sourceId}`, f);
							for (const b of f.matchedBlocks) {
								this.blockMatchMap.set(`block-${b.blockId}`, b);
							}
						}
					} else {
						for (const b of mergedPayload.blocks) {
							this.blockMatchMap.set(`block-${b.blockId}`, b);
						}
					}

					this.renderResults(newResponse.hits);

					if (mergedPayload.granularity === "file") {
						const visibleFiles = this.getVisibleFilesForGraph(mergedPayload.files);
						await this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
					} else {
						await this.renderBlockGraph(mergedPayload.blocks, this.plugin.lockedNodesService.getAll());
					}

					new Notice(`Expanded semantics with ${response.hits.length} hits`);
				}
			} catch (e) {
				console.error("[VaultRagExplorerView] Expand Semantic failed", e);
				new Notice("Expand Semantic failed");
			}
		});

		actions.createEl("button", { text: "Expand Wikilinks" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector wikilink expand clicked", block);
			const expander = this.plugin.wikilinkExpander;
			const expansions = expander.expandFrom(block.path);

			if (expansions.length === 0) {
				new Notice("No wikilink expansions found.");
				return;
			}

			const state = this.store.getState();
			const currentResponse = state.queryResponse;
			if (currentResponse && currentResponse.payload) {
				const currentGranularity = this.retrievalGranularityOverride ?? this.plugin.settings.retrievalGranularity;
				const mergedPayload: QueryResultPayload = {
					granularity: currentGranularity,
					files: [...currentResponse.payload.files],
					blocks: [...currentResponse.payload.blocks]
				};
				const mergedHits = [...currentResponse.hits];

				let addedFileCount = 0;
				const resolvedSourceIds: number[] = [];
				for (const expansion of expansions) {
					const dstId = this.getSourceIdForPath(expansion.path);
					if (dstId) {
						resolvedSourceIds.push(dstId);
						if (currentGranularity === "file") {
							if (!mergedPayload.files.some(f => f.sourceId === dstId)) {
								const newTitle = expansion.path.replace('.md', '').split('/').pop() ?? expansion.path;
								mergedPayload.files.push({
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									score: 0.05,
									bestBlockScore: 0,
									matchedBlocks: []
								});
								mergedHits.push({
									nodeType: "note",
									nodeId: dstId,
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									semanticScore: 0.05,
									wikilinkBoost: 0,
									finalScore: 0.05,
									reasons: ["Expanded via wikilink"]
								});
								addedFileCount++;
							}
						} else {
							// Block mode note-level additions
							if (!mergedHits.some(h => h.nodeType === "note" && h.nodeId === dstId)) {
								const newTitle = expansion.path.replace('.md', '').split('/').pop() ?? expansion.path;
								mergedHits.push({
									nodeType: "note",
									nodeId: dstId,
									sourceId: dstId,
									path: expansion.path,
									title: newTitle,
									semanticScore: 0.05,
									wikilinkBoost: 0,
									finalScore: 0.05,
									reasons: ["Expanded via wikilink"]
								});
								addedFileCount++;
							}
						}
					}
				}

				console.log("[VaultRagExplorerView] wikilink expansion resolved paths", { sourcePath: block.path, expansionCount: expansions.length, resolvedSourceIds });
				console.log("[VaultRagExplorerView] wikilink expansion merged into results", { addedFileCount, totalFileCount: mergedPayload.files.length });

				const newResponse = { ...currentResponse, hits: mergedHits, payload: mergedPayload };
				this.store.setState({ queryResponse: newResponse });

				this.fileMatchMap.clear();
				this.blockMatchMap.clear();
				this.lastQueryResults = mergedPayload;

				if (mergedPayload.granularity === "file") {
					for (const f of mergedPayload.files) {
						this.fileMatchMap.set(`note-${f.sourceId}`, f);
						for (const b of f.matchedBlocks) {
							this.blockMatchMap.set(`block-${b.blockId}`, b);
						}
					}
					// File rendering via payload
					this.renderResults(newResponse.hits);
					const visibleFiles = this.getVisibleFilesForGraph(mergedPayload.files);
					this.renderFileGraph(visibleFiles, this.plugin.lockedNodesService.getAll());
				} else {
					for (const b of mergedPayload.blocks) {
						this.blockMatchMap.set(`block-${b.blockId}`, b);
					}
					// Block rendering
					this.renderResults(newResponse.hits);
					this.renderBlockGraph(mergedPayload.blocks, this.plugin.lockedNodesService.getAll());
				}

				// The graph rendering creates nodes, we need to explicitly inject the graph edges
				if (this.graphPanel) {
					const expansionEdges: unknown[] = [];
					for (const expansion of expansions) {
						const dstId = this.getSourceIdForPath(expansion.path);
						if (dstId) {
							const srcId = `block-${block.blockId}`;
							const tgtId = `note-${dstId}`;
							expansionEdges.push({
								id: `edge-expansion-${block.blockId}-${dstId}-${expansion.direction}`,
								source: expansion.direction === "outbound" ? srcId : tgtId,
								target: expansion.direction === "outbound" ? tgtId : srcId,
								edgeType: "wikilink",
								weight: 1.0,
								expansion: true,
							});
						}
					}
					this.graphPanel.addExpansion([], expansionEdges as GraphEdge[]);
					new Notice(`Expanded with ${addedFileCount} wikilinks`);
				}
			}
		});
	}

	private renderLegacyInspector(hit: RetrievalHit): void {
		if (!this.inspectorEl) return;
		this.inspectorEl.createEl("h4", { text: hit.title + " (Legacy)" });
		this.inspectorEl.createEl("div", { text: `Type: ${hit.nodeType}` });
		this.inspectorEl.createEl("div", { text: `Path: ${hit.path}` });
		if (hit.blockKey) {
			this.inspectorEl.createEl("div", { text: `Block: ${hit.blockKey}` });
		}
		this.inspectorEl.createEl("div", {
			text: `Final score: ${hit.finalScore.toFixed(3)}`,
		});
		this.inspectorEl.createEl("p", {
			text: hit.previewText ?? "No preview text available.",
		});
		const actions = this.inspectorEl.createDiv({ cls: "vre-inspector-actions" });
		actions.createEl("button", { text: "Open File" }).addEventListener("click", async () => {
			await this.openHit(hit);
		});

		const key = `${hit.nodeType}-${hit.nodeId}`;
		const isLocked = this.plugin.lockedNodesService.isLocked(key);
		actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock Node" }).addEventListener("click", (e) => {
			if (this.plugin.lockedNodesService.isLocked(key)) {
				this.plugin.lockedNodesService.unlock(key);
				(e.target as HTMLButtonElement).setText("Lock Node");
			} else {
				this.plugin.lockedNodesService.lock({
					nodeType: hit.nodeType,
					nodeId: hit.nodeId,
					path: hit.path,
					title: hit.title,
					blockKey: hit.blockKey,
					lockedAt: Date.now(),
				});
				(e.target as HTMLButtonElement).setText("Locked ✓");
			}
		});

		actions.createEl("button", { text: "Expand Semantic" }).addEventListener("click", async () => {
			console.log("[VaultRagExplorerView] Inspector semantic expand clicked (legacy)", hit);
			new Notice("Expand Semantic not fully implemented in legacy inspector");
		});

		actions.createEl("button", { text: "Expand Wikilinks" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector wikilink expand clicked", hit);
			const expander = this.plugin.wikilinkExpander;
			const expansions = expander.expandFrom(hit.path);

			if (expansions.length === 0) {
				new Notice("No wikilink expansions found.");
				return;
			}

			const expansionNodes: unknown[] = [];
			const expansionEdges: unknown[] = [];
			for (const expansion of expansions) {
				const dstId = this.getSourceIdForPath(expansion.path);
				if (dstId) {
					expansionNodes.push({
						id: `note-${dstId}`,
						label: expansion.path.replace('.md', '').split('/').pop() ?? expansion.path,
						nodeType: "note",
						score: 0,
						sourceId: dstId,
						locked: false,
						excluded: false,
						radius: 6,
					});
					const srcId = `${hit.nodeType}-${hit.nodeId}`;
					const tgtId = `note-${dstId}`;
					expansionEdges.push({
						id: `edge-expansion-${hit.nodeId}-${dstId}-${expansion.direction}`,
						source: expansion.direction === "outbound" ? srcId : tgtId,
						target: expansion.direction === "outbound" ? tgtId : srcId,
						edgeType: "wikilink",
						weight: 1.0,
						expansion: true,
					});
				}
			}

		console.log(`[VaultRagExplorerView] wikilink expand: adding ${expansionNodes.length} nodes, ${expansionEdges.length} edges`);
			this.graphPanel?.addNodes(expansionNodes, expansionEdges);
			new Notice(`Expanded with ${expansions.length} wikilinks`);
		});
	}

	private getOutlinksForPath(path: string): string[] {
		const rawDb = this.plugin.db.getDb();
		const stmt = rawDb.prepare(`
			SELECT dst_path FROM wikilinks WHERE src_source_id = (SELECT id FROM sources WHERE path = $path)
		`);
		stmt.bind({ $path: path });
		const results: string[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as { dst_path: string };
			results.push(row.dst_path);
		}
		stmt.free();
		return results;
	}

	private getSourceIdForPath(path: string): number | null {
		const rawDb = this.plugin.db.getDb();
		const stmt = rawDb.prepare(`
			SELECT id FROM sources WHERE path = $path
		`);
		stmt.bind({ $path: path });
		let result: number | null = null;
		if (stmt.step()) {
			const row = stmt.getAsObject() as { id: number };
			result = row.id;
		}
		stmt.free();
		return result;
	}

	private async renderFileGraph(files: FileMatch[], lockedNodes: LockedNode[]): Promise<void> {
		if (!this.graphPanel) return;
		console.log("[VaultRagExplorerView] renderFileGraph", { fileCount: files.length });

		this.excludedSourceIds.clear();
		this.excludedPaths.clear();
		this.preFilter.excludedSourceIds = [];

		const lockedSet = new Set(lockedNodes.map(n => `note-${n.nodeId}`));
		const nodes = files.map(file => ({
			id: `note-${file.sourceId}`,
			label: file.title,
			nodeType: "note",
			score: file.score,
			sourceId: file.sourceId,
			locked: lockedSet.has(`note-${file.sourceId}`),
			excluded: false,
			radius: 6,
		})) as unknown as GraphNode[];

		const edges: GraphEdge[] = [];
		const resultPaths = new Set(files.map(f => f.path));
		for (const file of files) {
			const outlinks = this.getOutlinksForPath(file.path);
			for (const dst of outlinks) {
				if (resultPaths.has(dst)) {
					const dstId = this.getSourceIdForPath(dst);
					if (dstId) {
						edges.push({
							id: `edge-wl-${file.sourceId}-${dstId}`,
							source: `note-${file.sourceId}`,
							target: `note-${dstId}`,
							edgeType: "wikilink",
							weight: 1.0,
							expansion: false,
						} as unknown as GraphEdge);
					}
				}
			}
		}

		const mockHits = files.map(f => ({
			nodeType: "note" as const,
			nodeId: f.sourceId,
			sourceId: f.sourceId,
			path: f.path,
			title: f.title,
			semanticScore: f.score,
			wikilinkBoost: 0,
			finalScore: f.score,
			reasons: []
		})) as RetrievalHit[];
		try {
			const semEdges = await this.buildSemanticEdges(mockHits);
			this.graphPanel.setGraph(nodes, [...edges, ...semEdges]);
		} catch (e) {
			this.graphPanel.setGraph(nodes, edges);
		}
	}

	private async renderBlockGraph(blocks: BlockMatch[], lockedNodes: LockedNode[]): Promise<void> {
		if (!this.graphPanel) return;
		console.log("[VaultRagExplorerView] renderBlockGraph", { blockCount: blocks.length });

		this.excludedSourceIds.clear();
		this.excludedPaths.clear();
		this.preFilter.excludedSourceIds = [];

		const lockedSet = new Set(lockedNodes.map(n => `block-${n.nodeId}`));
		const nodes = blocks.map(block => ({
			id: `block-${block.blockId}`,
			label: block.title,
			nodeType: "block",
			score: block.score,
			sourceId: block.sourceId,
			locked: lockedSet.has(`block-${block.blockId}`),
			excluded: false,
			radius: 6,
		})) as unknown as GraphNode[];

		const edges: GraphEdge[] = [];
		const mockHits = blocks.map(b => ({
			nodeType: "block" as const,
			nodeId: b.blockId,
			sourceId: b.sourceId,
			path: b.path,
			title: b.title,
			semanticScore: b.score,
			wikilinkBoost: 0,
			finalScore: b.score,
			reasons: []
		})) as RetrievalHit[];
		try {
			const semEdges = await this.buildSemanticEdges(mockHits);
			this.graphPanel.setGraph(nodes, semEdges);
		} catch (e) {
			this.graphPanel.setGraph(nodes, []);
		}
	}

	private async renderGraph(hits: RetrievalHit[], lockedNodes: LockedNode[]): Promise<void> {
    if (!this.graphPanel) {
        console.warn("[VaultRagExplorerView] renderGraph — graphPanel is null, aborting");
        return;
    }
    const panel = this.graphPanel;
    console.log(`[VaultRagExplorerView] renderGraph called — hits=${hits.length}`);

    // Clear stale exclusions so new query starts fresh
    this.excludedSourceIds.clear();
    this.excludedPaths.clear();
    this.preFilter.excludedSourceIds = [];

    const lockedSet = new Set(lockedNodes.map(n => `${n.nodeType}-${n.nodeId}`));
    const nodes = hits.map(hit => ({
        id: `${hit.nodeType}-${hit.nodeId}`,
        label: hit.title,
        nodeType: hit.nodeType,
        score: hit.finalScore,
        sourceId: hit.sourceId,
        locked: lockedSet.has(`${hit.nodeType}-${hit.nodeId}`),
        excluded: false,
        radius: 6,
    })) as unknown as GraphNode[];

    const edges: GraphEdge[] = [];
    const resultPaths = new Set(hits.map(h => h.path));
    for (const hit of hits) {
        const outlinks = this.getOutlinksForPath(hit.path);
        for (const dst of outlinks) {
            if (resultPaths.has(dst)) {
                const dstId = this.getSourceIdForPath(dst);
                if (dstId) {
                    edges.push({
                        id: `edge-wl-${hit.nodeId}-${dstId}`,
                        source: `${hit.nodeType}-${hit.nodeId}`,
                        target: `note-${dstId}`,
                        edgeType: "wikilink",
                        weight: 1.0,
                        expansion: false,
                    } as unknown as GraphEdge);
                }
            }
        }
    }

    try {
        const semEdges = await this.buildSemanticEdges(hits);
        console.log(`[VaultRagExplorerView] renderGraph — wikiEdges=${edges.length} semEdges=${semEdges.length}`);
        panel.setGraph(nodes, [...edges, ...semEdges]);
        console.log(`[VaultRagExplorerView] renderGraph — setGraph called with ${nodes.length} nodes`);
    } catch (e) {
        console.error("[VaultRagExplorerView] renderGraph — buildSemanticEdges failed, rendering with wikilinks only", e);
        panel.setGraph(nodes, edges);
    }
}

	private async buildSemanticEdges(hits: RetrievalHit[]): Promise<GraphEdge[]> {
  const THRESHOLD = 0.75;
  const modelName = this.plugin.settings.embeddingModelName;
  const semEdges: GraphEdge[] = [];
  for (let i = 0; i < hits.length; i++) {
    const vecA = this.plugin.embeddingReader.loadForOwner(
      hits[i]?.nodeType === "note" ? "source" : "block",
      hits[i]?.nodeId as number,
      modelName
    );
    if (!vecA) continue;
    for (let j = i + 1; j < hits.length; j++) {
      const vecB = this.plugin.embeddingReader.loadForOwner(
        hits[j]?.nodeType === "note" ? "source" : "block",
        hits[j]?.nodeId as number,
        modelName
      );
      if (!vecB) continue;
      let dot = 0;
      for (let k = 0; k < vecA.vec.length; k++) dot += (vecA.vec[k] || 0) * (vecB.vec[k] || 0);
      if (dot >= THRESHOLD) {
        semEdges.push({
          id: `sem-${hits[i]?.nodeId}-${hits[j]?.nodeId}`,
          source: `${hits[i]?.nodeType}-${hits[i]?.nodeId}`,
          target: `${hits[j]?.nodeType}-${hits[j]?.nodeId}`,
          edgeType: "semantic",
          weight: dot,
          expansion: false,
        } as unknown as GraphEdge);
      }
    }
  }
  return semEdges;
}

	private async addCrossEdges(cy: unknown, hits: RetrievalHit[]): Promise<void> {
		const THRESHOLD = 0.75;
		const modelName = this.plugin.settings.embeddingModelName;

		for (let i = 0; i < hits.length; i++) {
			const vecA = this.plugin.embeddingReader.loadForOwner(hits[i]?.nodeType === 'note' ? 'source' : 'block', hits[i]?.nodeId as number, modelName);
			if (!vecA) continue;
			for (let j = i + 1; j < hits.length; j++) {
				const vecB = this.plugin.embeddingReader.loadForOwner(hits[j]?.nodeType === 'note' ? 'source' : 'block', hits[j]?.nodeId as number, modelName);
				if (!vecB) continue;
				let dot = 0;
				for (let k = 0; k < vecA.vec.length; k++) dot += (vecA.vec[k] || 0) * (vecB.vec[k] || 0);
				if (dot >= THRESHOLD) {
					const edgeId = `sem-${hits[i]?.nodeId}-${hits[j]?.nodeId}`;
					if (!cy.getElementById(edgeId).length) {
						cy.add({ data: { id: edgeId, source: `${hits[i]?.nodeType}-${hits[i]?.nodeId}`, target: `${hits[j]?.nodeType}-${hits[j]?.nodeId}`, edgeType: 'semantic', weight: dot } });
					}
				}
			}
		}

		console.log(`[VaultRagExplorerView] Cross-edge threshold=${THRESHOLD}, pairs checked=${hits.length * (hits.length-1) / 2}`);
	}

	private async openHit(hit: RetrievalHit): Promise<void> {

		console.log('[VaultRagExplorerView] openHit entered', { path: hit.path, nodeType: hit.nodeType, lineStart: hit.lineStart });

		console.log('[VaultRagExplorerView] openHit', { path: hit.path, blockKey: hit.blockKey, lineStart: hit.lineStart });

		const file = this.app.vault.getAbstractFileByPath(hit.path);
		if (!file) {
			new Notice(`File not found: ${hit.path}`);

		console.warn('[VaultRagExplorerView] openHit: file not found', hit.path);
			return;
		}

		// Search ALL workspace leaves across ALL windows for an existing open leaf
		let existingLeaf: import('obsidian').WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as { file?: { path: string } };
			if (view?.file?.path === hit.path) {
				existingLeaf = leaf;
			}
		});

		// Use existing leaf or open a new one in the most recently used window
		const leaf = existingLeaf ?? this.app.workspace.getLeaf('tab');

		if (!existingLeaf) {
			await leaf.openFile(file as import('obsidian').TFile);

		console.log('[VaultRagExplorerView] openHit: opened in new tab', hit.path);
		} else {
			// Bring the window containing the existing leaf to focus
			this.app.workspace.setActiveLeaf(leaf, { focus: true });

		console.log('[VaultRagExplorerView] openHit: revealed existing leaf', hit.path);
		}

		// Scroll to the block if we have a line number
		if (hit.nodeType === 'block' && hit.lineStart !== undefined && hit.lineStart > 0) {
			// Wait a tick for the file to fully render before scrolling
			window.setTimeout(() => {
				try {
					const view = leaf.view as {
						editor?: {
							setCursor: (pos: { line: number; ch: number }) => void;
							scrollIntoView: (range: { from: { line: number; ch: number }; to: { line: number; ch: number } }, center: boolean) => void;
						}
					};
					if (view.editor) {
						const line = Math.max(0, (hit.lineStart ?? 1) - 1); // Convert 1-based to 0-based
						view.editor.setCursor({ line, ch: 0 });
						view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: (hit.lineEnd ?? hit.lineStart ?? 1) - 1, ch: 0 } }, true);

		console.log('[VaultRagExplorerView] openHit: scrolled to line', line);
					} else {

		console.warn('[VaultRagExplorerView] openHit: editor not available on leaf view, cannot scroll');
					}
				} catch (e) {

		console.error('[VaultRagExplorerView] openHit: scroll failed', e);
				}
			}, 150);
		}
	}
}
