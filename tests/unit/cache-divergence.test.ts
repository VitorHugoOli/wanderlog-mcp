import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TripCache } from "../../src/cache/trip-cache.ts";
import type { AppContext } from "../../src/context.ts";
import { WanderlogError } from "../../src/errors.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { submitOp } from "../../src/tools/shared.ts";
import type { RestClient } from "../../src/transport/rest.ts";
import type { ShareDBPool, SubmitResult } from "../../src/transport/sharedb.ts";

type SubmitBehaviour = (ops: Json0Op[], baseVersion?: number) => Promise<SubmitResult | void>;

class FakeClient extends EventEmitter {
  isSubscribed = false;
  readonly submits: Array<{ ops: Json0Op[]; baseVersion?: number }> = [];
  behaviour?: SubmitBehaviour;

  constructor(
    public version: number,
    private readonly title: string,
  ) {
    super();
  }

  async subscribe() {
    this.isSubscribed = true;
    return { title: this.title, itinerary: { sections: [] } };
  }

  async submit(ops: Json0Op[], baseVersion?: number): Promise<SubmitResult | void> {
    this.submits.push({ ops, baseVersion });
    if (this.behaviour) return this.behaviour(ops, baseVersion);
    const sentVersion = baseVersion ?? this.version;
    this.version += 1;
    return { sentVersion, ackVersion: sentVersion };
  }

  close(): void {
    this.isSubscribed = false;
  }
}

class FakePool {
  readonly created: FakeClient[] = [];
  private current?: FakeClient;

  get(): FakeClient {
    if (!this.current) {
      const n = this.created.length + 1;
      this.current = new FakeClient(n * 10, `snapshot ${n}`);
      this.created.push(this.current);
    }
    return this.current;
  }

  has(): boolean {
    return this.current !== undefined;
  }

  evict(_tripKey: string, expected?: FakeClient): boolean {
    if (!this.current || (expected && expected !== this.current)) return false;
    this.current.close();
    this.current = undefined;
    return true;
  }
}

function setup() {
  const rest = { getTripWithResources: async () => ({ geos: [] }) } as unknown as RestClient;
  const pool = new FakePool();
  const cache = new TripCache(rest, pool as unknown as ShareDBPool);
  const ctx = { pool: pool as unknown as ShareDBPool, tripCache: cache } as AppContext;
  return { pool, cache, ctx };
}

const setTitle = (from: string, to: string): Json0Op[] => [{ p: ["title"], od: from, oi: to }];

describe("TripCache freshness", () => {
  it("drops an entry whose version lags the live client and resubscribes", async () => {
    const { pool, cache } = setup();
    await cache.get("tripA");
    const first = pool.created[0]!;

    // An op advanced the client without reaching the cache (e.g. one we
    // could not apply), so the cached snapshot is missing content.
    first.version += 1;

    const trip = await cache.get("tripA");
    expect(trip.title).toBe("snapshot 2");
    expect(pool.created).toHaveLength(2);
  });

  it("keeps serving an entry that matches the live client", async () => {
    const { pool, cache } = setup();
    await cache.get("tripA");
    await cache.get("tripA");
    expect(pool.created).toHaveLength(1);
  });
});

describe("submitOp version handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends ops at the version of the snapshot they were built from", async () => {
    const { pool, ctx } = setup();
    await submitOp(ctx, "tripA", (entry, submit) =>
      submit(setTitle(entry.snapshot.title, "renamed")),
    );
    expect(pool.created[0]!.submits[0]!.baseVersion).toBe(10);
    expect((await ctx.tripCache.get("tripA")).title).toBe("renamed");
  });

  it("refetches instead of applying ops the server transformed", async () => {
    const { pool, ctx } = setup();
    const first = pool.get();
    first.behaviour = async (_ops, baseVersion) => {
      // Two concurrent edits landed first; ours was transformed and applied at v12.
      first.version = 13;
      return { sentVersion: baseVersion!, ackVersion: 12 };
    };

    let entryAfter: unknown;
    let entryBefore: unknown;
    await submitOp(ctx, "tripA", async (entry, submit) => {
      entryBefore = entry;
      await submit(setTitle(entry.snapshot.title, "local guess"));
      entryAfter = entry;
      expect(entry.snapshot.title).toBe("snapshot 2");
      // A follow-up batch in the same mutation goes to the fresh client.
      await submit(setTitle(entry.snapshot.title, "second batch"));
    });

    expect(entryAfter).toBe(entryBefore);
    expect(pool.created).toHaveLength(2);
    expect(pool.created[1]!.submits).toHaveLength(1);
    expect((await ctx.tripCache.get("tripA")).title).toBe("second batch");
  });

  it("retries a rate-limited submit at the original base version", async () => {
    vi.useFakeTimers();
    const { pool, ctx } = setup();
    const client = pool.get();
    let calls = 0;
    client.behaviour = async (_ops, baseVersion) => {
      calls += 1;
      if (calls === 1) {
        // Another editor's op arrives while we wait out the rate limit.
        client.version += 1;
        client.emit("remoteOp", [], client.version);
        throw new WanderlogError("Too many requests", "rate_limited");
      }
      client.version += 1;
      return { sentVersion: baseVersion!, ackVersion: baseVersion! + 1 };
    };

    const done = submitOp(ctx, "tripA", (entry, submit) =>
      submit(setTitle(entry.snapshot.title, "after wait")),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(client.submits.map((s) => s.baseVersion)).toEqual([10, 10]);
    // Transformed by the server (acked at 11, sent at 10), so the cache refetched.
    expect(pool.created).toHaveLength(2);
  });
});

describe("refresh racing other reads", () => {
  it("shares one subscription, so remote ops are applied exactly once", async () => {
    const { pool, cache } = setup();
    await cache.get("tripA");

    await Promise.all([cache.refresh("tripA"), cache.get("tripA"), cache.get("tripA")]);

    const live = pool.get();
    expect(pool.created).toHaveLength(2);
    expect(live.listenerCount("remoteOp")).toBe(1);
    live.version += 1;
    live.emit("remoteOp", [{ p: ["itinerary", "sections", 0], li: { blocks: [] } }], live.version);
    expect((await cache.get("tripA")).itinerary.sections).toHaveLength(1);
  });

  it("never reports a failure for a write the server accepted", async () => {
    const { pool, ctx } = setup();
    const first = pool.get();
    first.behaviour = async (_ops, baseVersion) => ({ sentVersion: baseVersion!, ackVersion: 99 });
    // The resync after the transformed ack fails (e.g. a network blip).
    ctx.tripCache.refresh = async () => {
      throw new WanderlogError("socket hang up", "network");
    };

    await expect(
      submitOp(ctx, "tripA", (entry, submit) => submit(setTitle(entry.snapshot.title, "x"))),
    ).resolves.toBeUndefined();
  });
});
