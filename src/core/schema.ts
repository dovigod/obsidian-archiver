import { z } from "zod";
import { Role } from "@constants/role";
import { Source } from "@constants/source";

export { Role, Source };

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
