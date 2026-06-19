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

export class EmbeddingReader {
  constructor(private db: Database) {}

  /**
   * Load all stored embeddings for a given modelName.
   * Returns an array of StoredEmbedding, one per row in the embeddings table.
   */
  loadAll(modelName: string): StoredEmbedding[] {
    const rawDb = this.db.getDb();
    const rows = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE model_name = ?
    `).all(modelName) as {
      owner_type: 'source' | 'block';
      owner_id: number;
      model_name: string;
      dim: number;
      norm: number;
      is_normalized: number;
      embedding: Buffer;
    }[];

    const results: StoredEmbedding[] = [];

    for (const row of rows) {
      const vec = new Float32Array(Buffer.from(row.embedding).buffer);
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

    console.log(`${LOG_PREFIX} Loaded ${results.length} embeddings for model=${modelName}`);
    return results;
  }

  /**
   * Load embeddings for a specific owner (source or block).
   */
  loadForOwner(ownerType: 'source' | 'block', ownerId: number, modelName: string): StoredEmbedding | null {
    const rawDb = this.db.getDb();
    const row = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE owner_type = ? AND owner_id = ? AND model_name = ?
    `).get(ownerType, ownerId, modelName) as {
      owner_type: 'source' | 'block';
      owner_id: number;
      model_name: string;
      dim: number;
      norm: number;
      is_normalized: number;
      embedding: Buffer;
    } | undefined;

    if (!row) {
      return null;
    }

    const vec = new Float32Array(Buffer.from(row.embedding).buffer);
    if (vec.length !== row.dim) {
      console.warn(`${LOG_PREFIX} Skipping embedding id=${row.owner_id} — dim mismatch stored=${row.dim} actual=${vec.length}`);
      return null;
    }

    return {
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      modelName: row.model_name,
      dim: row.dim,
      norm: row.norm,
      isNormalized: Boolean(row.is_normalized),
      vec
    };
  }
}
