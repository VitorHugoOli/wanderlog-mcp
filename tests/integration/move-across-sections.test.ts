import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { addSection } from "../../src/tools/add-section.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { moveBlock } from "../../src/tools/move-block.ts";
import { reorderSections } from "../../src/tools/reorder-sections.ts";
import { isPlaceBlock } from "../../src/types.ts";
import { assertTestTrip } from "./guard.ts";

/** Live: move a place between days intact, and reorder custom lists. */
describe("move across sections / reorder lists (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const created = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: "2099-07-01",
      end_date: "2099-07-02",
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

  const ok = (r: { isError?: boolean; content: Array<{ text: string }> }) => {
    if (r.isError) throw new Error(r.content[0]!.text);
    return r.content[0]!.text;
  };

  it("moves a place to another day keeping note, times and id", async () => {
    ok(
      await addPlace(ctx, {
        trip_key: tripKey!,
        place: "Torre de Belém",
        day: "2099-07-01",
        note: "Go early",
        start_time: "09:00",
      }),
    );
    ok(await addPlace(ctx, { trip_key: tripKey!, place: "Praça do Comércio", day: "2099-07-02" }));
    const before = await ctx.rest.getTrip(tripKey!);
    const original = before.itinerary.sections.find((s) => s.date === "2099-07-01")!.blocks[0]!;

    ok(
      await moveBlock(ctx, {
        trip_key: tripKey!,
        block: "Belém",
        to_day: "2099-07-02",
        position: 1,
      }),
    );

    const after = await ctx.rest.getTrip(tripKey!);
    const day1 = after.itinerary.sections.find((s) => s.date === "2099-07-01")!;
    const day2 = after.itinerary.sections.find((s) => s.date === "2099-07-02")!;
    expect(day1.blocks).toHaveLength(0);
    expect(day2.blocks[0]).toEqual(original);
    expect(isPlaceBlock(day2.blocks[1]!) && day2.blocks[1].place.name).toContain("Comércio");
  }, 90_000);

  it("reorders custom lists", async () => {
    for (const heading of ["Food", "Bars", "Shops"])
      ok(await addSection(ctx, { trip_key: tripKey!, heading }));
    ok(await reorderSections(ctx, { trip_key: tripKey!, section: "Shops", position: 1 }));
    const trip = await ctx.rest.getTrip(tripKey!);
    const custom = trip.itinerary.sections
      .filter((s) => ["Food", "Bars", "Shops"].includes(s.heading))
      .map((s) => s.heading);
    expect(custom).toEqual(["Shops", "Food", "Bars"]);
  }, 90_000);
});
