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
/// <reference types="cytoscape" />
import cytoscape from "cytoscape";
import type { LockedNode } from "../services/LockedNodesService";

export class VaultRagExplorerView extends ItemView {
	plugin: VaultRagExplorerPlugin;
	store: RagExplorerStore;
	queryService: QueryService;

	private queryInputEl: HTMLTextAreaElement | null = null;
	private resultsEl: HTMLDivElement | null = null;
	private graphEl: HTMLDivElement | null = null;
	private inspectorEl: HTMLDivElement | null = null;

	private unsubscribeStore: (() => void) | null = null;
	private cytoscapeInstance: cytoscape.Core | null = null;

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
			if (this.cytoscapeInstance) {
				this.cytoscapeInstance.nodes().forEach((node: cytoscape.NodeSingular) => {
					console.log("[VaultRagExplorerView] saveSession node position", node.id());
					graphPositions[node.id()] = { ...node.position() };
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
				if (this.cytoscapeInstance) {
					this.cytoscapeInstance.nodes().forEach((node: cytoscape.NodeSingular) => {
						const pos = session.graphPositions[node.id()];
						console.log("[VaultRagExplorerView] loadSession restoring node position", {
							id: node.id(),
							hasPosition: !!pos,
						});
						if (pos) {
							node.position(pos);
						}
					});
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
				options: state.queryOptions,
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

			const isLocked = this.plugin.lockedNodesService.isLocked(`${hit.nodeType}-${hit.nodeId}`);
			const lockBtn = actions.createEl("button", { text: isLocked ? "Locked ✓" : "Lock" });
			lockBtn.addEventListener("click", () => {
				const key = `${hit.nodeType}-${hit.nodeId}`;
				if (this.plugin.lockedNodesService.isLocked(key)) {
					this.plugin.lockedNodesService.unlock(key);
					lockBtn.setText("Lock");
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
					lockBtn.setText("Locked ✓");
					console.log("[View] Locked node", hit.path);
					new Notice(`Locked: ${hit.title}`);
				}
				// Re-render inspector if it's currently showing this node
				if (this.store.getState().selectedNodeId === key) {
					this.renderMockInspector(hit);
				}
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

			if (this.cytoscapeInstance) {
				const elementsToAdd: cytoscape.ElementDefinition[] = [];
				for (const expansion of expansions) {
					const dstId = this.getSourceIdForPath(expansion.path);
					if (dstId) {
						// Add node if not exists
						if (this.cytoscapeInstance.$id(`note-${dstId}`).length === 0) {
							elementsToAdd.push({
								data: {
									id: `note-${dstId}`,
									label: expansion.path,
									nodeType: "note",
									score: 0,
									locked: false
								}
							});
						}

						// Add edge
						const edgeId = `edge-expansion-${hit.nodeId}-${dstId}-${expansion.direction}`;
						if (this.cytoscapeInstance.$id(edgeId).length === 0) {
							const source = expansion.direction === "outbound" ? `${hit.nodeType}-${hit.nodeId}` : `note-${dstId}`;
							const target = expansion.direction === "outbound" ? `note-${dstId}` : `${hit.nodeType}-${hit.nodeId}`;

							elementsToAdd.push({
								data: {
									id: edgeId,
									source,
									target,
									edgeType: "wikilink"
								}
							});
						}
					}
				}
				this.cytoscapeInstance.add(elementsToAdd);
				this.cytoscapeInstance.layout({ name: 'cose', animate: true }).run();
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

		const elements: cytoscape.ElementDefinition[] = [];

		// Add hit nodes
		for (const hit of hits) {
			elements.push({
				data: {
					id: `${hit.nodeType}-${hit.nodeId}`,
					label: hit.title,
					nodeType: hit.nodeType,
					score: hit.finalScore,
					locked: lockedNodes.some(n => n.nodeId === hit.nodeId && n.nodeType === hit.nodeType),
				}
			});
		}

		// Add wikilink edges — query from DB: source's outlinks that appear in results
		const resultPaths = new Set(hits.map(h => h.path));
		for (const hit of hits) {
			const outlinks = this.getOutlinksForPath(hit.path);
			for (const dst of outlinks) {
				if (resultPaths.has(dst)) {
					const dstId = this.getSourceIdForPath(dst);
					if (dstId) {
						elements.push({
							data: {
								id: `edge-${hit.nodeId}-${dst}`,
								source: `${hit.nodeType}-${hit.nodeId}`,
								target: `note-${dstId}`,
								edgeType: 'wikilink',
							}
						});
					}
				}
			}
		}

		this.cytoscapeInstance = cytoscape({
			container: this.graphEl,
			elements,
			style: [
				{ selector: 'node', style: { label: 'data(label)', 'font-size': '10px', 'background-color': '#4a9eff' } },
				{ selector: 'node[locked=1]', style: { 'background-color': '#ff6b35', 'border-width': 2 } },
				{ selector: 'node[nodeType="block"]', style: { shape: 'rectangle' } },
				{ selector: 'edge', style: { 'line-color': '#888', 'width': 1, 'target-arrow-shape': 'triangle' } },
			],
			layout: { name: 'cose', animate: false },
		});

		this.cytoscapeInstance?.on('tap', 'node', (event: cytoscape.EventObject) => {
			console.log("[VaultRagExplorerView] tap event on node", event.target.id());
			const nodeData = event.target.data();
			console.log('[Graph] Node tapped', nodeData);
			this.store.setState({ selectedNodeId: nodeData.id });

			// Re-render inspector with selected node data
			const response = this.store.getState().queryResponse;
			if (response) {
				const hit = response.hits.find(h => `${h.nodeType}-${h.nodeId}` === nodeData.id);
				if (hit) {
					this.renderMockInspector(hit);
				}
			}
		});

		console.log("[VaultRagExplorerView] Cytoscape instance created", {
			nodeCount: this.cytoscapeInstance?.nodes().length ?? 0,
		});

		console.log('[VaultRagExplorerView] Cytoscape graph rendered', { nodeCount: hits.length });
	}
}