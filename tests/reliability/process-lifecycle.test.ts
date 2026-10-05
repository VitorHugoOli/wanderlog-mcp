import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the built server (dist/index.js) as a real child process against a
 * fake Wanderlog that accepts connections and never answers, to check the
 * process lifecycle without credentials: the MCP handshake must not wait on
 * the auth probe, and the process must exit once its client goes away.
 */
const FAKE_COOKIE = "s%3AFakeSessionIdFakeSessionId0123.FakeSignatureFakeSignature0123456";

const logDir = mkdtempSync(join(tmpdir(), "wl-proc-log-"));
let blackhole: Server;
let blackholeUrl: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  blackhole = createServer(() => {});
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address() as { port: number };
  blackholeUrl = `http://127.0.0.1:${port}`;
  return () => blackhole.close();
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function startServer(): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      PATH: process.env.PATH,
      WANDERLOG_COOKIE: FAKE_COOKIE,
      WANDERLOG_BASE_URL: blackholeUrl,
      WANDERLOG_WS_BASE_URL: blackholeUrl.replace("http", "ws"),
      WANDERLOG_LOG_DIR: logDir,
      WANDERLOG_LOG_FILE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  return { child, stderr: () => err };
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("server process lifecycle", () => {
  it("is ready for MCP before the auth probe answers", async () => {
    const { stderr } = startServer();
    await waitFor(() => stderr().includes("ready (stdio)"), 10_000);
    expect(stderr()).not.toContain("authenticated");
  });

  it("exits promptly when the client closes stdin", async () => {
    const { child, stderr } = startServer();
    await waitFor(() => stderr().includes("ready (stdio)"), 10_000);
    const exit = exited(child);
    const started = Date.now();
    child.stdin!.end();
    expect(await exit).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stderr()).toContain("client closed stdin");
  });

  it("never writes the cookie to its logs", async () => {
    const { child, stderr } = startServer();
    await waitFor(() => stderr().includes("ready (stdio)"), 10_000);
    const exit = exited(child);
    child.stdin!.end();
    await exit;
    expect(stderr()).not.toContain("FakeSessionId");
    const files = readdirSync(logDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(logDir, file), "utf8");
      expect(content).toContain('"scope":"server"');
      expect(content).not.toContain("FakeSessionId");
    }
  });
});
