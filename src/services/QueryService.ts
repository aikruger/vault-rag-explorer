import type { QueryRequest, QueryResponse, RetrievalHit, BlockMatch, FileMatch, QueryResultPayload } from "../types";
import type { Database } from "../db/Database";
import type { SmartConnectionsBridge } from "./SmartConnectionsBridge";
import type { EmbeddingReader } from "../db/EmbeddingReader";
import type { PreFilterService, PreFilterOptions } from "./PreFilterService";
import type VaultRagExplorerPlugin from "../plugin";

const LOG_PREFIX = "[QueryService]";

export class QueryService {
  constructor(
    private plugin: VaultRagExplorerPlugin,
    private db: Database,
    private embeddingService: SmartConnectionsBridge,
    private embeddingReader: EmbeddingReader,
    private preFilterService?: PreFilterService
  ) {
    console.log("[QueryService] constructor received plugin", {
      pluginConstructor: this.plugin?.constructor?.name,
      pluginKeys: this.plugin ? Object.keys(this.plugin).slice(0, 20) : null,
      hasBeginQuery: typeof (this.plugin as { beginQuery?: unknown })?.beginQuery,
      hasEndQuery: typeof (this.plugin as { endQuery?: unknown })?.endQuery,
      debugInstanceId: (this.plugin as { debugInstanceId?: string })?.debugInstanceId,
    });
  }

  // Optional dependency, to avoid circular dependencies or massive refactors late in the process.
  public lockedNodesService: unknown; // We can set this from the plugin if needed.

  async runQuery(request: QueryRequest): Promise<QueryResponse> {
    if (!this.plugin || typeof this.plugin.beginQuery !== "function") {
      console.error("[QueryService] invalid plugin instance", {
        pluginConstructor: this.plugin?.constructor?.name,
        pluginKeys: this.plugin ? Object.keys(this.plugin).slice(0, 20) : null,
        hasBeginQuery: typeof (this.plugin as { beginQuery?: unknown })?.beginQuery,
        hasEndQuery: typeof (this.plugin as { endQuery?: unknown })?.endQuery,
      });
      throw new Error("QueryService misconfigured: plugin.beginQuery is unavailable");
    }

    this.plugin.beginQuery();
    try {
      const startTime = Date.now();
      const topK = request.options.topK;
      const modelName = request.options.embeddingModelName || "TaylorAI/bge-micro-v2";
      const wikilinkBoostEnabled = request.options.wikilinkBoostEnabled;

      console.log(`${LOG_PREFIX} runQuery start`, {
        isIndexing: this.plugin.isIndexing,
        activeQueryCount: this.plugin.activeQueryCount,
        queryTextLength: request.queryText?.length ?? 0,
      });

      if (this.plugin.isIndexing) {
        console.log(`${LOG_PREFIX} runQuery abort — indexing in progress`);
        throw new Error("Index update in progress. Retry the query in a moment.");
      }

      // 1. Embed query

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

    const granularity = request.options.granularityOverride ?? this.plugin.settings.retrievalGranularity;
    const retrievalCount = request.options.retrievalCountOverride ??
      this.plugin.settings.retrievalDocumentLimit;
    const blocksPerDocument = request.options.blocksPerDocumentOverride ??
      this.plugin.settings.retrievalBlocksPerDocument;

    console.log("[QueryService] runQuery options resolved", {
      granularity,
      retrievalCount,
      blocksPerDocument,
    });

    const internalBlockFetchLimit = granularity === "file"
      ? Math.max(retrievalCount * 6, retrievalCount * blocksPerDocument)
      : retrievalCount;

    console.log("[QueryService] internal fetch sizing", {
      granularity,
      retrievalCount,
      blocksPerDocument,
      internalBlockFetchLimit,
    });

    // Score and rank uses the internal block fetch limit if it's file mode
    // (though scoreAndRank currently blends blocks and sources).
    // For file-first aggregation, we fetch blocks.
    const hits = this.scoreAndRank(queryVec, modelName, internalBlockFetchLimit, wikilinkBoostEnabled, request.options);

    const payload = this.buildPayloadFromHits(hits, granularity, retrievalCount, blocksPerDocument);

      const elapsed = Date.now() - startTime;
      console.log(`${LOG_PREFIX} runQuery complete hits=${hits.length} durationMs=${elapsed}`);

      return {
        queryText: request.queryText,
        queryEmbeddingModel: modelName,
        hits,
        payload,
        generatedAt: Date.now()
      };
    } catch (error) {
      console.error(`${LOG_PREFIX} runQuery failed`, error);
      throw error;
    } finally {
      console.log(`${LOG_PREFIX} runQuery finally`, {
        isIndexing: this.plugin.isIndexing,
        activeQueryCount: this.plugin.activeQueryCount,
      });
      this.plugin.endQuery();
    }
  }

