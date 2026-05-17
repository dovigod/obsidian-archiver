#!/usr/bin/env node
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { simpleGit } from "simple-git";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { createDb } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { EntitiesRepository } from "@core/db/repository/entities";
import { JobsRepository } from "@core/db/repository/jobs";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import { reconcile } from "@core/pipeline/reconcile";
import { renderDirty } from "@core/pipeline/render";
import { ProposalRepository } from "@core/repository/proposals";
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
      "  kh init <vault-path>",
      "  kh archive-transcript <transcript.jsonl> [--project NAME]... [--tag TAG]...",
      "                                          [--topic TOPIC]... [--vault PATH]",
      "  kh worker [--once] [--poll-ms MS]",
      "  kh sync [--entity NAME] [--since YYYY-MM-DD] [--full] [--dry-run]",
      "  kh reconcile",
      "  kh apply-proposal <id>",
      "  kh backup",
      "  kh restore <path>",
      "  kh status",
      "  kh --help",
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

async function runInit(args: ParsedArgs): Promise<number> {
  const [vault] = args.positional;
  if (!vault) {
    process.stderr.write("error: missing <vault-path>\n");
    printUsage();
    return 2;
  }
  const absVault = resolve(vault);
  for (const sub of [
    ".",
    "raw/conversations",
    "knowledge",
    "_proposals",
    "_backups",
  ]) {
    mkdirSync(join(absVault, sub), { recursive: true });
  }

  const gitignorePath = join(absVault, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      ["*.kh.db", "*.kh.db-wal", "*.kh.db-shm", ".smart-env/", ""].join("\n"),
    );
  }

  const dbPath = join(absVault, ".kh.db");
  const { sqlite } = createDb({ path: dbPath, migrate: true });
  sqlite.close();

  if (!existsSync(join(absVault, ".git"))) {
    try {
      const git = simpleGit({ baseDir: absVault });
      await git.init();
      await git.add(".gitignore");
      await git.commit("init: knowledge-hub vault");
    } catch (err) {
      process.stderr.write(
        `warning: git init failed (${(err as Error).message}); vault scaffolded but not committed.\n`,
      );
    }
  }

  process.stdout.write(`initialized vault at ${absVault}\n`);
  return 0;
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
  const entityFilter = asString(args.options.entity);
  const sinceFilter = asString(args.options.since);
  const fullRebuild = args.options.full === true;
  const { config, db, sqlite } = openDbFromConfig();
  try {
    const entitiesRepo = new EntitiesRepository(db);
    const renderedRepo = new RenderedFilesRepository(db);

    if (fullRebuild) {
      // Force every alive entity dirty by clearing synced_at.
      for (const ent of entitiesRepo.listAll()) {
        sqlite
          .prepare(`UPDATE entities SET synced_at = NULL WHERE id = ?`)
          .run(ent.id);
      }
    } else if (entityFilter) {
      const ent = entitiesRepo.findByName(entityFilter);
      if (!ent) {
        process.stderr.write(`error: no entity named "${entityFilter}"\n`);
        return 2;
      }
      sqlite
        .prepare(`UPDATE entities SET synced_at = NULL WHERE id = ?`)
        .run(ent.id);
    } else if (sinceFilter) {
      const sinceMs = Date.parse(sinceFilter);
      if (Number.isNaN(sinceMs)) {
        process.stderr.write(
          `error: --since "${sinceFilter}" is not a valid date\n`,
        );
        return 2;
      }
      sqlite
        .prepare(`UPDATE entities SET synced_at = NULL WHERE updated_at >= ?`)
        .run(sinceMs);
    }

    if (dryRun) {
      const dirty = entitiesRepo.listDirty();
      const deleted = entitiesRepo.listDeletedSinceSync();
      process.stdout.write(
        `dry-run: ${dirty.length} dirty, ${deleted.length} to delete\n`,
      );
      for (const ent of dirty) {
        process.stdout.write(`  + ${ent.name}\n`);
      }
      for (const ent of deleted) {
        process.stdout.write(`  - ${ent.name}\n`);
      }
      return 0;
    }
    const result = await renderDirty(
      config.vault.path,
      entitiesRepo,
      renderedRepo,
    );
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

async function runApplyProposal(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    process.stderr.write("error: missing <proposal-id>\n");
    return 2;
  }
  const { config, db, sqlite } = openDbFromConfig();
  try {
    const proposals = new ProposalRepository(config.vault.path);
    const record = await proposals.findById(id);
    if (!record) {
      process.stderr.write(`error: no proposal with id ${id}\n`);
      return 2;
    }

    if (record.kind === "manual_edit") {
      const entitiesRepo = new EntitiesRepository(db);
      const ent = entitiesRepo.findByName(record.entity_name);
      if (!ent) {
        process.stderr.write(
          `error: proposal targets entity "${record.entity_name}" but no such entity exists\n`,
        );
        return 2;
      }
      const content = String(record.payload.content ?? "");
      if (!content) {
        process.stderr.write("error: proposal has no content to apply\n");
        return 2;
      }
      // Extract the body from the (banner + frontmatter + H1 + body + Sources)
      // bundle produced by the renderer. Conservative: strip frontmatter via
      // matter() and drop the H1; leave Sources in place — the renderer
      // re-adds it from the manifest on next render.
      const newBody = extractBodyFromRendered(content, record.entity_name);
      entitiesRepo.updateBody({ id: ent.id, bodyMd: newBody });
      await proposals.remove(record.kind, record.id);
      process.stdout.write(
        `applied manual_edit to "${ent.name}" — re-render with \`kh sync\`\n`,
      );
      return 0;
    }

    // raw_invalid has no "apply" semantics — only dismiss.
    await proposals.remove(record.kind, record.id);
    process.stdout.write(`dismissed ${record.kind} proposal ${record.id}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}

function extractBodyFromRendered(text: string, entityName: string): string {
  // Strip banner comment line
  let body = text.replace(/^<!--[\s\S]*?-->\s*\n?/, "");
  // Strip YAML frontmatter
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // Strip the leading H1 (matches "# <name>")
  const h1Pattern = new RegExp(
    `^# ${entityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n+`,
  );
  body = body.replace(h1Pattern, "");
  // Strip trailing "## Sources" section (renderer re-adds it).
  body = body.replace(/\n## Sources[\s\S]*$/, "\n");
  return body.trim();
}

async function runBackup(): Promise<number> {
  const { config, sqlite } = openDbFromConfig();
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(config.vault.path, "_backups");
    mkdirSync(backupDir, { recursive: true });
    const tmp = join(backupDir, `kh-${ts}.db`);
    await sqlite.backup(tmp);
    const gz = `${tmp}.gz`;
    await pipeline(createReadStream(tmp), createGzip(), createWriteStream(gz));
    rmSync(tmp, { force: true });
    process.stdout.write(`${gz}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}

async function runRestore(args: ParsedArgs): Promise<number> {
  const [backupPath] = args.positional;
  if (!backupPath) {
    process.stderr.write("error: missing <backup-path>\n");
    return 2;
  }
  const config = loadConfig();
  const dbPath = join(config.vault.path, config.storage.sqlite.path);
  const tmpPath = `${dbPath}.restore.${Date.now()}`;
  await pipeline(
    createReadStream(backupPath),
    createGunzip(),
    createWriteStream(tmpPath),
  );
  // Replace atomically; clear stale WAL sidecars.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(tmpPath, dbPath);
  process.stdout.write(`restored ${dbPath} from ${backupPath}\n`);
  return 0;
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
    case "init":
      return runInit(args);
    case "archive-transcript":
      return runArchiveTranscript(args);
    case "worker":
      return runWorkerCommand(args);
    case "sync":
      return runSync(args);
    case "reconcile":
      return runReconcile();
    case "apply-proposal":
      return runApplyProposal(args);
    case "backup":
      return runBackup();
    case "restore":
      return runRestore(args);
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
