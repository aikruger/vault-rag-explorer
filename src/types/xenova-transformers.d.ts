// Minimal ambient shim for @xenova/transformers until bundler resolution resolves its types.
declare module "@xenova/transformers" {
  type PipelineType = "feature-extraction" | string;

  interface PipelineOutput {
    data: Float32Array;
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