  async expandSemantic(
    ownerType: 'source' | 'block',
    ownerId: number,
    modelName: string,
    topK: number,
    options?: import("../types").QueryOptions
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
    const { DEFAULT_QUERY_OPTIONS } = require("../types");
    const queryOptions = options || { ...DEFAULT_QUERY_OPTIONS, scopeFilterEnabled: false };

    const granularity = queryOptions.granularityOverride ?? this.plugin.settings.retrievalGranularity;
    const retrievalCount = queryOptions.retrievalCountOverride ?? this.plugin.settings.retrievalDocumentLimit;
    const blocksPerDocument = queryOptions.blocksPerDocumentOverride ?? this.plugin.settings.retrievalBlocksPerDocument;

    const internalBlockFetchLimit = granularity === "file"
      ? Math.max(retrievalCount * 6, retrievalCount * blocksPerDocument)
      : retrievalCount;

    const hits = this.scoreAndRank(seedEmb.vec, modelName, Math.max(topK, internalBlockFetchLimit), true, queryOptions);
    const payload = this.buildPayloadFromHits(hits, granularity, retrievalCount, blocksPerDocument);

    return {
      queryText: `Semantic expansion of ${ownerType} ${ownerId}`,
      queryEmbeddingModel: modelName,
      hits,
      payload,
      generatedAt: Date.now()
    };
  }

  public buildPayloadFromHits(
    hits: RetrievalHit[],
    granularity: "file" | "block",
    retrievalCount: number,
    blocksPerDocument: number
  ): QueryResultPayload {
    console.log("[QueryService] buildPayloadFromHits", { granularity, hitCount: hits.length, retrievalCount, blocksPerDocument });
    const blockHits: BlockMatch[] = [];
    for (const hit of hits) {
      if (hit.nodeType === "block") {
        blockHits.push({
          blockId: hit.nodeId,
          blockKey: hit.blockKey || "",
          blockLabel: hit.title || null,
          text: hit.previewText || "",
          score: hit.finalScore,
          lineStart: hit.lineStart ?? null,
          lineEnd: hit.lineEnd ?? null,
          sourceId: hit.sourceId,
          path: hit.path,
          title: hit.title,
        });
      }
    }

    if (granularity === "file") {
      const files = this.aggregateBlockHitsToFiles(blockHits, retrievalCount, blocksPerDocument);
      return {
        granularity: "file",
        files,
        blocks: [],
      };
    } else {
      return {
        granularity: "block",
        files: [],
        blocks: blockHits.slice(0, retrievalCount),
      };
    }
  }

  private aggregateBlockHitsToFiles(
    blockHits: BlockMatch[],
    documentLimit: number,
    blocksPerDocument: number
  ): FileMatch[] {
    console.log("[QueryService] aggregateBlockHitsToFiles start", {
      blockHitCount: blockHits.length,
      documentLimit,
      blocksPerDocument,
    });

    const grouped = new Map<number, FileMatch>();

    for (const hit of blockHits) {
      let file = grouped.get(hit.sourceId);
      if (!file) {
        file = {
          sourceId: hit.sourceId,
          path: hit.path,
          title: hit.title, // we might need to improve source title here
          score: 0,
          bestBlockScore: hit.score,
          matchedBlocks: [],
        };
        grouped.set(hit.sourceId, file);
      }

      file.bestBlockScore = Math.max(file.bestBlockScore, hit.score);
      file.matchedBlocks.push(hit);
    }

    const files = Array.from(grouped.values()).map((file) => {
      file.matchedBlocks.sort((a, b) => b.score - a.score);
      file.matchedBlocks = file.matchedBlocks.slice(0, blocksPerDocument);

      const avgTopScore =
        file.matchedBlocks.reduce((sum, block) => sum + block.score, 0) /
        Math.max(file.matchedBlocks.length, 1);

      file.score = file.bestBlockScore * 0.7 + avgTopScore * 0.3;
      return file;
    });

    files.sort((a, b) => b.score - a.score);

    const sliced = files.slice(0, documentLimit);

    console.log("[QueryService] aggregateBlockHitsToFiles complete", {
      fileCount: sliced.length,
      topFiles: sliced.map((file) => ({
        path: file.path,
        score: file.score,
        bestBlockScore: file.bestBlockScore,
        matchedBlockCount: file.matchedBlocks.length,
      })),
    });

    return sliced;
  }

