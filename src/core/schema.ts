import { z } from "zod";
import { AutonomyAction } from "@constants/autonomy-action";
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
// Stage 2: extract → resolve → classify → execute
// ---------------------------------------------------------------------------

/**
 * Output of `pipeline/extract.ts`. One entity candidate pulled from a
 * conversation, fed (one at a time) to `pipeline/resolve.ts` to build the
 * classifier input.
 */
export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractOutputSchema = z.object({
  entities: z.array(ExtractedEntitySchema).default([]),
});
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

// ---- Classify input ------------------------------------------------------

export const NewNodeSchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
});
export type NewNode = z.infer<typeof NewNodeSchema>;

export const CandidateCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().default(""),
  path: z.array(z.string()).default([]),
  sibling_examples: z.array(z.string()).default([]),
  similarity_score: z.number().default(0),
});
export type CandidateCategory = z.infer<typeof CandidateCategorySchema>;

export const CandidateEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().default(""),
  aliases: z.array(z.string()).default([]),
});
export type CandidateEntity = z.infer<typeof CandidateEntitySchema>;

export const NearbyNodeSchema = z.object({
  name: z.string(),
  relation: z.string().default(""),
  summary: z.string().default(""),
});
export type NearbyNode = z.infer<typeof NearbyNodeSchema>;

const AutonomyActionSchema = z.nativeEnum(AutonomyAction);

export const AutonomyPolicySchema = z.object({
  auto_actions: z.array(AutonomyActionSchema),
  proposal_actions: z.array(AutonomyActionSchema),
});
export type AutonomyPolicy = z.infer<typeof AutonomyPolicySchema>;

export const ConfidenceThresholdsSchema = z.object({
  auto_min: z.number().min(0).max(1),
  propose_min: z.number().min(0).max(1),
});
export type ConfidenceThresholds = z.infer<typeof ConfidenceThresholdsSchema>;

export const OntologyHealthSignalsSchema = z.object({
  category_entropy: z.record(z.number()).default({}),
  sibling_coherence: z.record(z.number()).default({}),
  overloaded_categories: z.array(z.string()).default([]),
});
export type OntologyHealthSignals = z.infer<typeof OntologyHealthSignalsSchema>;

export const ClassifyInputSchema = z.object({
  new_node: NewNodeSchema,
  candidate_categories: z.array(CandidateCategorySchema).default([]),
  candidate_entities: z.array(CandidateEntitySchema).default([]),
  nearby_nodes: z.array(NearbyNodeSchema).default([]),
  existing_relations: z
    .array(z.object({}).passthrough())
    .default([]),
  ontology_rules: z.array(z.string()).default([]),
  autonomy_policy: AutonomyPolicySchema,
  confidence_thresholds: ConfidenceThresholdsSchema,
  ontology_health_signals: OntologyHealthSignalsSchema.default({
    category_entropy: {},
    sibling_coherence: {},
    overloaded_categories: [],
  }),
});
export type ClassifyInput = z.infer<typeof ClassifyInputSchema>;

// ---- Classify output -----------------------------------------------------

export const NewCategoryProposalSchema = z.object({
  name: z.string(),
  parent_id: z.string().default(""),
  summary: z.string().default(""),
  rationale: z.string().default(""),
});
export type NewCategoryProposal = z.infer<typeof NewCategoryProposalSchema>;

export const SecondaryRelationSchema = z.object({
  target_id: z.string().default(""),
  target_name: z.string().default(""),
  relation: z.string().default(""),
});
export type SecondaryRelation = z.infer<typeof SecondaryRelationSchema>;

export const RejectedCandidateSchema = z.object({
  candidate_id: z.string().default(""),
  reason: z.string().default(""),
});

export const ClassifyDecisionSchema = z.object({
  is_duplicate_of: z.string().nullable().default(null),
  primary_parent_id: z.string().default(""),
  primary_parent_name: z.string().default(""),
  additional_index_ids: z.array(z.string()).default([]),
  additional_index_names: z.array(z.string()).default([]),
  new_category_proposal: NewCategoryProposalSchema.nullable().default(null),
  aliases: z.array(z.string()).default([]),
  secondary_relations: z.array(SecondaryRelationSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
});
export type ClassifyDecision = z.infer<typeof ClassifyDecisionSchema>;

export const ClassifyReasoningSchema = z.object({
  semantic_fit: z.string().default(""),
  sibling_analysis: z.string().default(""),
  rejected_candidates: z.array(RejectedCandidateSchema).default([]),
  ontology_considerations: z.string().default(""),
});
export type ClassifyReasoning = z.infer<typeof ClassifyReasoningSchema>;

export const RebalancingActionSchema = z.object({
  type: z.enum([
    "move",
    "split",
    "merge",
    "rename",
    "create_category",
    "delete_page",
  ]),
  target_id: z.string().default(""),
  details: z.string().default(""),
});
export type RebalancingAction = z.infer<typeof RebalancingActionSchema>;

export const RebalancingSchema = z.object({
  needed: z.boolean().default(false),
  reasons: z.array(z.string()).default([]),
  actions: z.array(RebalancingActionSchema).default([]),
});
export type Rebalancing = z.infer<typeof RebalancingSchema>;

export const ClassifyModeSchema = z.enum(["auto", "proposal"]);
export type ClassifyMode = z.infer<typeof ClassifyModeSchema>;

export const ClassifyOutputSchema = z.object({
  decision: ClassifyDecisionSchema,
  mode: ClassifyModeSchema,
  reasoning: ClassifyReasoningSchema.default({
    semantic_fit: "",
    sibling_analysis: "",
    rejected_candidates: [],
    ontology_considerations: "",
  }),
  rebalancing: RebalancingSchema.default({
    needed: false,
    reasons: [],
    actions: [],
  }),
  warnings: z.array(z.string()).default([]),
});
export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

// ---- Proposal records ----------------------------------------------------

export const ProposalKindSchema = z.enum([
  "classification",
  "rebalancing",
  "new_category",
  "raw_invalid",
]);
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
