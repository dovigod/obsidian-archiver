import { eq, sql } from "drizzle-orm";
import type { DB } from "@core/db/client";
import { conversations, type ConversationRow } from "@core/db/schema";

export interface CreateConversationInput {
  id: string;
  source: string;
  model?: string;
  /** Epoch ms. */
  createdAt: number;
  project?: readonly string[];
  topics?: readonly string[];
  conversationType?: readonly string[];
  tags?: readonly string[];
  git?: { repo?: string; branch?: string; commit?: string };
  cwd?: string;
  rawPath: string;
}

export class ConversationsRepository {
  constructor(private readonly db: DB) {}

  create(input: CreateConversationInput): ConversationRow {
    return this.db
      .insert(conversations)
      .values({
        id: input.id,
        source: input.source,
        model: input.model ?? null,
        createdAt: input.createdAt,
        projectJson: JSON.stringify(input.project ?? []),
        topicsJson: JSON.stringify(input.topics ?? []),
        conversationTypeJson: JSON.stringify(input.conversationType ?? []),
        tagsJson: JSON.stringify(input.tags ?? []),
        gitRepo: input.git?.repo ?? null,
        gitBranch: input.git?.branch ?? null,
        gitCommit: input.git?.commit ?? null,
        cwd: input.cwd ?? null,
        rawPath: input.rawPath,
      })
      .returning()
      .get();
  }

  findById(id: string): ConversationRow | undefined {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
  }

  exists(id: string): boolean {
    const row = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
    return row !== undefined;
  }

  listAllIds(): string[] {
    const rows = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .all();
    return rows.map((r) => r.id);
  }

  count(): number {
    const row = this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(conversations)
      .get();
    return row?.c ?? 0;
  }
}
