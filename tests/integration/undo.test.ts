import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import { moveBlock } from "../../src/tools/move-block.ts";
import { undo } from "../../src/tools/undo.ts";
import { assertTestTrip } from "./guard.ts";

/** Live: every undo must bring the server's copy of the day back exactly. */
describe("undo (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-10-01";

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const created = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: DAY,
      end_date: DAY,
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
  const dayOnServer = async () =>
    (await ctx.rest.getTrip(tripKey!)).itinerary.sections.find((s) => s.date === DAY)!.blocks;

  it("reverts add, edit and move on the server", async () => {
    ok(await addPlace(ctx, { trip_key: tripKey!, place: "Torre de Belém", day: DAY }));
    ok(await addNote(ctx, { trip_key: tripKey!, text: "Walk **along the river**", day: DAY }));
    const base = await dayOnServer();

    ok(
      await addPlace(ctx, {
        trip_key: tripKey!,
        place: "Praça do Comércio",
        day: DAY,
        note: "*lunch*",
        start_time: "12:00",
      }),
    );
    ok(await undo(ctx, { trip_key: tripKey! }));
    expect(await dayOnServer()).toEqual(base);

    ok(await editNote(ctx, { trip_key: tripKey!, old_text: "river", new_text: "Tagus" }));
    ok(await moveBlock(ctx, { trip_key: tripKey!, block: "Belém", position: 2 }));
    ok(await undo(ctx, { trip_key: tripKey!, steps: 2 }));
    expect(await dayOnServer()).toEqual(base);
  }, 120_000);
});
