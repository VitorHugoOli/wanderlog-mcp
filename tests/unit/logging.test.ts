import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("structured logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadWithDir() {
    const dir = mkdtempSync(join(tmpdir(), "wl-log-"));
    vi.stubEnv("WANDERLOG_LOG_DIR", dir);
    vi.stubEnv("WANDERLOG_LOG_FILE", "1");
    const mod = await import("../../src/logging.ts");
    return { dir, ...mod };
  }

  it("writes one redacted JSON record per line, with pid and scope, to stderr and file", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { dir, createLogger } = await loadWithDir();
    const cookie = "s%3AFakeSessionIdFakeSessionId0123.FakeSignatureFakeSignature0123";

    createLogger("ws").warn(`closing connect.sid=${cookie}`, { trip: "abc", header: cookie });

    const [file] = readdirSync(dir);
    const record = JSON.parse(readFileSync(join(dir, file!), "utf8").trim());
    expect(record).toMatchObject({ level: "warn", scope: "ws", pid: process.pid, trip: "abc" });
    expect(JSON.stringify(record)).not.toContain("FakeSessionId");
    expect(String(stderr.mock.calls[0]![0])).toContain("[wanderdog:ws]");
    expect(String(stderr.mock.calls[0]![0])).not.toContain("FakeSessionId");
  });

  it("respects the configured level", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("WANDERLOG_LOG_LEVEL", "warn");
    const { createLogger } = await loadWithDir();
    createLogger("x").info("hidden");
    createLogger("x").debug("hidden");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("prunes log files older than a week", async () => {
    const { dir, pruneOldLogs } = await loadWithDir();
    const old = join(dir, "wanderlog-mcp-2000-01-01.log");
    const recent = join(dir, "wanderlog-mcp-2099-01-01.log");
    writeFileSync(old, "{}\n");
    writeFileSync(recent, "{}\n");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    pruneOldLogs();
    expect(readdirSync(dir).sort()).toEqual(["wanderlog-mcp-2099-01-01.log"]);
  });
});
