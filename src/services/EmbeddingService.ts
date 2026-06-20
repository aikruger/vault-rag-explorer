import { pipeline, env } from "@huggingface/transformers";
import { Notice } from "obsidian";

const LOG_PREFIX = "[EmbeddingService]";

export class EmbeddingService {
    private modelName: string;
    private pipelineInstance: unknown = null;

    constructor(modelName = 'TaylorAI/bge-micro-v2') {
        // Do NOT access env.backends here — the library may not be
        // fully initialised yet when the constructor runs synchronously.
        // All env configuration is deferred to the first embed() call.
        this.modelName = modelName;
        console.log(`[EmbeddingService] constructor — model=${this.modelName} (env config deferred)`);
    }

    private configureEnv(): void {
        console.log('[EmbeddingService] configureEnv() — applying @huggingface/transformers env settings');

        env.allowRemoteModels = true;
        env.allowLocalModels  = true;
        env.cacheDir          = './.cache/huggingface';

        // Guard every level — env.backends.onnx.wasm may be undefined
        // depending on the library init order in Obsidian's Electron renderer
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.wasmPaths  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
            env.backends.onnx.wasm.numThreads = 1;
            env.backends.onnx.wasm.proxy      = false;
            console.log('[EmbeddingService] ONNX WASM backend configured');
        } else {
            console.warn('[EmbeddingService] env.backends.onnx.wasm not available — ' +
                         'library may self-configure; pipeline device forced to wasm in options');
        }

        console.log('[EmbeddingService] env configured:', {
            allowRemoteModels: env.allowRemoteModels,
            cacheDir:          env.cacheDir,
        });
    }

    async embed(text: string): Promise<Float32Array> {
        console.log(`[EmbeddingService] embed() called, text.length=${text.length}`);

        if (!this.pipelineInstance) {
            console.log('[EmbeddingService] Pipeline not yet loaded — initialising...');
            new Notice('Loading embedding model for the first time — this may take up to a minute.');

            // Configure env here, not in constructor
            this.configureEnv();

            try {
                this.pipelineInstance = await pipeline('feature-extraction', this.modelName, {
                    device: 'wasm',
                    dtype:  'fp32',
                });
                console.log(`[EmbeddingService] Pipeline ready — model=${this.modelName}`);
                new Notice('Embedding model loaded successfully.');
            } catch (error) {
                console.error('[EmbeddingService] Pipeline load failed — ONNX WASM init error:', error);
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
