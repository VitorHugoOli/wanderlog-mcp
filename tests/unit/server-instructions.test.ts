import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { buildServer, SERVER_INSTRUCTIONS } from "../../src/server.ts";

describe("server instructions", () => {
  it("only mention tools that are actually registered", () => {
    const server = buildServer({ authenticated: true } as AppContext);
    const registered = new Set(
      Object.keys(
        (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
      ),
    );
    const mentioned = new Set(SERVER_INSTRUCTIONS.match(/wanderlog_[a-z_]+/g));
    const unknown = [...mentioned].filter((name) => !registered.has(name));
    expect(unknown).toEqual([]);
  });

  it("mention every registered tool, so agents can find each one", () => {
    const server = buildServer({ authenticated: true } as AppContext);
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    const missing = registered.filter((name) => !SERVER_INSTRUCTIONS.includes(name));
    expect(missing).toEqual([]);
  });
});
