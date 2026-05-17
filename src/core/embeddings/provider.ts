/**
 * Pluggable embedding API. The dedup pipeline uses this only to compute the
 * vector for a candidate; nearest-neighbor search is done in JS against the
 * `dedup_embeddings` table.
 */
export interface EmbeddingsProvider {
  readonly model: string;
  readonly dims: number;
  embed(text: string): Promise<Float32Array>;
}

/** Pack a Float32Array as a node Buffer for SQLite blob storage. */
export function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a SQLite blob back into a Float32Array view. */
export function unpackVector(buf: Buffer | Uint8Array): Float32Array {
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(
    view.buffer,
    view.byteOffset,
    view.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {return 0;}
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {return 0;}
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
