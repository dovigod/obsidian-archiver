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
