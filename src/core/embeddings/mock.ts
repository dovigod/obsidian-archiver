import type { EmbeddingsProvider } from "@core/embeddings/provider";

const DEFAULT_DIMS = 128;
const NGRAM_SIZE = 3;

/**
 * Deterministic character-n-gram embedder used for tests (and as a sensible
 * default when no API key is available). Surfaces substring overlap as
 * cosine similarity, which catches obvious synonym pairs like "Redis" vs
 * "redis-server" but isn't a substitute for a real model.
 */
export class MockEmbeddingsProvider implements EmbeddingsProvider {
  readonly model = "mock-ngram-v1";
  readonly dims: number;
  private readonly ngramSize: number;

  constructor(opts: { dims?: number; ngramSize?: number } = {}) {
    this.dims = opts.dims ?? DEFAULT_DIMS;
    this.ngramSize = opts.ngramSize ?? NGRAM_SIZE;
  }

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dims);
    const normalized = text.toLowerCase();
    const padded = ` ${normalized} `;
    for (let i = 0; i <= padded.length - this.ngramSize; i++) {
      const ngram = padded.slice(i, i + this.ngramSize);
      const slot = hashStringToInt(ngram) % this.dims;
      vec[slot]! += 1;
    }
    // L2-normalize so cosine sim is dot product
    let norm = 0;
    for (const v of vec) {norm += v * v;}
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < vec.length; i++) {vec[i] = vec[i]! * inv;}
    }
    return vec;
  }
}

function hashStringToInt(s: string): number {
  // FNV-1a 32-bit, fine for hashing-trick bucketing.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
