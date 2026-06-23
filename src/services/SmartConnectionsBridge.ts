import { App } from 'obsidian';

const LOG_PREFIX = '[SmartConnectionsBridge]';

/**
 * Calls Smart Connections' already-loaded embedding model to produce
 * a query vector. This guarantees perfect vector compatibility with
 * all embeddings stored in smart_index.db (same model, same tokenizer).
 *
 * Smart Connections must be installed and enabled. If it is not present
 * or its embed model is not ready, this throws a descriptive error.
 */
export class SmartConnectionsBridge {
    private app: App;

    constructor(app: App) {
        this.app = app;
        console.log(`${LOG_PREFIX} constructed`);
    }

    /**
     * Returns the Smart Connections plugin instance or throws.
     */
    private getScPlugin(): any {
        const plugins = (this.app as any).plugins?.plugins;
        if (!plugins) {
            throw new Error(`${LOG_PREFIX} Cannot access app.plugins.plugins — Obsidian API unavailable`);
        }

        const sc = plugins['smart-connections'];
        if (!sc) {
            throw new Error(
                `${LOG_PREFIX} Smart Connections plugin not found. ` +
                `Please install and enable Smart Connections before using Vault RAG Explorer.`
            );
        }

        console.log(`${LOG_PREFIX} Smart Connections plugin found — version=${sc.manifest?.version ?? 'unknown'}`);
        return sc;
    }

    /**
     * Resolves the live embed model from SC's smart_env.
     * SC v2+ stores it at smart_env.embed_model or smart_env.smart_embed_model.
     */
    private getEmbedModel(sc: any): any {
        const env = sc.smart_env ?? sc.env;
        if (!env) {
            throw new Error(
                `${LOG_PREFIX} Smart Connections smart_env not initialised yet. ` +
                `Wait for SC to finish loading before running queries.`
            );
        }

        console.log(`${LOG_PREFIX} smart_env found — resolving embed model`);
        console.log(`${LOG_PREFIX} _embed_model on smart_env:`, typeof env._embed_model, env._embed_model ? 'EXISTS' : 'MISSING');

        // SC stores the embed model as _embed_model (private/lazy field).
        // We check all known variants for forwards/backwards compatibility.
        const model =
            env._embed_model ??
            env.embed_model ??
            env.smart_embed_model ??
            env.embedModel ??
            env.smart_embed ??
            env.embed ??
            sc.embed_model ??
            sc.embedModel ??
            sc._embed_model ??
            null;

        if (!model) {
            throw new Error(
                `${LOG_PREFIX} Smart Connections embed model (_embed_model) is null. ` +
                `SC may still be initialising its embedding model — wait a moment and run the query again.`
            );
        }

        const modelName = model.model_key ?? model.model_name ?? model.config?.model_key ?? model.key ?? 'unknown';
        console.log(`${LOG_PREFIX} embed_model resolved — model=${modelName}`);
        return model;
    }

    /**
     * Embeds a single query string using SC's live embedding model.
     * Returns a normalised Float32Array of the same dimensionality as
     * the stored embeddings in smart_index.db.
     */
    async embed(text: string): Promise<Float32Array> {
        console.log(`${LOG_PREFIX} embed() called — text.length=${text.length}`);

        const sc = this.getScPlugin();
        const model = this.getEmbedModel(sc);

        let result: any;

        // SC's embed API differs slightly across versions:
        // v2.2+  → model.embed(text)  returns { vec: Float32Array }
        // v2.1   → model.embed_batch([{embed_input: text}]) returns [{vec: Float32Array}]
        // older  → model.embed(text) returns Float32Array directly
        try {
            if (typeof model.embed === 'function') {
                console.log(`${LOG_PREFIX} calling model.embed(text) — SC v2.2+ API`);
                result = await model.embed(text);
                console.log(`${LOG_PREFIX} model.embed() returned — type=${typeof result} keys=${result ? Object.keys(result).join(',') : 'null'}`);
            } else if (typeof model.embed_batch === 'function') {
                console.log(`${LOG_PREFIX} calling model.embed_batch() — SC v2.1 API`);
                const batch = await model.embed_batch([{ embed_input: text }]);
                result = batch?.[0];
                console.log(`${LOG_PREFIX} model.embed_batch() returned batch[0] — type=${typeof result}`);
            } else if (typeof model.embed_input === 'function') {
                console.log(`${LOG_PREFIX} calling model.embed_input(text) — SC internal API`);
                result = await model.embed_input(text);
                console.log(`${LOG_PREFIX} model.embed_input() returned — type=${typeof result}`);
            } else {
                throw new Error(`${LOG_PREFIX} Smart Connections embed model has no embed() or embed_batch() method`);
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} SC embed call failed:`, err);
            throw err;
        }

        // Normalise result to Float32Array
        let vec: Float32Array;
        if (result instanceof Float32Array) {
            vec = result;
        } else if (result?.vec instanceof Float32Array) {
            vec = result.vec;
        } else if (result?.data) {
            vec = new Float32Array(result.data);
        } else if (Array.isArray(result?.vec)) {
            vec = new Float32Array(result.vec);
        } else if (Array.isArray(result)) {
            vec = new Float32Array(result);
        } else {
            console.error(`${LOG_PREFIX} Unrecognised embed result shape:`, result);
            throw new Error(`${LOG_PREFIX} Could not extract Float32Array from SC embed result`);
        }

        const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
        console.log(`${LOG_PREFIX} embed complete — dim=${vec.length} norm=${norm.toFixed(6)}`);
        return vec;
    }

    private normaliseModelName(raw: string): string {
        console.log('[SmartConnectionsBridge] raw model name from SC:', raw);
        const MODEL_NAME_MAP: Record<string, string> = {
            'TaylorAI/bge':           'TaylorAI/bge-micro-v2',
            'bge-micro':              'TaylorAI/bge-micro-v2',
            'bge-micro-v2':           'TaylorAI/bge-micro-v2',
            'text-embedding-ada-002': 'text-embedding-ada-002',
        };
        const normalised = MODEL_NAME_MAP[raw] ?? raw;
        console.log('[SmartConnectionsBridge] normalised model name:', normalised);
        return normalised;
    }

    private resolveModelName(): string {
        try {
            const sc = this.getScPlugin();
            const model = this.getEmbedModel(sc);
            const name = model.model_key ?? model.model_name ?? model.config?.model_key ?? 'unknown';
            return name;
        } catch (err) {
            console.warn(`${LOG_PREFIX} resolveModelName() failed:`, err);
            return 'unknown';
        }
    }

    /**
     * Returns the model key SC is currently using, for
     * validating it matches the stored embeddings in smart_index.db.
     */
    getModelName(): string {
        const raw = this.resolveModelName(); // existing logic unchanged
        return this.normaliseModelName(raw);
    }
}
