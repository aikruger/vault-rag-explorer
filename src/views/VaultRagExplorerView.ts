
/* eslint-disable obsidianmd/rule-custom-message, obsidianmd/ui/sentence-case, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// @ts-nocheck
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type VaultRagExplorerPlugin from "../plugin";
import {
	type PersistedViewState,
	type QueryOptions,
	type RetrievalHit,
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
	private resultItemMap: Map<string, HTMLElement> = new Map();
	private excludedPaths: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, plugin: VaultRagExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new RagExplorerStore();
		this.queryService = new QueryService(plugin.db, plugin.embeddingService, plugin.embeddingReader);
		this.queryService.lockedNodesService = plugin.lockedNodesService;

		console.log("[VaultRagExplorerView] Constructor");
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

		const runBtn = controls.createEl("button", { text: "Run Query" });
		runBtn.addEventListener("click", async () => {
			runBtn.setAttr("disabled", "true");
			runBtn.empty();
			runBtn.createSpan({ cls: "loading-spinner" });
			runBtn.createSpan({ text: " Running…" });
			console.log("[VaultRagExplorerView] runQuery started — spinner shown");
			try {
				await this.runQuery();
			} finally {
				runBtn.removeAttribute("disabled");
				runBtn.empty();
				runBtn.setText("Run Query");
				console.log("[VaultRagExplorerView] runQuery finished — spinner removed");
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
			const fileName = `rag_context_export_${Date.now()}.md`;
			await this.app.vault.adapter.write(fileName, bundle);
			new Notice(`Exported ${bundle.length} chars to ${fileName}`);
		});
	}

	private renderResultsPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "vre-panel vre-results-panel" });
		panel.createEl("h3", { text: "Results" });

		this.resultsEl = panel.createDiv({ cls: "vre-results-list" });
		this.resultsEl.createEl("div", {
			text: "No query run yet.",
			cls: "vre-empty-state",
		});
	}

	private renderGraphPanel(container: HTMLElement): void {
  const panel = container.createDiv({ cls: "vre-panel vre-graph-panel" });
  panel.createEl("h3", { text: "Graph" });
  this.graphEl = panel.createDiv({ cls: "vre-graph-canvas" });
  if (this.graphPanel) {
    this.graphPanel.destroy();
    this.graphPanel = null;
  }
  this.graphPanel = new D3GraphPanel(this.graphEl);
  this.graphPanel.setOnNodeClick((nodeId) => {
    this.store.setState({ selectedNodeId: nodeId });
    const response = this.store.getState().queryResponse;
    if (response) {
      const hit = response.hits.find(h => `${h.nodeType}-${h.nodeId}` === nodeId);
      if (hit) this.renderMockInspector(hit);
    }
  });
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
				},
			});

			this.store.setState({ queryResponse: response });

			this.renderMockResults(response.hits);
			this.renderMockInspector(null);
			await this.renderGraph(response.hits, this.plugin.lockedNodesService.getAll());

			new Notice(`Query complete: ${response.hits.length} hits`);

		console.log("[VaultRagExplorerView] Query complete", { hitCount: response.hits.length });
		} catch (error) {

		console.error("[VaultRagExplorerView] Query failed", error);
			new Notice("Query failed. Check console for details.");
		}
	}

	private excludeNode(hit: RetrievalHit): void {
		this.excludedSourceIds.add(hit.sourceId);
		this.excludedPaths.add(hit.path);

		if (!this.preFilter.excludedSourceIds.includes(hit.sourceId)) {
			this.preFilter.excludedSourceIds.push(hit.sourceId);
		}

		// Remove ALL graph nodes that belong to this source (note + all its blocks)
		this.graphPanel?.excludeBySourceId(hit.sourceId);

		if ((this as unknown)._refreshExclusionList) (this as unknown)._refreshExclusionList();
	}

	private renderExclusionList(container: HTMLElement): void {
		const details = container.createEl('details', { cls: 'vre-exclusion-panel' });
		details.createEl('summary', { text: '🚫 Excluded files' });

		const listEl = details.createEl('ul', { cls: 'vre-exclusion-list' });

		const refresh = () => {
			listEl.empty();
			if (this.excludedPaths.size === 0) {
				listEl.createEl('li', { text: 'None', cls: 'vre-exclusion-empty' });
				return;
			}
			this.excludedPaths.forEach(path => {
				const li = listEl.createEl('li', { cls: 'vre-exclusion-item' });
				li.createEl('span', { text: path.replace('.md', ''), cls: 'vre-exclusion-path' });
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
				});
			});
		};

		(this as unknown)._refreshExclusionList = refresh;
		refresh();
	}

	private renderMockResults(hits: RetrievalHit[]): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();
		this.resultItemMap.clear();
		this.renderExclusionList(this.resultsEl);
		hits.forEach((hit) => {
			this.renderHitItem(this.resultsEl!, hit, null);
		});
		const selectedId = this.store.getState().selectedNodeId;
		if (selectedId) {
			this.highlightResultItem(selectedId);
			console.log(`[VaultRagExplorerView] renderMockResults: restored highlight for ${selectedId}`);
		}
	}

	private renderHitItem(container: HTMLElement, hit: RetrievalHit, selectedId: string | null = null): void {
		const item = container.createEl('div', { cls: 'vre-result-item' });

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
			this.excludeNode(hit);
			item.remove();
		});

		const actions = item.createDiv({ cls: "vre-result-actions" });

		const inspectBtn = actions.createEl("button", { text: "Inspect" });
			inspectBtn.addEventListener("click", () => {
				this.store.setState({ selectedNodeId: `${hit.nodeType}-${hit.nodeId}` });
				this.renderMockInspector(hit);
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
					this.renderMockInspector(hit);
				}
			});

			const openBtn = actions.createEl("button", { text: "Open" });
			openBtn.addEventListener("click", async () => {

		console.log('[VaultRagExplorerView] Open button clicked', { path: hit.path, lineStart: hit.lineStart });
				await this.openHit(hit);
			});
	}


	private highlightResultItem(nodeId: string): void {
		console.log(`[VaultRagExplorerView] highlightResultItem called nodeId=${nodeId}`);
		if (!this.resultsEl) return;
		this.resultsEl.querySelectorAll(".vre-result-item").forEach((el) => {
			(el as HTMLElement).removeClass("vre-result-highlighted");
		});
		const item = this.resultItemMap.get(nodeId);
		if (item) {
			item.addClass("vre-result-highlighted");
			item.scrollIntoView({ behavior: "smooth", block: "nearest" });
			console.log(`[VaultRagExplorerView] highlightResultItem — highlighted ${nodeId}`);
		} else {
			console.warn(`[VaultRagExplorerView] highlightResultItem — no DOM item found for nodeId=${nodeId}`);
		}
	}

	private renderMockInspector(hit: RetrievalHit | null): void {
		if (!this.inspectorEl) return;
		this.inspectorEl.empty();

		if (!hit) {
			this.inspectorEl.createEl("div", {
				text: "No node selected.",
				cls: "vre-empty-state",
			});
			return;
		}

		this.inspectorEl.createEl("h4", { text: hit.title });
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

		const reasons = this.inspectorEl.createEl("ul");
		for (const reason of hit.reasons) {
			reasons.createEl("li", { text: reason });
		}

		const actions = this.inspectorEl.createDiv({ cls: "vre-inspector-actions" });

		actions.createEl("button", { text: "Open File" }).addEventListener("click", async () => {

		console.log('[VaultRagExplorerView] Inspector open file clicked', { path: hit.path, lineStart: hit.lineStart });
			await this.openHit(hit);
		});

		const key = `${hit.nodeType}-${hit.nodeId}`;
		const isLocked = this.plugin.lockedNodesService.isLocked(key);

		actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock Node" }).addEventListener("click", (e) => {

		console.log("[VaultRagExplorerView] Inspector lock clicked", hit);

			if (this.plugin.lockedNodesService.isLocked(key)) {
				this.plugin.lockedNodesService.unlock(key);
				(e.target as HTMLButtonElement).setText("Lock Node");

		console.log("[View] Unlocked node", hit.path);
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
				(e.target as HTMLButtonElement).setText("Locked ✓");

		console.log("[View] Locked node", hit.path);
				new Notice(`Locked: ${hit.title}`);
			}
			// Re-render results to update lock states
			const response = this.store.getState().queryResponse;
			if (response) {
				this.renderMockResults(response.hits);
			}
		});

		actions.createEl("button", { text: "Expand Semantic" }).addEventListener("click", async () => {

		console.log("[VaultRagExplorerView] Inspector semantic expand clicked", hit);
			const ownerType = hit.nodeType === "note" ? "source" : "block";
			const state = this.store.getState();
			const modelName = state.queryOptions.embeddingModelName || "TaylorAI/bge-micro-v2";

			try {
				const response = await this.queryService.expandSemantic(ownerType, hit.nodeId, modelName, state.queryOptions.topK);

				// Merge new hits into the store
				const currentResponse = state.queryResponse;
				if (currentResponse) {
					// Extremely simplistic merge for demonstration. A proper merge would deduplicate by ID.
					const mergedHits = [...currentResponse.hits];
					for (const newHit of response.hits) {
						if (!mergedHits.some(h => h.nodeId === newHit.nodeId && h.nodeType === newHit.nodeType)) {
							mergedHits.push(newHit);
						}
					}

					const newResponse = { ...currentResponse, hits: mergedHits };
					this.store.setState({ queryResponse: newResponse });
					this.renderMockResults(newResponse.hits);
					await this.renderGraph(newResponse.hits, this.plugin.lockedNodesService.getAll());
					new Notice(`Expanded semantics with ${response.hits.length} hits`);
				}
			} catch (e) {

		console.error("[VaultRagExplorerView] Expand Semantic failed", e);
				new Notice("Expand Semantic failed");
			}
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
						expansionSource: false,
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
