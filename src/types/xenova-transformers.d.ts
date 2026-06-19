// Ambient type shim for @xenova/transformers.
// The package ships JS types via its exports map but TypeScript's bundler
// resolution cannot locate them. This shim provides the minimal surface used
// in EmbeddingService.ts.

declare module "@xenova/transformers" {
  type PipelineType = "feature-extraction" | string;

  interface PipelineOutput {
    data: Float32Array;
    [key: string]: unknown;
  }

  type PipelineFn = (
    text: string,
    options?: Record<string, unknown>
  ) => Promise<PipelineOutput>;

  export function pipeline(
    task: PipelineType,
    model?: string,
    options?: Record<string, unknown>
  ): Promise<PipelineFn>;
}