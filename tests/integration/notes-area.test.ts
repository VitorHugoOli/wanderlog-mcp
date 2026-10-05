import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import { removeNote } from "../../src/tools/remove-note.ts";
import type { TripPlan } from "../../src/types.ts";
import { assertTestTrip } from "./guard.ts";

/** Live round trip on the trip-level notes area (a textOnly section's rich text). */
describe("notes area (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const created = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: "2099-05-01",
      end_date: "2099-05-01",
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

  const notesText = (trip: TripPlan) =>
    (trip.itinerary.sections.find((s) => s.type === "textOnly")?.text?.ops ?? [])
      .map((op) => (typeof op.insert === "string" ? op.insert : "￼"))
      .join("");

  const ok = (r: { isError?: boolean; content: Array<{ text: string }> }) => {
    if (r.isError) throw new Error(r.content[0]!.text);
    return r.content[0]!.text;
  };

  it("adds, edits and removes paragraphs, and the cache matches the server", async () => {
    ok(await addNote(ctx, { trip_key: tripKey!, text: "Bring cash for trams", section: "notes" }));
    ok(await addNote(ctx, { trip_key: tripKey!, text: "Museums closed Monday", section: "notes" }));
    ok(
      await addNote(ctx, {
        trip_key: tripKey!,
        text: "Buy a SIM at the airport",
        section: "notes",
      }),
    );
    expect(
      ok(
        await addNote(ctx, { trip_key: tripKey!, text: "Museums closed Monday", section: "notes" }),
      ),
    ).toContain("already in");

    ok(await editNote(ctx, { trip_key: tripKey!, old_text: "cash", new_text: "coins" }));
    ok(await removeNote(ctx, { trip_key: tripKey!, text: "museums closed" }));

    const server = notesText(await ctx.rest.getTrip(tripKey!));
    expect(server).toBe("Bring coins for trams\nBuy a SIM at the airport\n");
    expect(notesText(await ctx.tripCache.get(tripKey!))).toBe(server);
  }, 120_000);
});
