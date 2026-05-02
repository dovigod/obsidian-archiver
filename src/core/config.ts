import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AutonomyAction } from "@constants/autonomy-action";
import { AutonomyMode } from "@constants/autonomy-mode";
import { CaptureMode } from "@constants/capture-mode";
import { EntityResolutionMethod } from "@constants/entity-resolution-method";
import { ExecutionMode } from "@constants/execution-mode";
import { IdStrategy } from "@constants/id-strategy";
import { LLMProvider } from "@constants/llm-provider";
import { PageUpdateStrategy } from "@constants/page-update-strategy";

const AutonomyActionSchema = z.nativeEnum(AutonomyAction);

export const ConfigSchema = z.object({
  vault: z.object({
    path: z.string().min(1),
  }),
  capture: z
    .object({
      mode: z.nativeEnum(CaptureMode).default(CaptureMode.Auto),
      sources: z
        .object({
          claude_code: z.boolean().default(true),
        })
        .default({ claude_code: true }),
    })
    .default({
      mode: CaptureMode.Auto,
      sources: { claude_code: true },
    }),
  classification: z
    .object({
      enabled: z.boolean().default(true),
      execution: z.nativeEnum(ExecutionMode).default(ExecutionMode.Async),
      llm: z
        .object({
          provider: z.nativeEnum(LLMProvider).default(LLMProvider.Claude),
          model: z.string().default("claude-opus-4-7"),
          api_key_env: z.string().default("ANTHROPIC_API_KEY"),
        })
        .default({
          provider: LLMProvider.Claude,
          model: "claude-opus-4-7",
          api_key_env: "ANTHROPIC_API_KEY",
        }),
    })
    .default({
      enabled: true,
      execution: ExecutionMode.Async,
      llm: {
        provider: LLMProvider.Claude,
        model: "claude-opus-4-7",
        api_key_env: "ANTHROPIC_API_KEY",
      },
    }),
  page_update_strategy: z
    .nativeEnum(PageUpdateStrategy)
    .default(PageUpdateStrategy.LLMRewrite),
  autonomy: z
    .object({
      mode: z.nativeEnum(AutonomyMode).default(AutonomyMode.Hybrid),
      auto_actions: z
        .array(AutonomyActionSchema)
        .default([
          AutonomyAction.CreateEntity,
          AutonomyAction.UpdateEntity,
          AutonomyAction.AddToIndex,
        ]),
      proposal_actions: z
        .array(AutonomyActionSchema)
        .default([
          AutonomyAction.SplitCategory,
          AutonomyAction.MergeEntities,
          AutonomyAction.RenameEntity,
          AutonomyAction.DeletePage,
        ]),
    })
    .default({
      mode: AutonomyMode.Hybrid,
      auto_actions: [
        AutonomyAction.CreateEntity,
        AutonomyAction.UpdateEntity,
        AutonomyAction.AddToIndex,
      ],
      proposal_actions: [
        AutonomyAction.SplitCategory,
        AutonomyAction.MergeEntities,
        AutonomyAction.RenameEntity,
        AutonomyAction.DeletePage,
      ],
    }),
  entity_resolution: z
    .object({
      method: z
        .nativeEnum(EntityResolutionMethod)
        .default(EntityResolutionMethod.LLM),
      graph_max_entities: z.number().int().positive().default(500),
    })
    .default({
      method: EntityResolutionMethod.LLM,
      graph_max_entities: 500,
    }),
  views: z
    .object({
      canvases: z
        .object({
          per_category: z.boolean().default(true),
          per_entity: z.boolean().default(true),
          global_graph: z.boolean().default(true),
        })
        .default({ per_category: true, per_entity: true, global_graph: true }),
      bases: z
        .object({
          entity_catalog: z.boolean().default(true),
        })
        .default({ entity_catalog: true }),
    })
    .default({
      canvases: { per_category: true, per_entity: true, global_graph: true },
      bases: { entity_catalog: true },
    }),
  git: z.object({ auto_commit: z.boolean().default(true) }).default({
    auto_commit: true,
  }),
  ids: z
    .object({
      strategy: z.nativeEnum(IdStrategy).default(IdStrategy.UuidV7),
    })
    .default({ strategy: IdStrategy.UuidV7 }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PartialConfig = z.input<typeof ConfigSchema>;

const GLOBAL_CONFIG_PATH = join(homedir(), ".knowledge-hub", "config.json");
const PROJECT_CONFIG_REL = join(".knowledge-hub", "config.json");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) {
    return base;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export interface LoadConfigOptions {
  /** Project root to search for `.knowledge-hub/config.json`. Defaults to cwd. */
  projectRoot?: string;
  /** Optional override that wins over both global and project config. */
  overrides?: PartialConfig;
  /** When set, skip reading `~/.knowledge-hub/config.json`. */
  skipGlobal?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : process.cwd();
  const globalRaw = options.skipGlobal
    ? undefined
    : readJsonIfExists(GLOBAL_CONFIG_PATH);
  const projectRaw = readJsonIfExists(join(projectRoot, PROJECT_CONFIG_REL));

  const merged = deepMerge(
    deepMerge(globalRaw ?? {}, projectRaw ?? {}),
    options.overrides ?? {},
  );

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n  ");
    throw new Error(
      `Invalid knowledge-hub config:\n  ${issues}\n\nSearched:\n  global=${GLOBAL_CONFIG_PATH}\n  project=${join(projectRoot, PROJECT_CONFIG_REL)}`,
    );
  }
  return parsed.data;
}
