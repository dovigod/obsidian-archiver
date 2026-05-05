import type { Config } from "@core/config";
import type { LLMProvider } from "@core/llm/provider";
import { classifyEntity } from "@core/pipeline/classify";
import {
  type ExecuteProposalRef,
  type ExecuteResult,
  executeDecision,
  loadExistingEntity,
} from "@core/pipeline/execute";
import { extractEntities } from "@core/pipeline/extract";
import { buildClassifyInput } from "@core/pipeline/resolve";
import {
  type ConversationLink,
  type EntitySummary,
  KnowledgeRepository,
} from "@core/repository/knowledge";
import { MarkdownVaultRepository } from "@core/repository/raw";
import type { Conversation } from "@core/schema";

export interface RunPipelineInput {
  conversationId: string;
  /** Vault-relative path to the raw conversation .md. */
  conversationPath: string;
}

export interface RunPipelineEntityResult {
  name: string;
  applied: boolean;
  matched: string | null;
  written: string | null;
  proposals: ExecuteProposalRef[];
}

export interface RunPipelineResult {
  conversationId: string;
  entities: RunPipelineEntityResult[];
}

function conversationLabel(conv: Conversation): string {
  const date = conv.created_at.slice(0, 10);
  const firstUser = conv.messages.find((m) => m.role === "user");
  if (!firstUser) {
    return date;
  }
  const snippet = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 60);
  return snippet ? `${date} — ${snippet}` : date;
}

/**
 * Stage 2 entry point: extract → resolve → classify → execute for one
 * conversation.
 *
 *   1. extract: pull entity candidates from the raw conversation.
 *   2. resolve: build a ClassifyInput per candidate from the existing graph.
 *   3. classify: ask the LLM for a structured ClassifyOutput (with retry +
 *      proposal fallback on schema-validation failure).
 *   4. execute: apply auto-decisions or stage proposals under
 *      `vault/_proposals/`.
 *
 * New entities (auto-applied) are appended to the in-memory graph so later
 * candidates from the same conversation can resolve to them without a fresh
 * disk read.
 */
export async function runStage2Pipeline(
  config: Config,
  llm: LLMProvider,
  input: RunPipelineInput,
): Promise<RunPipelineResult> {
  const raw = new MarkdownVaultRepository(config.vault.path);
  const conversation = await raw.readConversation(input.conversationPath);

  const candidates = await extractEntities(llm, conversation);
  if (candidates.length === 0) {
    return { conversationId: input.conversationId, entities: [] };
  }

  const knowledge = new KnowledgeRepository(config.vault.path);
  const graph: EntitySummary[] = await knowledge.listEntities();

  const link: ConversationLink = {
    id: conversation.id,
    path: input.conversationPath.replace(/\.md$/, ""),
    label: conversationLabel(conversation),
  };

  const entities: RunPipelineEntityResult[] = [];
  for (const candidate of candidates) {
    const classifyInput = buildClassifyInput({
      config,
      newNode: candidate,
      graph,
    });
    const { output, fallbackRaw } = await classifyEntity(llm, classifyInput);

    const existing = await loadExistingEntity(
      config,
      output.decision.is_duplicate_of,
      candidate.name,
      graph,
    );

    const result: ExecuteResult = await executeDecision({
      config,
      llm,
      conversation,
      conversationLink: link,
      newNode: candidate,
      classify: output,
      existing,
      ...(fallbackRaw !== undefined ? { fallbackRaw } : {}),
    });

    if (result.applied && result.entityName) {
      // Refresh the in-memory graph so later candidates in this same run can
      // dedup against the entity we just wrote.
      const summaryIdx = graph.findIndex(
        (g) => g.name === result.entityName,
      );
      const summary: EntitySummary = {
        id: existing?.id ?? "",
        name: result.entityName,
        categories: dedupStrings([
          ...(existing?.categories ?? []),
          ...output.decision.additional_index_names,
          ...(output.decision.primary_parent_name
            ? [output.decision.primary_parent_name]
            : []),
        ]),
        aliases: dedupStrings([
          ...(existing?.aliases ?? []),
          ...candidate.aliases,
          ...output.decision.aliases,
        ]),
        primary_parent_id:
          output.decision.primary_parent_id ||
          existing?.primary_parent_id ||
          null,
        primary_parent_name:
          output.decision.primary_parent_name ||
          existing?.primary_parent_name ||
          null,
        additional_index_ids: dedupStrings([
          ...(existing?.additional_index_ids ?? []),
          ...output.decision.additional_index_ids,
        ]),
        additional_index_names: dedupStrings([
          ...(existing?.additional_index_names ?? []),
          ...output.decision.additional_index_names,
        ]),
      };
      if (summaryIdx >= 0) {
        graph[summaryIdx] = summary;
      } else {
        graph.push(summary);
      }
    }

    entities.push({
      name: result.entityName ?? candidate.name,
      applied: result.applied,
      matched: result.matched,
      written: result.written,
      proposals: result.proposals,
    });
  }

  return { conversationId: input.conversationId, entities };
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
