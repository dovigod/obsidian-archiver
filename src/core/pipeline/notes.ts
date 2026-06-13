import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@core/config";
import {
  autoCommit,
  pushVault,
  resolvePushRemoteUrl,
  resolvePushToken,
} from "@core/git";
import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { extractJson } from "@core/pipeline/json";
import { MarkdownVaultRepository } from "@core/repository/raw";
import { NotesRepository } from "@core/repository/notes";
import {
  ArchiveScope,
  type Conversation,
  type Message,
  type NotesCanvasSpec,
  NotesCanvasSpecSchema,
  type NotesPlan,
  NotesPlanSchema,
  type NotesReaskPlan,
  NotesReaskPlanSchema,
  Role,
} from "@core/schema";

export const CANVAS_DIR = "canvas";

export interface RunNotesInput {
  conversationId: string;
  /** Vault-relative path to the raw conversation .md. */
  conversationPath: string;
}

export interface NoteResult {
  file: string;
  relativePath: string;
  title: string;
  action: "create" | "merge";
  needsCanvas: boolean;
}

export interface RunNotesResult {
  conversationId: string;
  notes: NoteResult[];
  /** Vault-relative paths of generated .canvas files. */
  canvases: string[];
  committed: boolean;
}

/**
 * Stage 2 "notes" job: distill one raw conversation into topic notes.
 *
 *   1. read the raw conversation md
 *   2. plan topic groups (LLM) — grouped from the USER's questions, merged
 *      aggressively, with create-vs-merge decided against existing notes/
 *   3. per group: lightly edit the assistant turns into explanatory prose
 *      (LLM), integrating into the existing note body on merge
 *   4. canvases: a concept map per group the user struggled with
 *      (needs_canvas), plus an overview canvas when ≥2 notes were touched
 *   5. git auto-commit (config-gated)
 *
 * Every LLM failure mode is recoverable: malformed plan JSON → no-op,
 * malformed canvas JSON → note is kept, canvas skipped.
 *
 * Dispatches by archive scope: `answer` captures (from the `archive_answer`
 * MCP tool) keep the legacy transcription path; full conversations use the
 * re-ask path, which regenerates rich answers from the user's questions
 * (the archived assistant turns are often lossy summaries).
 */
export async function runNotesPipeline(
  config: Config,
  llm: LLMProvider,
  input: RunNotesInput,
): Promise<RunNotesResult> {
  const raw = new MarkdownVaultRepository(config.vault.path);
  const conversation = await raw.readConversation(input.conversationPath);
  if (conversation.scope === ArchiveScope.Answer) {
    return runTranscriptionNotes(config, llm, input);
  }
  return runReaskNotes(config, llm, input, conversation);
}

/**
 * Legacy transcription path (now only used for `archive_answer` captures):
 * lightly edits the archived assistant turns into a topic note, merging into
 * existing notes when the vault already covers the theme.
 */
