import { App } from 'obsidian';

// Duck-type interfaces for Smart Connections internals — shapes vary across SC versions
interface ScPluginShape {
  manifest?: { version?: string };
  smart_env?: ScEnvShape;
  env?: ScEnvShape;
  embed_model?: ScModelShape;
  embedModel?: ScModelShape;
  _embed_model?: ScModelShape;
}

interface ScEnvShape {
  _embed_model?: ScModelShape;
  embed_model?: ScModelShape;
  smart_embed_model?: ScModelShape;
  embedModel?: ScModelShape;
  smart_embed?: ScModelShape;
  embed?: ScModelShape;
}

interface ScModelShape {
  embed?: (text: string) => Promise<unknown>;
  embed_batch?: (items: { embed_input: string }[]) => Promise<unknown[]>;
  embed_input?: (text: string) => Promise<unknown>;
  model_key?: string;
  model_name?: string;
  config?: { model_key?: string };
  key?: string;
  vec?: Float32Array | number[];
  data?: ArrayLike<number>;
}

interface ScEmbedResult {
  vec?: Float32Array | number[];
  data?: ArrayLike<number>;
}

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
    private getScPlugin(): ScPluginShape {
        const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, ScPluginShape> } }).plugins?.plugins;
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
    private getEmbedModel(sc: ScPluginShape): ScModelShape {
        const env: ScEnvShape | undefined = sc.smart_env ?? sc.env;
        if (!env) {
            throw new Error(
                `${LOG_PREFIX} Smart Connections smart_env not initialised yet. ` +
                `Wait for SC to finish loading before running queries.`
            );
        }
        console.log(`${LOG_PREFIX} smart_env found — resolving embed model`);
        console.log(`${LOG_PREFIX} _embed_model on smart_env:`, typeof env._embed_model, env._embed_model ? 'EXISTS' : 'MISSING');

        const model: ScModelShape | null | undefined =
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
	 * Generates an embedding vector for the provided text using SC's exact model.
	 *
	 * @param text The string to embed
	 * @returns A Float32Array containing the embedding, or throws if unavailable
	 */
	public async embed(text: string): Promise<Float32Array> {
		console.log(`${LOG_PREFIX} embed() called — text.length=${text.length}`);
		const sc = this.getScPlugin();
		const model = this.getEmbedModel(sc);
		let result: unknown;

		try {
			if (typeof model.embed === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed(text) — SC v2.2+ API`);
				result = await model.embed(text);
				console.log(`${LOG_PREFIX} model.embed() returned — type=${typeof result}`);
			} else if (typeof model.embed_batch === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed_batch() — SC v2.1 API`);
				const batch = await model.embed_batch([{ embed_input: text }]);
				result = batch?.[0];
				console.log(`${LOG_PREFIX} model.embed_batch() returned batch[0]`);
			} else if (typeof model.embed_input === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed_input(text) — SC internal API`);
				result = await model.embed_input(text);
				console.log(`${LOG_PREFIX} model.embed_input() returned`);
			} else {
				throw new Error(`${LOG_PREFIX} Smart Connections embed model has no embed() or embed_batch() method`);
			}
		} catch (err) {
			console.error(`${LOG_PREFIX} SC embed call failed:`, err);
			throw err;
		}

		// Normalise result to Float32Array
		let vec: Float32Array;
		const r = result as ScEmbedResult | Float32Array | number[] | null | undefined;
		if (r instanceof Float32Array) {
			vec = r;
		} else if (r && 'vec' in r && r.vec instanceof Float32Array) {
			vec = r.vec;
		} else if (r && 'data' in r && r.data) {
			vec = new Float32Array(r.data);
		} else if (r && 'vec' in r && Array.isArray(r.vec)) {
			vec = new Float32Array(r.vec);
		} else if (Array.isArray(r)) {
			vec = new Float32Array(r);
		} else {
			console.error(`${LOG_PREFIX} Unrecognised embed result shape:`, result);
			throw new Error(`${LOG_PREFIX} Could not extract Float32Array from SC embed result`);
		}

		const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
		console.log(`${LOG_PREFIX} embed complete — dim=${vec.length} norm=${norm.toFixed(6)}`);
		return vec;
	}

	public getModelName(): string {
		return this.resolveModelName();
	}

	private resolveModelName(): string {
		try {
			const sc = this.getScPlugin();
			const model = this.getEmbedModel(sc);
			const name = model.model_key ?? model.model_name ?? model.config?.model_key ?? model.key ?? 'unknown';
			return name;
		} catch (err) {
			console.warn(`${LOG_PREFIX} resolveModelName() failed:`, err);
			return 'unknown';
		}
	}

	public async getEmbedding(text: string): Promise<{ vec: number[] } | null> {
		const sc = this.getScPlugin();
		const model = this.getEmbedModel(sc);
		if (!model) return null;

		let result: unknown;
		try {
			if (typeof model.embed === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed(text) — SC v2.2+ API`);
				result = await model.embed(text);
				console.log(`${LOG_PREFIX} model.embed() returned — type=${typeof result}`);
			} else if (typeof model.embed_batch === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed_batch() — SC v2.1 API`);
				const batch = await model.embed_batch([{ embed_input: text }]);
				result = batch?.[0];
				console.log(`${LOG_PREFIX} model.embed_batch() returned batch[0]`);
			} else if (typeof model.embed_input === 'function') {
				console.log(`${LOG_PREFIX} calling model.embed_input(text) — SC internal API`);
				result = await model.embed_input(text);
				console.log(`${LOG_PREFIX} model.embed_input() returned`);
			} else {
				throw new Error(`${LOG_PREFIX} Smart Connections embed model has no embed() or embed_batch() method`);
			}
		} catch (err) {
			console.error(`${LOG_PREFIX} SC embed call failed:`, err);
			throw err;
		}

		// Normalise result to Float32Array
		let vec: Float32Array;
		const r = result as ScEmbedResult | Float32Array | number[] | null | undefined;
		if (r instanceof Float32Array) {
			vec = r;
		} else if (r && 'vec' in r && r.vec instanceof Float32Array) {
			vec = r.vec;
		} else if (r && 'data' in r && r.data) {
			vec = new Float32Array(r.data);
		} else if (r && 'vec' in r && Array.isArray(r.vec)) {
			vec = new Float32Array(r.vec);
		} else if (Array.isArray(r)) {
			vec = new Float32Array(r);
		} else {
			console.error(`${LOG_PREFIX} Unrecognised embed result shape:`, result);
			throw new Error(`${LOG_PREFIX} Could not extract Float32Array from SC embed result`);
		}

		const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
		console.log(`${LOG_PREFIX} embed complete — dim=${vec.length} norm=${norm.toFixed(6)}`);

		return { vec: Array.from(vec) };
	}

	public getEmbeddingModelConfig(): { model_key: string; config: unknown } | null {
		const sc = this.getScPlugin();
		const model = this.getEmbedModel(sc);
		if (!model) return null;
		return { model_key: model.model_key || model.model_name || 'unknown', config: model.config };
	}

	public getIndexHealth(): { dimension?: number; size?: number; loaded: boolean; status: string } {
		try {
			const sc = this.getScPlugin();
			const model = this.getEmbedModel(sc);

			// Try to get dimension from model
			let dimension: number | undefined;
			if (model && (model as any).dimensions) {
				dimension = (model as any).dimensions;
			} else if (model && model.config && (model.config as any).dimensions) {
				dimension = (model.config as any).dimensions;
			}

			// Try to get size from smart_env items or similar collections
			let size: number | undefined;
			const env = sc.smart_env ?? sc.env;
			if (env) {
				// Different versions of SC expose items/blocks differently
				if ((env as any).smart_blocks && (env as any).smart_blocks.items) {
					size = Object.keys((env as any).smart_blocks.items).length;
				} else if ((env as any).items) {
					size = Object.keys((env as any).items).length;
				}
			}

			const loaded = !!model;

			let status = "Healthy";
			if (!loaded) status = "Model not loaded";
			else if (size === 0) status = "Index empty";

			const health = { dimension, size, loaded, status };
			console.log(`${LOG_PREFIX} getIndexHealth result:`, health);
			return health;
		} catch (err) {
			console.warn(`${LOG_PREFIX} getIndexHealth failed:`, err);
			return { loaded: false, status: "Error getting health" };
		}
	}
}
