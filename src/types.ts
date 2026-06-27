export const VIEW_TYPE_VAULT_RAG_EXPLORER = "vault-rag-explorer-view";

export type NodeType = "query" | "note" | "block";
export type EdgeType = "semantic" | "wikilink" | "backlink" | "session";
export type RetrievalMode = "semantic" | "wikilink" | "hybrid" | "pathfinder";

export interface VaultRagExplorerSettings {
	smartFolderPath: string;
	indexDbPath: string;
	embeddingModelName: string;
	defaultTopK: number;
	defaultSemanticWeight: number;
	defaultWikilinkWeight: number;
	defaultIncludeBlocks: boolean;
	defaultCollapseBlocksBySource: boolean;
	enableDebugLogging: boolean;
	lastIndexBuild: number;
	autoIndexOnLoad: boolean;
}

export const DEFAULT_SETTINGS: VaultRagExplorerSettings = {
	smartFolderPath: "",
	indexDbPath: ".obsidian/plugins/vault-rag-explorer/data/smart_index.db",
	embeddingModelName: "TaylorAI/bge-micro-v2",
	defaultTopK: 20,
	defaultSemanticWeight: 1.0,
	defaultWikilinkWeight: 0.25,
	defaultIncludeBlocks: true,
	defaultCollapseBlocksBySource: false,
	enableDebugLogging: true,
	lastIndexBuild: 0,
	autoIndexOnLoad: false,
};

export interface QueryOptions {
	topK: number;
	retrievalMode: RetrievalMode;
	semanticWeight: number;
	wikilinkWeight: number;
	includeBlocks: boolean;
	collapseBlocksBySource: boolean;
	wikilinkBoostEnabled: boolean;
	embeddingModelName: string;
	preFilterOptions: import('./services/PreFilterService').PreFilterOptions | null;

	scopeFilterEnabled: boolean;
	includeFolders: string[];       // e.g. ["Research/", "Projects/Active"]
	excludeFolders: string[];
	includeTags: string[];          // matched against sources.metadata JSON
	excludeTags: string[];
	filenameContains: string[];     // substring match on path
	filenameExact: string[];        // exact filename match (no extension)
	filenameExcludes: string[];     // substring match exclusion on path/title
	filePathExcludes: string[];     // explicit full vault paths to exclude (e.g. "Research/MyNote.md")
	createdAfter: number | null;    // Unix ms
	createdBefore: number | null;
	propertyFilters: { key: string; value: string }[];  // metadata key=value pairs
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
	lineStart?: number;
	lineEnd?: number;
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
	graphPositions?: Record<string, { x: number; y: number }>;
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
	embeddingModelName: DEFAULT_SETTINGS.embeddingModelName,
	preFilterOptions: null,

	scopeFilterEnabled: true,
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
};// ---------------------------------------------------------------------------
// Milestone 5: Parser and IndexBuilder types
// ---------------------------------------------------------------------------

/**
 * One embedding vector extracted from an .ajson record.
 * The model name is the dynamic key under which the vector lives in the raw JSON.
 */
export interface ParsedEmbedding {
  modelName: string;       // e.g. "TaylorAI/bge-micro-v2"
  vec: number[];           // raw float array as parsed from JSON
  dim: number;             // vec.length — validated on parse
}

/**
 * A normalized note-level record produced by AjsonParser.
 * Corresponds to a row in the `sources` table.
 */
export interface ParsedSource {
  path: string;            // vault-relative path, e.g. "Research/Methods.md"
  title: string;           // derived: last segment of path without extension
  hash: string;            // last_read.hash from .ajson — used for incremental re-index
  embedHash: string;       // last_embed.hash from .ajson
  mtime: number;           // last_read.mtime (Unix ms) or 0 if absent
  outlinks: string[];      // array of destination paths from the outlinks field
  metadata: Record<string, unknown>;  // any remaining top-level fields stored as JSON
  rawJson: string;         // JSON.stringify of the original record for audit
  embeddings: ParsedEmbedding[];      // 0-n embeddings (one per model present)
}

/**
 * A normalized block-level record produced by AjsonParser.
 * Corresponds to a row in the `blocks` table.
 */
export interface ParsedBlock {
  blockKey: string;        // full key, e.g. "Research/Methods.md#{heading text}"
  blockPath: string;       // vault-relative path of the parent note
  blockLabel: string;      // human-readable label: the heading or first ~80 chars of text
  lineStart: number;       // line_start from .ajson
  lineEnd: number;         // line_end from .ajson
  text: string;            // block body text, or empty string if absent
  textLength: number;      // text.length
  hash: string;            // last_read.hash
  embedHash: string;       // last_embed.hash
  outlinks: string[];      // outlinks for wikilink graph
  metadata: Record<string, unknown>;
  rawJson: string;
  embeddings: ParsedEmbedding[];
}

/**
 * Summary returned by AjsonParser.parseFile() describing what was found.
 */
export interface ParseResult {
  sources: ParsedSource[];
  blocks: ParsedBlock[];
  skippedCount: number;    // records skipped due to missing required fields
  errors: string[];        // non-fatal parse error messages (one per skipped record)
}

/**
 * Summary returned by IndexBuilder.buildIndex() describing what was written.
 */
export interface IndexBuildResult {
  sourcesInserted: number;
  sourcesUpdated: number;
  sourcesSkipped: number;   // skipped because hash unchanged (incremental mode)
  blocksInserted: number;
  blocksUpdated: number;
  blocksSkipped: number;
  embeddingsWritten: number;
  wikilinksWritten: number;
  durationMs: number;
  errors: string[];
}
console.log('[types] DEFAULT_QUERY_OPTIONS initialised with exclude fields');
