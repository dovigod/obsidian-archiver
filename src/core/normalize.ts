import { newId } from "@core/ids";
import {
  type ArchiveInput,
  ArchiveScope,
  type Conversation,
  ConversationSchema,
  Fidelity,
} from "@core/schema";

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  if (!values) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || seen.has(v)) {
      continue;
    }
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function normalizeArchiveInput(input: ArchiveInput): Conversation {
  const intent = input.intent?.trim() || undefined;
  const conv: Conversation = ConversationSchema.parse({
    id: newId(),
    source: input.source,
    model: input.model,
    created_at: input.created_at ?? new Date().toISOString(),
    cwd: input.cwd,
    project: uniqueNonEmpty(input.project),
    topics: uniqueNonEmpty(input.topics),
    conversation_type: uniqueNonEmpty(input.conversation_type),
    tags: uniqueNonEmpty(input.tags),
    git: input.git,
    messages: input.messages,
    ...(intent ? { intent } : {}),
    ...(input.partial ? { partial: true } : {}),
    // Only persist the non-default scope, same as `partial`.
    ...(input.scope === ArchiveScope.Answer
      ? { scope: ArchiveScope.Answer }
      : {}),
    // Only persist the non-default fidelity (verbatim is implied).
    ...(input.fidelity === Fidelity.Summarized
      ? { fidelity: Fidelity.Summarized }
      : {}),
  });
  return conv;
}
