import type { Database } from "./Database";

const LOG_PREFIX = "[EmbeddingReader]";

export interface StoredEmbedding {
  ownerType: 'source' | 'block';
  ownerId: number;
  modelName: string;
  dim: number;
  norm: number;
  isNormalized: boolean;
  vec: Float32Array;
}

import type { Database as SqlJsDatabase } from "sql.js";
import { getScalar, getRows } from "./IndexBuilder";

export class EmbeddingReader {
  constructor(private db: Database) {}

  /**
   * Load all stored embeddings for a given modelName.
   * Returns an array of StoredEmbedding, one per row in the embeddings table.
   */
  loadAll(modelName: string): StoredEmbedding[] {
    const rawDb = this.db.getDb();
    console.log('[EmbeddingReader] loadEmbeddings start', { modelName });

    console.log('[EmbeddingReader] DB counts before model query', {
      totalEmbeddings: getScalar(rawDb, 'SELECT COUNT(*) FROM embeddings'),
      byModel: getRows(rawDb, `
        SELECT model_name as modelname, COUNT(*) AS count
        FROM embeddings
        GROUP BY model_name
        ORDER BY count DESC
      `),
    });

    console.log('[EmbeddingReader] querying embeddings', {
      requestedModel: modelName,
    });

    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE model_name = ?
    `);

    stmt.bind([modelName]);

    const results: StoredEmbedding[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        owner_type: 'source' | 'block';
        owner_id: number;
        model_name: string;
        dim: number;
        norm: number;
        is_normalized: number;
        embedding: Uint8Array;
      };

      const buf = Buffer.from(row.embedding);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

      if (vec.length !== row.dim) {
        console.warn(`${LOG_PREFIX} Skipping embedding id=${row.owner_id} — dim mismatch stored=${row.dim} actual=${vec.length}`);
        continue;
      }

      results.push({
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        modelName: row.model_name,
        dim: row.dim,
        norm: row.norm,
        isNormalized: Boolean(row.is_normalized),
        vec
      });
    }
    stmt.free();

    console.log('[EmbeddingReader] query results', {
      requestedModel: modelName,
      rowCount: results.length,
      sample: results[0]
        ? {
            ownerType: results[0].ownerType,
            ownerId: results[0].ownerId,
            modelName: results[0].modelName,
            dim: results[0].dim,
          }
        : null,
    });

    return results;
  }

  /**
   * Load embeddings for a specific owner (source or block).
   */
  loadForOwner(ownerType: 'source' | 'block', ownerId: number, modelName: string): StoredEmbedding | null {
    const rawDb = this.db.getDb();
    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE owner_type = ? AND owner_id = ? AND model_name = ?
    `);

    stmt.bind([ownerType, ownerId, modelName]);

    let resultRow: StoredEmbedding | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as {
        owner_type: 'source' | 'block';
        owner_id: number;
        model_name: string;
        dim: number;
        norm: number;
        is_normalized: number;
        embedding: Uint8Array;
      };

      const buf = Buffer.from(row.embedding);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

      if (vec.length === row.dim) {
        resultRow = {
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          modelName: row.model_name,
          dim: row.dim,
          norm: row.norm,
          isNormalized: Boolean(row.is_normalized),
          vec
        };
      } else {
        console.warn(`${LOG_PREFIX} Skipping embedding id=${row.owner_id} — dim mismatch stored=${row.dim} actual=${vec.length}`);
      }
    }
    stmt.free();

    return resultRow;
  }

  loadAllByDim(dim: number): StoredEmbedding[] {
    const rawDb = this.db.getDb();
    console.log('[EmbeddingReader] loadAllByDim', { dim });
    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE dim = ?
    `);
    stmt.bind([dim]);
    const results: StoredEmbedding[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      const buf = Buffer.from(row.embedding);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (vec.length !== row.dim) continue;
      results.push({
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        modelName: row.model_name,
        dim: row.dim,
        norm: row.norm,
        isNormalized: Boolean(row.is_normalized),
        vec,
      });
    }
    stmt.free();
    console.log('[EmbeddingReader] loadAllByDim results', { dim, count: results.length });
    return results;
  }
}
