import { spawn } from "node:child_process";
import type { LLMCompleteOptions, LLMProvider } from "@core/llm/provider";

export interface ClaudeCliProviderOptions {
  /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
  binary?: string;
  /** Forwarded as `--model`. Default: let the CLI pick. */
  model?: string;
  /** Extra args appended after our standard set (escape hatch). */
  extraArgs?: readonly string[];
  /** Hard timeout per call (ms). Default 120_000. */
  timeoutMs?: number;
}

/**
 * Shells out to the local `claude` CLI in print/headless mode (`-p`). Uses the
 * binary's existing OAuth credentials — no API key required, the worker bills
 * through whatever Claude Code subscription is signed in.
 *
 * Trade-offs vs. the SDK-based `ClaudeProvider`:
 *   - Pro: zero extra cost; works with subscription-only setups.
 *   - Con: each call spawns a process (slower); subscription rate-limits apply.
 */
export class ClaudeCliProvider implements LLMProvider {
  private readonly binary: string;
  private readonly model: string | undefined;
  private readonly extraArgs: readonly string[];
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliProviderOptions = {}) {
    this.binary = opts.binary ?? "claude";
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(opts: LLMCompleteOptions): Promise<string> {
    const args: string[] = ["-p", "--output-format", "text"];
    if (this.model) {
      args.push("--model", this.model);
    }
    if (opts.system) {
      args.push("--append-system-prompt", opts.system);
    }
    args.push(...this.extraArgs);

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (
        ok: boolean,
        result: string | Error,
      ): void => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timer);
        if (ok && typeof result === "string") {
          resolve(result);
        } else {
          reject(result instanceof Error ? result : new Error(String(result)));
        }
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(
          false,
          new Error(
            `claude CLI timed out after ${this.timeoutMs}ms (${stderr.trim() || stdout.trim()})`,
          ),
        );
      }, this.timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        finish(false, err);
      });
      child.on("close", (code) => {
        if (code === 0) {
          finish(true, stdout.trim());
          return;
        }
        finish(
          false,
          new Error(
            `claude CLI exited ${code}: ${(stderr || stdout).trim() || "(no output)"}`,
          ),
        );
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
