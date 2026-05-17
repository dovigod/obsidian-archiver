import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CaptureMode } from "@constants/capture-mode";
import { ExecutionMode } from "@constants/execution-mode";
import { IdStrategy } from "@constants/id-strategy";
import { LLMProvider } from "@constants/llm-provider";
import { PageUpdateStrategy } from "@constants/page-update-strategy";

export const ConfigSchema = z.object({
  vault: z.object({
    path: z.string().min(1),
  }),
  storage: z
    .object({
      sqlite: z
        .object({
          path: z.string().default(".kh.db"),
          journal_mode: z
            .enum(["WAL", "DELETE", "MEMORY"])
            .default("WAL"),
          busy_timeout_ms: z.number().int().positive().default(5000),
          synchronous: z.enum(["OFF", "NORMAL", "FULL"]).default("NORMAL"),
        })
        .default({
          path: ".kh.db",
          journal_mode: "WAL",
          busy_timeout_ms: 5000,
          synchronous: "NORMAL",
        }),
    })
    .default({
      sqlite: {
        path: ".kh.db",
        journal_mode: "WAL",
        busy_timeout_ms: 5000,
        synchronous: "NORMAL",
      },
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
  extract: z
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
  dedup: z
    .object({
      exact: z
        .array(z.enum(["name", "aliases"]))
        .default(["name", "aliases"]),
      fuzzy: z
        .object({
          engine: z.literal("fts5").default("fts5"),
          min_score: z.number().default(0.6),
          top_k: z.number().int().positive().default(3),
          llm_confirm: z.boolean().default(true),
          embeddings: z
            .object({
              enabled: z.boolean().default(false),
              provider: z.enum(["mock", "openai"]).default("openai"),
              model: z.string().default("text-embedding-3-small"),
              api_key_env: z.string().default("OPENAI_API_KEY"),
              top_k: z.number().int().positive().default(5),
              min_cosine: z.number().default(0.78),
            })
            .default({
              enabled: false,
              provider: "openai",
              model: "text-embedding-3-small",
              api_key_env: "OPENAI_API_KEY",
              top_k: 5,
              min_cosine: 0.78,
            }),
        })
        .default({
          engine: "fts5",
          min_score: 0.6,
          top_k: 3,
          llm_confirm: true,
          embeddings: {
            enabled: false,
            provider: "openai",
            model: "text-embedding-3-small",
            api_key_env: "OPENAI_API_KEY",
            top_k: 5,
            min_cosine: 0.78,
          },
        }),
    })
    .default({
      exact: ["name", "aliases"],
      fuzzy: {
        engine: "fts5",
        min_score: 0.6,
        top_k: 3,
        llm_confirm: true,
        embeddings: {
          enabled: false,
          provider: "openai",
          model: "text-embedding-3-small",
          api_key_env: "OPENAI_API_KEY",
          top_k: 5,
          min_cosine: 0.78,
        },
      },
    }),
  page_update_strategy: z
    .nativeEnum(PageUpdateStrategy)
    .default(PageUpdateStrategy.LLMRewrite),
  sync: z
    .object({
      mode: z.enum(["auto", "manual"]).default("auto"),
      auto: z
        .object({
          strategy: z.enum(["eager", "debounced"]).default("eager"),
          debounce_ms: z.number().int().nonnegative().default(2000),
        })
        .default({ strategy: "eager", debounce_ms: 2000 }),
      drift: z
        .object({
          detect: z.boolean().default(true),
          stage_under: z.string().default("_proposals/manual_edit"),
        })
        .default({ detect: true, stage_under: "_proposals/manual_edit" }),
    })
    .default({
      mode: "auto",
      auto: { strategy: "eager", debounce_ms: 2000 },
      drift: { detect: true, stage_under: "_proposals/manual_edit" },
    }),
  git: z
    .object({
      auto_commit: z.boolean().default(true),
      commit_per_render: z.boolean().default(true),
    })
    .default({ auto_commit: true, commit_per_render: true }),
  ids: z
    .object({
      strategy: z.nativeEnum(IdStrategy).default(IdStrategy.UuidV7),
    })
    .default({ strategy: IdStrategy.UuidV7 }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PartialConfig = z.input<typeof ConfigSchema>;

export const GLOBAL_CONFIG_PATH = join(homedir(), ".knowledge-hub", "config.json");
export const PROJECT_CONFIG_REL = join(".knowledge-hub", "config.json");

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
    const firstRunHint =
      globalRaw === undefined && projectRaw === undefined
        ? "\n\nNo config file was found. Run `kh setup` for an interactive first-time setup,\nor create one of the searched files manually."
        : "";
    throw new Error(
      `Invalid knowledge-hub config:\n  ${issues}\n\nSearched:\n  global=${GLOBAL_CONFIG_PATH}\n  project=${join(projectRoot, PROJECT_CONFIG_REL)}${firstRunHint}`,
    );
  }
  return parsed.data;
}
