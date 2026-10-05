import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addChecklist } from "../../src/tools/add-checklist.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { getTrip } from "../../src/tools/get-trip.ts";
import { isPlaceBlock } from "../../src/types.ts";
import { assertTestTrip } from "./guard.ts";

/**
 * Live check of insert-at-position against Wanderlog: build a day, then put
 * new items between existing ones by position, before and after, and verify
 * the order the server stores — and that get_trip's numbers match it.
 */
describe("insert at position (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-04-01";

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

  const order = async () => {
    const trip = await ctx.rest.getTrip(tripKey!);
    return trip.itinerary.sections
      .find((s) => s.mode === "dayPlan" && s.date === DAY)!
      .blocks.map((b) =>
        isPlaceBlock(b)
          ? b.place.name
          : b.type === "note"
            ? `note:${JSON.stringify(b.text).match(/"insert":"([^"\\]*)/)?.[1] ?? ""}`
            : b.type,
      );
  };

  const ok = (r: { isError?: boolean; content: Array<{ text: string }> }) => {
    if (r.isError) throw new Error(r.content[0]!.text);
    return r.content[0]!.text;
  };

  it("inserts between existing items by position, after and before", async () => {
    for (const place of ["Castelo de São Jorge", "Praça do Comércio", "Torre de Belém"]) {
      ok(await addPlace(ctx, { trip_key: tripKey!, place, day: DAY }));
    }
    const base = await order();
    expect(base).toHaveLength(3);
    const [first, second, third] = base;

    expect(
      ok(
        await addPlace(ctx, {
          trip_key: tripKey!,
          place: "Elevador de Santa Justa",
          day: DAY,
          position: 2,
        }),
      ),
    ).toContain("at position 2");
    expect(
      ok(
        await addNote(ctx, {
          trip_key: tripKey!,
          text: "Tram 28 to the next stop",
          day: DAY,
          after: "sao jorge",
        }),
      ),
    ).toContain("after");
    ok(
      await addChecklist(ctx, {
        trip_key: tripKey!,
        items: ["Buy Viva Viagem card"],
        day: DAY,
        before: third!,
      }),
    );

    const after = await order();
    expect(after).toEqual([
      first,
      "note:Tram 28 to the next stop",
      expect.stringContaining("Santa Justa"),
      second,
      "checklist",
      third,
    ]);

    const view = ok(await getTrip(ctx, { trip_key: tripKey!, day: DAY }));
    const numbered = view.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(6);
    expect(numbered[2]).toMatch(/^3\. .*Santa Justa/);
    expect(numbered[5]).toMatch(new RegExp(`^6\\. .*${third!.split(" ")[0]}`));
  }, 120_000);
});
