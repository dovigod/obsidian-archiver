import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  /** Tag prepended to every line, e.g. "mcp", "worker", "cli". */
  component: string;
  /**
   * Log file path. `undefined` = default (~/.knowledge-hub/logs/knowledge-hub.log),
   * `null` = no file (stderr only).
   */
  path?: string | null;
  /** Mirror lines to stderr. Safe for stdio MCP servers (stdout carries JSON-RPC). */
  stderr?: boolean;
}

export function defaultLogPath(): string {
  return join(homedir(), ".knowledge-hub", "logs", "knowledge-hub.log");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function formatLogLine(
  component: string,
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
  now: Date = new Date(),
): string {
  const parts = [
    now.toISOString(),
    level.toUpperCase().padEnd(5),
    `[${component}]`,
    event,
  ];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

/** A logger that drops everything (tests, `logging.enabled = false`). */
export const NULL_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Tiny structured line logger. Writes are synchronous appends (low volume:
 * one line per tool call / job transition) and failures are swallowed —
 * logging must never break archiving.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const file = opts.path === null ? null : (opts.path ?? defaultLogPath());
  const mirror = opts.stderr ?? true;
  let dirReady = false;

  const write = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    const line = formatLogLine(opts.component, level, event, fields);
    if (mirror) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* never throw from logging */
      }
    }
    if (file) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(file), { recursive: true });
          dirReady = true;
        }
        appendFileSync(file, `${line}\n`);
      } catch {
        /* never throw from logging */
      }
    }
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export interface LoggingConfigLike {
  enabled: boolean;
  path: string;
  stderr: boolean;
}

/** Build a logger from the `logging` config block. */
export function loggerFromConfig(
  logging: LoggingConfigLike,
  component: string,
): Logger {
  if (!logging.enabled) {
    return NULL_LOGGER;
  }
  return createLogger({
    component,
    path: logging.path === "" ? undefined : logging.path,
    stderr: logging.stderr,
  });
}
