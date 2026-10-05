import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { buildNoteBlock, submitOp } from "../../src/tools/shared.ts";
import { updateTripDates } from "../../src/tools/update-trip-dates.ts";
import { assertTestTrip } from "./guard.ts";

/** Live check for upstream issue #58: a duplicated day section is merged back. */
describe("duplicate day repair (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-08-01";

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const created = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: DAY,
      end_date: "2099-08-02",
      title: `WANDERDOG_TEST_${Date.now()}`,
      privacy: "private",
    });
    tripKey = created.content[0]!.text.match(/Key: (\w+)/)?.[1];
    assertTestTrip(await ctx.rest.getTrip(tripKey!));
  }, 30_000);

  afterAll(async () => {
    ctx?.pool.closeAll();
    if (tripKey) await ctx.rest.deleteTrip(tripKey).catch(() => {});
  });

  it("merges a duplicated day without losing its items", async () => {
    await addNote(ctx, { trip_key: tripKey!, text: "original day", day: DAY });
    // Simulate the corruption: a second day section for the same date, with content.
    await submitOp(ctx, tripKey!, async (entry, submit) => {
      const sections = entry.snapshot.itinerary.sections;
      const index = sections.findIndex((s) => s.mode === "dayPlan" && s.date === DAY);
      const duplicate = {
        ...structuredClone(sections[index]!),
        id: 777000001,
        blocks: [
          { ...buildNoteBlock(ctx.userId!), text: { ops: [{ insert: "from duplicate\n" }] } },
        ],
      };
      await submit([{ p: ["itinerary", "sections", index + 1], li: duplicate }]);
    });
    const corrupted = await ctx.rest.getTrip(tripKey!);
    expect(corrupted.itinerary.sections.filter((s) => s.date === DAY)).toHaveLength(2);

    const result = await updateTripDates(ctx, {
      trip_key: tripKey!,
      start_date: DAY,
      end_date: "2099-08-02",
    });
    expect(result.content[0]!.text).toContain("Repaired");

    const repaired = await ctx.rest.getTrip(tripKey!);
    const days = repaired.itinerary.sections.filter((s) => s.date === DAY);
    expect(days).toHaveLength(1);
    const texts = JSON.stringify(days[0]!.blocks);
    expect(texts).toContain("original day");
    expect(texts).toContain("from duplicate");
  }, 90_000);
});
