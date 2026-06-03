import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, formatLogLine, loggerFromConfig } from "@core/log";
import { testTmpDir } from "./helpers";

describe("formatLogLine", () => {
  it("formats level, component, event and key=value fields", () => {
    const line = formatLogLine(
      "worker",
      "info",
      "job.done",
      { id: "abc", duration_ms: 42, ok: true },
      new Date("2026-06-03T12:00:00.000Z"),
    );
    expect(line).toBe(
      "2026-06-03T12:00:00.000Z INFO  [worker] job.done id=abc duration_ms=42 ok=true",
    );
  });

  it("quotes values containing spaces and skips undefined", () => {
    const line = formatLogLine(
      "mcp",
      "error",
      "archive.fail",
      { error: "boom went the db", skipped: undefined },
      new Date("2026-06-03T12:00:00.000Z"),
    );
    expect(line).toContain('error="boom went the db"');
    expect(line).not.toContain("skipped");
  });
});

describe("createLogger", () => {
  it("appends lines to the log file and creates parent dirs", () => {
    const dir = mkdtempSync(join(testTmpDir(), "log-"));
    const file = join(dir, "nested", "kh.log");
    const log = createLogger({ component: "test", path: file, stderr: false });

    log.info("one", { a: 1 });
    log.error("two", { reason: "x" });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("INFO  [test] one a=1");
    expect(lines[1]).toContain("ERROR [test] two reason=x");
  });

  it("never throws when the log path is unwritable", () => {
    const log = createLogger({
      component: "test",
      path: "/dev/null/impossible/kh.log",
      stderr: false,
    });
    expect(() => log.info("ok")).not.toThrow();
  });
});

describe("loggerFromConfig", () => {
  it("returns a no-op logger when disabled", () => {
    const dir = mkdtempSync(join(testTmpDir(), "log-"));
    const file = join(dir, "kh.log");
    const log = loggerFromConfig(
      { enabled: false, path: file, stderr: false },
      "test",
    );
    log.info("dropped");
    expect(() => readFileSync(file, "utf8")).toThrow(); // nothing written
  });
});
