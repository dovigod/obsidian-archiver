import type { Config } from "@core/config";
import { autoCommit } from "@core/git";
import { newId } from "@core/ids";
import type { LLMProvider } from "@core/llm/provider";
import { synthesizeEntityBody } from "@core/pipeline/synthesize";
import {
  type ConversationLink,
  type EntityPage,
  type EntitySummary,
  KnowledgeRepository,
} from "@core/repository/knowledge";
import { ProposalRepository } from "@core/repository/proposals";
import type {
  ClassifyOutput,
  Conversation,
  ExtractedEntity,
  ProposalKind,
  ProposalRecord,
} from "@core/schema";

export interface ExecuteArgs {
  config: Config;
  llm: LLMProvider;
  conversation: Conversation;
  conversationLink: ConversationLink;
  newNode: ExtractedEntity;
  classify: ClassifyOutput;
  /**
   * The pre-existing entity matching `is_duplicate_of` (when set) or the
   * `new_node.name` slot. Read by the caller so the executor stays free of
   * filesystem I/O for the lookup itself.
   */
  existing: EntityPage | null;
  /**
   * Set when both classifier responses failed schema validation. The caller
   * stages a `raw_invalid` proposal carrying this text so a human can review
   * what the model actually returned.
   */
  fallbackRaw?: string;
}

export interface ExecuteProposalRef {
  kind: ProposalKind;
  relativePath: string;
}

export interface ExecuteResult {
  /** True iff an entity page was created or rewritten. */
  applied: boolean;
  /** Canonical entity name written, or `null` for proposal-only outcomes. */
  entityName: string | null;
  /** Vault-relative path of the written entity, or null. */
  written: string | null;
  /** When deduped, the existing entity name we merged into. */
  matched: string | null;
  proposals: ExecuteProposalRef[];
}

function dedupStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of items) {
    const t = v.trim();
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

function dedupSources(items: readonly ConversationLink[]): ConversationLink[] {
  const seen = new Set<string>();
  const out: ConversationLink[] = [];
  for (const link of items) {
    if (seen.has(link.id)) {
      continue;
    }
    seen.add(link.id);
    out.push(link);
  }
  return out;
}

function unionedCategories(page: EntityPage): string[] {
  const all = [
    ...(page.primary_parent_name ? [page.primary_parent_name] : []),
    ...page.additional_index_names,
  ];
  return dedupStrings(all);
}

/**
 * Apply or stage one classifier decision. Side-effects (entity write, git
 * commit, proposal staging) are gated by `mode` and the global autonomy
 * config. Pure ordering — no recursion into other entities.
 */
export async function executeDecision(
  args: ExecuteArgs,
): Promise<ExecuteResult> {
  const proposals: ExecuteProposalRef[] = [];
  const proposalRepo = new ProposalRepository(args.config.vault.path);
  const knowledge = new KnowledgeRepository(args.config.vault.path);

  // Always stage raw-invalid first so the artifact is preserved even if
  // downstream apply/proposal staging fails.
  if (args.fallbackRaw !== undefined) {
    proposals.push(
      await stageProposal(proposalRepo, "raw_invalid", {
        conversationId: args.conversation.id,
        entityName: args.newNode.name,
        payload: {
          raw_text: args.fallbackRaw,
          new_node: args.newNode,
        },
      }),
    );
  }

  // Always stage new_category_proposal and rebalancing.actions independently
  // of mode — per design.md these are *always* proposals.
  if (args.classify.decision.new_category_proposal) {
    proposals.push(
      await stageProposal(proposalRepo, "new_category", {
        conversationId: args.conversation.id,
        entityName: args.newNode.name,
        payload: {
          proposal: args.classify.decision.new_category_proposal,
          source_classification: args.classify,
        },
      }),
    );
  }
  if (args.classify.rebalancing.actions.length > 0) {
    proposals.push(
      await stageProposal(proposalRepo, "rebalancing", {
        conversationId: args.conversation.id,
        entityName: args.newNode.name,
        payload: {
          rebalancing: args.classify.rebalancing,
          source_classification: args.classify,
        },
      }),
    );
  }

  if (args.classify.mode === "proposal") {
    proposals.push(
      await stageProposal(proposalRepo, "classification", {
        conversationId: args.conversation.id,
        entityName: args.newNode.name,
        payload: {
          new_node: args.newNode,
          classification: args.classify,
        },
      }),
    );
    return {
      applied: false,
      entityName: null,
      written: null,
      matched: null,
      proposals,
    };
  }

  // mode === "auto" → write/update the entity page.
  const decision = args.classify.decision;
  const targetName = decision.is_duplicate_of ?? args.newNode.name;
  const existing = args.existing;

  const newBody = await synthesizeEntityBody(args.llm, {
    entityName: targetName,
    summary: args.newNode.summary,
    existing,
    conversation: args.conversation,
  });

  const aliases = dedupStrings([
    ...(existing?.aliases ?? []),
    ...args.newNode.aliases,
    ...decision.aliases,
  ]);

  const additional_index_ids = dedupStrings([
    ...(existing?.additional_index_ids ?? []),
    ...decision.additional_index_ids,
  ]);
  const additional_index_names = dedupStrings([
    ...(existing?.additional_index_names ?? []),
    ...decision.additional_index_names,
  ]);

  const primary_parent_id =
    decision.primary_parent_id || existing?.primary_parent_id || null;
  const primary_parent_name =
    decision.primary_parent_name || existing?.primary_parent_name || null;

  const updated: EntityPage = {
    id: existing?.id ?? newId(),
    name: targetName,
    aliases,
    primary_parent_id,
    primary_parent_name,
    additional_index_ids,
    additional_index_names,
    categories: dedupStrings([
      ...(existing?.categories ?? []),
      ...(primary_parent_name ? [primary_parent_name] : []),
      ...additional_index_names,
    ]),
    sources: dedupSources([...(existing?.sources ?? []), args.conversationLink]),
    updated_at: new Date().toISOString(),
    body: newBody,
  };
  // Re-derive categories from the canonical fields to stay consistent on rewrite.
  updated.categories = unionedCategories(updated);

  const { absolutePath, relativePath } = await knowledge.writeEntity(updated);
  if (args.config.git.auto_commit) {
    await autoCommit({
      vaultPath: args.config.vault.path,
      files: [absolutePath],
      message: `synthesize(${updated.name}): +${args.conversation.id.slice(0, 8)}`,
    });
  }

  return {
    applied: true,
    entityName: updated.name,
    written: relativePath,
    matched: decision.is_duplicate_of,
    proposals,
  };
}

interface StageProposalArgs {
  conversationId: string;
  entityName: string;
  payload: Record<string, unknown>;
}

async function stageProposal(
  repo: ProposalRepository,
  kind: ProposalKind,
  args: StageProposalArgs,
): Promise<ExecuteProposalRef> {
  const record: ProposalRecord = {
    id: newId(),
    kind,
    created_at: new Date().toISOString(),
    conversation_id: args.conversationId,
    entity_name: args.entityName,
    payload: args.payload,
  };
  const { relativePath } = await repo.write(record);
  return { kind, relativePath };
}

/**
 * Look up the entity page the executor will potentially merge into.
 *
 * Resolution order:
 *   1. `decision.is_duplicate_of` — explicit dedup target named by the LLM.
 *   2. `new_node.name` — same-name match against the canonical filename.
 *
 * Pulled into its own helper so `run.ts` can pass it as `existing` without
 * the executor having to read the filesystem itself.
 */
export async function loadExistingEntity(
  config: Config,
  decisionDuplicateOf: string | null,
  newNodeName: string,
  graph: readonly EntitySummary[],
): Promise<EntityPage | null> {
  const knowledge = new KnowledgeRepository(config.vault.path);
  if (decisionDuplicateOf) {
    const direct = await knowledge.readEntity(decisionDuplicateOf);
    if (direct) {
      return direct;
    }
    // is_duplicate_of may name an entity by id rather than canonical name.
    const byId = graph.find(
      (e) => e.id === decisionDuplicateOf || e.name === decisionDuplicateOf,
    );
    if (byId) {
      return knowledge.readEntity(byId.name);
    }
  }
  return knowledge.readEntity(newNodeName);
}
