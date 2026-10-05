import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { formatTrip } from "../../src/formatters/trip-summary.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addChecklist } from "../../src/tools/add-checklist.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { resolveInsertionPoint } from "../../src/tools/insert-position.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";

// checklistTrip, day 2026-06-01 (section index 2): 1. Park Güell, 2. note, 3. checklist.
const DAY = "2026-06-01";
const DAY_INDEX = 2;
const LOUVRE = { name: "Musée du Louvre", place_id: "louvre-id" };

function makeFakeContext(trip: TripPlan = checklistTrip) {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 3656632,
    rest: {
      searchPlacesAutocomplete: async () => [{ place_id: "louvre-id", description: "Louvre" }],
      getPlaceDetails: async () => LOUVRE,
      getPlacePhotos: async () => [],
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  const dayLines = () =>
    formatTrip(entry.snapshot, "concise", entry.snapshot.itinerary.sections[DAY_INDEX])
      .split("\n")
      .slice(1);
  return { ctx, submittedOps, entry, dayLines };
}

describe("resolveInsertionPoint", () => {
  const trip = structuredClone(checklistTrip);

  it("appends when no anchor is given", () => {
    expect(resolveInsertionPoint(trip, DAY_INDEX, {}).index).toBe(3);
  });

  it("maps a 1-based position onto the raw block index, up to one past the end", () => {
    expect(resolveInsertionPoint(trip, DAY_INDEX, { position: 1 }).index).toBe(0);
    expect(resolveInsertionPoint(trip, DAY_INDEX, { position: 3 }).index).toBe(2);
    expect(resolveInsertionPoint(trip, DAY_INDEX, { position: 4 }).index).toBe(3);
    expect(() => resolveInsertionPoint(trip, DAY_INDEX, { position: 5 })).toThrow(
      /Position 5 is outside day 2026-06-01, which has 3 items/,
    );
  });

  it("resolves before/after against places in the target section", () => {
    expect(resolveInsertionPoint(trip, DAY_INDEX, { before: "Park Güell" })).toEqual({
      index: 0,
      description: "at position 1 (before Park Güell)",
    });
    expect(resolveInsertionPoint(trip, DAY_INDEX, { after: "park guell" }).index).toBe(1);
  });

  it("does not see places that live in other sections", () => {
    // La Sagrada Familia is in "Places to visit", not on this day.
    expect(() => resolveInsertionPoint(trip, DAY_INDEX, { after: "Sagrada Familia" })).toThrow(
      /No itinerary block matching/,
    );
  });

  it("rejects more than one anchor", () => {
    expect(() =>
      resolveInsertionPoint(trip, DAY_INDEX, { position: 1, after: "Park Güell" }),
    ).toThrow(/at most one of position, before, or after/);
  });
});

describe("insert tools place the new block where asked", () => {
  it("add_place at position 2 lands between items 1 and 2, and get_trip shows it as item 2", async () => {
    const { ctx, submittedOps, dayLines } = makeFakeContext();
    const result = await addPlace(ctx, { trip_key: "T", place: "Louvre", day: DAY, position: 2 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("at position 2");
    expect(submittedOps[0]![0]!.p).toEqual(["itinerary", "sections", DAY_INDEX, "blocks", 1]);
    // Note and times ride in the same batch at the same (inserted) path.
    expect(dayLines()).toEqual([
      "1. Park Güell",
      "2. Musée du Louvre",
      expect.stringMatching(/^3\. 📝 Don't forget the sunscreen!/),
      expect.stringMatching(/^4\. ☑ Packing list/),
    ]);
  });

  it("add_note after a place goes right below it", async () => {
    const { ctx, dayLines } = makeFakeContext();
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Walk 10 min downhill to the next stop",
      day: DAY,
      after: "Park Güell",
    });
    expect(result.content[0]!.text).toContain("at position 2 (after Park Güell)");
    expect(dayLines()[1]).toBe("2. 📝 Walk 10 min downhill to the next stop");
  });

  it("add_checklist before a place goes first", async () => {
    const { ctx, dayLines } = makeFakeContext();
    await addChecklist(ctx, { trip_key: "T", items: ["Tickets"], day: DAY, before: "Park Güell" });
    expect(dayLines()[0]).toMatch(/^1\. ☑ \[ \] Tickets/);
    expect(dayLines()[1]).toBe("2. Park Güell");
  });

  it("without an anchor it still appends", async () => {
    const { ctx, dayLines } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "Last thing", day: DAY });
    expect(dayLines().at(-1)).toBe("4. 📝 Last thing");
  });

  it("refuses an anchor when add_place targets both a day and a section", async () => {
    const { ctx, submittedOps } = makeFakeContext();
    const result = await addPlace(ctx, {
      trip_key: "T",
      place: "Louvre",
      day: DAY,
      section: "Places to visit",
      position: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("needs a single target");
    expect(submittedOps).toHaveLength(0);
  });

  it("reports an out-of-range position without writing", async () => {
    const { ctx, submittedOps } = makeFakeContext();
    const result = await addNote(ctx, { trip_key: "T", text: "x", day: DAY, position: 9 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Use a position from 1 to 4");
    expect(submittedOps).toHaveLength(0);
  });
});

describe("get_trip numbering", () => {
  it("numbers every block, including ones that render empty, so positions never skip", () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections[DAY_INDEX]!.blocks.splice(1, 0, {
      id: 1,
      type: "note",
      text: { ops: [{ insert: "\n" }] },
    } as never);
    const lines = formatTrip(trip, "concise", trip.itinerary.sections[DAY_INDEX]).split("\n");
    expect(lines.slice(1, 4)).toEqual([
      "1. Park Güell",
      "2. 📝 (empty note)",
      expect.stringMatching(/^3\. 📝 Don't forget/),
    ]);
  });
});

describe("Phase 2 review coverage", () => {
  it("numbers Places to visit and custom lists but keeps hotels/flights bulleted", () => {
    const out = formatTrip(mixedBlocksTrip, "concise");
    expect(out).toMatch(/✈ Flights\n {2}• ✈ NH 890/);
    expect(out).toMatch(/🏨 Hotels and lodging\n {2}• Far East Village/);
    const barcelona = formatTrip(checklistTrip, "concise");
    expect(barcelona).toMatch(/📌 Places to visit\n {2}1\. La Sagrada Familia/);
  });

  it("shows a whitespace-only note as an empty placeholder", () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections[DAY_INDEX]!.blocks.push({
      id: 2,
      type: "note",
      text: { ops: [{ insert: "   \n \n" }] },
    } as never);
    const lines = formatTrip(trip, "concise", trip.itinerary.sections[DAY_INDEX]).split("\n");
    expect(lines.at(-1)).toBe("4. 📝 (empty note)");
  });

  it("add_place honours before/after", async () => {
    const before = makeFakeContext();
    await addPlace(before.ctx, { trip_key: "T", place: "Louvre", day: DAY, before: "Park Güell" });
    expect(before.dayLines()[0]).toBe("1. Musée du Louvre");

    const after = makeFakeContext();
    await addPlace(after.ctx, { trip_key: "T", place: "Louvre", day: DAY, after: "Park Güell" });
    expect(after.dayLines()[1]).toBe("2. Musée du Louvre");
  });

  it("add_place with an anchor and no target places it in Places to visit", async () => {
    const { ctx, submittedOps } = makeFakeContext();
    const result = await addPlace(ctx, { trip_key: "T", place: "Louvre", position: 1 });
    expect(result.isError).toBeUndefined();
    expect(submittedOps[0]![0]!.p).toEqual(["itinerary", "sections", 1, "blocks", 0]);
  });

  it("resolves ordinal references inside the target section only", () => {
    const trip = structuredClone(checklistTrip);
    const day = trip.itinerary.sections[DAY_INDEX]!;
    day.blocks.push(structuredClone(day.blocks[0]!), structuredClone(day.blocks[0]!));
    expect(resolveInsertionPoint(trip, DAY_INDEX, { after: "2nd Park Güell" }).index).toBe(4);
  });

  it("refuses an anchor in a section Wanderlog keeps in date order", () => {
    const hotels = mixedBlocksTrip.itinerary.sections.findIndex((s) => s.type === "hotels");
    expect(() => resolveInsertionPoint(mixedBlocksTrip, hotels, { position: 1 })).toThrow(
      /date order/,
    );
  });
});
