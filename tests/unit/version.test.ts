import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";

/**
 * Regression guard for the MCP handshake version.
 *
 * v0.3.0 and v0.3.1 both shipped announcing "0.2.0" over MCP, because the
 * version was a literal in server.ts that release bumps didn't touch. It is now
 * derived from package.json; these tests fail if that derivation breaks.
 */
describe("VERSION", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("matches the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is a non-empty semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is not hardcoded anywhere in server.ts", () => {
    // The specific mistake being guarded against: a literal version string
    // passed to the McpServer constructor, which then silently goes stale.
    const source = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/name:\s*"wanderlog-mcp",\s*version:\s*"/);
  });
});
