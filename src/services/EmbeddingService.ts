import { pipeline } from "@xenova/transformers";
import { Notice } from "obsidian";

const LOG_PREFIX = "[EmbeddingService]";

export class EmbeddingService {
  private modelName: string;
  private pipelineInstance: unknown = null;

  constructor(modelName = "TaylorAI/bge-micro-v2") {
    this.modelName = modelName;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipelineInstance) {
      new Notice('Downloading embedding model on first use, please wait…');
      console.log(`${LOG_PREFIX} Loading pipeline for model ${this.modelName}`);
      try {
        this.pipelineInstance = await pipeline("feature-extraction", this.modelName);
      } catch (error) {
        console.error(`${LOG_PREFIX} embed failed: ${error}`);
        throw error;
      }
    }

    try {
      const pipelineCall = this.pipelineInstance as (text: string, options: any) => Promise<{ data: Float32Array }>;
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
