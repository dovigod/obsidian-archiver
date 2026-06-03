import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeProjectDirName,
  locateClaudeSessionTranscript,
} from "@core/transcript/locate";
import { testTmpDir } from "./helpers";

describe("claudeProjectDirName", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(
      claudeProjectDirName(
        "/Users/mccalister/Desktop/private_workspace/knowledge-hub",
      ),
    ).toBe("-Users-mccalister-Desktop-private-workspace-knowledge-hub");
  });
});

describe("locateClaudeSessionTranscript", () => {
  function setup(cwd: string): { root: string; projectDir: string } {
    const root = mkdtempSync(join(testTmpDir(), "locate-"));
    const projectDir = join(root, claudeProjectDirName(cwd));
    mkdirSync(projectDir, { recursive: true });
    return { root, projectDir };
  }

  it("picks the most recently modified session when no session_id is given", async () => {
    const cwd = "/tmp/my_project";
    const { root, projectDir } = setup(cwd);
    const older = join(projectDir, "aaaa.jsonl");
    const newer = join(projectDir, "bbbb.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    // Force distinct mtimes regardless of filesystem timestamp resolution.
    utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(newer, new Date("2026-06-01"), new Date("2026-06-01"));

    const path = await locateClaudeSessionTranscript({
      cwd,
      projectsRoot: root,
    });
    expect(path).toBe(newer);
  });

  it("resolves an explicit session_id", async () => {
    const cwd = "/tmp/my_project";
    const { root, projectDir } = setup(cwd);
    writeFileSync(join(projectDir, "aaaa.jsonl"), "{}\n");

    const path = await locateClaudeSessionTranscript({
      cwd,
      sessionId: "aaaa",
      projectsRoot: root,
    });
    expect(path).toBe(join(projectDir, "aaaa.jsonl"));
  });

  it("throws when the session_id has no transcript", async () => {
    const cwd = "/tmp/my_project";
    const { root } = setup(cwd);
    await expect(
      locateClaudeSessionTranscript({
        cwd,
        sessionId: "missing",
        projectsRoot: root,
      }),
    ).rejects.toThrow(/No transcript for session missing/);
  });

  it("throws when the project directory does not exist", async () => {
    const root = mkdtempSync(join(testTmpDir(), "locate-"));
    await expect(
      locateClaudeSessionTranscript({ cwd: "/nope", projectsRoot: root }),
    ).rejects.toThrow(/No Claude Code project directory/);
  });

  it("throws when the project directory has no jsonl files", async () => {
    const cwd = "/tmp/empty_project";
    const { root, projectDir } = setup(cwd);
    writeFileSync(join(projectDir, "notes.txt"), "hi");
    await expect(
      locateClaudeSessionTranscript({ cwd, projectsRoot: root }),
    ).rejects.toThrow(/No session transcripts/);
  });
});