  private scoreAndRank(
    queryVec: Float32Array,
    modelName: string,
    topK: number,
    wikilinkBoostEnabled: boolean,
    options: import("../types").QueryOptions
  ): RetrievalHit[] {

  // --- Build allowed source path set from SQL pre-filter ---
  let rawDbFilter = this.db.getDb();
  let allowedSourceIds: Set<number> | null = null;

  if (options.scopeFilterEnabled) {
    console.log(`[QueryService] Building scope filter`, options);
	  let sql = `SELECT id, path, mtime, metadata_json FROM sources WHERE COALESCE(is_deleted, 0) = 0`;
    const params: Record<string, unknown> = {};

    if (options.includeFolders.length > 0) {
      const clauses = options.includeFolders.map((f, i) => {
        params[`$incFolder${i}`] = f;
        return `path LIKE $incFolder${i} || '%'`;
      });
      sql += ` AND (${clauses.join(' OR ')})`;
    }
    if (options.excludeFolders.length > 0) {
      options.excludeFolders.forEach((f, i) => {
        params[`$excFolder${i}`] = f;
        sql += ` AND path NOT LIKE $excFolder${i} || '%'`;
      });
    }
    if (options.filenameContains.length > 0) {
      const clauses = options.filenameContains.map((s, i) => {
        params[`$fnContains${i}`] = `%${s}%`;
        return `path LIKE $fnContains${i}`;
      });
      sql += ` AND (${clauses.join(' OR ')})`;
    }
    if (options.filenameExact.length > 0) {
      const clauses = options.filenameExact.map((s, i) => {
        params[`$fnExact${i}`] = s;
        return `(path = $fnExact${i} OR path LIKE '%/' || $fnExact${i} || '.md')`;
      });
      sql += ` AND (${clauses.join(' OR ')})`;
    }
    if (options.createdAfter !== null) {
      params[`$createdAfter`] = options.createdAfter;
      sql += ` AND mtime >= $createdAfter`;
    }
    if (options.createdBefore !== null) {
      params[`$createdBefore`] = options.createdBefore;
      sql += ` AND mtime <= $createdBefore`;
    }

    console.log(`[QueryService] Scope SQL: ${sql}`, params);
    const stmt = rawDbFilter.prepare(sql);
    stmt.bind(params as import("sql.js").BindParams);
    allowedSourceIds = new Set<number>();
    while (stmt.step()) {
		const row = stmt.getAsObject() as { id: number; path: string; metadata_json: string };

      // Tag filters (metadata is JSON string)
      if (options.includeTags.length > 0 || options.excludeTags.length > 0 || options.propertyFilters.length > 0) {
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(row.metadata_json || '{}'); } catch { meta = {}; }
        const tags: string[] = Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : [];

        if (options.includeTags.length > 0) {
          const hasAll = options.includeTags.every(t => tags.includes(t));
          if (!hasAll) { continue; }
        }
        if (options.excludeTags.length > 0) {
          const hasAny = options.excludeTags.some(t => tags.includes(t));
          if (hasAny) { continue; }
        }
        if (options.propertyFilters.length > 0) {
          const passAll = options.propertyFilters.every(pf => {
            const val = meta[pf.key];
            return val !== undefined && String(val) === pf.value;
          });
          if (!passAll) { continue; }
        }
      }

      allowedSourceIds.add(row.id);
    }
    stmt.free();
    console.log(`[QueryService] Scope filter allowed ${allowedSourceIds.size} sources`);
  }

  // --- Filter stored embeddings by allowed source IDs ---
  let storedEmbeddings = this.embeddingReader.loadAll(modelName);
  if (allowedSourceIds !== null) {
    storedEmbeddings = storedEmbeddings.filter(e => {
      if (e.ownerType === 'source') return allowedSourceIds.has(e.ownerId);
      // For blocks, we need the block's parent source id — skip if we can't determine
      return true; // block filtering by parent source handled below after path lookup
    });
  }

