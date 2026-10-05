import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./errors.js";

/*
 * Structured logging (idea from wcrusher@745c11a, without the pino dependency).
 *
 * Every line goes to stderr — never stdout, which carries the MCP protocol —
 * and is appended as one JSON object to a dated file, so connection problems
 * in long-lived sessions can be diagnosed after the fact. Several servers run
 * at once (one per client session), hence the pid on every record. Messages
 * and metadata are redacted; a cookie must never reach a log.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const RETENTION_DAYS = 7;

export const LOG_DIR = process.env.WANDERLOG_LOG_DIR ?? join(tmpdir(), "wanderlog-mcp");

function configuredLevel(): LogLevel {
  const raw = process.env.WANDERLOG_LOG_LEVEL?.toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

let fileLoggingBroken = false;

function appendToFile(record: Record<string, unknown>): void {
  if (fileLoggingBroken || process.env.WANDERLOG_LOG_FILE === "0") return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `wanderlog-mcp-${day}.log`), `${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never take the server down; stop trying after one failure.
    fileLoggingBroken = true;
  }
}

function log(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
  const safeMessage = redactSecrets(message);
  const safeMeta = meta ? (JSON.parse(redactSecrets(JSON.stringify(meta))) as object) : undefined;
  const suffix = safeMeta && Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : "";
  process.stderr.write(`[wanderdog:${scope}] ${safeMessage}${suffix}\n`);
  appendToFile({
    time: new Date().toISOString(),
    level,
    pid: process.pid,
    scope,
    msg: safeMessage,
    ...safeMeta,
  });
}

export type Logger = Record<LogLevel, (message: string, meta?: Record<string, unknown>) => void>;

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => log("debug", scope, message, meta),
    info: (message, meta) => log("info", scope, message, meta),
    warn: (message, meta) => log("warn", scope, message, meta),
    error: (message, meta) => log("error", scope, message, meta),
  };
}

/** Delete log files older than the retention window. Best effort. */
export function pruneOldLogs(now = Date.now()): void {
  try {
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.startsWith("wanderlog-mcp-") || !name.endsWith(".log")) continue;
      const path = join(LOG_DIR, name);
      if (now - statSync(path).mtimeMs > RETENTION_DAYS * 86_400_000) unlinkSync(path);
    }
  } catch {
    // Missing directory or a race with another process pruning: fine.
  }
}
