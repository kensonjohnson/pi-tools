/**
 * Local embedding provider using @huggingface/transformers.
 * Zero API keys — runs entirely locally.
 */

const MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
const DIMENSIONS = 384;

type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: "mean"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    return pipeline("feature-extraction", MODEL) as Promise<FeatureExtractionPipeline>;
  })();

  return pipelinePromise;
}

export async function embed(text: string): Promise<number[]> {
  const embeddings = await embedBatch([text]);
  return embeddings[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const extractor = await getExtractor();
  const output = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });

  const raw = Array.from(output.data);
  const dims = output.dims;

  if (dims.length !== 2) {
    throw new Error(`Unexpected embedding tensor rank ${dims.length} for ${MODEL}`);
  }

  const [batchSize, width] = dims;
  if (width !== DIMENSIONS) {
    throw new Error(`Embedding dimension mismatch: expected ${DIMENSIONS}, got ${width}`);
  }

  const embeddings: number[][] = [];
  for (let i = 0; i < batchSize; i++) {
    embeddings.push(raw.slice(i * width, (i + 1) * width));
  }

  return embeddings;
}

export function getModelName(): string {
  return MODEL;
}

export function getDimensions(): number {
  return DIMENSIONS;
}
