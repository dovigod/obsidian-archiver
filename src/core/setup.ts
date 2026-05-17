import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { GLOBAL_CONFIG_PATH, PROJECT_CONFIG_REL } from "@core/config";
import { initVault, type InitResult } from "@core/init";

export type SetupScope = "global" | "project";

export interface SetupAnswers {
  scope: SetupScope;
  vaultPath: string;
  /** Confirm overwrite when target config file already exists. */
  overwrite: boolean;
}

export interface SetupResult {
  configPath: string;
  scope: SetupScope;
  vaultPath: string;
  initResult: InitResult;
}

export interface InteractiveSetupOptions {
  cwd?: string;
  /**
   * Pre-supplied answers — when provided fully, no prompts are issued.
   * Tests pass this to keep flows hermetic.
   */
  answers?: Partial<SetupAnswers>;
  /** Override stdin/stdout, mainly for tests. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

function expandTilde(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function defaultVaultPath(scope: SetupScope, cwd: string): string {
  return scope === "global"
    ? join(homedir(), "knowledge-hub-vault")
    : join(cwd, "vault");
}

function configPathFor(scope: SetupScope, cwd: string): string {
  return scope === "global"
    ? GLOBAL_CONFIG_PATH
    : join(cwd, PROJECT_CONFIG_REL);
}

async function ask(
  rl: readline.Interface,
  prompt: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer === "" ? fallback : answer;
}

async function askYesNo(
  rl: readline.Interface,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const raw = (await rl.question(prompt + suffix)).trim().toLowerCase();
  if (raw === "") {
    return defaultYes;
  }
  return raw === "y" || raw === "yes";
}

export class SetupAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupAbortedError";
  }
}

export async function interactiveSetup(
  options: InteractiveSetupOptions = {},
): Promise<SetupResult> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const supplied = options.answers ?? {};

  const fullyNonInteractive =
    supplied.scope !== undefined && supplied.vaultPath !== undefined;

  let scope: SetupScope;
  let vaultPath: string;
  let overwrite: boolean;

  if (fullyNonInteractive) {
    scope = supplied.scope!;
    vaultPath = resolve(expandTilde(supplied.vaultPath!));
    overwrite = supplied.overwrite ?? false;
  } else {
    const stdin = options.stdin ?? process.stdin;
    const isTty = "isTTY" in stdin ? (stdin as NodeJS.ReadStream).isTTY : false;
    if (!isTty) {
      throw new SetupAbortedError(
        "kh setup requires a TTY for interactive prompts. " +
          "Pass --scope and --vault on the command line to run non-interactively.",
      );
    }

    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
    });
    try {
      stdout.write("\nknowledge-hub setup\n-------------------\n\n");

      // 1. Scope
      const scopeAnswer = supplied.scope
        ? supplied.scope
        : ((
            await ask(
              rl,
              "Where should the config live? (global = ~/.knowledge-hub/config.json, project = ./.knowledge-hub/config.json) [global]: ",
              "global",
            )
          ).toLowerCase() as SetupScope);
      if (scopeAnswer !== "global" && scopeAnswer !== "project") {
        throw new SetupAbortedError(
          `Invalid scope "${scopeAnswer}" — expected "global" or "project".`,
        );
      }
      scope = scopeAnswer;

      // 2. Vault path
      const suggested = defaultVaultPath(scope, cwd);
      const vaultAnswer = supplied.vaultPath
        ? supplied.vaultPath
        : await ask(rl, `Vault path [${suggested}]: `, suggested);
      const absVault = resolve(expandTilde(vaultAnswer));
      if (!isAbsolute(absVault)) {
        throw new SetupAbortedError(
          `Vault path must resolve to an absolute path; got "${vaultAnswer}".`,
        );
      }
      vaultPath = absVault;

      // 3. Confirmation
      const configPath = configPathFor(scope, cwd);
      stdout.write(
        `\nAbout to write:\n  config: ${configPath}\n  vault:  ${vaultPath}\n\n`,
      );
      const proceed = await askYesNo(rl, "Continue?", true);
      if (!proceed) {
        throw new SetupAbortedError("Setup aborted by user.");
      }

      // 4. Overwrite (only if existing config)
      if (existsSync(configPath)) {
        overwrite =
          supplied.overwrite ??
          (await askYesNo(
            rl,
            `Config file already exists at ${configPath}. Overwrite?`,
            false,
          ));
        if (!overwrite) {
          throw new SetupAbortedError(
            `Refusing to overwrite ${configPath}. Re-run with --force to replace.`,
          );
        }
      } else {
        overwrite = false;
      }
    } finally {
      rl.close();
    }
  }

  const configPath = configPathFor(scope, cwd);

  // In the fully-non-interactive path we still must respect the overwrite flag.
  if (fullyNonInteractive && existsSync(configPath) && !overwrite) {
    throw new SetupAbortedError(
      `Refusing to overwrite ${configPath}. Pass overwrite=true (--force) to replace it.`,
    );
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ vault: { path: vaultPath } }, null, 2)}\n`,
  );

  const initResult = await initVault(vaultPath);

  stdout.write(
    [
      "",
      `✓ wrote ${configPath}`,
      `✓ vault initialized at ${initResult.vaultPath}`,
      ...(initResult.gitInitialized ? ["✓ git initialized"] : []),
      ...(initResult.gitWarning
        ? [`! git warning: ${initResult.gitWarning}`]
        : []),
      "",
      "Next steps:",
      "  pnpm dev:mcp                # start the MCP server",
      "  kh status                   # inspect vault state",
      "",
      "Wire the MCP server into Claude Code:",
      "  {",
      `    "mcpServers": { "knowledge-hub": { "command": "kh-mcp" } }`,
      "  }",
      "",
    ].join("\n"),
  );

  return { configPath, scope, vaultPath, initResult };
}