async function runTranscriptionNotes(
  config: Config,
  llm: LLMProvider,
  input: RunNotesInput,
): Promise<RunNotesResult> {
  const empty: RunNotesResult = {
    conversationId: input.conversationId,
    notes: [],
    canvases: [],
    committed: false,
  };

  const raw = new MarkdownVaultRepository(config.vault.path);
  const conversation = await raw.readConversation(input.conversationPath);
  const assistantMessages = conversation.messages.filter(
    (m) => m.role === Role.Assistant,
  );
  if (assistantMessages.length === 0) {
    return empty;
  }

  const notesRepo = new NotesRepository(config.vault.path);
  const plan = await planNotes(llm, conversation, notesRepo);
  if (!plan || plan.notes.length === 0) {
    return empty;
  }

  const userQuestions = conversation.messages
    .filter((m) => m.role === Role.User)
    .map((m) => `- ${m.content.trim()}`)
    .join("\n");

  const written: NoteResult[] = [];
  const writtenAbsPaths: string[] = [];
  const canvases: string[] = [];

  for (const entry of plan.notes) {
    const indexes = entry.assistant_indexes.filter(
      (i) => i < assistantMessages.length,
    );
    const groupMessages: Message[] = indexes.length
      ? indexes.map((i) => assistantMessages[i]!)
      : assistantMessages;
    const assistantContent = groupMessages
      .map((m) => m.content.trim())
      .join("\n\n---\n\n");

    // A merge target that doesn't exist (LLM hallucinated the filename)
    // degrades to create.
    const existing =
      entry.action === "merge" && entry.target
        ? await notesRepo
            .read(entry.target)
            .then((note) =>
              note ? { file: entry.target!, note } : undefined,
            )
        : undefined;

    const writeTpl = await loadPrompt("notes-write");
    const body = (
      await llm.complete({
        prompt: render(writeTpl, {
          title: entry.title,
          user_questions: userQuestions,
          assistant_content: assistantContent,
          existing_body: existing?.note.body ?? "",
        }),
        maxTokens: 8192,
      })
    ).trim();
    // "EMPTY" is the prompt's explicit no-content sentinel.
    if (!body || body === "EMPTY") {
      continue;
    }

    const result = await notesRepo.write({
      title: entry.title,
      topics: entry.topics,
      body,
      sourceConversationId: input.conversationId,
      ...(existing ? { existing } : {}),
    });
    written.push({
      file: result.file,
      relativePath: result.relativePath,
      title: entry.title,
      action: existing ? "merge" : "create",
      needsCanvas: entry.needs_canvas,
    });
    writtenAbsPaths.push(result.absolutePath);

    if (entry.needs_canvas) {
      const canvasRel = await writeConceptCanvas(config.vault.path, llm, {
        title: entry.title,
        noteFile: result.file,
        noteBody: body,
      });
      if (canvasRel) {
        canvases.push(canvasRel);
        writtenAbsPaths.push(join(resolve(config.vault.path), canvasRel));
      }
    }
  }

  if (written.length >= 2) {
    const overviewRel = await writeOverviewCanvas(
      config.vault.path,
      input.conversationId,
      written,
    );
    canvases.push(overviewRel);
    writtenAbsPaths.push(join(resolve(config.vault.path), overviewRel));
  }

  let committed = false;
  if (config.git.auto_commit && writtenAbsPaths.length > 0) {
    committed = await autoCommit({
      vaultPath: config.vault.path,
      files: writtenAbsPaths,
      message: commitMessageForNotes(input.conversationId, written, canvases),
    });
    if (committed && config.git.auto_push) {
      const token = resolvePushToken();
      const remoteUrl = resolvePushRemoteUrl();
      await pushVault({
        vaultPath: config.vault.path,
        remote: config.git.push.remote,
        branch: config.git.push.branch,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(token ? { token } : {}),
      });
    }
  }

  return {
    conversationId: input.conversationId,
    notes: written,
    canvases,
    committed,
  };
}

/**
 * Re-ask path (full conversations): take the USER's questions verbatim, group
 * them into topic notes, then re-ask the LLM to ANSWER each group richly —
 * the archived assistant turns are passed only as lossy context hints. Always
 * creates fresh notes (no compare/merge against existing notes).
 */
async function runReaskNotes(
  config: Config,
  llm: LLMProvider,
  input: RunNotesInput,
  conversation: Conversation,
): Promise<RunNotesResult> {
  const empty: RunNotesResult = {
    conversationId: input.conversationId,
    notes: [],
    canvases: [],
    committed: false,
  };

  const userMessages = conversation.messages.filter(
    (m) => m.role === Role.User,
  );
  if (userMessages.length === 0) {
    return empty;
  }

  const numberedQuestions = userMessages
    .map((m, i) => `[#${i}] ${m.content.trim()}`)
    .join("\n\n");
  // The archived assistant turns are summaries; they survive only as hints so
  // the regenerated answer keeps conversation-specific detail.
  const contextSummary = conversation.messages
    .filter((m) => m.role === Role.Assistant)
    .map((m) => m.content.trim())
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");

  const plan = await planReaskNotes(llm, numberedQuestions);
  if (!plan || plan.notes.length === 0) {
    return empty;
  }

  const notesRepo = new NotesRepository(config.vault.path);
  const written: NoteResult[] = [];
  const writtenAbsPaths: string[] = [];
  const canvases: string[] = [];

  const writeTpl = await loadPrompt("notes-reask-write");
  for (const entry of plan.notes) {
    const indexes = entry.question_indexes.filter(
      (i) => i < userMessages.length,
    );
    const groupQuestions = (
      indexes.length ? indexes.map((i) => userMessages[i]!) : userMessages
    )
      .map((m) => `- ${m.content.trim()}`)
      .join("\n");

    let body = (
      await llm.complete({
        prompt: render(writeTpl, {
          title: entry.title,
          questions: groupQuestions,
          context_summary: contextSummary,
        }),
        maxTokens: 16000,
      })
    ).trim();
    // "EMPTY" is the prompt's explicit no-content sentinel.
    if (!body || body === "EMPTY") {
      continue;
    }

    // Build the canvas BEFORE writing the note so we can inject a back-link
    // into the note body. The note filename is deterministic (always create),
    // so writeConceptCanvas embeds the right note and derives a matching slug.
    const noteFile = notesRepo.fileForTitle(entry.title);
    if (entry.needs_canvas) {
      const canvasRel = await writeConceptCanvas(config.vault.path, llm, {
        title: entry.title,
        noteFile,
        noteBody: body,
      });
      if (canvasRel) {
        body = injectCanvasLink(body, canvasRel);
        canvases.push(canvasRel);
        writtenAbsPaths.push(join(resolve(config.vault.path), canvasRel));
      }
    }

    const result = await notesRepo.write({
      title: entry.title,
      topics: entry.topics,
      tags: conversation.tags,
      body,
      sourceConversationId: input.conversationId,
    });
    written.push({
      file: result.file,
      relativePath: result.relativePath,
      title: entry.title,
      action: "create",
      needsCanvas: entry.needs_canvas,
    });
    writtenAbsPaths.push(result.absolutePath);
  }

  if (written.length === 0) {
    return empty;
  }

  if (written.length >= 2) {
    const overviewRel = await writeOverviewCanvas(
      config.vault.path,
      input.conversationId,
      written,
    );
    canvases.push(overviewRel);
    writtenAbsPaths.push(join(resolve(config.vault.path), overviewRel));
  }

  let committed = false;
  if (config.git.auto_commit && writtenAbsPaths.length > 0) {
    committed = await autoCommit({
      vaultPath: config.vault.path,
      files: writtenAbsPaths,
      message: commitMessageForNotes(input.conversationId, written, canvases),
    });
    if (committed && config.git.auto_push) {
      const token = resolvePushToken();
      const remoteUrl = resolvePushRemoteUrl();
      await pushVault({
        vaultPath: config.vault.path,
        remote: config.git.push.remote,
        branch: config.git.push.branch,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(token ? { token } : {}),
      });
    }
  }

  return {
    conversationId: input.conversationId,
    notes: written,
    canvases,
    committed,
  };
}

