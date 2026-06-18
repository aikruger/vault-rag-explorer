import type { QueryRequest, QueryResponse, RetrievalHit } from "../types";
import type { Database } from "../db/Database";

export class QueryService {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async runQuery(request: QueryRequest): Promise<QueryResponse> {
		console.log("[QueryService] runQuery stub called", request);

		// Milestone 4: Return mocked query results in the expected format
		// (In a real implementation, this would involve embedding the text and querying the vector index in DB)
		const mockHits: RetrievalHit[] = [
			{
				nodeType: "note",
				nodeId: 1,
				sourceId: 1,
				path: "Mock/Source/Note1.md",
				title: "Mock Note 1",
				previewText: "This is a mocked semantic hit for the query: " + request.queryText,
				semanticScore: 0.95,
				wikilinkBoost: request.options.wikilinkBoostEnabled ? 0.05 : 0.0,
				finalScore: 0.95 + (request.options.wikilinkBoostEnabled ? 0.05 : 0.0),
				reasons: ["Strong semantic match"],
			},
			{
				nodeType: "block",
				nodeId: 2,
				sourceId: 2,
				path: "Mock/Source/Note2.md",
				title: "Mock Block in Note 2",
				blockKey: "Mock/Source/Note2.md#MockBlock",
				previewText: "Another mock hit focusing on a specific block.",
				semanticScore: 0.88,
				wikilinkBoost: 0.0,
				finalScore: 0.88,
				reasons: ["Semantic match at block level"],
			},
		];

		const response: QueryResponse = {
			queryText: request.queryText,
			queryEmbeddingModel: "mock-model",
			hits: mockHits.slice(0, request.options.topK),
			generatedAt: Date.now(),
		};

		return response;
	}
}
