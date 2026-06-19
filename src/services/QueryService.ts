import type { QueryRequest, QueryResponse, RetrievalHit } from "../types";
import type { Database } from "../db/Database";
import type { EmbeddingService } from "./EmbeddingService";
import type { EmbeddingReader } from "../db/EmbeddingReader";

const LOG_PREFIX = "[QueryService]";

export class QueryService {
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService,
    private embeddingReader: EmbeddingReader
  ) {}

  // Optional dependency, to avoid circular dependencies or massive refactors late in the process.
  public lockedNodesService: unknown; // We can set this from the plugin if needed.

  async runQuery(request: QueryRequest): Promise<QueryResponse> {
    const startTime = Date.now();
    const topK = request.options.topK;
    const modelName = request.options.embeddingModelName || "TaylorAI/bge-micro-v2";
    const wikilinkBoostEnabled = request.options.wikilinkBoostEnabled;

    console.log(`${LOG_PREFIX} runQuery start text="${request.queryText}" topK=${topK} model=${modelName}`);

    // 1. Embed query
    const queryVec = await this.embeddingService.embed(request.queryText);
    console.log(`${LOG_PREFIX} query embedded, dim=${queryVec.length}`);

    const hits = this.scoreAndRank(queryVec, modelName, topK, wikilinkBoostEnabled);

    const elapsed = Date.now() - startTime;
    console.log(`${LOG_PREFIX} runQuery complete hits=${hits.length} durationMs=${elapsed}`);

    return {
      queryText: request.queryText,
      queryEmbeddingModel: modelName,
      hits,
      generatedAt: Date.now()
    };
  }

  async expandSemantic(
    ownerType: 'source' | 'block',
    ownerId: number,
    modelName: string,
    topK: number
  ): Promise<QueryResponse> {
    console.log(`[QueryService] expandSemantic ownerType=${ownerType} ownerId=${ownerId}`);
    const seedEmb = this.embeddingReader.loadForOwner(ownerType, ownerId, modelName);
    if (!seedEmb) {
      console.warn(`[QueryService] expandSemantic: no embedding found for owner`);
      return {
        queryText: `Semantic expansion of ${ownerType} ${ownerId}`,
        queryEmbeddingModel: modelName,
        hits: [],
        generatedAt: Date.now()
      };
    }

    // Use seedEmb.vec as query vector. Expansion defaults to boost enabled.
    const hits = this.scoreAndRank(seedEmb.vec, modelName, topK, true);

    return {
      queryText: `Semantic expansion of ${ownerType} ${ownerId}`,
      queryEmbeddingModel: modelName,
      hits,
      generatedAt: Date.now()
    };
  }

  private scoreAndRank(queryVec: Float32Array, modelName: string, topK: number, wikilinkBoostEnabled: boolean): RetrievalHit[] {
    // 2. Load stored embeddings
    const storedEmbeddings = this.embeddingReader.loadAll(modelName);

    if (storedEmbeddings.length === 0) {
      console.warn(`${LOG_PREFIX} No stored embeddings found for model ${modelName}`);
      return [];
    }

    // 3. Compute cosine similarity (dot product since vectors are normalized)
    const scoredEmbeddings = storedEmbeddings.map(stored => {
      let score = 0;
      for (let i = 0; i < queryVec.length; i++) {
        score += (queryVec[i] || 0) * ((stored.vec[i]) || 0);
      }
      return { ...stored, score };
    });

    console.log(`${LOG_PREFIX} Scored ${scoredEmbeddings.length} embeddings`);

    // 5. Look up details from DB
    const rawDb = this.db.getDb();
    const selectSource = rawDb.prepare(`SELECT path, title FROM sources WHERE id = ?`);
    const selectBlock = rawDb.prepare(`SELECT block_key, block_label, text, block_path FROM blocks WHERE id = ?`);

    // Milestone 6 wikilink boost calculation
    const lockedPaths = new Set<string>();
    const _lockedNodesService = this.lockedNodesService as any;
    if (_lockedNodesService && typeof _lockedNodesService.getAll === "function") {
      const lockedNodes = _lockedNodesService.getAll();
      for (const ln of lockedNodes) {
        lockedPaths.add(ln.path);
      }
    }

    // Prepare a set of paths that are destinations of wikilinks from locked nodes
    const boostedPaths = new Set<string>();
    if (wikilinkBoostEnabled && lockedPaths.size > 0) {
      const selectOutlinks = rawDb.prepare(`
        SELECT dst_path FROM wikilinks w
        JOIN sources s ON s.id = w.src_source_id
        WHERE s.path = ?
      `);
      for (const lp of lockedPaths) {
        const rows = selectOutlinks.all(lp) as { dst_path: string }[];
        for (const r of rows) {
          boostedPaths.add(r.dst_path);
        }
      }
    }

    // Add wikilink boost to score
    const finalScoredEmbeddings = scoredEmbeddings.map(emb => {
      let path = "";
      if (emb.ownerType === "source") {
         const row = selectSource.get(emb.ownerId) as { path: string } | undefined;
         if (row) path = row.path;
      } else {
         const row = selectBlock.get(emb.ownerId) as { block_path: string } | undefined;
         if (row) path = row.block_path;
      }

      const boost = boostedPaths.has(path) ? 0.05 : 0;
      return { ...emb, path, wikilinkBoost: boost, finalScore: emb.score + boost };
    });

    // 4. Sort and slice
    finalScoredEmbeddings.sort((a, b) => b.finalScore - a.finalScore);
    const topEmbeddings = finalScoredEmbeddings.slice(0, topK);

    const hits: RetrievalHit[] = [];

    for (const emb of topEmbeddings) {
      if (emb.ownerType === "source") {
        const row = selectSource.get(emb.ownerId) as { path: string; title: string } | undefined;
        if (row) {
          hits.push({
            nodeType: "note",
            nodeId: emb.ownerId,
            sourceId: emb.ownerId,
            path: row.path,
            title: row.title,
            previewText: "",
            semanticScore: emb.score,
            wikilinkBoost: emb.wikilinkBoost,
            finalScore: emb.finalScore,
            reasons: ["High semantic similarity", ...(emb.wikilinkBoost > 0 ? ["Linked to locked context"] : [])]
          });
        }
      } else if (emb.ownerType === "block") {
        const row = selectBlock.get(emb.ownerId) as { block_key: string; block_label: string; text: string; block_path: string } | undefined;
        if (row) {
          const srcRow = rawDb.prepare(`SELECT id FROM sources WHERE path = ?`).get(row.block_path) as { id: number } | undefined;

          hits.push({
            nodeType: "block",
            nodeId: emb.ownerId,
            sourceId: srcRow ? srcRow.id : -1,
            path: row.block_path,
            title: row.block_label,
            blockKey: row.block_key,
            previewText: row.text,
            semanticScore: emb.score,
            wikilinkBoost: emb.wikilinkBoost,
            finalScore: emb.finalScore,
            reasons: ["High semantic similarity at block level", ...(emb.wikilinkBoost > 0 ? ["Parent note linked to locked context"] : [])]
          });
        }
      }
    }

    return hits;
  }
}
