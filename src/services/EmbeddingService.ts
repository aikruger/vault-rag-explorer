import { pipeline } from "@xenova/transformers";
import { Notice } from "obsidian";

const LOG_PREFIX = "[EmbeddingService]";

export class EmbeddingService {
  private modelName: string;
  private pipelineInstance: unknown = null;

  constructor(modelName = "TaylorAI/bge-micro-v2") {
    console.log("[EmbeddingService] Module loaded — checking import.meta.url shim");
    const globalAny = globalThis as { importMetaUrl?: unknown };
    console.log("[EmbeddingService] typeof importMetaUrl:", typeof globalAny.importMetaUrl);
    this.modelName = modelName;
    console.log(`[EmbeddingService] constructor called, model=${this.modelName}`);
  }

  async embed(text: string): Promise<Float32Array> {
    console.log(`${LOG_PREFIX} embed() called, text length=${text.length}`);

    if (!this.pipelineInstance) {
      console.log(`${LOG_PREFIX} Pipeline not yet loaded, initialising...`);
      new Notice('Loading embedding model for first use, please wait…');
      try {
        this.pipelineInstance = await pipeline("feature-extraction", this.modelName);
        console.log(`${LOG_PREFIX} Pipeline ready for model ${this.modelName}`);
      } catch (error) {
        console.error(`${LOG_PREFIX} Pipeline load failed — @xenova/transformers may not be compatible in this Obsidian version:`, error);
        new Notice(`Embedding model failed to load: ${String(error)}. Check console for details.`);
        throw error;
      }
    }

    try {
      const pipelineCall = this.pipelineInstance as (text: string, options: unknown) => Promise<{ data: Float32Array }>;
      const output = await pipelineCall(text, { pooling: "mean", normalize: true });
      const vec = output.data;

      // Calculate norm for logging purposes
      let sumSq = 0;
      for (let i = 0; i < vec.length; i++) {
        sumSq += (vec[i] || 0) * (vec[i] || 0);
      }
      const norm = Math.sqrt(sumSq);

      console.log(`${LOG_PREFIX} embed complete dim=${vec.length} norm=${norm.toFixed(6)}`);
      return vec;
    } catch (error) {
      console.error(`${LOG_PREFIX} embed failed: ${error}`);
      throw error;
    }
  }
}
