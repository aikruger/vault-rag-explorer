export const VIEW_TYPE_VAULT_RAG_EXPLORER = "vault-rag-explorer-view";

export type NodeType = "query" | "note" | "block";
export type EdgeType = "semantic" | "wikilink" | "backlink" | "session";
export type RetrievalMode = "semantic" | "wikilink" | "hybrid" | "pathfinder";

export interface VaultRagExplorerSettings {
	indexDbPath: string;
	smartConnectionsExportPath: string;
	embeddingModelName: string;
	defaultTopK: number;
	defaultSemanticWeight: number;
	defaultWikilinkWeight: number;
	defaultIncludeBlocks: boolean;
	defaultCollapseBlocksBySource: boolean;
	enableDebugLogging: boolean;
}

export const DEFAULT_SETTINGS: VaultRagExplorerSettings = {
	indexDbPath: ".obsidian/plugins/vault-rag-explorer/data/smart_index.db",
	smartConnectionsExportPath: "",
	embeddingModelName: "TaylorAI/bge-micro-v2",
	defaultTopK: 20,
	defaultSemanticWeight: 1.0,
	defaultWikilinkWeight: 0.25,
	defaultIncludeBlocks: true,
	defaultCollapseBlocksBySource: false,
	enableDebugLogging: true,
};

export interface QueryOptions {
	topK: number;
	retrievalMode: RetrievalMode;
	semanticWeight: number;
	wikilinkWeight: number;
	includeBlocks: boolean;
	collapseBlocksBySource: boolean;
	wikilinkBoostEnabled: boolean;
}

export interface QueryRequest {
	queryText: string;
	options: QueryOptions;
}

export interface RetrievalHit {
	nodeType: "note" | "block";
	nodeId: number;
	sourceId: number;
	path: string;
	title: string;
	blockKey?: string;
	previewText?: string;
	semanticScore: number;
	wikilinkBoost: number;
	finalScore: number;
	reasons: string[];
}

export interface QueryResponse {
	queryText: string;
	queryEmbeddingModel: string;
	hits: RetrievalHit[];
	generatedAt: number;
}

export interface GraphNodeData {
	id: string;
	nodeType: NodeType;
	refId?: number;
	sourceId?: number;
	path?: string;
	title: string;
	previewText?: string;
	score?: number;
	isLocked: boolean;
	isPinned: boolean;
	isHidden: boolean;
	isExpandedSemantic: boolean;
	isExpandedWikilinks: boolean;
}

export interface GraphEdgeData {
	id: string;
	source: string;
	target: string;
	edgeType: EdgeType;
	weight: number;
	label?: string;
	explanation?: string;
}

export interface GraphLayoutPosition {
	nodeId: string;
	x: number;
	y: number;
}

export interface GraphWorkspaceState {
	nodes: GraphNodeData[];
	edges: GraphEdgeData[];
	positions: GraphLayoutPosition[];
}

export interface LockedNodeExplanation {
	nodeId: string;
	relevanceToQuery: string;
	relationshipToLockedSet: string;
}

export interface RagSession {
	id: string;
	name: string;
	queryText: string;
	queryEmbeddingModel: string;
	createdAt: number;
	updatedAt: number;
	options: QueryOptions;
	workspace: GraphWorkspaceState;
	explanations: LockedNodeExplanation[];
}

export interface RagContextItem {
	nodeId: string;
	nodeType: "note" | "block";
	path: string;
	title: string;
	blockKey?: string;
	previewText?: string;
	score?: number;
	relevanceToQuery?: string;
	relationshipToLockedSet?: string;
}

export interface RagContextBundle {
	sessionId: string;
	queryText: string;
	items: RagContextItem[];
	generatedAt: number;
}

export interface RagExplorerState {
	activeSessionId: string | null;
	currentQueryText: string;
	queryOptions: QueryOptions;
	queryResponse: QueryResponse | null;
	workspace: GraphWorkspaceState;
	selectedNodeId: string | null;
	loading: {
		query: boolean;
		expandSemantic: boolean;
		expandWikilinks: boolean;
		saveSession: boolean;
		loadSession: boolean;
	};
	error: string | null;
}

export interface PersistedViewState {
	activeSessionId: string | null;
	currentQueryText: string;
	queryOptions: QueryOptions;
	selectedNodeId: string | null;
}

export const DEFAULT_QUERY_OPTIONS: QueryOptions = {
	topK: DEFAULT_SETTINGS.defaultTopK,
	retrievalMode: "hybrid",
	semanticWeight: DEFAULT_SETTINGS.defaultSemanticWeight,
	wikilinkWeight: DEFAULT_SETTINGS.defaultWikilinkWeight,
	includeBlocks: DEFAULT_SETTINGS.defaultIncludeBlocks,
	collapseBlocksBySource: DEFAULT_SETTINGS.defaultCollapseBlocksBySource,
	wikilinkBoostEnabled: true,
};

export const EMPTY_WORKSPACE: GraphWorkspaceState = {
	nodes: [],
	edges: [],
	positions: [],
};

export const DEFAULT_RAG_EXPLORER_STATE: RagExplorerState = {
	activeSessionId: null,
	currentQueryText: "",
	queryOptions: DEFAULT_QUERY_OPTIONS,
	queryResponse: null,
	workspace: EMPTY_WORKSPACE,
	selectedNodeId: null,
	loading: {
		query: false,
		expandSemantic: false,
		expandWikilinks: false,
		saveSession: false,
		loadSession: false,
	},
	error: null,
};