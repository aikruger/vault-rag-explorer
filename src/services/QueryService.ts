import type { QueryRequest, QueryResponse, RetrievalHit } from "../types";
import type { Database } from "../db/Database";
import type { SmartConnectionsBridge } from "./SmartConnectionsBridge";
import type { EmbeddingReader } from "../db/EmbeddingReader";
import type { PreFilterService, PreFilterOptions } from "./PreFilterService";

const LOG_PREFIX = "[QueryService]";

export class QueryService {
  constructor(
    private db: Database,
    private embeddingService: SmartConnectionsBridge,
    private embeddingReader: EmbeddingReader,
    private preFilterService?: PreFilterService
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

    const scModel = this.embeddingService.getModelName();
    console.log('[QueryService] query context', {
      requestedTopK: topK,
      embeddedDim: queryVec.length,
      scModelName: scModel,
    });

    const searchPart = modelName.split('/')[1];
    if (scModel !== 'unknown' && searchPart && !scModel.includes(searchPart)) {
        console.warn(`[QueryService] Model mismatch warning: SC is using ${scModel} but stored embeddings indexed with ${modelName}`);
    }

    const preFilterOptions = request.options.preFilterOptions ?? null;
    const hits = this.scoreAndRank(queryVec, modelName, topK, wikilinkBoostEnabled, preFilterOptions);

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
    const hits = this.scoreAndRank(seedEmb.vec, modelName, topK, true, null);

    return {
      queryText: `Semantic expansion of ${ownerType} ${ownerId}`,
      queryEmbeddingModel: modelName,
      hits,
      generatedAt: Date.now()
    };
  }

  private scoreAndRank(queryVec: Float32Array, modelName: string, topK: number, wikilinkBoostEnabled: boolean, preFilterOptions: PreFilterOptions | null): RetrievalHit[] {
    let allowedSourceIds: Set<number> | null = null;
    if (this.preFilterService && preFilterOptions) {
      allowedSourceIds = this.preFilterService.getAllowedSourceIds(preFilterOptions);
      console.log(`[QueryService] Pre-filter active — allowed sources: ${allowedSourceIds?.size ?? 'all'}`);
    }
    // 2. Load stored embeddings
    console.log('[QueryService] loading stored embeddings', { modelName });
    let storedEmbeddings = this.embeddingReader.loadAll(modelName);

    console.log('[QueryService] stored embeddings loaded', {
      modelName,
      count: storedEmbeddings.length,
    });

    if (storedEmbeddings.length === 0) {
      console.warn('[QueryService] No embeddings found by model name — falling back to dim match');
      storedEmbeddings = this.embeddingReader.loadAllByDim(queryVec.length);
      console.log('[QueryService] fallback dim match results', { dim: queryVec.length, count: storedEmbeddings.length });
    }

    if (storedEmbeddings.length === 0) {
      console.warn(`${LOG_PREFIX} No stored embeddings found for model ${modelName} or dim ${queryVec.length}`);
      return [];
    }

    console.log(`[QueryService] After pre-filter: ${storedEmbeddings.length} embeddings to score`);

    // 3. Compute cosine similarity (dot product since vectors are normalized)
    const scoredEmbeddings = storedEmbeddings
      .filter(stored => {
        if (!allowedSourceIds) return true;
        if (stored.ownerType === 'source') return allowedSourceIds.has(stored.ownerId);
        return true;
      })
      .map(stored => {
      let score = 0;
      for (let i = 0; i < queryVec.length; i++) {
        score += (queryVec[i] || 0) * ((stored.vec[i]) || 0);
      }
      return { ...stored, score };
    });

    console.log(`${LOG_PREFIX} Scored ${scoredEmbeddings.length} embeddings`);

    // 5. Look up details from DB
    const rawDb = this.db.getDb();
    const selectSource = rawDb.prepare(`SELECT path, title FROM sources WHERE id = $id`);
    const selectBlock = rawDb.prepare(`SELECT block_key, block_label, text, block_path FROM blocks WHERE id = $id`);
    const selectSourceIdByPath = rawDb.prepare(`SELECT id FROM sources WHERE path = $path`);

    // Milestone 6 wikilink boost calculation
    const lockedPaths = new Set<string>();
    const lnService = this.lockedNodesService as { getAll: () => { path: string }[] };
    if (lnService && typeof lnService.getAll === "function") {
      const lockedNodes = lnService.getAll();
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
        WHERE s.path = $path
      `);
      for (const lp of lockedPaths) {
        selectOutlinks.bind({ $path: lp });
        while (selectOutlinks.step()) {
           const r = selectOutlinks.getAsObject() as { dst_path: string };
           boostedPaths.add(r.dst_path);
        }
        selectOutlinks.reset();
      }
      selectOutlinks.free();
    }

    // Add wikilink boost to score
    const finalScoredEmbeddings = scoredEmbeddings.map(emb => {
      let path = "";
      if (emb.ownerType === "source") {
         selectSource.bind({ $id: emb.ownerId });
         if (selectSource.step()) {
           const row = selectSource.getAsObject() as { path: string };
           path = row.path;
         }
         selectSource.reset();
      } else {
         selectBlock.bind({ $id: emb.ownerId });
         if (selectBlock.step()) {
           const row = selectBlock.getAsObject() as { block_path: string };
           path = row.block_path;
         }
         selectBlock.reset();

         if (allowedSourceIds && emb.ownerType === 'block') {
           selectSourceIdByPath.bind({ $path: path });
           let parentId = -1;
           if (selectSourceIdByPath.step()) {
             parentId = (selectSourceIdByPath.getAsObject() as { id: number }).id;
           }
           selectSourceIdByPath.reset();
           if (!allowedSourceIds.has(parentId)) {
             return { ...emb, path, wikilinkBoost: 0, finalScore: -1 }; // mark for removal
           }
         }
      }

      const boost = boostedPaths.has(path) ? 0.05 : 0;
      return { ...emb, path, wikilinkBoost: boost, finalScore: emb.score + boost };
    });

    // 4. Sort and slice
    finalScoredEmbeddings.sort((a, b) => b.finalScore - a.finalScore);
    const topEmbeddings = finalScoredEmbeddings.filter(e => e.finalScore >= 0).slice(0, topK);

    const hits: RetrievalHit[] = [];



    for (const emb of topEmbeddings) {
      if (emb.ownerType === "source") {
        selectSource.bind({ $id: emb.ownerId });
        if (selectSource.step()) {
          const row = selectSource.getAsObject() as { path: string; title: string };
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
        selectSource.reset();
      } else if (emb.ownerType === "block") {
        selectBlock.bind({ $id: emb.ownerId });
        if (selectBlock.step()) {
          const row = selectBlock.getAsObject() as { block_key: string; block_label: string; text: string; block_path: string };

          selectSourceIdByPath.bind({ $path: row.block_path });
          let srcRow: { id: number } | undefined;
          if (selectSourceIdByPath.step()) {
            srcRow = selectSourceIdByPath.getAsObject() as { id: number };
          }
          selectSourceIdByPath.reset();

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
        selectBlock.reset();
      }
    }

    selectSource.free();
    selectBlock.free();
    selectSourceIdByPath.free();

    return hits;
  }
}
