import type { Config } from "@core/config";
import { autoCommit } from "@core/git";
import { newId } from "@core/ids";
import type { LLMProvider } from "@core/llm/provider";
import { classifyConversation } from "@core/pipeline/classify";
import {
  type KnowledgeGraphEntry,
  resolveEntity,
} from "@core/pipeline/resolve";
import { synthesizeEntityBody } from "@core/pipeline/synthesize";
import {
  type ConversationLink,
  type EntityPage,
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
  matched: string | null;
  written: string;
}

export interface RunPipelineResult {
  conversationId: string;
  entities: RunPipelineEntityResult[];
}

function dedup<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(it);
  }
  return out;
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
 * Stage 2 entry point: classify → resolve → synthesize for one conversation.
 *
 * Each candidate entity from the conversation produces (or merges into) a
 * canonical entity page under `vault/knowledge/`. New entity pages discovered
 * during this run are added to the in-memory graph so subsequent candidates in
 * the same conversation can resolve to them without re-reading the vault.
 */
export async function runStage2Pipeline(
  config: Config,
  llm: LLMProvider,
  input: RunPipelineInput,
): Promise<RunPipelineResult> {
  const raw = new MarkdownVaultRepository(config.vault.path);
  const conversation = await raw.readConversation(input.conversationPath);

  const candidates = await classifyConversation(llm, conversation);
  if (candidates.length === 0) {
    return { conversationId: input.conversationId, entities: [] };
  }

  const knowledge = new KnowledgeRepository(config.vault.path);
  const graph: KnowledgeGraphEntry[] = await knowledge.listEntities();

  const link: ConversationLink = {
    id: conversation.id,
    path: input.conversationPath.replace(/\.md$/, ""),
    label: conversationLabel(conversation),
  };

  const entities: RunPipelineEntityResult[] = [];
  for (const candidate of candidates) {
    const resolution = await resolveEntity(llm, candidate, graph);
    const targetName = resolution.match ?? candidate.name;
    const existing = resolution.match
      ? await knowledge.readEntity(resolution.match)
      : null;

    const newBody = await synthesizeEntityBody(llm, {
      entityName: targetName,
      candidate,
      existing,
      conversation,
    });

    const updated: EntityPage = {
      id: existing?.id ?? newId(),
      name: targetName,
      categories: dedup(
        [...(existing?.categories ?? []), ...candidate.categories],
        (c) => c,
      ),
      sources: dedup(
        [...(existing?.sources ?? []), link],
        (s) => s.id,
      ),
      updated_at: new Date().toISOString(),
      body: newBody,
    };

    const { absolutePath } = await knowledge.writeEntity(updated);
    if (config.git.auto_commit) {
      await autoCommit({
        vaultPath: config.vault.path,
        files: [absolutePath],
        message: `synthesize(${updated.name}): +${conversation.id.slice(0, 8)}`,
      });
    }

    if (!resolution.match) {
      graph.push({ name: updated.name, categories: updated.categories });
    }

    entities.push({
      name: updated.name,
      matched: resolution.match,
      written: absolutePath,
    });
  }

  return { conversationId: input.conversationId, entities };
}
