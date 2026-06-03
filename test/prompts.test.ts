import { describe, expect, it } from "vitest";
import { loadPrompt } from "@core/llm/prompts";

describe("bilingual body contract", () => {
  it("extract prompt requires an English + ## 한국어 draft_body", async () => {
    const prompt = await loadPrompt("extract");
    expect(prompt).toContain("## 한국어");
    expect(prompt).toMatch(/both languages/i);
    // Summary must stay English — it feeds dedup/embeddings.
    expect(prompt).toMatch(/summary.*English/i);
  });

  it("rewrite prompt keeps both halves in sync and backfills missing Korean", async () => {
    const prompt = await loadPrompt("rewrite");
    expect(prompt).toContain("## 한국어");
    expect(prompt).toMatch(/BOTH halves/);
    expect(prompt).toMatch(/no `## 한국어` section yet/);
  });

  it("notes-plan prompt triggers a canvas for struggle signals AND flow/process explanations", async () => {
    const prompt = await loadPrompt("notes-plan");
    expect(prompt).toMatch(/needs_canvas/);
    // Struggle signals.
    expect(prompt).toMatch(/hard to grasp/i);
    // Overall flow/process/architecture content qualifies on its own.
    expect(prompt).toMatch(/overall flow, process, pipeline, or architecture/i);
    expect(prompt).toMatch(/regardless of how confident/i);
  });

  it("notes-write prompt demands near-verbatim transcription, bilingual halves, and append-style merge", async () => {
    const prompt = await loadPrompt("notes-write");
    // Near-raw contract: transcribe, don't rewrite.
    expect(prompt).toMatch(/TRANSCRIPTION, not a rewrite/);
    expect(prompt).toMatch(/nearly verbatim/i);
    expect(prompt).toMatch(/Do NOT summarize/);
    // Bilingual contract.
    expect(prompt).toContain("## 한국어");
    expect(prompt).toMatch(/both halves/i);
    // Merge contract: existing body untouched, new material appended.
    expect(prompt).toMatch(/keep it VERBATIM/);
    expect(prompt).toMatch(/APPEND the new material/);
  });
});
