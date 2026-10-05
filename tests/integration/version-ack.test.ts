import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { loadConfig } from "../../src/config.ts";
import { buildNoteBlock, findDaySectionByDate, submitOp } from "../../src/tools/shared.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { ShareDBClient } from "../../src/transport/sharedb.ts";

/**
 * Verifies the version assumptions the cache relies on against the live
 * server: an uncontended op is acked at the version it was sent at, and an op
 * sent at a stale base version is transformed by the server (acked later)
 * rather than applied at a wrong index. Uses a throwaway trip.
 */
describe("ShareDB version/ack semantics (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-02-01";

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const result = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: DAY,
      end_date: "2099-02-02",
      title: `WANDERDOG_TEST_${Date.now()}`,
      privacy: "private",
    });
    tripKey = result.content[0]!.text.match(/Key: (\w+)/)?.[1];
    expect(tripKey).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    ctx?.pool.closeAll();
    if (tripKey) await ctx.rest.deleteTrip(tripKey).catch(() => {});
  });

  function noteInsert(trip: Parameters<typeof findDaySectionByDate>[0], text: string) {
    const day = findDaySectionByDate(trip, DAY)!;
    const block = { ...buildNoteBlock(ctx.userId!), text: { ops: [{ insert: `${text}\n` }] } };
    return [{ p: ["itinerary", "sections", day.index, "blocks", 0], li: block }];
  }

  it("acks an uncontended op at the version it was sent at", async () => {
    const client = new ShareDBClient(loadConfig(), tripKey!);
    try {
      const trip = await client.subscribe();
      const base = client.version;
      const result = await client.submit(noteInsert(trip, "uncontended"), base);
      expect(result).toEqual({ sentVersion: base, ackVersion: base });
      expect(client.version).toBe(base + 1);
    } finally {
      client.close();
    }
  }, 30_000);

  it("transforms an op sent at a stale base version instead of misapplying it", async () => {
    const a = new ShareDBClient(loadConfig(), tripKey!);
    const b = new ShareDBClient(loadConfig(), tripKey!);
    try {
      const staleTrip = await a.subscribe();
      const staleBase = a.version;
      await b.subscribe();
      await b.submit(noteInsert(staleTrip, "from other editor"));

      const result = await a.submit(noteInsert(staleTrip, "from stale client"), staleBase);
      expect(result.sentVersion).toBe(staleBase);
      expect(result.ackVersion).toBeGreaterThan(staleBase);
    } finally {
      a.close();
      b.close();
    }

    const check = new ShareDBClient(loadConfig(), tripKey!);
    try {
      const fresh = await check.subscribe();
      const texts = findDaySectionByDate(fresh, DAY)!.section.blocks.map(
        (blk) => (blk as { text?: { ops?: Array<{ insert?: string }> } }).text?.ops?.[0]?.insert,
      );
      expect(texts).toContain("from other editor\n");
      expect(texts).toContain("from stale client\n");
      expect(texts).toContain("uncontended\n");
    } finally {
      check.close();
    }
  }, 45_000);

  it("keeps the cache consistent when submitOp's op is transformed", async () => {
    const other = new ShareDBClient(loadConfig(), tripKey!);
    try {
      await other.subscribe();
      await submitOp(ctx, tripKey!, async (entry, submit) => {
        const ops = noteInsert(entry.snapshot, "via submitOp");
        // Another editor lands an op after we built ours but before we send.
        await other.submit(noteInsert(other.currentSnapshot!, "concurrent"));
        await submit(ops);
      });
    } finally {
      other.close();
    }

    const cached = await ctx.tripCache.get(tripKey!);
    const texts = findDaySectionByDate(cached, DAY)!.section.blocks.map(
      (blk) => (blk as { text?: { ops?: Array<{ insert?: string }> } }).text?.ops?.[0]?.insert,
    );
    expect(texts).toContain("via submitOp\n");
    expect(texts).toContain("concurrent\n");
    expect(new Set(texts).size).toBe(texts.length);
  }, 45_000);
});