    console.log('[QueryService] loading stored embeddings', { modelName });
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

      try {
        console.log("[QueryService] Prepared selectOutlinks statement");
        for (const lp of lockedPaths) {
          if (lp == null || lp === "") {
            console.error("[QueryService] Invalid locked path before bind", { lp });
            continue;
          }
          console.log("[QueryService] selectOutlinks binding", { lp });
          selectOutlinks.bind({ $path: lp });
          while (selectOutlinks.step()) {
             const r = selectOutlinks.getAsObject() as { dst_path: string };
             boostedPaths.add(r.dst_path);
          }
          selectOutlinks.reset();
          console.log("[QueryService] selectOutlinks reset");
        }
      } catch (error) {
        console.error("[QueryService] selectOutlinks statement failed", error);
        throw error;
      } finally {
        selectOutlinks.free();
        console.log("[QueryService] selectOutlinks freed");
      }
    }

    const selectSource = rawDb.prepare(`SELECT path, title FROM sources WHERE id = $id`);
    const selectBlock = rawDb.prepare(`SELECT block_key, block_label, text, block_path, line_start, line_end FROM blocks WHERE id = $id`);
    const selectSourceIdByPath = rawDb.prepare(`SELECT id FROM sources WHERE path = $path`);

    let finalScoredEmbeddings: any[] = [];
    try {
      console.log("[QueryService] Prepared selectSource, selectBlock, selectSourceIdByPath statements");

      // Add wikilink boost to score
      for (const emb of scoredEmbeddings) {
        let path = "";
        if (emb.ownerType === "source") {
           if (!Number.isFinite(emb.ownerId)) {
             console.error("[QueryService] invalid ownerId before selectSource bind", { ownerId: emb.ownerId });
             continue;
           }
           selectSource.bind({ $id: emb.ownerId });
           if (selectSource.step()) {
             const row = selectSource.getAsObject() as { path: string };
             path = row.path;
           }
           selectSource.reset();
        } else {
           if (!Number.isFinite(emb.ownerId)) {
             console.error("[QueryService] invalid ownerId before selectBlock bind", { ownerId: emb.ownerId });
             continue;
           }
           selectBlock.bind({ $id: emb.ownerId });
           if (selectBlock.step()) {
             const row = selectBlock.getAsObject() as { block_path: string };
             path = row.block_path;
           }
           selectBlock.reset();

           if (allowedSourceIds && emb.ownerType === 'block') {
             if (path == null || path === "") {
               console.error("[QueryService] invalid path before selectSourceIdByPath bind", { path });
             } else {
               selectSourceIdByPath.bind({ $path: path });
               let parentId = -1;
               if (selectSourceIdByPath.step()) {
                 parentId = (selectSourceIdByPath.getAsObject() as { id: number }).id;
               }
               selectSourceIdByPath.reset();
               if (!allowedSourceIds.has(parentId)) {
                 finalScoredEmbeddings.push({ ...emb, path, wikilinkBoost: 0, finalScore: -1 }); // mark for removal
                 continue;
               }
             }
           }
        }

        const boost = boostedPaths.has(path) ? 0.05 : 0;
        finalScoredEmbeddings.push({ ...emb, path, wikilinkBoost: boost, finalScore: emb.score + boost });
      }

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
            const row = selectBlock.getAsObject() as { block_key: string; block_label: string; text: string; block_path: string; line_start: number; line_end: number };

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
              lineStart: row.line_start,
              lineEnd: row.line_end,
              previewText: row.text,
              semanticScore: emb.score,
              wikilinkBoost: emb.wikilinkBoost,
              finalScore: emb.finalScore,
              reasons: ["High semantic similarity at block level", ...(emb.wikilinkBoost > 0 ? ["Parent note linked to locked context"] : [])]
            });
            console.log('[QueryService] block hit with line range', { blockKey: row.block_key, lineStart: row.line_start, lineEnd: row.line_end });
          }
          selectBlock.reset();
        }
      }

      return hits;
    } catch (error) {
      console.error("[QueryService] error processing embeddings", error);
      throw error;
    } finally {
      selectSource.free();
      selectBlock.free();
      selectSourceIdByPath.free();
      console.log("[QueryService] selectSource, selectBlock, selectSourceIdByPath freed");
    }
  }
}
