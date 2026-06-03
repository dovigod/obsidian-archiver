import { z } from "zod";
import { ArchiveScope } from "@constants/archive-scope";
import { Fidelity } from "@constants/fidelity";
import { Role } from "@constants/role";
import { Source } from "@constants/source";

export { ArchiveScope, Fidelity, Role, Source };

export const ArchiveScopeSchema = z.nativeEnum(ArchiveScope);

export const FidelitySchema = z.nativeEnum(Fidelity);

export const SourceSchema = z.nativeEnum(Source);

export const RoleSchema = z.nativeEnum(Role);

export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  timestamp: z.string().datetime().optional(),
  name: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const GitContextSchema = z
  .object({
    repo: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
  })
  .partial();
export type GitContext = z.infer<typeof GitContextSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  model: z.string().optional(),
  created_at: z.string().datetime(),
  cwd: z.string().optional(),
  project: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  conversation_type: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  git: GitContextSchema.optional(),
  messages: z.array(MessageSchema).min(1),
  /** Triggering user phrase that caused this conversation to be archived. */
  intent: z.string().optional(),
  /** One-or-two-sentence TL;DR rendered above the verbatim transcript. */
  summary: z.string().optional(),
  /** Bulleted highlights rendered between TL;DR and Entities. */
  takeaways: z.array(z.string()).optional(),
  /** Bare entity names; renderer wraps them as `[[Wikilinks]]`. */
  entities: z.array(z.string()).optional(),
  /** Follow-up questions a reader might want to ask after the conversation. */
  related_questions: z.array(z.string()).optional(),
  /**
   * True when the transcript is best-effort rather than complete — e.g. a
   * remote caller (ChatGPT) whose context no longer holds the full original
   * text. A later lossless import (official export backfill) may supersede
   * this record.
   */
  partial: z.boolean().optional(),
  /**
   * What slice of the source conversation this record holds. Omitted (or
   * `full`) = the whole conversation; `answer` = a single Q&A excerpt
   * captured via the `archive_answer` MCP tool.
   */
  scope: ArchiveScopeSchema.optional(),
  /**
   * Transcript fidelity. Omitted (or `verbatim`) = original text. The HTTP
   * MCP server stamps `summarized` on every capture because remote models
   * (observed: ChatGPT) compress their own turns when serializing the
   * conversation into tool arguments — the lossless original lives in the
   * platform's official data export.
   */
  fidelity: FidelitySchema.optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ArchiveInputSchema = z.object({
  source: SourceSchema,
  model: z.string().optional(),
  created_at: z.string().datetime().optional(),
  cwd: z.string().optional(),
  project: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  conversation_type: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  git: GitContextSchema.optional(),
  messages: z.array(MessageSchema).min(1),
  metadata: z.record(z.unknown()).optional(),
  /** Triggering user phrase (e.g. "sync to kh"). Promoted to frontmatter. */
  intent: z.string().optional(),
  /** Caller could not reconstruct the complete transcript; archive best-effort. */
  partial: z.boolean().optional(),
  /** `answer` when the payload is a single Q&A excerpt, not a full transcript. */
  scope: ArchiveScopeSchema.optional(),
  /** `summarized` when the transcript content is model-compressed, not original. */
  fidelity: FidelitySchema.optional(),
});
export type ArchiveInput = z.infer<typeof ArchiveInputSchema>;

// ---------------------------------------------------------------------------
// Stage 2 pipeline: extract → dedup → rewrite → render
// ---------------------------------------------------------------------------

/**
 * One entity candidate pulled from a conversation by the extract LLM call.
 * `draft_body` is the initial markdown body used when the entity is new
 * (rewrite is skipped on first creation); when an existing match is found,
 * the rewrite step integrates the new conversation excerpt instead.
 */
export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  draft_body: z.string().default(""),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractOutputSchema = z.object({
  entities: z.array(ExtractedEntitySchema).default([]),
});
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

/**
 * Candidate passed to the dedup-confirm LLM call when FTS5 returns at least
 * one fuzzy hit above the configured `min_score` threshold.
 */
export const DedupCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().default(""),
  aliases: z.array(z.string()).default([]),
});
export type DedupCandidate = z.infer<typeof DedupCandidateSchema>;

export const DedupInputSchema = z.object({
  new_node: z.object({
    name: z.string(),
    summary: z.string().default(""),
    aliases: z.array(z.string()).default([]),
  }),
  candidates: z.array(DedupCandidateSchema).default([]),
});
export type DedupInput = z.infer<typeof DedupInputSchema>;

export const DedupOutputSchema = z.object({
  /** Existing entity id this new node refers to; null when it's distinct. */
  match_id: z.string().nullable().default(null),
});
export type DedupOutput = z.infer<typeof DedupOutputSchema>;

/**
 * Result of one extract → dedup decision. Drives the executor.
 */
export type DedupResult =
  | { kind: "match"; entityId: string; matchedTerm?: string }
  | { kind: "new" };

// ---------------------------------------------------------------------------
// Stage 2 notes pipeline: plan → write → (canvas)
// ---------------------------------------------------------------------------

/**
 * One topic-note decision from the notes-plan LLM call. Topics are grouped
 * from the USER's questions; similar themes must be merged into one group
 * (the prompt forbids over-splitting). `action: "merge"` targets an existing
 * `notes/{target}` file; `needs_canvas` is true when the user's questions
 * showed they struggled with the topic (re-asking, "explain it simply", …)
 * OR the content explains an overall flow/process/architecture.
 */
export const NotesPlanEntrySchema = z.object({
  action: z.enum(["create", "merge"]),
  /** Existing note filename (e.g. "Bitcoin_Transactions.md") when merging. */
  target: z.string().optional(),
  title: z.string().min(1),
  topics: z.array(z.string()).default([]),
  /** 0-based indexes into the conversation's assistant messages. */
  assistant_indexes: z.array(z.number().int().nonnegative()).default([]),
  needs_canvas: z.boolean().default(false),
});
export type NotesPlanEntry = z.infer<typeof NotesPlanEntrySchema>;

export const NotesPlanSchema = z.object({
  notes: z.array(NotesPlanEntrySchema).default([]),
});
export type NotesPlan = z.infer<typeof NotesPlanSchema>;

/**
 * Concept-graph spec the notes-canvas LLM call returns for a topic the user
 * struggled with. The server lays the nodes out into a JSON Canvas file —
 * the LLM never emits raw .canvas coordinates.
 */
export const NotesCanvasSpecSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        kind: z.enum(["concept", "step", "example"]).default("concept"),
      }),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().optional(),
      }),
    )
    .default([]),
});
export type NotesCanvasSpec = z.infer<typeof NotesCanvasSpecSchema>;

// ---- Proposal records (file-based; no DB table) --------------------------

/**
 * Only two flavors of proposal survive in the SQLite design: `raw_invalid`
 * (LLM output that failed zod validation) and `manual_edit` (drift-staged
 * user edits). Both live under `vault/_proposals/` as md/JSON files.
 */
export const ProposalKindSchema = z.enum(["raw_invalid", "manual_edit"]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const ProposalRecordSchema = z.object({
  id: z.string(),
  kind: ProposalKindSchema,
  created_at: z.string().datetime(),
  conversation_id: z.string().default(""),
  entity_name: z.string().default(""),
  /** Free-form payload — shape depends on kind. */
  payload: z.record(z.unknown()),
});
export type ProposalRecord = z.infer<typeof ProposalRecordSchema>;
