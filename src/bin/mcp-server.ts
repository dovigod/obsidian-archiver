#!/usr/bin/env node
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "@core/config";
import { createDb } from "@core/db/client";
import { JobsRepository } from "@core/db/repository/jobs";
import { loggerFromConfig } from "@core/log";
import { createKnowledgeHubServer } from "@core/mcp";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { runWorker } from "@core/worker";

// One queue for the lifetime of the MCP server process. Every conversation-
// processing request runs through it so the raw write + git commit stays
// strictly sequential.
const processingQueue = new SequentialQueue();

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("No config file was found")) {
      process.stderr.write(
        "knowledge-hub: no configuration found.\n" +
          "Run `kh setup` (or `pnpm dev:cli setup`) to create one.\n",
      );
      process.exit(2);
    }
    throw err;
  }
  const { db, sqlite } = createDb({
    path: join(config.vault.path, config.storage.sqlite.path),
    journalMode: config.storage.sqlite.journal_mode,
    busyTimeoutMs: config.storage.sqlite.busy_timeout_ms,
    synchronous: config.storage.sqlite.synchronous,
    migrate: true,
  });

  // Recover any jobs left running from a prior crashed process.
  const jobs = new JobsRepository(db, sqlite);
  jobs.reclaimStuck();

  const server = createKnowledgeHubServer({
    config,
    db,
    sqlite,
    queue: processingQueue,
  });

  const log = loggerFromConfig(config.logging, "mcp");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp.start", {
    vault: config.vault.path,
    capture_mode: config.capture.mode,
    pid: process.pid,
  });

  // In-process worker: drain Stage 2 extract jobs for the lifetime of the
  // MCP server — no separate `kh worker` required for the default
  // deployment. Job processing is routed through the same SequentialQueue
  // as archive_conversation so vault writes + git commits stay strictly
  // sequential within this process. Aborted when the transport closes so
  // the idle poll timer doesn't keep the process alive.
  const drainAbort = new AbortController();
  server.onclose = (): void => {
    drainAbort.abort();
  };
  // The SDK's StdioServerTransport never fires onclose on stdin EOF (it only
  // listens to 'data'/'error'), so watch stdin directly: when the client
  // disconnects, stop draining so the process can exit instead of being
  // orphaned by the poll timer.
  process.stdin.once("end", () => drainAbort.abort());
  process.stdin.once("close", () => drainAbort.abort());
  void runWorker({
    config,
    db,
    sqlite,
    signal: drainAbort.signal,
    serialize: (fn) => processingQueue.enqueue(fn),
  }).catch((err) => {
    // Most likely a misconfigured LLM provider (e.g. missing API key).
    // Capture keeps working; jobs stay pending until `kh worker` runs.
    process.stderr.write(
      `[knowledge-hub] in-process worker stopped: ${(err as Error).message}\n` +
        "Extract jobs will remain pending until `kh worker` is run.\n",
    );
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
