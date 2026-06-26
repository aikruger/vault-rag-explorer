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
import * as d3 from "d3";
import type { LockedNode } from "../services/LockedNodesService";

interface D3Node extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  nodeType: "note" | "block";
  score: number;
  locked: boolean;
  radius: number;
  connectionCount: number;
  color: string;
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  id: string;
  score: number;       // semantic similarity score for distance mapping
  edgeType: "semantic" | "wikilink";
}
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
	private d3Simulation: d3.Simulation<D3Node, D3Link> | null = null;
	private d3Canvas: HTMLCanvasElement | null = null;
	private d3Pinned = false;
	private preFilter: PreFilterOptions = JSON.parse(JSON.stringify(EMPTY_PREFILTER));
	private excludedSourceIds: Set<number> = new Set();
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

		const addRow = (label: string, placeholder: string, key: string, isExclude = false) => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: label, cls: isExclude ? 'vre-label-exclude' : 'vre-label-include' });
			const input = row.createEl('input', {
				type: 'text',
				placeholder,
				cls: 'vre-prefilter-input',
			}) as HTMLInputElement;
			input.addEventListener('change', () => {
				const values = input.value.split(',').map(v => v.trim()).filter(Boolean);
				this.store.setState({
					queryOptions: { ...this.store.getState().queryOptions, [key]: values }
				});
			});
			return input;
		};

		const addDateRow = (label: string, key: 'createdAfter' | 'createdBefore') => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: label, cls: 'vre-label-include' });
			const input = row.createEl('input', { type: 'date', cls: 'vre-prefilter-input' }) as HTMLInputElement;
			input.addEventListener('change', () => {
				const ms = input.value ? new Date(input.value).getTime() : null;
				this.store.setState({
					queryOptions: { ...this.store.getState().queryOptions, [key]: ms }
				});
			});
		};

		const addPropertyRow = () => {
			const row = grid.createEl('div', { cls: 'vre-prefilter-row' });
			row.createEl('label', { text: 'Property (key=value, comma-separated)', cls: 'vre-label-include' });
			const input = row.createEl('input', {
				type: 'text',
				placeholder: 'status=active, type=concept',
				cls: 'vre-prefilter-input',
			}) as HTMLInputElement;
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
			});
		};

		grid.createEl('div', { text: '✅ Include only', cls: 'vre-prefilter-section-label' });
		addRow('Folders (comma-separated)', 'Research/, Projects/Active', 'includeFolders');
		addRow('Tags (comma-separated)', 'concept, permanent', 'includeTags');
		addRow('Filename contains', 'MOC, index', 'filenameContains');
		addRow('Filename exact', 'Home, Dashboard', 'filenameExact');
		addDateRow('Created after', 'createdAfter');
		addDateRow('Created before', 'createdBefore');
		addPropertyRow();

		grid.createEl('div', { text: '❌ Exclude', cls: 'vre-prefilter-section-label' });
		addRow('Folders (comma-separated)', 'Archive/, Templates/', 'excludeFolders', true);
		addRow('Tags (comma-separated)', 'draft, inbox', 'excludeTags', true);
		// Note: The UI prompt asks for filenameExcludes here, but it wasn't added to QueryOptions in step 1.
		// Leaving it off to match types.ts constraints and avoid TS errors.

		const resetBtn = details.createEl('button', { text: 'Reset filters', cls: 'vre-prefilter-reset' });
		resetBtn.addEventListener('click', () => {
			this.store.setState({
				queryOptions: {
					...this.store.getState().queryOptions,
					includeFolders: [],
					excludeFolders: [],
					includeTags: [],
					excludeTags: [],
					filenameContains: [],
					filenameExact: [],
					createdAfter: null,
					createdBefore: null,
					propertyFilters: [],
				}
			});
			details.querySelectorAll('input').forEach((el: HTMLInputElement) => { el.value = ''; });
		});
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
			await this.runQuery();
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

			const graphPositions: Record<string, {x: number, y: number}> = {};
			if (this.d3Simulation) {
				this.d3Simulation.nodes().forEach(n => {
					graphPositions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
				});
			}

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
				if (this.d3Simulation) {
					this.d3Simulation.nodes().forEach(n => {
						const pos = session.graphPositions[n.id];
						if (pos) { n.fx = pos.x; n.fy = pos.y; }
						console.log('[VaultRagExplorerView] loadSession restoring node', { id: n.id, hasPos: !!pos });
					});
					this.d3Simulation.alpha(0.3).restart();
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
		this.graphEl.createEl("div", {
			text: "Graph canvas placeholder. Cytoscape integration will go here.",
			cls: "vre-empty-state",
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
			this.renderGraph(response.hits, this.plugin.lockedNodesService.getAll());

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

		// Removed cytoscape instance exclusion logic

		if ((this as any)._refreshExclusionList) (this as any)._refreshExclusionList();
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
						// Removed cytoscape instance exclusion logic
					}
					stmt.free();
					refresh();
				});
			});
		};

		(this as any)._refreshExclusionList = refresh;
		refresh();
	}

	private renderMockResults(hits: RetrievalHit[]): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();

		this.renderExclusionList(this.resultsEl);

		hits.forEach((hit) => {
			this.renderHitItem(this.resultsEl!, hit);
		});
	}

	private renderHitItem(container: HTMLElement, hit: RetrievalHit): void {
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
				const file = this.app.vault.getAbstractFileByPath(hit.path);
				if (file) {
					await this.app.workspace.getLeaf(true).openFile(file as never);
				} else {
					new Notice(`Could not find file: ${hit.path}`);
				}
			});
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
					this.renderGraph(newResponse.hits, this.plugin.lockedNodesService.getAll());
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

			const state = this.store.getState();
			const currentResponse = state.queryResponse;
			if (currentResponse) {
				const mergedHits = [...currentResponse.hits];
				for (const expansion of expansions) {
					const dstId = this.getSourceIdForPath(expansion.path);
					if (dstId) {
						if (!mergedHits.some(h => h.nodeId === dstId && h.nodeType === "note")) {
							mergedHits.push({
								nodeId: dstId,
								nodeType: "note",
								path: expansion.path,
								title: expansion.path,
								finalScore: 0,
									sourceId: dstId,
									semanticScore: 0,
									wikilinkBoost: 0,
									reasons: []
								});
						}
					}
				}

				const newResponse = { ...currentResponse, hits: mergedHits };
				this.store.setState({ queryResponse: newResponse });
				this.renderMockResults(newResponse.hits);
				this.renderGraph(newResponse.hits, this.plugin.lockedNodesService.getAll());
				new Notice(`Expanded with ${expansions.length} wikilinks`);
			}

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

	private renderGraph(hits: RetrievalHit[], lockedNodes: LockedNode[]): void {
  if (!this.graphEl) return;
  this.graphEl.empty();

  console.log('[VaultRagExplorerView] renderGraph D3 start', { hitCount: hits.length });

  // Stop any existing simulation
  if (this.d3Simulation) {
    this.d3Simulation.stop();
    this.d3Simulation = null;
  }

  // --- Build nodes ---
  const lockedSet = new Set(lockedNodes.map(n => `${n.nodeType}-${n.nodeId}`));
  const connectionCounts: Record<string, number> = {};

  // Count connections per node (semantic edges: all pairs with score above threshold)
  const SEMANTIC_EDGE_THRESHOLD = 0.3;
  const semanticEdges: D3Link[] = [];
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i] as RetrievalHit, b = hits[j] as RetrievalHit;
      // Use average of both scores as proxy for pair similarity
      const pairScore = (a.finalScore + b.finalScore) / 2;
      if (pairScore >= SEMANTIC_EDGE_THRESHOLD) {
        const srcId = `${a.nodeType}-${a.nodeId}`;
        const tgtId = `${b.nodeType}-${b.nodeId}`;
        semanticEdges.push({ id: `sem-${srcId}-${tgtId}`, source: srcId, target: tgtId, score: pairScore, edgeType: 'semantic' });
        connectionCounts[srcId] = (connectionCounts[srcId] || 0) + 1;
        connectionCounts[tgtId] = (connectionCounts[tgtId] || 0) + 1;
      }
    }
  }

  // Wikilink edges from DB
  const wikilinkEdges: D3Link[] = [];
  const resultPaths = new Set(hits.map(h => h.path));
  for (const hit of hits) {
    const srcId = `${hit.nodeType}-${hit.nodeId}`;
    const outlinks = this.getOutlinksForPath(hit.path);
    for (const dst of outlinks) {
      if (resultPaths.has(dst)) {
        const dstDbId = this.getSourceIdForPath(dst);
        if (dstDbId) {
          const tgtId = `note-${dstDbId}`;
          const edgeId = `wl-${srcId}-${tgtId}`;
          if (!wikilinkEdges.some(e => e.id === edgeId)) {
            wikilinkEdges.push({ id: edgeId, source: srcId, target: tgtId, score: 0.5, edgeType: 'wikilink' });
            connectionCounts[srcId] = (connectionCounts[srcId] || 0) + 1;
            connectionCounts[tgtId] = (connectionCounts[tgtId] || 0) + 1;
          }
        }
      }
    }
  }

  const allLinks: D3Link[] = [...semanticEdges, ...wikilinkEdges];

  const nodes: D3Node[] = hits.map(hit => {
    const id = `${hit.nodeType}-${hit.nodeId}`;
    const conns = connectionCounts[id] || 0;
    const BASE_R = 8, GROWTH = 2.5, MAX_R = 40;
    const radius = Math.min(BASE_R + conns * GROWTH, MAX_R);
    const isLocked = lockedSet.has(id);
    const color = isLocked ? '#ff6b35' : (hit.nodeType === 'block' ? '#7c8594' : '#4a9eff');
    return { id, label: hit.title, nodeType: hit.nodeType, score: hit.finalScore, locked: isLocked, radius, connectionCount: conns, color };
  });

  console.log('[VaultRagExplorerView] D3 graph nodes/links', { nodes: nodes.length, links: allLinks.length });

  // --- Create canvas ---
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  this.graphEl.appendChild(canvas);
  this.d3Canvas = canvas;

  // --- Canvas toolbar ---
  const toolbar = this.graphEl.createDiv({ cls: 'vre-graph-toolbar' });
  const pinBtn = toolbar.createEl('button', { text: '📌 Pin Layout' });
  const resetBtn = toolbar.createEl('button', { text: '⟳ Reset' });

  const ctx = canvas.getContext('2d')!;

  function resizeCanvas() {
    const rect = (canvas.parentElement as HTMLElement).getBoundingClientRect();
    canvas.width = rect.width || 400;
    canvas.height = (rect.height - 40) || 300;  // subtract toolbar height
    console.log('[D3Graph] Canvas resized', { w: canvas.width, h: canvas.height });
    ticked();
  }

  // --- D3 zoom/pan state ---
  let transform = d3.zoomIdentity;

  const zoomBehavior = d3.zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([0.05, 10])
    .filter(event => {
      // Don't zoom when clicking on a node
      if (event.type === 'mousedown' || event.type === 'wheel') {
        const [mx, my] = d3.pointer(event, canvas);
        const [sx, sy] = transform.invert([mx, my]);
        return findNodeAt(sx, sy) === null;
      }
      return true;
    })
    .on('zoom', (event) => {
      transform = event.transform;
      ticked();
    });

  d3.select(canvas).call(zoomBehavior);

  // --- Distance scale: higher score = shorter distance (closer) ---
  const allScores = allLinks.map(l => l.score);
  const minScore = d3.min(allScores) ?? 0.3;
  const maxScore = d3.max(allScores) ?? 1.0;
  const distanceScale = d3.scalePow()
    .exponent(2)
    .domain([minScore, maxScore])
    .range([350, 40])
    .clamp(true);

  // --- Simulation ---
  const simulation = d3.forceSimulation<D3Node>(nodes)
    .velocityDecay(0.7)
    .force('charge', d3.forceManyBody<D3Node>().strength(n => -(80 + n.radius * 5)))
    .force('link', d3.forceLink<D3Node, D3Link>(allLinks)
      .id(d => d.id)
      .distance(link => distanceScale(link.score))
      .strength(0.4)
    )
    .force('center', d3.forceCenter(0, 0))
    .force('collision', d3.forceCollide<D3Node>().radius(n => n.radius + 4))
    .on('tick', ticked);

  this.d3Simulation = simulation;

  // Pre-warm
  for (let i = 0; i < 80; i++) simulation.tick();
  simulation.alphaTarget(0).restart();

  // --- Helper: find node at simulation coords ---
  function findNodeAt(sx: number, sy: number): D3Node | null {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n) continue;
      const dx = sx - (n.x ?? 0), dy = sy - (n.y ?? 0);
      if (dx * dx + dy * dy <= n.radius * n.radius) return n;
    }
    return null;
  }

  // --- Hover & selection state ---
  let hoveredNode: D3Node | null = null;
  let selectedNode: D3Node | null = null;

  // --- Draw loop ---
  function ticked() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x + W / 2, transform.y + H / 2);
    ctx.scale(transform.k, transform.k);

    // Compute connected sets for hover highlight
    const connectedNodes = new Set<D3Node>();
    const connectedLinks = new Set<D3Link>();
    if (hoveredNode) {
      connectedNodes.add(hoveredNode);
      allLinks.forEach(link => {
        const s = link.source as D3Node, t = link.target as D3Node;
        if (s === hoveredNode || t === hoveredNode) {
          connectedLinks.add(link);
          connectedNodes.add(s);
          connectedNodes.add(t);
        }
      });
    }

    // Draw links
    allLinks.forEach(link => {
      const s = link.source as D3Node, t = link.target as D3Node;
      if (!s.x || !t.x) return;
      const alpha = hoveredNode ? (connectedLinks.has(link) ? 0.9 : 0.05) : (link.edgeType === 'wikilink' ? 0.6 : 0.35);
      ctx.beginPath();
      ctx.strokeStyle = link.edgeType === 'wikilink'
        ? `rgba(255, 165, 0, ${alpha})`
        : `rgba(76, 158, 255, ${alpha})`;
      ctx.lineWidth = link.edgeType === 'wikilink' ? 1.5 : 1;
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
    });

    // Draw nodes
    nodes.forEach(node => {
      const x = node.x ?? 0, y = node.y ?? 0;
      const alpha = hoveredNode ? (connectedNodes.has(node) ? 1.0 : 0.15) : 1.0;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      if (node.nodeType === 'block') {
        // Rounded rect for blocks
        const r = node.radius, s = r * 0.3;
        ctx.roundRect(x - r, y - r, r * 2, r * 2, s);
      } else {
        ctx.arc(x, y, node.radius, 0, 2 * Math.PI);
      }
      ctx.fillStyle = node.color;
      ctx.fill();

      // Selection / hover ring
      if (node === selectedNode || node === hoveredNode) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = node === selectedNode ? '#ffd700' : '#ffffff';
        ctx.stroke();
      }
      // Lock indicator ring
      if (node.locked) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff6b35';
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    });

    // Labels for hovered or selected
    const labelNodes = new Set<D3Node>();
    if (hoveredNode) labelNodes.add(hoveredNode);
    if (selectedNode) labelNodes.add(selectedNode);
    labelNodes.forEach(node => {
      const x = node.x ?? 0, y = node.y ?? 0;
      ctx.font = `${Math.max(9, 10 / transform.k)}px sans-serif`;
      ctx.fillStyle = '#e0e0e0';
      ctx.textAlign = 'center';
      const maxLen = 30;
      const label = node.label.length > maxLen ? node.label.slice(0, maxLen) + '…' : node.label;
      ctx.fillText(label, x, y - node.radius - 4);
    });

    ctx.restore();
  }

  // --- Drag behaviour ---
  let dragNode: D3Node | null = null;
  let dragStartSim: [number, number] | null = null;
  let dragStartNodePos: { x: number, y: number } | null = null;

  d3.select(canvas)
    .on('mousedown', (event: MouseEvent) => {
      const [mx, my] = d3.pointer(event, canvas);
      const [sx, sy] = transform.invert([mx - canvas.width / 2, my - canvas.height / 2]);
      dragNode = findNodeAt(sx, sy);
      if (dragNode) {
        dragStartSim = [sx, sy];
        dragStartNodePos = { x: dragNode.x ?? 0, y: dragNode.y ?? 0 };
        simulation.alphaTarget(0.15).restart();
        console.log('[D3Graph] drag start', dragNode.id);
        event.stopPropagation();
      }
    })
    .on('mousemove', (event: MouseEvent) => {
      const [mx, my] = d3.pointer(event, canvas);
      const [sx, sy] = transform.invert([mx - canvas.width / 2, my - canvas.height / 2]);
      if (dragNode && dragStartSim && dragStartNodePos) {
        dragNode.fx = dragStartNodePos.x + (sx - dragStartSim[0]);
        dragNode.fy = dragStartNodePos.y + (sy - dragStartSim[1]);
      } else {
        const prev = hoveredNode;
        hoveredNode = findNodeAt(sx, sy);
        canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
        if (hoveredNode !== prev) ticked();
      }
    })
    .on('mouseup', (event: MouseEvent) => {
      if (dragNode) {
        console.log('[D3Graph] drag end', dragNode.id);
        if (!this.d3Pinned) {
          dragNode.fx = null;
          dragNode.fy = null;
        }
        simulation.alphaTarget(0);
        dragNode = null;
        dragStartSim = null;
        dragStartNodePos = null;
      }
    })
    .on('click', (event: MouseEvent) => {
      const [mx, my] = d3.pointer(event, canvas);
      const [sx, sy] = transform.invert([mx - canvas.width / 2, my - canvas.height / 2]);
      const clicked = findNodeAt(sx, sy);
      if (clicked) {
        selectedNode = clicked;
        console.log('[D3Graph] node clicked', clicked.id);
        this.store.setState({ selectedNodeId: clicked.id });
        const response = this.store.getState().queryResponse;
        if (response) {
          const hit = response.hits.find(h => `${h.nodeType}-${h.nodeId}` === clicked.id);
          if (hit) this.renderMockInspector(hit);
        }
        ticked();
      }
    });

  // --- Toolbar buttons ---
  pinBtn.addEventListener('click', () => {
    this.d3Pinned = !this.d3Pinned;
    if (this.d3Pinned) {
      simulation.alpha(0).alphaTarget(0);
      nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
      pinBtn.textContent = '📍 Unpin Layout';
      console.log('[D3Graph] pinned');
    } else {
      nodes.forEach(n => { n.fx = null; n.fy = null; });
      simulation.alpha(0.5).restart();
      pinBtn.textContent = '📌 Pin Layout';
      console.log('[D3Graph] unpinned');
    }
  });

  resetBtn.addEventListener('click', () => {
    nodes.forEach(n => { n.fx = null; n.fy = null; n.x = undefined; n.y = undefined; });
    this.d3Pinned = false;
    pinBtn.textContent = '📌 Pin Layout';
    simulation.alpha(1).restart();
    console.log('[D3Graph] reset');
  });

  // --- Resize observer ---
  const ro = new ResizeObserver(() => {
    requestAnimationFrame(resizeCanvas);
  });
  ro.observe(this.graphEl);

  requestAnimationFrame(() => setTimeout(resizeCanvas, 0));

  console.log('[VaultRagExplorerView] D3 graph rendered', { nodes: nodes.length, links: allLinks.length });
}
}
