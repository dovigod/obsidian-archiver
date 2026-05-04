import type { LLMCompleteOptions, LLMProvider } from "@core/llm/provider";

type Responder =
  | string
  | ((opts: LLMCompleteOptions) => string | Promise<string>);

/**
 * Test-only LLM provider. Two response strategies:
 *   1. FIFO queue via `enqueue(...responses)` — used by ordered pipeline tests.
 *   2. Pattern matching via `respondWhen(matcher, responder)` — used when the
 *      caller doesn't want to depend on call order.
 *
 * Every `complete` call records its options for later assertion.
 */
export class MockLLMProvider implements LLMProvider {
  private readonly queue: Responder[] = [];
  private readonly tagged: Array<{ matcher: RegExp; responder: Responder }> =
    [];
  readonly calls: LLMCompleteOptions[] = [];

  enqueue(...responses: Responder[]): void {
    this.queue.push(...responses);
  }

  respondWhen(matcher: RegExp, responder: Responder): void {
    this.tagged.push({ matcher, responder });
  }

  async complete(opts: LLMCompleteOptions): Promise<string> {
    this.calls.push(opts);
    for (const { matcher, responder } of this.tagged) {
      const haystack = `${opts.system ?? ""}\n${opts.prompt}`;
      if (matcher.test(haystack)) {
        return typeof responder === "function" ? responder(opts) : responder;
      }
    }
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(
        `MockLLMProvider: no scripted response. Prompt head: "${opts.prompt.slice(
          0,
          120,
        )}..."`,
      );
    }
    return typeof next === "function" ? next(opts) : next;
  }

  reset(): void {
    this.queue.length = 0;
    this.tagged.length = 0;
    this.calls.length = 0;
  }
}
