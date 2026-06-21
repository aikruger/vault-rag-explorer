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
                `${LOG_PREFIX} Smart Connections smart_env not initialised yet.`
            );
        }

        // --- DIAGNOSTIC: log every key on env and sc so we can find the embedder ---
        console.log(`${LOG_PREFIX} smart_env keys:`, Object.keys(env));
        console.log(`${LOG_PREFIX} sc (plugin) keys:`, Object.keys(sc));

        // Log keys that look embedding-related
        const envEmbedKeys = Object.keys(env).filter(k =>
            k.toLowerCase().includes('embed') ||
            k.toLowerCase().includes('model') ||
            k.toLowerCase().includes('smart')
        );
        console.log(`${LOG_PREFIX} embed/model-related keys on smart_env:`, envEmbedKeys);

        // Log any property on env whose value is an object with an embed or embed_batch function
        for (const key of Object.keys(env)) {
            const val = env[key];
            if (val && typeof val === 'object') {
                if (typeof val.embed === 'function' || typeof val.embed_batch === 'function') {
                    console.log(`${LOG_PREFIX} FOUND embedder candidate at env.${key} — methods:`, Object.keys(val).filter(k => typeof val[k] === 'function'));
                }
            }
        }

        // Also check sc directly (some SC versions attach embed_model to plugin root)
        const scEmbedKeys = Object.keys(sc).filter(k =>
            k.toLowerCase().includes('embed') ||
            k.toLowerCase().includes('model')
        );
        console.log(`${LOG_PREFIX} embed/model-related keys on sc plugin root:`, scEmbedKeys);
        for (const key of scEmbedKeys) {
            const val = sc[key];
            if (val && typeof val === 'object') {
                if (typeof val.embed === 'function' || typeof val.embed_batch === 'function') {
                    console.log(`${LOG_PREFIX} FOUND embedder candidate at sc.${key}`);
                }
            }
        }
        // --- END DIAGNOSTIC ---

        // Try every known location
        const model =
            env.embed_model ??
            env.smart_embed_model ??
            env.embedModel ??
            env.smart_embed ??
            env.embed ??
            sc.embed_model ??
            sc.embedModel ??
            null;

        if (!model) {
            // Log full env object shape to console so we can inspect it
            console.error(`${LOG_PREFIX} Could not find embed model. Full smart_env snapshot:`, JSON.stringify(
                Object.fromEntries(
                    Object.keys(env).map(k => [k, typeof env[k]])
                )
            ));
            throw new Error(
                `${LOG_PREFIX} No embed_model found on smart_env. ` +
                `Check the console log above for "embed/model-related keys" to find the correct property name.`
            );
        }

        const modelName = model.model_key ?? model.model_name ?? model.config?.model_key ?? 'unknown';
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

    /**
     * Returns the model key SC is currently using, for
     * validating it matches the stored embeddings in smart_index.db.
     */
    getModelName(): string {
        try {
            const sc = this.getScPlugin();
            const model = this.getEmbedModel(sc);
            const name = model.model_key ?? model.model_name ?? model.config?.model_key ?? 'unknown';
            console.log(`${LOG_PREFIX} getModelName() → ${name}`);
            return name;
        } catch (err) {
            console.warn(`${LOG_PREFIX} getModelName() failed:`, err);
            return 'unknown';
        }
    }
}
