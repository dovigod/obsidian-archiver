import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { simpleGit } from "simple-git";
import { GLOBAL_CONFIG_PATH, PROJECT_CONFIG_REL } from "@core/config";
import { initVault, type InitResult } from "@core/init";

export type SetupScope = "global" | "project";

/** Auth modes for the extractor LLM. */
export type SetupLLMMode = "claude" | "claude-cli";

export interface SetupAnswers {
  scope: SetupScope;
  vaultPath: string;
  /** Confirm overwrite when target config file already exists. */
  overwrite: boolean;
  /**
   * LLM auth mode:
   *  - "claude"     → Anthropic API key (env `ANTHROPIC_API_KEY`)
   *  - "claude-cli" → reuse local `claude` CLI subscription credentials
   *
   * When omitted, the config file is written without an `extract.llm` block
   * and the runtime falls back to schema defaults (= API key mode).
   */
  llm?: SetupLLMMode;
  /** Commit AND push to a git remote after each archive. */
  autoPush?: boolean;
  /** Remote URL to configure as `origin` on the vault. Blank = keep existing. */
  pushRemoteUrl?: string;
  /**
   * GitHub access token for https pushes, stored under `git.push.token`.
   * Blank = fall back to $GITHUB_TOKEN at runtime (or SSH keys for SSH remotes).
   */
  githubToken?: string;
}

/** Returns true when a `claude` binary is resolvable on PATH. */
export function detectClaudeBinary(): boolean {
  try {
    execSync(process.platform === "win32" ? "where claude" : "command -v claude", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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
  let llm: SetupLLMMode | undefined = supplied.llm;
  let autoPush: boolean | undefined = supplied.autoPush;
  let pushRemoteUrl: string | undefined = supplied.pushRemoteUrl;
  let githubToken: string | undefined = supplied.githubToken;

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

      // 3. LLM auth mode — only ask when the user didn't supply one.
      if (llm === undefined) {
        const hasClaudeBin = detectClaudeBinary();
        const defaultMode: SetupLLMMode = hasClaudeBin ? "claude-cli" : "claude";
        const hint = hasClaudeBin
          ? "claude CLI detected → defaulting to subscription"
          : "no claude CLI on PATH → defaulting to API key";
        stdout.write(`\nLLM auth (${hint}).\n`);
        const llmAnswer = (
          await ask(
            rl,
            `Use [s]ubscription (claude CLI, no API key) or [a]pi key? [${defaultMode === "claude-cli" ? "s" : "a"}]: `,
            defaultMode === "claude-cli" ? "s" : "a",
          )
        )
          .toLowerCase()
          .trim();
        if (llmAnswer === "s" || llmAnswer === "sub" || llmAnswer === "subscription" || llmAnswer === "claude-cli") {
          llm = "claude-cli";
        } else if (llmAnswer === "a" || llmAnswer === "api" || llmAnswer === "claude") {
          llm = "claude";
        } else {
          throw new SetupAbortedError(
            `Invalid LLM mode "${llmAnswer}" — expected "s"/"subscription" or "a"/"api".`,
          );
        }
      }

      // 4. Git auto-push — commit AND push after each archive.
      if (autoPush === undefined) {
        stdout.write(
          "\nGit auto-push: after each archive, commit AND push the vault to a remote.\n",
        );
        autoPush = await askYesNo(rl, "Enable auto-push?", false);
        if (autoPush) {
          pushRemoteUrl = await ask(
            rl,
            "Remote URL (e.g. https://github.com/you/vault.git; blank = keep existing `origin`): ",
            "",
          );
          githubToken = await ask(
            rl,
            "GitHub access token for https push (blank = use $GITHUB_TOKEN or SSH keys): ",
            "",
          );
        }
      }

      // 5. Confirmation
      const configPath = configPathFor(scope, cwd);
      const llmLine = llm
        ? `\n  llm:    ${llm === "claude-cli" ? "subscription (claude-cli)" : "api key (ANTHROPIC_API_KEY)"}`
        : "";
      const pushLine = autoPush
        ? `\n  push:   on (${pushRemoteUrl || "existing origin"}, ${
            githubToken ? "token in config" : "$GITHUB_TOKEN / SSH"
          })`
        : "";
      stdout.write(
        `\nAbout to write:\n  config: ${configPath}\n  vault:  ${vaultPath}${llmLine}${pushLine}\n\n`,
      );
      const proceed = await askYesNo(rl, "Continue?", true);
      if (!proceed) {
        throw new SetupAbortedError("Setup aborted by user.");
      }

      // 6. Overwrite (only if existing config)
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

  const configPayload: Record<string, unknown> = { vault: { path: vaultPath } };
  if (llm !== undefined) {
    configPayload.extract = { llm: { provider: llm } };
  }
  if (autoPush) {
    configPayload.git = {
      auto_push: true,
      ...(githubToken ? { push: { token: githubToken } } : {}),
    };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(configPayload, null, 2)}\n`);

  const initResult = await initVault(vaultPath);

  // Wire the push remote onto the vault repo (set-url when origin exists).
  let remoteWarning: string | undefined;
  if (autoPush && pushRemoteUrl) {
    try {
      const git = simpleGit({ baseDir: vaultPath });
      const remotes = await git.getRemotes();
      if (remotes.some((r) => r.name === "origin")) {
        await git.remote(["set-url", "origin", pushRemoteUrl]);
      } else {
        await git.addRemote("origin", pushRemoteUrl);
      }
    } catch (err) {
      remoteWarning = (err as Error).message;
    }
  }

  const llmNote =
    llm === "claude-cli"
      ? "  using `claude` CLI subscription — no API key required"
      : llm === "claude"
        ? "  using Anthropic API — set ANTHROPIC_API_KEY in your shell"
        : "  defaulting to Anthropic API — set ANTHROPIC_API_KEY (or pass --llm claude-cli to use a subscription)";

  stdout.write(
    [
      "",
      `✓ wrote ${configPath}`,
      `✓ vault initialized at ${initResult.vaultPath}`,
      ...(initResult.gitInitialized ? ["✓ git initialized"] : []),
      ...(initResult.gitWarning
        ? [`! git warning: ${initResult.gitWarning}`]
        : []),
      ...(autoPush
        ? [
            `✓ auto-push enabled${pushRemoteUrl ? ` → ${pushRemoteUrl}` : " (existing origin)"}`,
            githubToken
              ? "  https auth: token stored in config (git.push.token)"
              : "  https auth: $GITHUB_TOKEN at runtime (SSH remotes use keys)",
          ]
        : []),
      ...(remoteWarning ? [`! remote warning: ${remoteWarning}`] : []),
      "",
      "LLM auth:",
      llmNote,
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
