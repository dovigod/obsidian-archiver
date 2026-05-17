import type { EmbeddingsProvider } from "@core/embeddings/provider";

export interface OpenAIEmbeddingsOptions {
  apiKey: string;
  model?: string;
  /** Override for the OpenAI endpoint (e.g. for Azure / proxies). */
  endpoint?: string;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * Calls the OpenAI embeddings endpoint over `fetch`. No new SDK dep — Node 20
 * has global fetch. Default model is `text-embedding-3-small` (cheap, strong
 * baseline). Requires `OPENAI_API_KEY` (or the configured env var) at runtime.
 */
export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  readonly model: string;
  readonly dims: number;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingsOptions) {
    if (!opts.apiKey) {
      throw new Error("OpenAIEmbeddingsProvider: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.dims = MODEL_DIMS[this.model] ?? 1536;
    this.endpoint = opts.endpoint ?? "https://api.openai.com/v1/embeddings";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `OpenAI embeddings ${res.status} ${res.statusText}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as {
      data?: { embedding?: number[] }[];
    };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error("OpenAI embeddings: empty response");
    }
    return Float32Array.from(embedding);
  }
}
