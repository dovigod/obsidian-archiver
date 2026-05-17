import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { createDb } from "@core/db/client";
import {
  SMART_CONNECTIONS_DOC_FILENAME,
  writeSmartConnectionsDoc,
} from "@core/smart-connections";

export interface InitResult {
  vaultPath: string;
  /** True when this run wrote SMART_CONNECTIONS.md; false if it already existed. */
  smartConnectionsDocWritten: boolean;
  /** True when `git init` + initial commit ran in this call. */
  gitInitialized: boolean;
  /** Non-fatal git warning, if any. */
  gitWarning?: string;
}

const GITIGNORE_LINES = [
  "*.kh.db",
  "*.kh.db-wal",
  "*.kh.db-shm",
  ".smart-env/",
  "",
];

const SUBDIRS = [".", "raw/conversations", "knowledge", "_proposals", "_backups"];

/**
 * Scaffold a knowledge-hub vault: dirs, .gitignore, .kh.db with migrations
 * applied, SMART_CONNECTIONS.md, and an initial git commit. Idempotent —
 * re-running on an existing vault is a no-op for any file that already exists.
 */
export async function initVault(vaultPath: string): Promise<InitResult> {
  const absVault = resolve(vaultPath);
  for (const sub of SUBDIRS) {
    mkdirSync(join(absVault, sub), { recursive: true });
  }

  const gitignorePath = join(absVault, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_LINES.join("\n"));
  }

  const smartDoc = writeSmartConnectionsDoc(absVault);

  const dbPath = join(absVault, ".kh.db");
  const { sqlite } = createDb({ path: dbPath, migrate: true });
  sqlite.close();

  let gitInitialized = false;
  let gitWarning: string | undefined;
  if (!existsSync(join(absVault, ".git"))) {
    try {
      const git = simpleGit({ baseDir: absVault });
      await git.init();
      await git.add(".gitignore");
      await git.add(SMART_CONNECTIONS_DOC_FILENAME);
      await git.commit("init: knowledge-hub vault");
      gitInitialized = true;
    } catch (err) {
      gitWarning = (err as Error).message;
    }
  }

  return {
    vaultPath: absVault,
    smartConnectionsDocWritten: smartDoc.written,
    gitInitialized,
    ...(gitWarning ? { gitWarning } : {}),
  };
}
