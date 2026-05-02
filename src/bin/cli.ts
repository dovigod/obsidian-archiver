#!/usr/bin/env node
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import {
  parseTranscriptFile,
  transcriptToArchiveInput,
} from "@core/transcript";

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
      "  kh --help",
      "",
      "Stage 1 only: archives a Claude Code JSONL transcript into the vault.",
      "",
    ].join("\n"),
  );
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

  const result = await archiveConversation(config, input);
  process.stdout.write(
    `${result.relativePath}${result.committed ? " (committed)" : ""}\n`,
  );
  return 0;
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
