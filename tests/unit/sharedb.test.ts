import { describe, expect, it, vi } from "vitest";
import { ShareDBPool } from "../../src/transport/sharedb.ts";

describe("ShareDBPool eviction", () => {
  const config = {
    wsBaseUrl: "wss://test",
    baseUrl: "https://test",
    userAgent: "test",
  } as any;

  it("closes and removes the current trip client", () => {
    const pool = new ShareDBPool(config);
    const client = pool.get("tripA");
    const closeSpy = vi.spyOn(client, "close");

    expect(pool.evict("tripA", client)).toBe(true);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.has("tripA")).toBe(false);
    expect(pool.get("tripA")).not.toBe(client);
    pool.closeAll();
  });

  it("does not evict a replacement client for a stale caller", () => {
    const pool = new ShareDBPool(config);
    const staleClient = pool.get("tripA");
    pool.evict("tripA", staleClient);
    const replacement = pool.get("tripA");
    const closeSpy = vi.spyOn(replacement, "close");

    expect(pool.evict("tripA", staleClient)).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(pool.get("tripA")).toBe(replacement);
    pool.closeAll();
  });
});
