#!/usr/bin/env node
import { join } from "node:path";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { createDb } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { EntitiesRepository } from "@core/db/repository/entities";
import { JobsRepository } from "@core/db/repository/jobs";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import { reconcile } from "@core/pipeline/reconcile";
import { renderDirty } from "@core/pipeline/render";
import {
  parseTranscriptFile,
  transcriptToArchiveInput,
} from "@core/transcript";
import { runWorker } from "@core/worker";

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  options: Record<string, string | string[] | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        addOption(options, key, arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          addOption(options, key, next);
          i++;
        } else {
          options[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, options };
}

function addOption(
  options: Record<string, string | string[] | boolean>,
  key: string,
  value: string,
): void {
  const existing = options[key];
  if (existing === undefined || existing === true) {
    options[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    options[key] = [existing as string, value];
  }
}

function asArray(value: string | string[] | boolean | undefined): string[] {
  if (value === undefined || value === true || value === false) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asString(
  value: string | string[] | boolean | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function printUsage(): void {
  process.stdout.write(
    [
      "knowledge-hub CLI",
      "",
      "Usage:",
      "  kh archive-transcript <transcript.jsonl> [--project NAME]... [--tag TAG]...",
      "                                          [--topic TOPIC]... [--vault PATH]",
      "  kh worker [--once] [--poll-ms MS]",
      "  kh sync [--dry-run]",
      "  kh reconcile",
      "  kh status",
      "  kh --help",
      "",
      "Subcommands:",
      "  archive-transcript   Archive a Claude Code JSONL transcript into the vault (Stage 1).",
      "  worker               Drain the Stage 2 extract queue. Long-running.",
      "  sync                 Render all dirty entities to markdown.",
      "  reconcile            Rebuild missing conversations rows from raw md.",
      "  status               Show queue depth and dirty entity count.",
      "",
    ].join("\n"),
  );
}

function openDbFromConfig() {
  const config = loadConfig();
  const { db, sqlite } = createDb({
    path: join(config.vault.path, config.storage.sqlite.path),
    journalMode: config.storage.sqlite.journal_mode,
    busyTimeoutMs: config.storage.sqlite.busy_timeout_ms,
    synchronous: config.storage.sqlite.synchronous,
    migrate: true,
  });
  return { config, db, sqlite };
}

async function runArchiveTranscript(args: ParsedArgs): Promise<number> {
  const [transcriptPath] = args.positional;
  if (!transcriptPath) {
    process.stderr.write("error: missing <transcript.jsonl>\n");
    printUsage();
    return 2;
  }

  const overrides = (() => {
    const vault = asString(args.options.vault);
    if (!vault) {
      return undefined;
    }
    return { vault: { path: vault } };
  })();

  const config = loadConfig({ overrides });
  const { db, sqlite } = createDb({
    path: join(config.vault.path, config.storage.sqlite.path),
    journalMode: config.storage.sqlite.journal_mode,
    busyTimeoutMs: config.storage.sqlite.busy_timeout_ms,
    synchronous: config.storage.sqlite.synchronous,
    migrate: true,
  });

  try {
    const parsed = await parseTranscriptFile(transcriptPath);
    if (parsed.messages.length === 0) {
      process.stderr.write(
        `warning: no recognizable messages in ${transcriptPath}; skipping archive.\n`,
      );
      return 0;
    }

    const input = transcriptToArchiveInput(parsed, {
      project: asArray(args.options.project),
      tags: asArray(args.options.tag),
      topics: asArray(args.options.topic),
    });

    const result = await archiveConversation({ config, db, sqlite }, input);
    process.stdout.write(
      `${result.relativePath}${result.committed ? " (committed)" : ""}\n`,
    );
    return 0;
  } finally {
    sqlite.close();
  }
}

async function runWorkerCommand(args: ParsedArgs): Promise<number> {
  const once = args.options.once === true;
  const pollOpt = asString(args.options["poll-ms"]);
  const pollIntervalMs = pollOpt ? Number(pollOpt) : undefined;
  await runWorker({
    once,
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
  });
  return 0;
}

async function runSync(args: ParsedArgs): Promise<number> {
  const dryRun = args.options["dry-run"] === true;
  const { config, db, sqlite } = openDbFromConfig();
  try {
    const entitiesRepo = new EntitiesRepository(db);
    const renderedRepo = new RenderedFilesRepository(db);
    if (dryRun) {
      const dirty = entitiesRepo.listDirty();
      const deleted = entitiesRepo.listDeletedSinceSync();
      process.stdout.write(
        `dry-run: ${dirty.length} dirty, ${deleted.length} to delete\n`,
      );
      return 0;
    }
    const result = await renderDirty(config.vault.path, entitiesRepo, renderedRepo);
    process.stdout.write(
      `wrote ${result.written.length}, deleted ${result.deleted.length}` +
        (result.driftStaged.length
          ? `, drift staged ${result.driftStaged.length}`
          : "") +
        "\n",
    );
    return 0;
  } finally {
    sqlite.close();
  }
}

async function runReconcile(): Promise<number> {
  const { config, db, sqlite } = openDbFromConfig();
  try {
    const conversationsRepo = new ConversationsRepository(db);
    const jobsRepo = new JobsRepository(db, sqlite);
    const result = await reconcile(config.vault.path, conversationsRepo, jobsRepo);
    process.stdout.write(
      `scanned ${result.scanned}, reinserted ${result.reinserted}, ` +
        `re-enqueued ${result.reenqueued}\n`,
    );
    return 0;
  } finally {
    sqlite.close();
  }
}

function runStatus(): number {
  const { db, sqlite } = openDbFromConfig();
  try {
    const entitiesRepo = new EntitiesRepository(db);
    const jobsRepo = new JobsRepository(db, sqlite);
    process.stdout.write(
      [
        `entities (alive):  ${entitiesRepo.countAll()}`,
        `dirty entities:    ${entitiesRepo.listDirty().length}`,
        `jobs pending:      ${jobsRepo.countByState("pending")}`,
        `jobs running:      ${jobsRepo.countByState("running")}`,
        `jobs failed:       ${jobsRepo.countByState("failed")}`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.options.help || args.command === "help" || !args.command) {
    printUsage();
    return args.command ? 0 : 1;
  }
  switch (args.command) {
    case "archive-transcript":
      return runArchiveTranscript(args);
    case "worker":
      return runWorkerCommand(args);
    case "sync":
      return runSync(args);
    case "reconcile":
      return runReconcile();
    case "status":
      return runStatus();
    default:
      process.stderr.write(`error: unknown command "${args.command}"\n`);
      printUsage();
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${(err as Error).stack ?? err}\n`);
    // Stage 1 design: hooks must never block Claude Code on archive failure.
    process.exit(0);
  },
);
