import { env, pipeline } from "@huggingface/transformers";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

export const modelId = "Xenova/multilingual-e5-small";
export const modelRevision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const embeddingId = `${modelId}@${modelRevision}:q8:mean:normalized:e5-prefix:v1`;

export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string, query?: boolean): Promise<Float32Array>;
}

export async function createEmbedder(
  cacheDirectory = NodePath.join(NodeOS.homedir(), ".cache", "cortex", "models"),
): Promise<Embedder> {
  env.cacheDir = cacheDirectory;
  const extractor = await pipeline("feature-extraction", modelId, {
    revision: modelRevision,
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  return {
    id: embeddingId,
    dimensions: 384,
    async embed(text, query = false) {
      const result = await extractor(`${query ? "query" : "passage"}: ${text}`, {
        pooling: "mean",
        normalize: true,
      });
      return Float32Array.from(result.data);
    },
  };
}