async function planReaskNotes(
  llm: LLMProvider,
  numberedQuestions: string,
): Promise<NotesReaskPlan | null> {
  const tpl = await loadPrompt("notes-reask-plan");
  const text = await llm.complete({
    prompt: render(tpl, { questions: numberedQuestions }),
    maxTokens: 4096,
  });
  let rawJson: unknown;
  try {
    rawJson = extractJson<unknown>(text);
  } catch {
    return null;
  }
  const parsed = NotesReaskPlanSchema.safeParse(rawJson);
  return parsed.success ? parsed.data : null;
}

/**
 * Inject a link to the concept canvas into the bilingual note body: a Korean
 * `## 다이어그램` section just before the `---` language separator, and an
 * English `## Diagram` section at the end. Falls back to a single appended
 * section when no separator is present.
 */
function injectCanvasLink(body: string, canvasRel: string): string {
  const ko = `## 다이어그램\n\n[[${canvasRel}|개념도]]`;
  const en = `## Diagram\n\n[[${canvasRel}|Concept map]]`;
  const sep = body.search(/^---$/m);
  if (sep !== -1) {
    const before = body.slice(0, sep).trimEnd();
    const after = body.slice(sep).trimEnd();
    return `${before}\n\n${ko}\n\n${after}\n\n${en}\n`;
  }
  return `${body.trimEnd()}\n\n${ko}\n\n${en}\n`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Commit message that says WHAT was distilled: note titles in the subject,
 * per-note create/merge actions and canvases in the body.
 */
function commitMessageForNotes(
  conversationId: string,
  notes: readonly NoteResult[],
  canvases: readonly string[],
): string {
  const subject = truncate(notes.map((n) => n.title).join(", "), 60);
  const lines = [`notes: ${subject}`, ""];
  for (const n of notes) {
    lines.push(`- ${n.action}: ${n.title} (${n.relativePath})`);
  }
  for (const c of canvases) {
    lines.push(`- canvas: ${c}`);
  }
  lines.push(`conversation: ${conversationId}`);
  return lines.join("\n");
}

/** Transcript with assistant turns numbered so the plan can reference them. */
function conversationToNumberedText(conv: Conversation): string {
  let assistantIdx = 0;
  return conv.messages
    .map((m) => {
      if (m.role === Role.Assistant) {
        const tag = `[assistant #${assistantIdx}]`;
        assistantIdx += 1;
        return `${tag} ${m.content}`;
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n\n");
}

async function planNotes(
  llm: LLMProvider,
  conversation: Conversation,
  notesRepo: NotesRepository,
): Promise<NotesPlan | null> {
  const existing = await notesRepo.list();
  const existingText = existing.length
    ? existing
        .map((n) => `${n.file} — ${n.title} [${n.topics.join(", ")}]`)
        .join("\n")
    : "(none)";
  const tpl = await loadPrompt("notes-plan");
  const text = await llm.complete({
    prompt: render(tpl, {
      conversation: conversationToNumberedText(conversation),
      existing_notes: existingText,
    }),
    maxTokens: 4096,
  });
  let rawJson: unknown;
  try {
    rawJson = extractJson<unknown>(text);
  } catch {
    return null;
  }
  const parsed = NotesPlanSchema.safeParse(rawJson);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// JSON Canvas generation (https://jsoncanvas.org/) — server-side layout
// ---------------------------------------------------------------------------

interface CanvasNode {
  id: string;
  type: "file" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  text?: string;
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide: "top" | "right" | "bottom" | "left";
  toSide: "top" | "right" | "bottom" | "left";
  label?: string;
}

const NODE_W = 460;
const NODE_H = 160;
const GAP_Y = 60;
const COL_GAP = 140;
const KIND_COLOR: Record<string, string> = {
  step: "4", // green
  concept: "6", // purple
  example: "3", // yellow
};

async function writeCanvasFile(
  vaultPath: string,
  relativePath: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<void> {
  const abs = join(resolve(vaultPath), relativePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify({ nodes, edges }, null, 2)}\n`, "utf8");
}

/**
 * Concept canvas for a topic the user struggled with: steps flow top-down in
 * the left column, concepts stack in the middle, examples on the right, and
 * the note itself is embedded as a file node alongside.
 */
async function writeConceptCanvas(
  vaultPath: string,
  llm: LLMProvider,
  input: { title: string; noteFile: string; noteBody: string },
): Promise<string | null> {
  const tpl = await loadPrompt("notes-canvas");
  const text = await llm.complete({
    prompt: render(tpl, { title: input.title, note_body: input.noteBody }),
    maxTokens: 4096,
  });
  let rawJson: unknown;
  try {
    rawJson = extractJson<unknown>(text);
  } catch {
    return null;
  }
  const parsed = NotesCanvasSpecSchema.safeParse(rawJson);
  if (!parsed.success || parsed.data.nodes.length === 0) {
    return null;
  }
  const spec: NotesCanvasSpec = parsed.data;

  const columns: Record<string, number> = { step: 0, concept: 1, example: 2 };
  const rowByColumn = [0, 0, 0];
  const placed = new Map<string, CanvasNode>();
  const nodes: CanvasNode[] = [
    {
      id: "note",
      type: "file",
      file: `notes/${input.noteFile}`,
      x: -(NODE_W + COL_GAP + 140),
      y: 0,
      width: 520,
      height: 640,
    },
  ];
  for (const n of spec.nodes) {
    const col = columns[n.kind] ?? 1;
    const node: CanvasNode = {
      id: n.id,
      type: "text",
      text: n.label,
      x: col * (NODE_W + COL_GAP),
      y: rowByColumn[col]! * (NODE_H + GAP_Y),
      width: NODE_W,
      height: NODE_H,
      color: KIND_COLOR[n.kind] ?? KIND_COLOR.concept!,
    };
    rowByColumn[col] = rowByColumn[col]! + 1;
    placed.set(n.id, node);
    nodes.push(node);
  }

  const edges: CanvasEdge[] = [];
  let edgeSeq = 0;
  for (const e of spec.edges) {
    const from = placed.get(e.from);
    const to = placed.get(e.to);
    if (!from || !to) {
      continue; // dangling reference from the LLM — drop the edge
    }
    const sameColumn = from.x === to.x;
    edges.push({
      id: `e${edgeSeq++}`,
      fromNode: from.id,
      toNode: to.id,
      fromSide: sameColumn ? "bottom" : from.x < to.x ? "right" : "left",
      toSide: sameColumn ? "top" : from.x < to.x ? "left" : "right",
      ...(e.label ? { label: e.label } : {}),
    });
  }

  const slug = input.noteFile.replace(/\.md$/, "");
  const rel = join(CANVAS_DIR, `${slug}.canvas`);
  await writeCanvasFile(vaultPath, rel, nodes, edges);
  return rel;
}

/** Overview canvas linking every note touched by one conversation. */
async function writeOverviewCanvas(
  vaultPath: string,
  conversationId: string,
  notes: readonly NoteResult[],
): Promise<string> {
  const nodes: CanvasNode[] = notes.map((n, i) => ({
    id: `note${i}`,
    type: "file",
    file: n.relativePath,
    x: i * (520 + 120),
    y: 0,
    width: 520,
    height: 640,
  }));
  const rel = join(CANVAS_DIR, `${conversationId}.canvas`);
  await writeCanvasFile(vaultPath, rel, nodes, []);
  return rel;
}
