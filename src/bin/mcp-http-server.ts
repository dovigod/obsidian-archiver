#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "@core/config";
import { createDb } from "@core/db/client";
import { JobsRepository } from "@core/db/repository/jobs";
import { createKnowledgeHubServer } from "@core/mcp";
import { Fidelity } from "@core/schema";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { runWorker } from "@core/worker";

const MCP_PATH = "/mcp";
const DEFAULT_PORT = 8000;

// One queue for the lifetime of the HTTP server process, shared by every
// MCP session so the raw write + git commit stays strictly sequential.
const processingQueue = new SequentialQueue();

function readToken(): string | undefined {
  if (
    process.argv.includes("--no-auth") ||
    process.env.KH_MCP_NO_AUTH === "1"
  ) {
    process.stderr.write(
      "knowledge-hub: WARNING — running WITHOUT authentication. Anyone who\n" +
        "knows the URL can write to your vault and trigger LLM jobs.\n",
    );
    return undefined;
  }
  const token = process.env.KH_MCP_TOKEN;
  if (!token || token.length < 16) {
    process.stderr.write(
      "knowledge-hub: KH_MCP_TOKEN is required for the HTTP server.\n" +
        "This endpoint is expected to be exposed publicly (e.g. via a\n" +
        "cloudflared tunnel), so it refuses to start without a bearer token\n" +
        "of at least 16 characters. Generate one with:\n" +
        "  openssl rand -hex 32\n" +
        "then run:  KH_MCP_TOKEN=<token> kh-mcp-http\n" +
        "To deliberately run without auth: kh-mcp-http --no-auth\n",
    );
    process.exit(2);
  }
  return token;
}

function readPort(): number {
  const idx = process.argv.indexOf("--port");
  const raw =
    idx !== -1 ? process.argv[idx + 1] : process.env.KH_MCP_PORT;
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`error: invalid port "${raw}"\n`);
    process.exit(2);
  }
  return port;
}

function isAuthorized(
  req: IncomingMessage,
  token: string | undefined,
): boolean {
  if (token === undefined) {
    return true; // auth explicitly disabled via --no-auth
  }
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

async function main(): Promise<void> {
  const token = readToken();
  const port = readPort();

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

  // One MCP session per Streamable HTTP session id. Each session gets its
  // own Server/transport pair; they all share the db handle and the
  // SequentialQueue, so concurrent sessions cannot interleave vault writes.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    // Request log: method, path, session id (if any), final status. Written
    // on response finish so the status code is accurate for SDK-handled
    // requests too.
    const startedAt = Date.now();
    res.once("finish", () => {
      const sid = req.headers["mcp-session-id"];
      process.stderr.write(
        `[req] ${new Date().toISOString()} ${req.method} ${req.url} ` +
          `sid=${typeof sid === "string" ? sid.slice(0, 8) : "-"} ` +
          `-> ${res.statusCode} (${Date.now() - startedAt}ms)\n`,
      );
    });
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== MCP_PATH) {
        sendJsonError(res, 404, "Not found");
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJsonError(res, 401, "Unauthorized");
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const existing =
        typeof sessionId === "string"
          ? transports.get(sessionId)
          : undefined;

      if (existing) {
        await existing.handleRequest(req, res);
        return;
      }

      if (typeof sessionId === "string") {
        // Stale session id (e.g. this process restarted and lost the
        // in-memory session map). Per the MCP spec the server MUST answer
        // 404 so the client knows to re-initialize a fresh session instead
        // of surfacing a stream error.
        sendJsonError(res, 404, "Session not found; re-initialize");
        return;
      }

      if (req.method !== "POST") {
        // GET (SSE stream) / DELETE require an established session.
        sendJsonError(res, 400, "Missing MCP session id");
        return;
      }

      // New session: first POST must be an initialize request — the
      // transport validates that itself and rejects anything else.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };
      const server = createKnowledgeHubServer({
        config,
        db,
        sqlite,
        queue: processingQueue,
        // Remote callers (ChatGPT et al.) have no Claude Code session on
        // this machine — never advertise archive_session over HTTP.
        sessionTool: false,
        // Remote models compress their own turns when serializing the
        // conversation into tool args (observed consistently with ChatGPT),
        // so stamp every HTTP capture as summarized regardless of claims.
        forcedFidelity: Fidelity.Summarized,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err) => {
      process.stderr.write(
        `[knowledge-hub] request failed: ${(err as Error).stack ?? err}\n`,
      );
      if (!res.headersSent) {
        sendJsonError(res, 500, "Internal server error");
      } else {
        res.end();
      }
    });
  });

  httpServer.listen(port, () => {
    process.stderr.write(
      `knowledge-hub MCP (Streamable HTTP) listening on http://localhost:${port}${MCP_PATH}\n`,
    );
  });

  // In-process worker: drain Stage 2 extract jobs for the lifetime of the
  // HTTP server, serialized through the same queue as archive requests.
  const drainAbort = new AbortController();
  const shutdown = (): void => {
    drainAbort.abort();
    for (const transport of transports.values()) {
      void transport.close();
    }
    httpServer.close(() => process.exit(0));
    // Fallback if open SSE streams keep the server from closing.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
