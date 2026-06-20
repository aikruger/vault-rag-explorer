import { Notice } from "obsidian";
import { pipeline, env } from '@huggingface/transformers';

const LOG_PREFIX = "[EmbeddingService]";

export class EmbeddingService {
    private modelName: string;
    private pipelineInstance: unknown = null;

    constructor(modelName = 'TaylorAI/bge-micro-v2') {
        this.modelName = modelName;
        console.log(`[EmbeddingService] constructor — model=${this.modelName} (env config deferred)`);
    }

    async embed(text: string): Promise<Float32Array> {
        console.log(`[EmbeddingService] embed() called, text.length=${text.length}`);

        if (!this.pipelineInstance) {
            console.log('[EmbeddingService] Pipeline not yet loaded — loading transformers and initialising...');
            new Notice('Loading embedding model for the first time — this may take up to a minute.');

            // onnxruntime-node is active in Obsidian Electron — no WASM path config needed
            // env.backends.onnx.wasm is only relevant for browser/onnxruntime-web builds
            console.log('[EmbeddingService] Running in Electron Node context — onnxruntime-node backend, cpu device');
            env.allowRemoteModels = true;
            env.allowLocalModels  = true;
            env.cacheDir          = './.cache/huggingface';

            try {
                console.log(`[EmbeddingService] Initialising pipeline — device=cpu model=${this.modelName}`);
                this.pipelineInstance = await pipeline('feature-extraction', this.modelName, {
                    device: 'cpu',
                    dtype: 'fp32',
                });
                console.log(`[EmbeddingService] Pipeline ready — device=cpu model=${this.modelName}`);
                new Notice('Embedding model loaded successfully.');
            } catch (error) {
                console.error('[EmbeddingService] Pipeline load failed on cpu device:', error);
                console.error('[EmbeddingService] Available devices depend on onnxruntime build. In Obsidian Electron: cpu and dml (Windows DirectML) are supported. wasm is not available in Node context.');
                new Notice('Embedding model failed to load. Check console for details.');
                throw error;
            }
        }

        try {
            const pipelineFn = this.pipelineInstance as (
                text: string,
                options: Record<string, unknown>
            ) => Promise<unknown>;

            const output = await pipelineFn(text, { pooling: 'mean', normalize: true });

            const tensor = output as { data: Float32Array; dims: number[] };
            if (!tensor?.data) {
                throw new Error('EmbeddingService: pipeline output has no .data property');
            }

            const vec = new Float32Array(tensor.data);
            let sumSq = 0;
            for (let i = 0; i < vec.length; i++) sumSq += (vec[i] || 0) * (vec[i] || 0);
            const norm = Math.sqrt(sumSq);
            console.log(`[EmbeddingService] embed complete dim=${vec.length} norm=${norm.toFixed(6)}`);
            return vec;

        } catch (error) {
            console.error('[EmbeddingService] embed() inference failed:', error);
            throw error;
        }
    }
}
