import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { composeDelta } from "../../src/ot/rich-text.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import type { QuillDelta, TripPlan } from "../../src/types.ts";
import { assertTestTrip } from "./guard.ts";

/**
 * Markdown notes against the live server: formatting must land as Quill
 * attributes, and the cache (which now composes deltas instead of flattening
 * them) must hold exactly what the server stores.
 */
describe("markdown notes (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-06-01";

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
  const dayTexts = (trip: TripPlan) =>
    trip.itinerary.sections
      .find((s) => s.mode === "dayPlan" && s.date === DAY)!
      .blocks.map((b) => composeDelta((b as { text?: QuillDelta }).text, []));
  const notesText = (trip: TripPlan) =>
    composeDelta(trip.itinerary.sections.find((s) => s.type === "textOnly")?.text, []);

  it("stores formatting as attributes and keeps the cache identical to the server", async () => {
    ok(
      await addNote(ctx, {
        trip_key: tripKey!,
        text: "Take **tram 28** — [map](https://example.com)",
        day: DAY,
      }),
    );
    ok(
      await addPlace(ctx, {
        trip_key: tripKey!,
        place: "Castelo de São Jorge",
        day: DAY,
        note: "- *Book* ahead\n- Bring water",
      }),
    );
    ok(
      await addNote(ctx, {
        trip_key: tripKey!,
        text: "# Packing\n- **Passport**",
        section: "notes",
      }),
    );
    ok(await editNote(ctx, { trip_key: tripKey!, old_text: "tram 28", new_text: "tram 12" }));

    const server = await ctx.rest.getTrip(tripKey!);
    const [note, place] = dayTexts(server);
    expect(note!.ops).toEqual([
      { insert: "Take " },
      { insert: "tram 12", attributes: { bold: true } },
      { insert: " — " },
      { insert: "map", attributes: { link: "https://example.com" } },
      { insert: "\n" },
    ]);
    expect(place!.ops).toEqual([
      { insert: "Book", attributes: { italic: true } },
      { insert: " ahead" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "Bring water" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);

    const cached = await ctx.tripCache.get(tripKey!);
    expect(dayTexts(cached)).toEqual(dayTexts(server));
    expect(notesText(cached)).toEqual(notesText(server));
    expect(notesText(server).ops).toEqual([
      { insert: "Packing" },
      { insert: "\n", attributes: { header: 1 } },
      { insert: "Passport", attributes: { bold: true } },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
  }, 120_000);
});
