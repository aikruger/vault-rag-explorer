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

export class VaultRagExplorerView extends ItemView {
	plugin: VaultRagExplorerPlugin;
	store: RagExplorerStore;
	queryService: QueryService;

	private queryInputEl: HTMLTextAreaElement | null = null;
	private resultsEl: HTMLDivElement | null = null;
	private graphEl: HTMLDivElement | null = null;
	private inspectorEl: HTMLDivElement | null = null;

	private unsubscribeStore: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultRagExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new RagExplorerStore();
		this.queryService = new QueryService(plugin.db);
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

		const controls = panel.createDiv({ cls: "vre-query-controls" });

		const runBtn = controls.createEl("button", { text: "Run Query" });
		runBtn.addEventListener("click", async () => {
			await this.runQuery();
		});

		const lockAllBtn = controls.createEl("button", { text: "Lock All Visible" });
		lockAllBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Lock all visible clicked");
			new Notice("Lock all visible: not implemented yet");
		});

		const saveBtn = controls.createEl("button", { text: "Save Session" });
		saveBtn.addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Save session clicked");
			new Notice("Save session: not implemented yet");
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

		try {
			const response = await this.queryService.runQuery({
				queryText: query,
				options: state.queryOptions,
			});

			this.store.setState({ queryResponse: response });

			this.renderMockResults(response.hits);
			this.renderMockInspector(null);
			this.renderMockGraph(response.hits);

			new Notice(`Query complete: ${response.hits.length} hits`);
			console.log("[VaultRagExplorerView] Query complete", { hitCount: response.hits.length });
		} catch (error) {
			console.error("[VaultRagExplorerView] Query failed", error);
			new Notice("Query failed. Check console for details.");
		}
	}

	private renderMockResults(hits: RetrievalHit[]): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();

		hits.forEach((hit) => {
			const card = this.resultsEl!.createDiv({ cls: "vre-result-card" });
			card.createEl("div", {
				text: `${hit.title} (${hit.nodeType})`,
				cls: "vre-result-title",
			});
			card.createEl("div", {
				text: hit.path,
				cls: "vre-result-path",
			});
			card.createEl("div", {
				text: hit.previewText ?? "",
				cls: "vre-result-preview",
			});
			card.createEl("div", {
				text: `Semantic: ${hit.semanticScore.toFixed(3)} | Wikilink: ${hit.wikilinkBoost.toFixed(3)} | Final: ${hit.finalScore.toFixed(3)}`,
				cls: "vre-result-score",
			});

			const actions = card.createDiv({ cls: "vre-result-actions" });

			const inspectBtn = actions.createEl("button", { text: "Inspect" });
			inspectBtn.addEventListener("click", () => {
				console.log("[VaultRagExplorerView] Inspect result", hit);
				this.store.setState({ selectedNodeId: `${hit.nodeType}-${hit.nodeId}` });
				this.renderMockInspector(hit);
			});

			const lockBtn = actions.createEl("button", { text: "Lock" });
			lockBtn.addEventListener("click", () => {
				console.log("[VaultRagExplorerView] Lock result", hit);
				new Notice(`Lock node: ${hit.title} (not implemented yet)`);
			});

			const openBtn = actions.createEl("button", { text: "Open" });
			openBtn.addEventListener("click", async () => {
				console.log("[VaultRagExplorerView] Open file requested", {
					path: hit.path,
				});
				const file = this.app.vault.getAbstractFileByPath(hit.path);
				if (file) {
					await this.app.workspace.getLeaf(true).openFile(file as never);
				} else {
					new Notice(`Could not find file: ${hit.path}`);
				}
			});
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

		actions.createEl("button", { text: "Lock Node" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector lock clicked", hit);
			new Notice("Lock node: not implemented yet");
		});

		actions.createEl("button", { text: "Expand Semantic" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector semantic expand clicked", hit);
			new Notice("Expand semantic: not implemented yet");
		});

		actions.createEl("button", { text: "Expand Wikilinks" }).addEventListener("click", () => {
			console.log("[VaultRagExplorerView] Inspector wikilink expand clicked", hit);
			new Notice("Expand wikilinks: not implemented yet");
		});
	}

	private renderMockGraph(hits: RetrievalHit[]): void {
		if (!this.graphEl) return;
		this.graphEl.empty();

		const summary = this.graphEl.createDiv({ cls: "vre-graph-summary" });
		summary.createEl("div", {
			text: `Graph placeholder: ${hits.length} nodes would be rendered here.`,
		});
		summary.createEl("div", {
			text: "Upcoming: Cytoscape graph with pin/hide/lock/expand actions.",
		});

		console.log("[VaultRagExplorerView] Graph placeholder rendered", {
			nodeCount: hits.length,
		});
	}
}