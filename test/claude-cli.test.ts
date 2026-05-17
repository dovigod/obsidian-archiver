import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "@core/llm/claude-cli";
import { testTmpDir } from "./helpers";

/**
 * Drops a synthetic `claude` binary into a tmp dir and returns its path.
 * The script echoes stdin through a transform so we can assert that
 * `complete()` writes the prompt to stdin and reads stdout back.
 */
function writeFakeClaude(script: string): string {
  const dir = mkdtempSync(join(testTmpDir(), "fake-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("ClaudeCliProvider", () => {
  it("pipes prompt to stdin and returns stdout", async () => {
    // Cat stdin (the prompt), suffix a sentinel.
    const fakePath = writeFakeClaude(`cat; echo "::END::"`);
    const provider = new ClaudeCliProvider({ binary: fakePath });
    const out = await provider.complete({ prompt: "hello world" });
    // Provider trims trailing whitespace; payload should contain prompt + sentinel.
    // `cat` doesn't add a trailing newline to a newline-less input, so the
    // prompt and sentinel sit adjacent.
    expect(out).toBe("hello world::END::");
  });

  it("forwards --model when configured", async () => {
    // Echo whichever --model value we get so the test can assert on it.
    const fakePath = writeFakeClaude(
      `args="$@"; echo "args: $args"; cat > /dev/null`,
    );
    const provider = new ClaudeCliProvider({
      binary: fakePath,
      model: "claude-opus-4-7",
    });
    const out = await provider.complete({ prompt: "x" });
    expect(out).toMatch(/--model claude-opus-4-7/);
  });

  it("forwards --append-system-prompt when system is set", async () => {
    const fakePath = writeFakeClaude(
      `args="$@"; echo "args: $args"; cat > /dev/null`,
    );
    const provider = new ClaudeCliProvider({ binary: fakePath });
    const out = await provider.complete({
      prompt: "x",
      system: "you are terse",
    });
    expect(out).toMatch(/--append-system-prompt/);
    expect(out).toMatch(/you are terse/);
  });

  it("rejects with stderr when the binary exits non-zero", async () => {
    const fakePath = writeFakeClaude(
      `cat > /dev/null; echo "boom" 1>&2; exit 7`,
    );
    const provider = new ClaudeCliProvider({ binary: fakePath });
    await expect(provider.complete({ prompt: "x" })).rejects.toThrow(
      /exited 7.*boom/,
    );
  });

  it("rejects with ENOENT when the binary is missing", async () => {
    const provider = new ClaudeCliProvider({
      binary: "/nonexistent/claude-binary",
    });
    await expect(provider.complete({ prompt: "x" })).rejects.toThrow();
  });

  it("respects timeoutMs and kills a hung child", async () => {
    const fakePath = writeFakeClaude(`sleep 10`);
    const provider = new ClaudeCliProvider({
      binary: fakePath,
      timeoutMs: 100,
    });
    await expect(provider.complete({ prompt: "x" })).rejects.toThrow(/timed out/);
  });
});
