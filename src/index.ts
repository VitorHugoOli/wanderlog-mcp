#!/usr/bin/env node
import type { AppContext } from "./context.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { WanderlogAuthError, WanderlogError } from "./errors.js";
import { createLogger, pruneOldLogs } from "./logging.js";
import { buildServer, ensureAuthenticated } from "./server.js";

const logger = createLogger("server");
const log = (line: string) => logger.info(line);
const describe = (err: unknown) =>
  err instanceof WanderlogError ? err.toUserMessage() : ((err as Error)?.stack ?? String(err));

/** How long shutdown may take before the process is forced out. */
const SHUTDOWN_GRACE_MS = 2_000;
const PARENT_CHECK_MS = 30_000;

async function main() {
  pruneOldLogs();
  let ctx: AppContext;
  try {
    ctx = createContext();
  } catch (err) {
    log(`startup failed: ${describe(err)}`);
    process.exit(1);
  }

  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let exitCode = 0;
  const shutdown = (reason: string, code = 0) => {
    // A fatal error during a clean shutdown must still exit non-zero.
    exitCode = Math.max(exitCode, code);
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    setTimeout(() => process.exit(exitCode), SHUTDOWN_GRACE_MS).unref();
    ctx.tripCache.clear();
    ctx.pool.closeAll();
    server
      .close()
      .catch(() => {})
      .finally(() => process.exit(exitCode));
  };

  process.on("SIGINT", () => shutdown("SIGINT received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
  process.on("SIGHUP", () => shutdown("SIGHUP received"));
  // The stdio transport never listens for EOF, and open sockets keep the event
  // loop alive, so without this a server whose client exited lingers forever.
  // (transport.onclose is owned by the SDK's Protocol, hence stdin events.)
  process.stdin.on("end", () => shutdown("client closed stdin"));
  process.stdin.on("close", () => shutdown("client closed stdin"));
  // Belt and braces for a client that dies without closing the pipe: once the
  // parent is gone we are reparented (to launchd/init).
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) shutdown("parent process exited");
  }, PARENT_CHECK_MS).unref();

  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandled rejection (continuing): ${describe(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    logger.error(`uncaught exception: ${describe(err)}`);
    shutdown("fatal error", 1);
  });

  await server.connect(transport);
  log("ready (stdio)");

  // Probed after connecting so a slow or offline network cannot delay the MCP
  // handshake past the client's startup timeout. Tools await the same probe.
  ensureAuthenticated(ctx).then(
    () => log(`authenticated (user ${ctx.userId})`),
    (err) => {
      if (err instanceof WanderlogAuthError) {
        log(`auth probe failed: ${describe(err)}`);
        log("server stays up; every tool returns an auth error until the cookie is fixed");
      } else {
        log(
          `auth probe could not reach Wanderlog (will retry on first tool call): ${describe(err)}`,
        );
      }
    },
  );
}

main().catch((err) => {
  log(`fatal: ${describe(err)}`);
  process.exit(1);
});
