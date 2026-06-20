import { pipeline, env } from "@huggingface/transformers";
import { Notice } from "obsidian";

const LOG_PREFIX = "[EmbeddingService]";

export class EmbeddingService {
  private modelName: string;
  private pipelineInstance: unknown = null;

  constructor(modelName = 'TaylorAI/bge-micro-v2') {
    console.log('[EmbeddingService] Using @huggingface/transformers v3');

    // Explicitly override ONNX WASM paths to use the CDN version
    // This prevents the undefined .create error caused by broken
    // local WASM path resolution in Obsidian's Electron renderer
    if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
    } else {
        console.warn('[EmbeddingService] env.backends.onnx.wasm not yet available — will configure at pipeline init');
    }

    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    env.cacheDir = './.cache/huggingface';

    console.log('[EmbeddingService] env configured:', {
        wasmPaths: env.backends.onnx?.wasm?.wasmPaths,
        numThreads: env.backends.onnx?.wasm?.numThreads,
        allowRemoteModels: env.allowRemoteModels,
    });

    this.modelName = modelName;
    console.log(`[EmbeddingService] constructor complete, model=${this.modelName}`);
  }

  async embed(text: string): Promise<Float32Array> {
    console.log(`${LOG_PREFIX} embed() called, text.length=${text.length}`);

    if (!this.pipelineInstance) {
        console.log('[EmbeddingService] Pipeline not yet loaded — initialising...');
        new Notice('Loading embedding model for the first time — this may take up to a minute. Check the console for progress.');
        console.log('[EmbeddingService] First-run model download may be in progress. Model will be cached after this.');

        try {
            this.pipelineInstance = await pipeline('feature-extraction', this.modelName, {
                device: 'wasm',      // force WASM, never attempt WebGPU or WebNN
                dtype: 'fp32',
                session_options: {
                    executionProviders: ['wasm'],
                },
            });
            console.log(`[EmbeddingService] Pipeline ready — model=${this.modelName}`);
        } catch (error) {
            console.error('[EmbeddingService] Pipeline load failed — @huggingface/transformers ONNX WASM init error in Obsidian Electron:', error);
            new Notice(`Embedding model failed to load. Check console for details.`);
            throw error;
        }
    }

    try {
        const pipelineFn = this.pipelineInstance as (
            text: string,
            options: Record<string, unknown>
        ) => Promise<unknown>;

        const output = await pipelineFn(text, { pooling: 'mean', normalize: true });

        console.log('[EmbeddingService] Raw pipeline output type:', typeof output, Array.isArray(output));

        // v3 returns a Tensor object; extract the underlying float data
        // The Tensor has a .data property (TypedArray) and .dims
        const tensor = output as { data: Float32Array; dims: number[] };

        if (!tensor?.data) {
            console.error('[EmbeddingService] Unexpected output shape — tensor.data is undefined. Full output:', output);
            throw new Error('EmbeddingService: pipeline output has no .data property — check model and pooling config');
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
